use crate::project_ownership::canonicalize_project_path;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Runtime, State};

pub(crate) const PROJECT_RUNTIME_INVOCATION_EVENT: &str = "project-runtime-invocation";

/// 本机通道的口令长度（字节）。口令随地址一起写进工作区的归属记录，只有本账户能读；
/// 每个请求都要带上它，否则拒绝。
const BRIDGE_TOKEN_BYTES: usize = 32;

#[derive(Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
enum ProjectRuntimeRequest {
    Invocation {
        request_id: String,
        project_path: String,
        tool_name: String,
        input: Value,
    },
    Cancellation {
        cancel_request_id: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ProjectRuntimeEvent {
    Invoke {
        request_id: String,
        project_path: String,
        tool_name: String,
        input: Value,
    },
    Cancel {
        request_id: String,
    },
}

type InvocationEmitter = dyn Fn(ProjectRuntimeEvent) -> Result<(), ()> + Send + Sync;

pub(crate) struct ProjectRuntimeBridgeManager {
    endpoint: String,
    pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
}

impl ProjectRuntimeBridgeManager {
    pub(crate) fn start<R: Runtime>(app: AppHandle<R>) -> std::io::Result<Arc<Self>> {
        Self::start_with_emitter(move |invocation| {
            app.emit(PROJECT_RUNTIME_INVOCATION_EVENT, invocation)
                .map_err(|_| ())
        })
    }

    fn start_with_emitter(
        emit: impl Fn(ProjectRuntimeEvent) -> Result<(), ()> + Send + Sync + 'static,
    ) -> std::io::Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let token = Arc::new(generate_bridge_token()?);
        let endpoint = format!("tcp://{}/?token={}", listener.local_addr()?, token);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let manager = Arc::new(Self {
            endpoint,
            pending: Arc::clone(&pending),
        });
        let emit: Arc<InvocationEmitter> = Arc::new(emit);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    break;
                };
                let pending = Arc::clone(&pending);
                let emit = Arc::clone(&emit);
                let token = Arc::clone(&token);
                thread::spawn(move || handle_connection(stream, pending, emit, token));
            }
        });
        Ok(manager)
    }

    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(crate) fn respond(&self, request_id: &str, response: Value) -> bool {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(request_id));
        sender.is_some_and(|sender| sender.send(response).is_ok())
    }
}

fn handle_connection(
    mut stream: TcpStream,
    pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
    emit: Arc<InvocationEmitter>,
    token: Arc<String>,
) {
    let response = stream
        .try_clone()
        .map_err(|_| BridgeError::Unavailable)
        .map(BufReader::new)
        .and_then(|mut reader| {
            read_request(&mut reader, &token).and_then(|request| match request {
                ProjectRuntimeRequest::Cancellation { cancel_request_id } => {
                    emit(ProjectRuntimeEvent::Cancel {
                        request_id: cancel_request_id,
                    })
                    .map_err(|_| BridgeError::Unavailable)?;
                    Ok(json!({ "ok": true, "value": null }))
                }
                ProjectRuntimeRequest::Invocation {
                    request_id,
                    project_path,
                    tool_name,
                    input,
                } => {
                    if request_id.is_empty() {
                        return Err(BridgeError::Unavailable);
                    }
                    let project_path = canonicalize_project_path(Path::new(&project_path))
                        .map_err(|_| BridgeError::Unavailable)?
                        .to_protocol_string();
                    let (response_sender, response_receiver) = mpsc::channel();
                    {
                        let mut pending = pending.lock().map_err(|_| BridgeError::Unavailable)?;
                        if pending.contains_key(&request_id) {
                            return Err(BridgeError::Unavailable);
                        }
                        pending.insert(request_id.clone(), response_sender);
                    }
                    let invocation = ProjectRuntimeEvent::Invoke {
                        request_id: request_id.clone(),
                        project_path,
                        tool_name,
                        input,
                    };
                    if emit(invocation).is_err() {
                        if let Ok(mut pending) = pending.lock() {
                            pending.remove(&request_id);
                        }
                        return Err(BridgeError::Unavailable);
                    }
                    let cancellation_emit = Arc::clone(&emit);
                    let cancellation_request_id = request_id.clone();
                    let cancellation_token = Arc::clone(&token);
                    let _cancellation_listener = thread::spawn(move || {
                        if let Ok(ProjectRuntimeRequest::Cancellation { cancel_request_id }) =
                            read_request(&mut reader, &cancellation_token)
                        {
                            if cancel_request_id == cancellation_request_id {
                                let _ = cancellation_emit(ProjectRuntimeEvent::Cancel {
                                    request_id: cancellation_request_id,
                                });
                            }
                        }
                    });
                    let response = response_receiver
                        .recv()
                        .map_err(|_| BridgeError::Unavailable);
                    if let Ok(mut pending) = pending.lock() {
                        pending.remove(&request_id);
                    }
                    response
                }
            })
        });
    let response = response.unwrap_or_else(|error| match error {
        BridgeError::Unavailable => runtime_host_unavailable(),
        BridgeError::Unauthorized => runtime_host_unauthorized(),
    });
    if let Ok(serialized) = serde_json::to_string(&response) {
        let _ = writeln!(stream, "{serialized}");
    }
    let _ = stream.shutdown(Shutdown::Both);
}

