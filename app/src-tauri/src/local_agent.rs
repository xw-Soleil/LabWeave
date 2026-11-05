// 第 0 步只声明接口；第 1 步接通调用后移除这两个占位代码的 lint 豁免。
#![allow(dead_code, unused_variables)]

use crate::cmd::research::ResearchRoot;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin};
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{ipc::Channel, State};

const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STDERR_TAIL_LINES: usize = 200;
const LOGIN_SHELL_ARGS: &[&str] = &["-ilc", "printf %s \"$PATH\""];
const COMMON_BIN_DIRECTORIES: &[&str] = &[
    "~/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.npm-global/bin",
    "~/.volta/bin",
    "~/.bun/bin",
];

#[derive(Clone, Copy, Debug)]
struct LocalAgentDefinition {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    host_command: &'static str,
    login_command: Option<&'static str>,
    install_command: Option<&'static str>,
    homepage: &'static str,
    tested: bool,
}

const LOCAL_AGENT_CATALOG: &[LocalAgentDefinition] = &[
    LocalAgentDefinition {
        id: "codex",
        name: "Codex",
        command: "codex-acp",
        args: &[],
        host_command: "codex",
        login_command: Some("codex login"),
        install_command: Some(
            "npm i -g @agentclientprotocol/codex-acp@2.5.0 --prefix \"$HOME/.local\"",
        ),
        homepage: "https://developers.openai.com/codex/",
        tested: true,
    },
    LocalAgentDefinition {
        id: "claude",
        name: "Claude Code",
        command: "claude-agent-acp",
        args: &[],
        host_command: "claude",
        login_command: Some("claude auth login"),
        install_command: Some(
            "npm i -g @agentclientprotocol/claude-agent-acp@0.100.0 --prefix \"$HOME/.local\"",
        ),
        homepage: "https://code.claude.com/docs/",
        tested: true,
    },
    LocalAgentDefinition {
        id: "gemini",
        name: "Gemini CLI",
        command: "gemini",
        args: &["--acp"],
        host_command: "gemini",
        login_command: None,
        install_command: None,
        homepage: "https://geminicli.com/",
        tested: false,
    },
    LocalAgentDefinition {
        id: "kimi",
        name: "Kimi Code",
        command: "kimi",
        args: &["acp"],
        host_command: "kimi",
        login_command: None,
        install_command: None,
        homepage: "https://www.kimi.com/code",
        tested: false,
    },
    LocalAgentDefinition {
        id: "cursor",
        name: "Cursor",
        command: "cursor-agent",
        args: &["acp"],
        host_command: "cursor-agent",
        login_command: Some("cursor-agent login"),
        install_command: None,
        homepage: "https://cursor.com/cli",
        tested: false,
    },
    LocalAgentDefinition {
        id: "opencode",
        name: "OpenCode",
        command: "opencode",
        args: &["acp"],
        host_command: "opencode",
        login_command: None,
        install_command: None,
        homepage: "https://opencode.ai/",
        tested: false,
    },
    LocalAgentDefinition {
        id: "qodercn",
        name: "Qoder CN",
        command: "qodercn",
        args: &["--acp"],
        host_command: "qodercn",
        login_command: Some("qodercn login"),
        install_command: None,
        homepage: "https://qoder.com.cn/cli",
        tested: false,
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentInfo {
    pub id: String,
    pub name: String,
    pub resolved_path: Option<String>,
    pub host_found: bool,
    pub login_command: Option<String>,
    pub install_command: Option<String>,
    pub homepage: String,
    pub tested: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocalAgentEvent {
    Stdout { line: String },
    Stderr { line: String },
    Exited { code: Option<i32> },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentTerminalAction {
    Login,
    Install,
}

#[derive(Default)]
pub struct LocalAgentManager {
    processes: Mutex<HashMap<u32, LocalAgentProcess>>,
    next_handle: AtomicU32,
    login_shell_path: OnceLock<Result<OsString, String>>,
}

struct LocalAgentProcess {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<ChildStdin>,
}

#[derive(Clone, Copy)]
enum ProcessOutput {
    Stdout,
    Stderr,
}

impl LocalAgentManager {
    fn search_path(&self) -> Result<OsString, String> {
        Err("not implemented".into())
    }

    pub fn stop_all(&self) -> Result<(), String> {
        Err("not implemented".into())
    }
}

fn agent_definition(agent_id: &str) -> Result<&'static LocalAgentDefinition, String> {
    Err("not implemented".into())
}

fn login_shell_path(shell: &Path, cache: &OnceLock<Result<OsString, String>>) -> Result<OsString, String> {
    Err("not implemented".into())
}

fn common_bin_directories(home: &Path) -> Result<Vec<PathBuf>, String> {
    Err("not implemented".into())
}

fn merge_search_paths(
    login_path: &OsStr,
    process_path: &OsStr,
    common_directories: &[PathBuf],
) -> Result<OsString, String> {
    Err("not implemented".into())
}

fn find_executable(command: &str, search_path: &OsStr) -> Result<Option<PathBuf>, String> {
    Err("not implemented".into())
}

fn validate_path_override(path: &Path, command: &str) -> Result<PathBuf, String> {
    Err("not implemented".into())
}

fn validate_json_line(line: &str) -> Result<(), String> {
    Err("not implemented".into())
}

fn research_directory(root: &ResearchRoot) -> Result<PathBuf, String> {
    Err("not implemented".into())
}

fn spawn_process(
    command: &Path,
    args: &[&str],
    cwd: &Path,
    search_path: &OsStr,
    emit: impl Fn(LocalAgentEvent) -> Result<(), String> + Send + Sync + 'static,
) -> Result<LocalAgentProcess, String> {
    Err("not implemented".into())
}

fn read_process_lines(
    reader: impl BufRead,
    output: ProcessOutput,
    emit: &dyn Fn(LocalAgentEvent) -> Result<(), String>,
) -> Result<(), String> {
    Err("not implemented".into())
}

fn write_process_line(process: &LocalAgentProcess, line: &str) -> Result<(), String> {
    Err("not implemented".into())
}

fn stop_process_group(process: &LocalAgentProcess) -> Result<(), String> {
    Err("not implemented".into())
}

fn terminal_command(
    agent: &LocalAgentDefinition,
    action: LocalAgentTerminalAction,
    search_path: &OsStr,
) -> Result<String, String> {
    Err("not implemented".into())
}

fn open_terminal(command: &str) -> Result<(), String> {
    Err("not implemented".into())
}

#[tauri::command]
pub async fn local_agent_catalog(
    state: State<'_, LocalAgentManager>,
) -> Result<Vec<LocalAgentInfo>, String> {
    Err("not implemented".into())
}

#[tauri::command]
pub async fn local_agent_start(
    state: State<'_, LocalAgentManager>,
    research_root: State<'_, ResearchRoot>,
    agent_id: String,
    path_override: Option<String>,
    on_event: Channel<LocalAgentEvent>,
) -> Result<u32, String> {
    Err("not implemented".into())
}

#[tauri::command]
pub async fn local_agent_write(
    state: State<'_, LocalAgentManager>,
    handle: u32,
    line: String,
) -> Result<(), String> {
    Err("not implemented".into())
}

#[tauri::command]
pub async fn local_agent_stop(
    state: State<'_, LocalAgentManager>,
    handle: u32,
) -> Result<(), String> {
    Err("not implemented".into())
}

#[tauri::command]
pub async fn local_agent_open_terminal(
    state: State<'_, LocalAgentManager>,
    agent_id: String,
    action: LocalAgentTerminalAction,
) -> Result<(), String> {
    Err("not implemented".into())
}

#[cfg(test)]
#[path = "local_agent_tests.rs"]
mod tests;
