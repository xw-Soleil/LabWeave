// 部分改写自 Agentero(MIT,Copyright (c) 2026 poco-ai):crates/agentero-core/src/process/discover.rs
// 部分改写自 Agentero(MIT,Copyright (c) 2026 poco-ai):src-tauri/src/features/agent/commands/doctor.rs

use crate::cmd::research::ResearchRoot;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State};

#[cfg(unix)]
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STDERR_TAIL_LINES: usize = 200;
const STDERR_FLUSH_INTERVAL: Duration = Duration::from_millis(100);
#[cfg(unix)]
const LOGIN_SHELL_ARGS: &[&str] = &[
    "-ilc",
    "printf '__RWB_PATH_BEGIN__%s__RWB_PATH_END__' \"$PATH\"",
];
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
    host_env: Option<&'static str>,
    login_command: Option<&'static str>,
    install_command: Option<&'static str>,
    homepage: &'static str,
    tested: bool,
}

// 转接器使用用户已安装的主程序，--omit=optional 避免另行下载自带主程序。
const LOCAL_AGENT_CATALOG: &[LocalAgentDefinition] = &[
    LocalAgentDefinition {
        id: "codex",
        name: "Codex",
        command: "codex-acp",
        args: &[],
        host_command: "codex",
        host_env: Some("CODEX_PATH"),
        login_command: Some("codex login"),
        install_command: Some(
            "npm i -g @agentclientprotocol/codex-acp@2.5.0 --omit=optional --prefix \"$HOME/.local\"",
        ),
        homepage: "https://github.com/openai/codex",
        tested: true,
    },
    LocalAgentDefinition {
        id: "claude",
        name: "Claude Code",
        command: "claude-agent-acp",
        args: &[],
        host_command: "claude",
        host_env: Some("CLAUDE_CODE_EXECUTABLE"),
        login_command: Some("claude auth login"),
        install_command: Some(
            "npm i -g @agentclientprotocol/claude-agent-acp@0.100.0 --omit=optional --prefix \"$HOME/.local\"",
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
        host_env: None,
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
        host_env: None,
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
        host_env: None,
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
        host_env: None,
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
        host_env: None,
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

#[derive(Clone, Default)]
pub struct LocalAgentManager {
    registry: Arc<Mutex<ProcessRegistry>>,
    login_shell_path: Arc<OnceLock<OsString>>,
}

#[derive(Default)]
struct ProcessRegistry {
    processes: HashMap<u32, Arc<LocalAgentProcess>>,
    next_handle: u32,
    shutting_down: bool,
}

struct LocalAgentProcess {
    process_group: u32,
    stdin: Mutex<Option<ChildStdin>>,
    exited: AtomicBool,
    stopped: Mutex<bool>,
}

#[derive(Clone, Copy)]
enum ProcessOutput {
    Stdout,
    Stderr,
}

impl LocalAgentManager {
    fn search_path(&self, home: &Path) -> Result<OsString, String> {
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        let login_path = self.cached_login_shell_path(Path::new(&shell), home);
        let common = common_bin_directories(home);
        merge_search_paths(
            &login_path,
            &std::env::var_os("PATH").unwrap_or_default(),
            &common,
        )
    }

    fn cached_login_shell_path(&self, shell: &Path, home: &Path) -> OsString {
        self.login_shell_path
            .get_or_init(|| match login_shell_path(shell, home) {
                Ok(path) => path,
                Err(error) => {
                    eprintln!("[local-agent] {error}，继续使用当前 PATH 和常见目录");
                    OsString::new()
                }
            })
            .clone()
    }

    fn start(
        &self,
        agent_id: &str,
        path_override: Option<&Path>,
        cwd: &Path,
        emit: impl Fn(LocalAgentEvent) -> Result<(), String> + Send + Sync + 'static,
    ) -> Result<u32, String> {
        let agent = agent_definition(agent_id)?;
        let home = account_home_dir()?;
        let search_path = self.search_path(&home)?;
        let command = match path_override {
            Some(path) => validate_path_override(path, agent.command)?,
            None => find_executable(agent.command, &search_path)
                .ok_or_else(|| format!("找不到程序: {}", agent.command))?,
        };
        let host = find_executable(agent.host_command, &search_path);
        let environment = process_environment(
            std::env::vars_os(),
            &home,
            &search_path,
            agent.host_env.zip(host.as_deref()),
        );
        let mut registry = self.registry.lock().map_err(|e| e.to_string())?;
        if registry.shutting_down {
            return Err("程序正在退出，无法启动本机 AI".into());
        }
        let handle = registry.next_handle;
        registry.next_handle = handle.checked_add(1).ok_or("本机 AI 句柄已用尽")?;
        let shared_registry = Arc::clone(&self.registry);
        let process = spawn_process(&command, agent.args, cwd, &environment, move |event| {
            if matches!(event, LocalAgentEvent::Exited { .. }) {
                shared_registry
                    .lock()
                    .map_err(|e| e.to_string())?
                    .processes
                    .remove(&handle);
            }
            emit(event)
        })?;
        registry.processes.insert(handle, process);
        Ok(handle)
    }

    fn write(&self, handle: u32, line: &str) -> Result<(), String> {
        let process = self
            .registry
            .lock()
            .map_err(|e| e.to_string())?
            .processes
            .get(&handle)
            .cloned()
            .ok_or_else(|| format!("本机 AI 句柄不存在或已退出: {handle}"))?;
        write_process_line(&process, line)
    }

    fn stop(&self, handle: u32) -> Result<(), String> {
        let process = self
            .registry
            .lock()
            .map_err(|e| e.to_string())?
            .processes
            .get(&handle)
            .cloned();
        if let Some(process) = process {
            stop_process_group(&process)?;
        }
        Ok(())
    }

    pub fn stop_all(&self) -> Result<(), String> {
        let processes: Vec<_> = {
            let mut registry = self.registry.lock().map_err(|e| e.to_string())?;
            registry.shutting_down = true;
            registry.processes.values().cloned().collect()
        };
        let errors: Vec<_> = processes
            .iter()
            .filter_map(|process| stop_process_group(process).err())
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("\n"))
        }
    }
}

fn agent_definition(agent_id: &str) -> Result<&'static LocalAgentDefinition, String> {
    LOCAL_AGENT_CATALOG
        .iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| format!("不支持的本机 AI 程序: {agent_id}"))
}

