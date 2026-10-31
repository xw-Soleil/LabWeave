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
    let display = strip_windows_verbatim_prefix(&canonical);

    let scope = app
        .try_fs_scope()
        .ok_or_else(|| "文件访问插件没有加载".to_string())?;
    // The scope check may see either the canonical form (\\?\C:\..., /private/var/...) or the
    // form the user picked, so allow all of them; they name the same directory.
    let mut allowed: Vec<PathBuf> = vec![canonical.clone()];
    for candidate in [PathBuf::from(&display), PathBuf::from(&path)] {
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

#[cfg(test)]
mod tests {
    use super::{resolve_research_root, strip_windows_verbatim_prefix};
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
}
