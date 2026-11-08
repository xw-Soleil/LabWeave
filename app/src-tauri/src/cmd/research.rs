use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::FsExt;

/// The research folder chosen by the user, canonicalized. Re-set by the frontend on every startup.
#[derive(Default)]
pub struct ResearchRoot(Mutex<Option<PathBuf>>);

#[tauri::command]
pub fn set_research_root<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ResearchRoot>,
    path: String,
) -> Result<String, String> {
    let canonical = resolve_research_root(&path)?;
    let stripped = strip_windows_verbatim_prefix(&canonical);
    let display = display_root(&canonical, &path);

    let scope = app
        .try_fs_scope()
        .ok_or_else(|| "文件访问插件没有加载".to_string())?;
    // The scope check may see either the canonical form (\\?\C:\..., /private/var/...) or the
    // form the user picked, so allow all of them; they name the same directory.
    let mut allowed: Vec<PathBuf> = vec![canonical.clone()];
    for candidate in [
        PathBuf::from(&stripped),
        PathBuf::from(&display),
        PathBuf::from(&path),
    ] {
        if candidate.is_absolute() && !allowed.contains(&candidate) {
            allowed.push(candidate);
        }
    }
    for dir in &allowed {
        scope
            .allow_directory(dir, true)
            .map_err(|e| format!("无法允许访问研究文件夹 {}: {e}", dir.display()))?;
    }

    let mut guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(canonical);
    Ok(display)
}

fn resolve_research_root(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("研究文件夹路径为空".to_string());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("无法打开研究文件夹 {path}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("这不是一个文件夹: {}", canonical.display()));
    }
    Ok(canonical)
}

fn strip_windows_verbatim_prefix(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.into_owned()
}

/// The root the frontend stores and builds every path from. canonicalize turns a mapped network
/// drive (Z:\papers) into \\?\UNC\server\share\papers; keep the drive letter the user picked, so
/// files dropped from Explorer as Z:\... still count as inside the folder.
fn display_root(canonical: &Path, picked: &str) -> String {
    let stripped = strip_windows_verbatim_prefix(canonical);
    if stripped.starts_with(r"\\") && is_drive_letter_path(picked) {
        return normalize_drive_path(picked);
    }
    stripped
}

fn is_drive_letter_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// Z:/a/./b\..\c\ -> Z:\a\c
fn normalize_drive_path(path: &str) -> String {
    let (drive, rest) = path.split_at(2);
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split(|c| c == '\\' || c == '/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!(r"{}\{}", drive.to_ascii_uppercase(), parts.join(r"\"))
}

/// 在访达 / 资源管理器里复制的文件。剪贴板里没有文件时返回空列表。
/// 只读出路径，不碰文件本身：之后和拖进来的文件走同一套流程。
#[tauri::command]
pub fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    match clipboard.get().file_list() {
        Ok(paths) => Ok(paths
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()),
        Err(arboard::Error::ContentNotAvailable) => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

/// 外部 AI（Claude Code、Codex 等）接入 MCP 时要运行的命令：node、命令行入口、程序用的 HOME。
/// 设置页据此拼出能直接复制的配置命令。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAiMcpLaunch {
    node: Option<String>,
    /// 安装包还没带命令行，这时为空，界面上说明以后再接
    script: Option<String>,
    app_home: Option<String>,
}

#[tauri::command]
pub fn external_ai_mcp_launch() -> ExternalAiMcpLaunch {
    ExternalAiMcpLaunch {
        node: find_on_path("node"),
        script: development_cli_script(),
        app_home: std::env::var("HOME").ok().filter(|home| !home.is_empty()),
    }
}

#[cfg(debug_assertions)]
fn development_cli_script() -> Option<String> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/project-graph-cli/src/cli.mjs")
        .canonicalize()
        .ok()
        .map(|script| script.to_string_lossy().into_owned())
}

#[cfg(not(debug_assertions))]
fn development_cli_script() -> Option<String> {
    None
}

/// GUI 程序（Claude Desktop 等）不一定有终端里的 PATH，所以配置里写 node 的绝对路径
fn find_on_path(name: &str) -> Option<String> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_owned()]
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        development_cli_script, display_root, external_ai_mcp_launch, resolve_research_root,
        strip_windows_verbatim_prefix,
    };
    use std::path::Path;

    #[test]
    fn resolves_only_existing_directories() {
        let base = std::env::temp_dir().join(format!(
            "research-workbench-root-tests-{}",
            std::process::id()
        ));
        let folder = base.join("论文 papers");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("note.md");
        std::fs::write(&file, "x").unwrap();

        let resolved = resolve_research_root(&folder.join("..").join("论文 papers").to_string_lossy())
            .unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&folder).unwrap());
        assert!(resolve_research_root("").is_err());
        assert!(resolve_research_root("   ").is_err());
        assert!(resolve_research_root(&file.to_string_lossy()).is_err());
        assert!(resolve_research_root(&base.join("missing").to_string_lossy()).is_err());

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn strips_verbatim_prefixes() {
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\C:\Research")),
            r"C:\Research"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\UNC\server\share\papers")),
            r"\\server\share\papers"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new("/Users/alice/Research")),
            "/Users/alice/Research"
        );
    }

    #[test]
    fn keeps_the_mapped_drive_the_user_picked() {
        let unc = Path::new(r"\\?\UNC\nas\share\papers");
        assert_eq!(display_root(unc, r"z:\papers\"), r"Z:\papers");
        assert_eq!(display_root(unc, r"Z:/lab/./x/../papers"), r"Z:\lab\papers");
        assert_eq!(display_root(unc, r"\\nas\share\papers"), r"\\nas\share\papers");
        assert_eq!(
            display_root(Path::new(r"\\?\C:\Research"), r"c:\Research"),
            r"C:\Research"
        );
        assert_eq!(
            display_root(Path::new("/Users/alice/Research"), "/Users/alice/Research/"),
            "/Users/alice/Research"
        );
    }

    #[test]
    fn development_build_points_external_ai_at_the_repository_cli() {
        let script = development_cli_script().expect("the dev build knows the repository");
        assert!(script.ends_with("cli.mjs") && Path::new(&script).is_file());
        assert_eq!(external_ai_mcp_launch().script, Some(script));
    }
}