fn account_home_dir() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        use std::ffi::CStr;
        use std::os::unix::ffi::OsStrExt;

        let mut buffer = vec![0 as libc::c_char; 1024];
        loop {
            let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
            let mut result = std::ptr::null_mut();
            let error = unsafe {
                libc::getpwuid_r(
                    libc::getuid(),
                    entry.as_mut_ptr(),
                    buffer.as_mut_ptr(),
                    buffer.len(),
                    &mut result,
                )
            };
            if error == libc::ERANGE {
                let size = buffer.len().checked_mul(2).ok_or("账户信息过长")?;
                buffer.resize(size, 0);
                continue;
            }
            if error != 0 {
                return Err(format!(
                    "无法读取账户主目录: {}",
                    std::io::Error::from_raw_os_error(error)
                ));
            }
            if result.is_null() {
                return Err("找不到当前账户的主目录".into());
            }
            let entry = unsafe { entry.assume_init() };
            if entry.pw_dir.is_null() {
                return Err("当前账户没有主目录".into());
            }
            let home = unsafe { CStr::from_ptr(entry.pw_dir) };
            let home = PathBuf::from(OsStr::from_bytes(home.to_bytes()));
            if !home.is_absolute() {
                return Err("账户主目录不是绝对路径".into());
            }
            return Ok(home);
        }
    }
    #[cfg(not(unix))]
    {
        dirs::home_dir().ok_or_else(|| "找不到当前账户的主目录".into())
    }
}

fn process_environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    home: &Path,
    search_path: &OsStr,
    host: Option<(&str, &Path)>,
) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<_> = inherited.into_iter().collect();
    environment.push(("HOME".into(), home.as_os_str().to_owned()));
    environment.push(("PATH".into(), search_path.to_owned()));
    if let Some((name, path)) = host {
        environment.push((name.into(), path.as_os_str().to_owned()));
    }
    environment
}

fn login_shell_path(shell: &Path, home: &Path) -> Result<OsString, String> {
    #[cfg(not(unix))]
    {
        let _ = (shell, home);
        Ok(std::env::var_os("PATH").unwrap_or_default())
    }
    #[cfg(unix)]
    {
        use std::os::unix::{ffi::OsStringExt, process::CommandExt};
        let mut child = Command::new(shell)
            .args(LOGIN_SHELL_ARGS)
            .env("HOME", home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("无法探测登录 shell 的 PATH: {e}"))?;
        let result = (|| {
            let stdout = child.stdout.take().ok_or("无法读取登录 shell 输出")?;
            let reader = thread::Builder::new()
                .name("local-agent-shell".into())
                .spawn(move || {
                    let mut output = Vec::new();
                    stdout.take(1024 * 1024).read_to_end(&mut output)?;
                    Ok::<_, std::io::Error>(output)
                })
                .map_err(|e| e.to_string())?;
            let deadline = Instant::now() + LOGIN_SHELL_TIMEOUT;
            loop {
                if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("登录 shell 的 PATH 探测超过 5 秒".into());
                }
                thread::sleep(Duration::from_millis(10));
            }
            // shell 退出后，后台子进程仍可能持有 stdout，必须先关闭整组再收集输出。
            signal_process_group(child.id(), libc::SIGKILL)?;
            let output = reader
                .join()
                .map_err(|_| "读取登录 shell 的线程异常退出".to_string())?
                .map_err(|e| e.to_string())?;
            let begin = b"__RWB_PATH_BEGIN__";
            let end = b"__RWB_PATH_END__";
            let start = output
                .windows(begin.len())
                .position(|bytes| bytes == begin)
                .ok_or("登录 shell 输出缺少 PATH 开始标记")?
                + begin.len();
            let path = &output[start..];
            let end = path
                .windows(end.len())
                .position(|bytes| bytes == end)
                .ok_or("登录 shell 输出缺少 PATH 结束标记")?;
            Ok(OsString::from_vec(path[..end].to_vec()))
        })();
        if result.is_err() {
            signal_process_group(child.id(), libc::SIGKILL)?;
            child.wait().map_err(|e| e.to_string())?;
        }
        result
    }
}

fn common_bin_directories(home: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<_> = COMMON_BIN_DIRECTORIES
        .iter()
        .map(|directory| match directory.strip_prefix("~/") {
            Some(relative) => home.join(relative),
            None => PathBuf::from(directory),
        })
        .collect();
    if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut bins: Vec<_> = versions
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("bin"))
            .filter(|path| path.is_dir())
            .collect();
        bins.sort();
        paths.extend(bins);
    }
    paths
}