enum BridgeError {
    Unavailable,
    Unauthorized,
}

/// 读一行请求，先核对口令再解析内容
fn read_request(
    reader: &mut impl BufRead,
    token: &str,
) -> Result<ProjectRuntimeRequest, BridgeError> {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|_| BridgeError::Unavailable)?;
    let mut request: Value = serde_json::from_str(&line).map_err(|_| BridgeError::Unavailable)?;
    let presented = request
        .as_object_mut()
        .and_then(|fields| fields.remove("token"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    if !tokens_match(&presented, token) {
        return Err(BridgeError::Unauthorized);
    }
    serde_json::from_value(request).map_err(|_| BridgeError::Unavailable)
}

/// 逐字节比较，耗时不随第一个不同字节的位置变化
fn tokens_match(presented: &str, expected: &str) -> bool {
    presented.len() == expected.len()
        && presented
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

fn generate_bridge_token() -> std::io::Result<String> {
    let mut bytes = [0u8; BRIDGE_TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn runtime_host_unavailable() -> Value {
    json!({
        "ok": false,
        "error": {
            "code": "RUNTIME_HOST_UNAVAILABLE",
            "message": "Open Project Runtime Host is unavailable."
        }
    })
}

fn runtime_host_unauthorized() -> Value {
    json!({
        "ok": false,
        "error": {
            "code": "RUNTIME_HOST_UNAUTHORIZED",
            "message": "The request did not carry this runtime host's token."
        }
    })
}

#[tauri::command]
pub(crate) fn respond_project_runtime_bridge(
    manager: State<'_, Arc<ProjectRuntimeBridgeManager>>,
    request_id: String,
    response: Value,
) -> bool {
    manager.respond(&request_id, response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_ownership::{
        default_ownership_directory, DesktopOwnershipAcquisition, DesktopProjectOwnershipManager,
        OWNERSHIP_DIRECTORY_ENVIRONMENT_VARIABLE,
    };
    use serde_json::json;
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread;

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "project-graph-runtime-host-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    /// 地址形如 tcp://127.0.0.1:端口/?token=口令
    fn address_and_token(endpoint: &str) -> (String, String) {
        let (address, token) = endpoint
            .strip_prefix("tcp://")
            .and_then(|rest| rest.split_once("/?token="))
            .unwrap();
        (address.to_owned(), token.to_owned())
    }

    #[test]
    fn loopback_bridge_forwards_one_runtime_invocation_and_response() {
        let directory = TestDirectory::new();
        let project_path = directory.path().join("graph.prg");
        fs::write(&project_path, b"project").unwrap();
        let (event_sender, event_receiver) = mpsc::channel();
        let bridge = ProjectRuntimeBridgeManager::start_with_emitter(move |invocation| {
            event_sender.send(invocation).map_err(|_| ())
        })
        .unwrap();
        let (address, token) = address_and_token(bridge.endpoint());
        let invocation_path = project_path.clone();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            writeln!(
                stream,
                "{}",
                json!({
                    "token": token,
                    "requestId": "request-1",
                    "projectPath": invocation_path,
                    "toolName": "get_all_nodes",
                    "input": {}
                })
            )
            .unwrap();
            let mut response = String::new();
            BufReader::new(stream).read_line(&mut response).unwrap();
            serde_json::from_str::<serde_json::Value>(&response).unwrap()
        });

        let ProjectRuntimeEvent::Invoke {
            request_id,
            project_path: emitted_project_path,
            tool_name,
            ..
        } = event_receiver.recv().unwrap()
        else {
            panic!("expected invocation event");
        };
        assert_eq!(
            emitted_project_path,
            canonicalize_project_path(&project_path)
                .unwrap()
                .to_protocol_string()
        );
        assert_eq!(tool_name, "get_all_nodes");
        assert!(bridge.respond(
            &request_id,
            json!({ "ok": true, "value": { "objects": [{ "ref": "n1" }] } }),
        ));

        assert_eq!(
            client.join().unwrap(),
            json!({ "ok": true, "value": { "objects": [{ "ref": "n1" }] } })
        );
    }

    #[test]
    fn loopback_bridge_returns_a_structured_error_when_the_frontend_rejects_the_invocation() {
        let directory = TestDirectory::new();
        let project_path = directory.path().join("graph.prg");
        fs::write(&project_path, b"project").unwrap();
        let bridge = ProjectRuntimeBridgeManager::start_with_emitter(|_| Err(())).unwrap();
        let (address, token) = address_and_token(bridge.endpoint());
        let mut stream = TcpStream::connect(address).unwrap();
        writeln!(
            stream,
            "{}",
            json!({
                "token": token,
                "requestId": "request-rejected",
                "projectPath": project_path,
                "toolName": "get_all_nodes",
                "input": {}
            })
        )
        .unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            runtime_host_unavailable()
        );
    }

    #[test]
    fn loopback_bridge_forwards_cancellation_for_the_matching_invocation() {
        let directory = TestDirectory::new();
        let project_path = directory.path().join("graph.prg");
        fs::write(&project_path, b"project").unwrap();
        let (event_sender, event_receiver) = mpsc::channel();
        let bridge = ProjectRuntimeBridgeManager::start_with_emitter(move |event| {
            event_sender.send(event).map_err(|_| ())
        })
        .unwrap();
        let (address, token) = address_and_token(bridge.endpoint());
        let mut invocation = TcpStream::connect(address).unwrap();
        writeln!(
            invocation,
            "{}",
            json!({
                "token": token,
                "requestId": "request-cancel",
                "projectPath": project_path,
                "toolName": "get_all_nodes",
                "input": {}
            })
        )
        .unwrap();

        assert!(matches!(
            event_receiver.recv().unwrap(),
            ProjectRuntimeEvent::Invoke { request_id, .. } if request_id == "request-cancel"
        ));
        writeln!(
            invocation,
            "{}",
            json!({ "token": token, "cancelRequestId": "request-cancel" })
        )
        .unwrap();
        assert!(matches!(
            event_receiver.recv().unwrap(),
            ProjectRuntimeEvent::Cancel { request_id } if request_id == "request-cancel"
        ));
        assert!(bridge.respond(
            "request-cancel",
            json!({
                "ok": false,
                "error": {
                    "code": "CANCELLED",
                    "message": "Project Graph CLI invocation was cancelled."
                }
            }),
        ));
        let mut response = String::new();
        BufReader::new(invocation).read_line(&mut response).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            json!({
                "ok": false,
                "error": {
                    "code": "CANCELLED",
                    "message": "Project Graph CLI invocation was cancelled."
                }
            })
        );
    }

    #[test]
    fn loopback_bridge_rejects_requests_without_the_token_and_forwards_nothing() {
        let directory = TestDirectory::new();
        let project_path = directory.path().join("graph.prg");
        fs::write(&project_path, b"project").unwrap();
        let (event_sender, event_receiver) = mpsc::channel();
        let bridge = ProjectRuntimeBridgeManager::start_with_emitter(move |event| {
            event_sender.send(event).map_err(|_| ())
        })
        .unwrap();
        let (address, token) = address_and_token(bridge.endpoint());
        assert_eq!(token.len(), BRIDGE_TOKEN_BYTES * 2);
        let wrong_token = "0".repeat(token.len());
        for presented in [None, Some(""), Some(wrong_token.as_str())] {
            let mut request = json!({
                "requestId": "request-unauthorized",
                "projectPath": project_path,
                "toolName": "delete_all_nodes",
                "input": {}
            });
            if let Some(presented) = presented {
                request["token"] = json!(presented);
            }
            let mut stream = TcpStream::connect(&address).unwrap();
            writeln!(stream, "{request}").unwrap();
            let mut response = String::new();
            BufReader::new(stream).read_line(&mut response).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap(),
                runtime_host_unauthorized()
            );
        }
        let mut cancellation = TcpStream::connect(&address).unwrap();
        writeln!(cancellation, "{}", json!({ "cancelRequestId": "request-unauthorized" })).unwrap();
        let mut response = String::new();
        BufReader::new(cancellation).read_line(&mut response).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            runtime_host_unauthorized()
        );
        assert!(event_receiver.try_recv().is_err());
    }

    #[test]
    fn each_bridge_gets_its_own_token() {
        let first = ProjectRuntimeBridgeManager::start_with_emitter(|_| Ok(())).unwrap();
        let second = ProjectRuntimeBridgeManager::start_with_emitter(|_| Ok(())).unwrap();
        assert_ne!(
            address_and_token(first.endpoint()).1,
            address_and_token(second.endpoint()).1
        );
    }

    #[test]
    fn real_cli_process_attaches_to_the_desktop_runtime_host() {
        let directory = TestDirectory::new();
        let project_path = directory.path().join("graph.prg");
        fs::write(&project_path, b"persisted fallback sentinel").unwrap();
        let before = fs::read(&project_path).unwrap();

        let (event_sender, event_receiver) = mpsc::channel();
        let bridge = ProjectRuntimeBridgeManager::start_with_emitter(move |invocation| {
            event_sender.send(invocation).map_err(|_| ())
        })
        .unwrap();
        let ownership = DesktopProjectOwnershipManager::default();
        let DesktopOwnershipAcquisition::Acquired { ownership_id, .. } = ownership
            .acquire_connectable(&project_path, bridge.endpoint())
            .unwrap()
        else {
            panic!("desktop Runtime Host must acquire the Project");
        };
        let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let ownership_helper_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "target/debug/project-graph-ownership-helper{}",
            std::env::consts::EXE_SUFFIX
        ));
        assert!(ownership_helper_path.is_file());
        let cli_project_path = project_path.clone();
        let cli = thread::spawn(move || {
            Command::new("node")
                .current_dir(repository_root)
                .env("NO_COLOR", "1")
                .env("PROJECT_GRAPH_OWNERSHIP_HELPER_PATH", ownership_helper_path)
                .env(
                    OWNERSHIP_DIRECTORY_ENVIRONMENT_VARIABLE,
                    default_ownership_directory().unwrap(),
                )
                .args([
                    "packages/project-graph-cli/src/cli.mjs",
                    "tool",
                    "invoke",
                    "get_all_nodes",
                    "--project",
                ])
                .arg(cli_project_path)
                .args(["--input", "{}"])
                .output()
                .unwrap()
        });

        let ProjectRuntimeEvent::Invoke {
            request_id,
            project_path: invocation_project_path,
            ..
        } = event_receiver.recv().unwrap()
        else {
            panic!("expected invocation event");
        };
        assert_eq!(
            invocation_project_path,
            canonicalize_project_path(&project_path)
                .unwrap()
                .to_protocol_string()
        );
        assert!(bridge.respond(
            &request_id,
            json!({
                "ok": true,
                "value": {
                    "objects": [{
                        "ref": "n1",
                        "type": "TextNode",
                        "text": "Unsaved live node"
                    }]
                }
            }),
        ));
        let output = cli.join().unwrap();

        assert!(output.status.success());
        assert_eq!(output.stderr, b"");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "{\"objects\":[{\"ref\":\"n1\",\"text\":\"Unsaved live node\",\"type\":\"TextNode\"}]}\n"
        );
        assert_eq!(fs::read(&project_path).unwrap(), before);
        assert_eq!(
            ownership
                .acquire_connectable(&project_path, bridge.endpoint())
                .unwrap(),
            DesktopOwnershipAcquisition::AlreadyOwned {
                ownership_id: ownership_id.clone(),
                canonical_path: canonicalize_project_path(&project_path)
                    .unwrap()
                    .to_protocol_string(),
            }
        );
        ownership.release(&ownership_id).unwrap();
    }
}
