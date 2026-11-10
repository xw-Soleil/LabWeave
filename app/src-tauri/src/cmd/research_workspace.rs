use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, Runtime};

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

fn workspace_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("research-workspaces.json"))
}

fn read_workspace(path: &Path) -> Result<Option<Value>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "workspaceCorrupt".to_string())?;
    value
        .as_object_mut()
        .and_then(|object| object.remove("data"))
        .filter(|data| data.is_object())
        .map(Some)
        .ok_or_else(|| "workspaceCorrupt".to_string())
}

fn write_workspace(path: &Path, expected: Option<Value>, data: Value) -> Result<(), String> {
    let parent = path.parent().ok_or("workspaceCorrupt")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    // The lock file stays at a stable path while the data file is atomically replaced.
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))
        .map_err(|error| error.to_string())?;
    lock.try_lock().map_err(|_| "workspaceBusy".to_string())?;
    let result = (|| {
        if read_workspace(path)? != expected {
            return Err("workspaceChanged".to_string());
        }
        if !data.is_object() {
            return Err("workspaceCorrupt".to_string());
        }
        let temporary = parent.join(format!(
            ".research-workspaces.{}.{}.tmp",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        let result = (|| {
            file.write_all(&serde_json::to_vec(&json!({ "data": data }))?)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, path)
        })();
        if let Err(error) = result {
            return match fs::remove_file(&temporary) {
                Ok(()) => Err(error.to_string()),
                Err(cleanup) => Err(format!("{error}; {cleanup}")),
            };
        }
        Ok(())
    })();
    let unlocked = lock.unlock().map_err(|error| error.to_string());
    result.and(unlocked)
}

#[tauri::command]
pub async fn load_research_workspace<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<Value>, String> {
    let path = workspace_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_workspace(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_research_workspace<R: Runtime>(
    app: AppHandle<R>,
    expected: Option<Value>,
    data: Value,
) -> Result<(), String> {
    let path = workspace_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_workspace(&path, expected, data))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_corrupt_or_changed_files_and_retries_failed_writes() {
        let directory =
            std::env::temp_dir().join(format!("workspace-store-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("research-workspaces.json");
        assert_eq!(read_workspace(&path).unwrap(), None);
        let first = json!({"version": 1, "name": "论文"});
        write_workspace(&path, None, first.clone()).unwrap();
        assert_eq!(read_workspace(&path).unwrap(), Some(first.clone()));
        let second = json!({"version": 1, "name": "next"});
        assert_eq!(
            write_workspace(&path, None, second.clone()).unwrap_err(),
            "workspaceChanged"
        );
        let lock = OpenOptions::new()
            .write(true)
            .open(path.with_extension("lock"))
            .unwrap();
        lock.lock().unwrap();
        assert_eq!(
            write_workspace(&path, Some(first.clone()), second.clone()).unwrap_err(),
            "workspaceBusy"
        );
        lock.unlock().unwrap();
        drop(lock);
        write_workspace(&path, Some(first), second).unwrap();
        for corrupt in ["{broken", "{}", "{\"data\":null}"] {
            fs::write(&path, corrupt).unwrap();
            assert_eq!(read_workspace(&path).unwrap_err(), "workspaceCorrupt");
            assert!(write_workspace(&path, None, json!({})).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
        }
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(read_workspace(&path).is_err());
        assert!(write_workspace(&path, None, json!({})).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