fn merge_search_paths(
    login_path: &OsStr,
    process_path: &OsStr,
    common_directories: &[PathBuf],
) -> Result<OsString, String> {
    let mut paths = Vec::new();
    for path in std::env::split_paths(login_path)
        .chain(std::env::split_paths(process_path))
        .chain(common_directories.iter().cloned())
    {
        if !path.as_os_str().is_empty() && !paths.contains(&path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).map_err(|e| format!("无法合并 PATH: {e}"))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn find_executable(command: &str, search_path: &OsStr) -> Option<PathBuf> {
    #[cfg(windows)]
    let names = [format!("{command}.exe"), format!("{command}.cmd")];
    #[cfg(not(windows))]
    let names = [command.to_string()];
    std::env::split_paths(search_path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .filter(|path| is_executable(path))
        // 保留 npm 的符号链接文件名；规范化到 JS 源文件会改变 Node 的启动方式。
        .find_map(|path| std::path::absolute(path).ok())
}

fn validate_path_override(path: &Path, command: &str) -> Result<PathBuf, String> {
    let name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
    let name = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".cmd"))
        .unwrap_or(name);
    if name != command || !is_executable(path) {
        return Err(format!("指定位置必须是名为 {command} 的可执行文件"));
    }
    std::path::absolute(path).map_err(|e| format!("无法解析程序路径: {e}"))
}

fn validate_json_line(line: &str) -> Result<(), String> {
    if line.contains(['\n', '\r']) {
        return Err("只能写入不含换行的单行 JSON 对象".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("无效 JSON: {e}"))?;
    if !value.is_object() {
        return Err("只能写入 JSON 对象".into());
    }
    Ok(())
}

fn spawn_process(
    command: &Path,
    args: &[&str],
    cwd: &Path,
    environment: &[(OsString, OsString)],
    emit: impl Fn(LocalAgentEvent) -> Result<(), String> + Send + Sync + 'static,
) -> Result<Arc<LocalAgentProcess>, String> {
    let mut builder = Command::new(command);
    builder
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        builder.process_group(0);
    }
    let mut child = builder
        .spawn()
        .map_err(|e| format!("无法启动 {}: {e}", command.display()))?;
    let process = Arc::new(LocalAgentProcess {
        process_group: child.id(),
        stdin: Mutex::new(child.stdin.take()),
        exited: AtomicBool::new(false),
        stopped: Mutex::new(false),
    });
    let worker_process = Arc::clone(&process);
    let (sender, receiver) = mpsc::sync_channel(1);
    // 等待线程创建成功以后再移交 Child，线程创建失败也能在这里回收进程。
    if let Err(error) = thread::Builder::new()
        .name("local-agent-wait".into())
        .spawn(move || {
            if let Ok(child) = receiver.recv() {
                supervise_process(child, worker_process, Arc::new(emit));
            }
        })
    {
        kill_process_group(process.process_group)?;
        child.wait().map_err(|e| e.to_string())?;
        return Err(format!("无法创建进程等待线程: {error}"));
    }
    if let Err(mut error) = sender.send(child) {
        kill_process_group(process.process_group)?;
        error.0.wait().map_err(|e| e.to_string())?;
        return Err("进程等待线程已关闭".into());
    }
    Ok(process)
}

type EventEmitter = dyn Fn(LocalAgentEvent) -> Result<(), String> + Send + Sync;

fn supervise_process(mut child: Child, process: Arc<LocalAgentProcess>, emit: Arc<EventEmitter>) {
    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
    let mut readers = Vec::new();
    let pipes: [(Option<Box<dyn Read + Send>>, ProcessOutput); 2] = [
        (
            child
                .stdout
                .take()
                .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
            ProcessOutput::Stdout,
        ),
        (
            child
                .stderr
                .take()
                .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
            ProcessOutput::Stderr,
        ),
    ];
    for (pipe, output) in pipes {
        let Some(pipe) = pipe else {
            report_process_error(&*emit, "无法读取本机 AI 的输出管道".into());
            if let Err(error) = kill_process_group(process.process_group) {
                report_process_error(&*emit, error);
            }
            continue;
        };
        let reader_emit = Arc::clone(&emit);
        let reader_process = Arc::clone(&process);
        let tail = Arc::clone(&stderr_tail);
        match thread::Builder::new()
            .name("local-agent-output".into())
            .spawn(move || {
                let result = read_process_lines(BufReader::new(pipe), output, &|event| {
                    if let LocalAgentEvent::Stderr { line } = event {
                        let mut tail = tail.lock().map_err(|e| e.to_string())?;
                        push_stderr_line(&mut tail, line);
                        Ok(())
                    } else {
                        reader_emit(event)
                    }
                });
                if let Err(error) = result {
                    report_process_error(&*reader_emit, error);
                    if let Err(error) = stop_process_group(&reader_process) {
                        report_process_error(&*reader_emit, error);
                    }
                }
            }) {
            Ok(reader) => readers.push(reader),
            Err(error) => {
                report_process_error(&*emit, format!("无法创建输出读取线程: {error}"));
                if let Err(error) = kill_process_group(process.process_group) {
                    report_process_error(&*emit, error);
                }
            }
        }
    }
    let mut last_flush = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(error) => {
                report_process_error(&*emit, format!("无法等待本机 AI 退出: {error}"));
                if let Err(error) = kill_process_group(process.process_group) {
                    report_process_error(&*emit, error);
                }
                break match child.wait() {
                    Ok(status) => status.code(),
                    Err(error) => {
                        report_process_error(&*emit, error.to_string());
                        None
                    }
                };
            }
        }
        if last_flush.elapsed() >= STDERR_FLUSH_INTERVAL {
            if let Err(error) = flush_stderr(&stderr_tail, &*emit) {
                eprintln!("[local-agent] {error}");
                if let Err(error) = stop_process_group(&process) {
                    report_process_error(&*emit, error);
                }
            }
            last_flush = Instant::now();
        }
        thread::sleep(STDERR_FLUSH_INTERVAL);
    };
    process.exited.store(true, Ordering::Release);
    // 主进程退出并不代表子进程退出；先清理剩余成员，读管道的线程才能收到 EOF。
    if let Err(error) = stop_process_group(&process) {
        report_process_error(&*emit, error);
    }
    for reader in readers {
        if reader.join().is_err() {
            report_process_error(&*emit, "本机 AI 输出线程异常退出".into());
        }
    }
    if let Err(error) = flush_stderr(&stderr_tail, &*emit) {
        eprintln!("[local-agent] {error}");
    }
    process
        .stdin
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Err(error) = emit(LocalAgentEvent::Exited { code }) {
        eprintln!("[local-agent] 无法发送退出事件: {error}");
    }
}

fn report_process_error(emit: &EventEmitter, line: String) {
    if let Err(error) = emit(LocalAgentEvent::Stderr { line }) {
        eprintln!("[local-agent] 无法发送进程错误: {error}");
    }
}

fn push_stderr_line(tail: &mut VecDeque<String>, line: String) {
    if tail.len() == STDERR_TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(line);
}

fn flush_stderr(tail: &Mutex<VecDeque<String>>, emit: &EventEmitter) -> Result<(), String> {
    let lines = std::mem::take(&mut *tail.lock().map_err(|e| e.to_string())?);
    for line in lines {
        emit(LocalAgentEvent::Stderr { line })?;
    }
    Ok(())
}

fn read_process_lines(
    reader: impl BufRead,
    output: ProcessOutput,
    emit: &dyn Fn(LocalAgentEvent) -> Result<(), String>,
) -> Result<(), String> {
    for line in reader.lines() {
        let line = line.map_err(|e| format!("无法读取本机 AI 输出: {e}"))?;
        emit(match output {
            ProcessOutput::Stdout => LocalAgentEvent::Stdout { line },
            ProcessOutput::Stderr => LocalAgentEvent::Stderr { line },
        })?;
    }
    Ok(())
}

fn write_process_line(process: &LocalAgentProcess, line: &str) -> Result<(), String> {
    validate_json_line(line)?;
    if process.exited.load(Ordering::Acquire) {
        return Err("本机 AI 已退出".into());
    }
    let mut stdin = process.stdin.lock().map_err(|e| e.to_string())?;
    let stdin = stdin.as_mut().ok_or("本机 AI 输入管道已关闭")?;
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("无法写入本机 AI: {e}"))
}

fn stop_process_group(process: &LocalAgentProcess) -> Result<(), String> {
    let mut stopped = process.stopped.lock().map_err(|e| e.to_string())?;
    if *stopped {
        return Ok(());
    }
    #[cfg(unix)]
    {
        signal_process_group(process.process_group, libc::SIGTERM)?;
        let deadline = Instant::now() + STOP_TIMEOUT;
        while signal_process_group(process.process_group, 0)? {
            if Instant::now() >= deadline {
                kill_process_group(process.process_group)?;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    #[cfg(not(unix))]
    if !process.exited.load(Ordering::Acquire) {
        kill_process_group(process.process_group)?;
    }
    *stopped = true;
    Ok(())
}

#[cfg(unix)]
fn signal_process_group(process_group: u32, signal: i32) -> Result<bool, String> {
    let group = i32::try_from(process_group)
        .ok()
        .filter(|group| *group > 1)
        .ok_or("无效的本机 AI 进程组号")?;
    // process_group 是 Command::process_group(0) 创建的独立进程组，负号表示整组。
    if unsafe { libc::kill(-group, signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    // macOS 上进程组只剩未回收的僵尸进程时会返回 EPERM，此时已没有活进程。
    if matches!(error.raw_os_error(), Some(libc::ESRCH | libc::EPERM)) {
        Ok(false)
    } else {
        Err(format!("无法向进程组 {group} 发送信号 {signal}: {error}"))
    }
}

fn kill_process_group(process_group: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        signal_process_group(process_group, libc::SIGKILL).map(|_| ())
    }
    #[cfg(not(unix))]
    {
        let output = Command::new("taskkill")
            .args(["/PID", &process_group.to_string(), "/T", "/F"])
            .output()
            .map_err(|e| format!("无法结束本机 AI: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).into_owned())
        }
    }
}

fn terminal_command(
    agent: &LocalAgentDefinition,
    action: LocalAgentTerminalAction,
    search_path: &OsStr,
) -> Result<String, String> {
    let command = match action {
        LocalAgentTerminalAction::Login => agent.login_command,
        LocalAgentTerminalAction::Install => agent.install_command,
    }
    .ok_or_else(|| format!("{} 没有对应的终端命令", agent.name))?;
    let (executable, arguments) = command.split_once(' ').unwrap_or((command, ""));
    let path = find_executable(executable, search_path)
        .ok_or_else(|| format!("找不到程序: {executable}"))?;
    let path = path.to_str().ok_or("程序路径不是有效的 UTF-8")?;
    Ok(format!("'{}' {arguments}", path.replace('\'', "'\\''")))
}

fn open_terminal(command: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                "tell application \"Terminal\"",
                "-e",
                "activate",
                "-e",
                "do script (item 1 of argv)",
                "-e",
                "end tell",
                "-e",
                "end run",
                "--",
                command,
            ])
            .output()
            .map_err(|e| format!("无法打开终端: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "无法打开终端: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = command;
        Err("请复制命令到终端运行".into())
    }
}

fn catalog(search_path: &OsStr) -> Vec<LocalAgentInfo> {
    LOCAL_AGENT_CATALOG
        .iter()
        .map(|agent| LocalAgentInfo {
            id: agent.id.into(),
            name: agent.name.into(),
            resolved_path: find_executable(agent.command, search_path)
                .map(|path| path.to_string_lossy().into_owned()),
            host_found: find_executable(agent.host_command, search_path).is_some(),
            login_command: agent.login_command.map(String::from),
            install_command: agent.install_command.map(String::from),
            homepage: agent.homepage.into(),
            tested: agent.tested,
        })
        .collect()
}

#[tauri::command]
pub async fn local_agent_catalog(
    state: State<'_, LocalAgentManager>,
) -> Result<Vec<LocalAgentInfo>, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(catalog(&manager.search_path(&account_home_dir()?)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_agent_start(
    state: State<'_, LocalAgentManager>,
    research_root: State<'_, ResearchRoot>,
    agent_id: String,
    path_override: Option<String>,
    on_event: Channel<LocalAgentEvent>,
) -> Result<u32, String> {
    let cwd = research_root.canonical_path()?;
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.start(
            &agent_id,
            path_override.as_deref().map(Path::new),
            &cwd,
            move |event| on_event.send(event).map_err(|e| e.to_string()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_agent_write(
    state: State<'_, LocalAgentManager>,
    handle: u32,
    line: String,
) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(handle, &line))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_agent_stop(
    state: State<'_, LocalAgentManager>,
    handle: u32,
) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop(handle))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_agent_open_terminal(
    state: State<'_, LocalAgentManager>,
    agent_id: String,
    action: LocalAgentTerminalAction,
) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let agent = agent_definition(&agent_id)?;
        if !cfg!(target_os = "macos") {
            return Err("请复制命令到终端运行".into());
        }
        open_terminal(&terminal_command(
            agent,
            action,
            &manager.search_path(&account_home_dir()?)?,
        )?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::sync::atomic::AtomicU32;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!(
                "local-agent-tests-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }

        fn executable(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn manager_with_path(path: &OsStr) -> LocalAgentManager {
        let manager = LocalAgentManager::default();
        manager.login_shell_path.set(path.to_owned()).unwrap();
        manager
    }

    #[cfg(unix)]
    struct TestProcess {
        process: Arc<LocalAgentProcess>,
        events: mpsc::Receiver<LocalAgentEvent>,
    }

    #[cfg(unix)]
    impl TestProcess {
        fn spawn(command: &str, args: &[&str], cwd: &Path, path: &OsStr) -> Self {
            let (sender, events) = mpsc::channel();
            let environment = process_environment(
                std::env::vars_os(),
                &account_home_dir().unwrap(),
                path,
                None,
            );
            let process =
                spawn_process(Path::new(command), args, cwd, &environment, move |event| {
                    sender.send(event).map_err(|e| e.to_string())
                })
                .unwrap();
            Self { process, events }
        }

        fn next(&self) -> LocalAgentEvent {
            self.events.recv_timeout(Duration::from_secs(5)).unwrap()
        }

        fn stdout(&self) -> String {
            match self.next() {
                LocalAgentEvent::Stdout { line } => line,
                event => panic!("expected stdout, got {event:?}"),
            }
        }

        fn exited(&self) -> (Option<i32>, Vec<String>) {
            let mut stderr = Vec::new();
            loop {
                match self.next() {
                    LocalAgentEvent::Stderr { line } => stderr.push(line),
                    LocalAgentEvent::Exited { code } => {
                        assert!(self.events.recv_timeout(Duration::from_millis(50)).is_err());
                        return (code, stderr);
                    }
                    event => panic!("unexpected event: {event:?}"),
                }
            }
        }
    }

    #[cfg(unix)]
    impl Drop for TestProcess {
        fn drop(&mut self) {
            if let Err(error) = stop_process_group(&self.process) {
                eprintln!("test process cleanup failed: {error}");
            }
        }
    }

    #[test]
    fn catalog_matches_fixed_commands_and_tested_flags() {
        let expected: [(&str, &str, &[&str], &str, Option<&str>, Option<&str>, bool); 7] = [
            ("codex", "codex-acp", &[], "codex", Some("codex login"), Some("npm i -g @agentclientprotocol/codex-acp@2.5.0 --omit=optional --prefix \"$HOME/.local\""), true),
            ("claude", "claude-agent-acp", &[], "claude", Some("claude auth login"), Some("npm i -g @agentclientprotocol/claude-agent-acp@0.100.0 --omit=optional --prefix \"$HOME/.local\""), true),
            ("gemini", "gemini", &["--acp"], "gemini", None, None, false),
            ("kimi", "kimi", &["acp"], "kimi", None, None, false),
            ("cursor", "cursor-agent", &["acp"], "cursor-agent", Some("cursor-agent login"), None, false),
            ("opencode", "opencode", &["acp"], "opencode", None, None, false),
            ("qodercn", "qodercn", &["--acp"], "qodercn", Some("qodercn login"), None, false),
        ];
        assert_eq!(LOCAL_AGENT_CATALOG.len(), expected.len());
        let mut ids = HashSet::new();
        for (agent, (id, command, args, host, login, install, tested)) in
            LOCAL_AGENT_CATALOG.iter().zip(expected)
        {
            assert!(ids.insert(agent.id));
            assert_eq!(
                (
                    agent.id,
                    agent.command,
                    agent.args,
                    agent.host_command,
                    agent.login_command,
                    agent.install_command,
                    agent.tested
                ),
                (id, command, args, host, login, install, tested)
            );
            assert!(!agent.name.is_empty());
            assert!(agent.homepage.starts_with("https://"));
            assert_eq!(
                agent.host_env,
                match agent.id {
                    "codex" => Some("CODEX_PATH"),
                    "claude" => Some("CLAUDE_CODE_EXECUTABLE"),
                    _ => None,
                }
            );
        }
    }

    #[test]
    fn ipc_serialization_matches_frontend_types() {
        let info = catalog(OsStr::new(""));
        assert_eq!(
            serde_json::to_value(&info[0]).unwrap(),
            serde_json::json!({
                "id": "codex", "name": "Codex", "resolvedPath": null, "hostFound": false,
                "loginCommand": "codex login",
                "installCommand": "npm i -g @agentclientprotocol/codex-acp@2.5.0 --omit=optional --prefix \"$HOME/.local\"",
                "homepage": "https://github.com/openai/codex", "tested": true
            })
        );
        for (event, expected) in [
            (
                LocalAgentEvent::Stdout { line: "{}".into() },
                serde_json::json!({"kind":"stdout","line":"{}"}),
            ),
            (
                LocalAgentEvent::Stderr {
                    line: "error".into(),
                },
                serde_json::json!({"kind":"stderr","line":"error"}),
            ),
            (
                LocalAgentEvent::Exited { code: Some(1) },
                serde_json::json!({"kind":"exited","code":1}),
            ),
            (
                LocalAgentEvent::Exited { code: None },
                serde_json::json!({"kind":"exited","code":null}),
            ),
        ] {
            assert_eq!(serde_json::to_value(event).unwrap(), expected);
        }
    }

    #[test]
    #[cfg(unix)]
    fn executable_discovery_respects_path_order() {
        let dir = TestDirectory::new();
        let files: Vec<_> = ["login", "current", "common"]
            .iter()
            .map(|name| dir.executable(&format!("{name}/codex-acp"), ""))
            .collect();
        let dirs: Vec<_> = files
            .iter()
            .map(|file| file.parent().unwrap().to_path_buf())
            .collect();
        let path = merge_search_paths(
            dirs[0].as_os_str(),
            dirs[1].as_os_str(),
            &[dirs[2].clone(), dirs[0].clone()],
        )
        .unwrap();
        assert_eq!(std::env::split_paths(&path).collect::<Vec<_>>(), dirs);
        for file in files {
            assert_eq!(find_executable("codex-acp", &path), Some(file.clone()));
            fs::remove_file(file).unwrap();
        }
        assert_eq!(find_executable("codex-acp", &path), None);
        assert!(
            merge_search_paths(OsStr::new(""), OsStr::new(""), &[PathBuf::from("bad:path")])
                .is_err()
        );
    }

    #[test]
    fn discovery_includes_home_and_nvm_directories() {
        let dir = TestDirectory::new();
        for version in ["v20.0.0", "v22.0.0"] {
            fs::create_dir_all(dir.0.join(format!(".nvm/versions/node/{version}/bin"))).unwrap();
        }
        fs::write(dir.0.join(".nvm/versions/node/not-a-version"), "").unwrap();
        let paths = common_bin_directories(&dir.0);
        assert_eq!(
            paths,
            vec![
                dir.0.join(".local/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
                dir.0.join(".npm-global/bin"),
                dir.0.join(".volta/bin"),
                dir.0.join(".bun/bin"),
                dir.0.join(".nvm/versions/node/v20.0.0/bin"),
                dir.0.join(".nvm/versions/node/v22.0.0/bin")
            ]
        );
    }

    #[test]
    #[cfg(unix)]
    fn login_shell_path_is_cached_including_errors() {
        let dir = TestDirectory::new();
        let shell = dir.executable(
            "shell",
            "#!/bin/sh\n[ \"$1\" = '-ilc' ] || exit 9\nprintf '__RWB_PATH_BEGIN__/first/bin__RWB_PATH_END__'\n",
        );
        let manager = LocalAgentManager::default();
        assert_eq!(
            manager.cached_login_shell_path(&shell, &dir.0),
            OsString::from("/first/bin")
        );
        fs::write(
            &shell,
            "#!/bin/sh\nprintf '__RWB_PATH_BEGIN__/changed/bin__RWB_PATH_END__'\n",
        )
        .unwrap();
        assert_eq!(
            manager.clone().cached_login_shell_path(&shell, &dir.0),
            OsString::from("/first/bin")
        );
        let failed_manager = LocalAgentManager::default();
        let missing = dir.0.join("missing");
        assert!(failed_manager
            .cached_login_shell_path(&missing, &dir.0)
            .is_empty());
        dir.executable(
            "missing",
            "#!/bin/sh\nprintf '__RWB_PATH_BEGIN__/now/exists__RWB_PATH_END__'\n",
        );
        assert!(failed_manager
            .clone()
            .cached_login_shell_path(&missing, &dir.0)
            .is_empty());
        assert!(!failed_manager.search_path(&dir.0).unwrap().is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn login_shell_path_ignores_noise_and_exit_status_and_sets_home() {
        let dir = TestDirectory::new();
        for status in [0, 7] {
            let shell = dir.executable(
                "shell",
                &format!("#!/bin/sh\nprintf 'startup noise\\n'\nPATH=\"$HOME/bin:/shell/bin\"\neval \"$2\"\nprintf '\\nshutdown noise\\n'\nexit {status}\n"),
            );
            assert_eq!(
                login_shell_path(&shell, &dir.0).unwrap(),
                std::env::join_paths([dir.0.join("bin"), PathBuf::from("/shell/bin")]).unwrap()
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn login_shell_missing_markers_falls_back_and_is_cached() {
        let dir = TestDirectory::new();
        for output in [
            "noise only",
            "__RWB_PATH_BEGIN__/incomplete",
            "__RWB_PATH_END__",
        ] {
            let shell = dir.executable("shell", &format!("#!/bin/sh\nprintf '{output}'\n"));
            assert!(login_shell_path(&shell, &dir.0)
                .unwrap_err()
                .contains("标记"));
            let manager = LocalAgentManager::default();
            assert!(manager.cached_login_shell_path(&shell, &dir.0).is_empty());
            fs::remove_file(&shell).unwrap();
            let fallback = manager.search_path(&dir.0).unwrap();
            assert_eq!(
                fallback,
                merge_search_paths(
                    OsStr::new(""),
                    &std::env::var_os("PATH").unwrap_or_default(),
                    &common_bin_directories(&dir.0),
                )
                .unwrap()
            );
            assert!(std::env::split_paths(&fallback).any(|path| path == dir.0.join(".local/bin")));
        }
    }

    #[test]
    #[cfg(unix)]
    fn login_shell_timeout_is_bounded() {
        let dir = TestDirectory::new();
        let shell = dir.executable("shell", "#!/bin/sh\nexec /bin/sleep 30\n");
        let start = Instant::now();
        let manager = LocalAgentManager::default();
        assert!(manager.cached_login_shell_path(&shell, &dir.0).is_empty());
        assert!(start.elapsed() >= LOGIN_SHELL_TIMEOUT);
        assert!(start.elapsed() < LOGIN_SHELL_TIMEOUT + Duration::from_secs(2));
        let start = Instant::now();
        assert!(manager
            .clone()
            .cached_login_shell_path(&shell, &dir.0)
            .is_empty());
        assert!(!manager.search_path(&dir.0).unwrap().is_empty());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    #[cfg(unix)]
    fn discovery_distinguishes_host_from_adapter() {
        let dir = TestDirectory::new();
        let host = dir.executable("codex", "");
        let host_only = catalog(dir.0.as_os_str());
        assert!(host_only[0].host_found);
        assert!(host_only[0].resolved_path.is_none());
        let adapter = dir.executable("codex-acp", "");
        let both = catalog(dir.0.as_os_str());
        assert!(both[0].host_found);
        assert_eq!(both[0].resolved_path.as_deref(), adapter.to_str());
        fs::remove_file(host).unwrap();
        assert!(!catalog(dir.0.as_os_str())[0].host_found);
    }

    #[test]
    fn path_override_accepts_matching_executables() {
        let dir = TestDirectory::new();
        for name in ["codex-acp", "codex-acp.exe", "codex-acp.cmd"] {
            let file = dir.executable(name, "");
            assert_eq!(validate_path_override(&file, "codex-acp").unwrap(), file);
        }
        #[cfg(unix)]
        {
            let target = dir.executable("actual.js", "");
            let link = dir.0.join("linked/codex-acp");
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(target, &link).unwrap();
            assert_eq!(validate_path_override(&link, "codex-acp").unwrap(), link);
        }
    }

    #[test]
    fn path_override_rejects_invalid_files_and_start_revalidates() {
        let dir = TestDirectory::new();
        let manager = manager_with_path(dir.0.as_os_str());
        let mut paths = vec![
            dir.executable("other", ""),
            dir.executable("codex-acp.bat", ""),
            dir.0.join("missing/codex-acp"),
        ];
        let directory = dir.0.join("folder/codex-acp");
        fs::create_dir_all(&directory).unwrap();
        paths.push(directory);
        #[cfg(unix)]
        {
            let file = dir.0.join("codex-acp");
            fs::write(&file, "").unwrap();
            paths.push(file);
        }
        for path in paths {
            assert!(
                validate_path_override(&path, "codex-acp").is_err(),
                "{path:?}"
            );
            assert!(
                manager
                    .start("codex", Some(&path), &dir.0, |_| Ok(()))
                    .is_err(),
                "{path:?}"
            );
        }
    }

    #[test]
    fn commands_reject_unknown_agent_ids() {
        for id in ["", "sh", "codex; echo injected", "../codex"] {
            assert!(agent_definition(id).is_err());
            assert!(LocalAgentManager::default()
                .start(id, None, Path::new("/"), |_| Ok(()))
                .is_err());
        }
    }

    #[test]
    fn start_requires_registered_research_root() {
        assert_eq!(
            ResearchRoot::default().canonical_path().unwrap_err(),
            "请先设置研究文件夹"
        );
    }

    #[test]
    fn environment_replaces_home_and_path_preserving_other_values() {
        let inherited = [
            (OsString::from("HOME"), OsString::from("/app-home")),
            (OsString::from("PATH"), OsString::from("/old/bin")),
            (OsString::from("KEEP_ME"), OsString::from("unchanged")),
        ];
        let environment: HashMap<_, _> = process_environment(
            inherited,
            Path::new("/account-home"),
            OsStr::new("/merged/bin"),
            None,
        )
        .into_iter()
        .collect();
        assert_eq!(environment.len(), 3);
        assert_eq!(environment[OsStr::new("HOME")], "/account-home");
        assert_eq!(environment[OsStr::new("PATH")], "/merged/bin");
        assert_eq!(environment[OsStr::new("KEEP_ME")], "unchanged");
    }

    #[test]
    fn environment_sets_host_only_when_resolved() {
        let dir = TestDirectory::new();
        for (id, variable) in [
            ("codex", "CODEX_PATH"),
            ("claude", "CLAUDE_CODE_EXECUTABLE"),
        ] {
            let agent = agent_definition(id).unwrap();
            let host = dir.executable(&format!("{}.exe", agent.host_command), "");
            let environment: HashMap<_, _> = process_environment(
                [(OsString::from(variable), OsString::from("/stale/host"))],
                &dir.0,
                dir.0.as_os_str(),
                agent.host_env.zip(Some(host.as_path())),
            )
            .into_iter()
            .collect();
            assert!(host.is_absolute());
            assert_eq!(environment[OsStr::new(variable)], host.as_os_str());
            let environment =
                process_environment([], &dir.0, dir.0.as_os_str(), agent.host_env.zip(None));
            assert!(!environment.iter().any(|(name, _)| name == variable));
        }
    }

    #[test]
    #[cfg(unix)]
    fn start_passes_account_home_and_resolved_host() {
        let dir = TestDirectory::new();
        for (id, variable) in [
            ("codex", "CODEX_PATH"),
            ("claude", "CLAUDE_CODE_EXECUTABLE"),
        ] {
            let agent = agent_definition(id).unwrap();
            let host = dir.executable(agent.host_command, "#!/bin/sh\nexit 0\n");
            dir.executable(
                agent.command,
                &format!("#!/bin/sh\nprintf '%s\\n' \"$HOME\" \"${variable}\"\n"),
            );
            let manager = manager_with_path(dir.0.as_os_str());
            let (sender, events) = mpsc::channel();
            manager
                .start(id, None, &dir.0, move |event| {
                    sender.send(event).map_err(|e| e.to_string())
                })
                .unwrap();
            for expected in [account_home_dir().unwrap(), host] {
                let event = events.recv_timeout(Duration::from_secs(5)).unwrap();
                assert!(
                    matches!(event, LocalAgentEvent::Stdout { line } if line == expected.to_str().unwrap())
                );
            }
            assert!(matches!(
                events.recv_timeout(Duration::from_secs(5)).unwrap(),
                LocalAgentEvent::Exited { code: Some(0) }
            ));
        }
    }

    #[test]
    #[cfg(unix)]
    fn start_replaces_home_and_path_and_sets_working_directory() {
        let dir = TestDirectory::new();
        let script = dir.executable(
            "environment.sh",
            "printf '%s\\n' \"$HOME\" \"$PATH\"\n/bin/pwd -P\n",
        );
        let child = TestProcess::spawn(
            "/bin/sh",
            &[script.to_str().unwrap()],
            &dir.0,
            OsStr::new("/merged/bin"),
        );
        assert_eq!(
            child.stdout(),
            account_home_dir().unwrap().to_str().unwrap()
        );
        assert_eq!(child.stdout(), "/merged/bin");
        assert_eq!(child.stdout(), dir.0.to_str().unwrap());
        assert_eq!(child.exited(), (Some(0), vec![]));
    }

    #[test]
    fn write_validates_single_line_json_objects() {
        for valid in [
            "{}",
            " {\"message\":\"hello\\nworld\"} ",
            "{\"items\":[1,null]}",
        ] {
            assert!(validate_json_line(valid).is_ok(), "{valid:?}");
        }
        for invalid in [
            "", " ", "{", "{}\n", "{}\r", "{\n}", "{} {}", "[]", "null", "true", "1", "\"text\"",
        ] {
            assert!(validate_json_line(invalid).is_err(), "{invalid:?}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn commands_handle_unknown_and_exited_processes() {
        let dir = TestDirectory::new();
        let adapter = dir.executable("codex-acp", "#!/bin/sh\nexit 0\n");
        let manager = manager_with_path(dir.0.as_os_str());
        assert!(manager.write(999, "{}").is_err());
        manager.stop(999).unwrap();
        let (sender, receiver) = mpsc::channel();
        let handle = manager
            .start("codex", Some(&adapter), &dir.0, move |event| {
                sender.send(event).map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
            LocalAgentEvent::Exited { code: Some(0) }
        ));
        assert!(manager.write(handle, "{}").is_err());
        manager.stop(handle).unwrap();
        manager.stop(handle).unwrap();
        assert!(manager.registry.lock().unwrap().processes.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn cat_round_trip_preserves_json_lines() {
        let dir = TestDirectory::new();
        let child = TestProcess::spawn("/bin/cat", &[], &dir.0, OsStr::new("/bin"));
        for line in ["{}", "{\"id\":1}", "{\"text\":\"line\\nbreak\"}"] {
            write_process_line(&child.process, line).unwrap();
            assert_eq!(child.stdout(), line);
        }
        assert!(write_process_line(&child.process, "{}\n{}").is_err());
        child.process.stdin.lock().unwrap().take();
        assert_eq!(child.exited(), (Some(0), vec![]));
        assert!(write_process_line(&child.process, "{}").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn output_delivery_failure_stops_the_process() {
        let dir = TestDirectory::new();
        let (sender, events) = mpsc::channel();
        let environment = process_environment(
            std::env::vars_os(),
            &account_home_dir().unwrap(),
            OsStr::new("/bin"),
            None,
        );
        let process = spawn_process(
            Path::new("/bin/cat"),
            &[],
            &dir.0,
            &environment,
            move |event| {
                if matches!(event, LocalAgentEvent::Stdout { .. }) {
                    return Err("接收端已关闭".into());
                }
                sender.send(event).map_err(|e| e.to_string())
            },
        )
        .unwrap();
        let child = TestProcess { process, events };
        write_process_line(&child.process, "{}").unwrap();
        assert_eq!(child.exited(), (None, vec!["接收端已关闭".to_string()]));
        assert!(!signal_process_group(child.process.process_group, 0).unwrap());
    }

    #[test]
    fn stderr_tail_keeps_last_two_hundred_lines() {
        let input = (0..350).map(|i| format!("line {i}\n")).collect::<String>();
        let tail = Mutex::new(VecDeque::new());
        read_process_lines(input.as_bytes(), ProcessOutput::Stderr, &|event| {
            let LocalAgentEvent::Stderr { line } = event else {
                panic!("wrong output stream")
            };
            push_stderr_line(&mut tail.lock().unwrap(), line);
            Ok(())
        })
        .unwrap();
        let tail = tail.into_inner().unwrap();
        assert_eq!(tail.len(), STDERR_TAIL_LINES);
        assert_eq!(tail.front().unwrap(), "line 150");
        assert_eq!(tail.back().unwrap(), "line 349");
    }

    #[test]
    #[cfg(unix)]
    fn cat_stderr_is_separate_and_exit_code_is_reported_once() {
        let dir = TestDirectory::new();
        let paths: Vec<_> = (0..350).map(|i| format!("missing-{i}")).collect();
        let args: Vec<_> = paths.iter().map(String::as_str).collect();
        let child = TestProcess::spawn("/bin/cat", &args, &dir.0, OsStr::new("/bin"));
        let (code, stderr) = child.exited();
        assert_eq!(code, Some(1));
        assert!(!stderr.is_empty());
        assert!(stderr.last().unwrap().contains("missing-349"));
        assert!(stderr.iter().all(|line| line.contains("missing-")));
    }

    #[test]
    #[cfg(unix)]
    fn stop_terminates_cat_process_group() {
        let dir = TestDirectory::new();
        let child = TestProcess::spawn("/bin/cat", &[], &dir.0, OsStr::new("/bin"));
        write_process_line(&child.process, "{}").unwrap();
        assert_eq!(child.stdout(), "{}");
        let start = Instant::now();
        stop_process_group(&child.process).unwrap();
        assert!(start.elapsed() < STOP_TIMEOUT);
        assert_eq!(child.exited(), (None, vec![]));
        assert!(!signal_process_group(child.process.process_group, 0).unwrap());
        stop_process_group(&child.process).unwrap();
    }

    #[cfg(unix)]
    fn assert_process_terminated(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let output = Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            let status = String::from_utf8_lossy(&output.stdout);
            if status.trim().is_empty() || status.trim().starts_with('Z') {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "process {pid} remains alive: {status}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    #[cfg(unix)]
    fn stop_terminates_descendants_and_escalates_to_sigkill() {
        for ignore_term in [false, true] {
            let dir = TestDirectory::new();
            let trap = if ignore_term {
                "trap '' TERM"
            } else {
                "trap 'wait \"$child\"; exit 0' TERM"
            };
            let script = dir.executable("group.sh", &format!("{trap}\nexec 3<&0\n/bin/cat <&3 &\nchild=$!\nprintf '%s\\n' \"$child\"\nwait \"$child\"\n"));
            let child = TestProcess::spawn(
                "/bin/sh",
                &[script.to_str().unwrap()],
                &dir.0,
                OsStr::new("/bin"),
            );
            let descendant: u32 = child.stdout().parse().unwrap();
            assert_eq!(
                unsafe { libc::getpgid(descendant as i32) },
                child.process.process_group as i32
            );
            write_process_line(&child.process, "{\"ready\":true}").unwrap();
            assert_eq!(child.stdout(), "{\"ready\":true}");
            let start = Instant::now();
            stop_process_group(&child.process).unwrap();
            let elapsed = start.elapsed();
            let (code, _) = child.exited();
            if ignore_term {
                assert!(elapsed >= STOP_TIMEOUT);
                assert!(elapsed < STOP_TIMEOUT + Duration::from_secs(2));
            } else {
                assert!(elapsed < STOP_TIMEOUT);
            }
            assert_eq!(code, if ignore_term { None } else { Some(0) });
            assert_process_terminated(descendant);
            assert_process_terminated(child.process.process_group);
        }
    }

    #[test]
    #[cfg(unix)]
    fn natural_exit_cleans_up_remaining_descendants() {
        let dir = TestDirectory::new();
        let script = dir.executable(
            "orphan.sh",
            "exec 3<&0\n/bin/cat <&3 >/dev/null &\nprintf '%s\\n' \"$!\"\nexit 7\n",
        );
        let child = TestProcess::spawn(
            "/bin/sh",
            &[script.to_str().unwrap()],
            &dir.0,
            OsStr::new("/bin"),
        );
        let descendant: u32 = child.stdout().parse().unwrap();
        assert_eq!(child.exited().0, Some(7));
        assert_process_terminated(descendant);
    }

    #[test]
    #[cfg(unix)]
    fn application_exit_stops_all_agents_even_after_an_error() {
        let dir = TestDirectory::new();
        let manager = manager_with_path(dir.0.as_os_str());
        let children: Vec<_> = (0..2)
            .map(|_| TestProcess::spawn("/bin/cat", &[], &dir.0, OsStr::new("/bin")))
            .collect();
        {
            let mut registry = manager.registry.lock().unwrap();
            registry.processes.insert(
                0,
                Arc::new(LocalAgentProcess {
                    process_group: 0,
                    stdin: Mutex::new(None),
                    exited: AtomicBool::new(false),
                    stopped: Mutex::new(false),
                }),
            );
            for (i, child) in children.iter().enumerate() {
                registry
                    .processes
                    .insert(i as u32 + 1, Arc::clone(&child.process));
            }
        }
        assert!(manager.stop_all().unwrap_err().contains("进程组号"));
        for child in &children {
            assert_eq!(child.exited(), (None, vec![]));
        }
        let adapter = dir.executable("codex-acp", "#!/bin/sh\nexit 0\n");
        assert!(manager
            .start("codex", Some(&adapter), &dir.0, |_| Ok(()))
            .unwrap_err()
            .contains("正在退出"));
        manager.registry.lock().unwrap().processes.remove(&0);
        manager.stop_all().unwrap();
    }

    #[test]
    fn terminal_action_is_allowlisted() {
        assert!(serde_json::from_str::<LocalAgentTerminalAction>("\"login\"").is_ok());
        assert!(serde_json::from_str::<LocalAgentTerminalAction>("\"install\"").is_ok());
        for action in ["\"shell\"", "\"login; sh\"", "null"] {
            assert!(serde_json::from_str::<LocalAgentTerminalAction>(action).is_err());
        }
        for agent in LOCAL_AGENT_CATALOG {
            for action in [
                LocalAgentTerminalAction::Login,
                LocalAgentTerminalAction::Install,
            ] {
                assert!(terminal_command(agent, action, OsStr::new("")).is_err());
            }
        }
    }

    #[test]
    #[cfg(unix)]
    fn terminal_command_uses_escaped_absolute_executable() {
        let dir = TestDirectory::new();
        let path = dir
            .0
            .join("spaces 'quotes' \"double\" $dollar `ticks` \\slash");
        fs::create_dir_all(&path).unwrap();
        for executable in ["codex", "claude", "npm", "cursor-agent", "qodercn"] {
            dir.executable(
                &format!(
                    "{}/{executable}",
                    path.file_name().unwrap().to_str().unwrap()
                ),
                "",
            );
        }
        for agent in LOCAL_AGENT_CATALOG {
            for (action, fixed) in [
                (LocalAgentTerminalAction::Login, agent.login_command),
                (LocalAgentTerminalAction::Install, agent.install_command),
            ] {
                let result = terminal_command(agent, action, path.as_os_str());
                if let Some(fixed) = fixed {
                    let (name, args) = fixed.split_once(' ').unwrap();
                    let absolute = path.join(name);
                    let output = Command::new("/bin/sh")
                        .args([
                            "-c",
                            &format!("set -- {}; printf '%s\\n' \"$@\"", result.unwrap()),
                        ])
                        .output()
                        .unwrap();
                    assert!(output.status.success());
                    assert!(output.stderr.is_empty());
                    let output = String::from_utf8(output.stdout).unwrap();
                    let parsed: Vec<_> = output.lines().collect();
                    assert_eq!(parsed[0], absolute.to_str().unwrap());
                    if matches!(action, LocalAgentTerminalAction::Install) {
                        assert_eq!(parsed.len(), 7);
                        assert_eq!(
                            &parsed[1..6],
                            args.split_whitespace().take(5).collect::<Vec<_>>()
                        );
                        assert_eq!(
                            parsed[6],
                            format!("{}/.local", std::env::var("HOME").unwrap())
                        );
                    } else {
                        assert_eq!(&parsed[1..], args.split_whitespace().collect::<Vec<_>>());
                    }
                } else {
                    assert!(result.is_err());
                }
            }
        }
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn terminal_is_unsupported_outside_macos() {
        assert_eq!(
            open_terminal("never execute this").unwrap_err(),
            "请复制命令到终端运行"
        );
    }
}
