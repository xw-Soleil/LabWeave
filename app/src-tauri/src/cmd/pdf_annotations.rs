use super::research::ResearchRoot;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, Runtime, State};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AnnotationTarget {
    Project {
        root_key: String,
        relative_path: String,
    },
    External {
        path_key: String,
    },
    Trash {
        root_key: String,
        entry_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSnapshot {
    annotations: Value,
    revision: Option<String>,
}

#[derive(Clone)]
struct Location {
    root: PathBuf,
    relative: PathBuf,
}

fn hex_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn relative_pdf(path: &str) -> Result<PathBuf, String> {
    if !path.to_ascii_lowercase().ends_with(".pdf") || path.len() > 4096 {
        return Err("annotationLocation".into());
    }
    let mut relative = PathBuf::new();
    for part in path.split('/') {
        // Reject Windows device paths, alternate streams and separators on every platform.
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:*?\"<>|".contains(c))
            || matches!(
                part.split('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_uppercase()
                    .as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
        {
            return Err("annotationLocation".into());
        }
        relative.push(part);
    }
    Ok(relative)
}

fn location(
    target: AnnotationTarget,
    roots: &ResearchRoot,
    app_data: &Path,
) -> Result<Location, String> {
    Ok(match target {
        AnnotationTarget::Project {
            root_key,
            relative_path,
        } => {
            if !hex_key(&root_key) {
                return Err("annotationLocation".into());
            }
            let pdf = relative_pdf(&relative_path)?;
            let mut relative = PathBuf::from(".workbench/annotations").join(pdf);
            let name = relative
                .file_name()
                .ok_or("annotationLocation")?
                .to_string_lossy()
                .into_owned();
            relative.set_file_name(format!("{name}.json"));
            Location {
                root: roots.annotation_root(&root_key)?,
                relative,
            }
        }
        AnnotationTarget::External { path_key } => {
            if !hex_key(&path_key) {
                return Err("annotationLocation".into());
            }
            Location {
                root: app_data.to_path_buf(),
                relative: PathBuf::from("annotations/external").join(format!("{path_key}.json")),
            }
        }
        AnnotationTarget::Trash { root_key, entry_id } => {
            if !hex_key(&root_key)
                || entry_id.len() != 36
                || !entry_id.bytes().enumerate().all(|(i, c)| {
                    if [8, 13, 18, 23].contains(&i) {
                        c == b'-'
                    } else {
                        c.is_ascii_hexdigit()
                    }
                })
            {
                return Err("annotationLocation".into());
            }
            Location {
                root: roots.annotation_root(&root_key)?,
                relative: PathBuf::from(".workbench/trash")
                    .join(entry_id)
                    .join("annotations.json"),
            }
        }
    })
}

fn safe_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let mut link = metadata.is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                link |= metadata.file_attributes() & 0x400 != 0;
            }
            #[cfg(not(windows))]
            {
                let _ = &mut link;
            }
            if link {
                return Err("annotationLocation".into());
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err("annotationReadFailed".into()),
    }
}

impl Location {
    fn path(&self, create: bool) -> Result<PathBuf, String> {
        // The root is either a previously authorized canonical project or the fixed app data directory.
        if create {
            fs::create_dir_all(&self.root).map_err(|_| "annotationWriteFailed")?;
        }
        if let Some(metadata) = safe_metadata(&self.root)? {
            if !metadata.is_dir() {
                return Err("annotationLocation".into());
            }
        }
        let mut path = self.root.clone();
        let components: Vec<_> = self.relative.components().collect();
        for (index, part) in components.iter().enumerate() {
            path.push(part);
            let last = index + 1 == components.len();
            match safe_metadata(&path)? {
                Some(meta) if (last && !meta.is_file()) || (!last && !meta.is_dir()) => {
                    return Err("annotationLocation".into())
                }
                None if create && !last => fs::create_dir(&path)
                    .or_else(|error| {
                        if error.kind() == ErrorKind::AlreadyExists {
                            Ok(())
                        } else {
                            Err(error)
                        }
                    })
                    .map_err(|_| "annotationWriteFailed")?,
                _ => {}
            }
            if create && !last && !safe_metadata(&path)?.is_some_and(|meta| meta.is_dir()) {
                return Err("annotationLocation".into());
            }
        }
        Ok(path)
    }
}

fn open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    options
}

fn revision(bytes: &[u8], metadata: &fs::Metadata) -> Result<String, String> {
    let modified = metadata
        .modified()
        .map_err(|_| "annotationReadFailed")?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "annotationReadFailed")?
        .as_nanos();
    let mut digest = Sha256::new();
    digest.update(bytes);
    digest.update(modified.to_le_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn read_snapshot(path: &Path) -> Result<AnnotationSnapshot, String> {
    if safe_metadata(path)?.is_none() {
        return Ok(AnnotationSnapshot {
            annotations: Value::Array(vec![]),
            revision: None,
        });
    }
    let mut file = open_options()
        .read(true)
        .open(path)
        .map_err(|_| "annotationReadFailed")?;
    let before = file.metadata().map_err(|_| "annotationReadFailed")?;
    if !before.is_file() || before.len() > MAX_BYTES {
        return Err("annotationCorrupt".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "annotationReadFailed")?;
    let after = file.metadata().map_err(|_| "annotationReadFailed")?;
    if bytes.len() as u64 > MAX_BYTES
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("annotationChanged".into());
    }
    let annotations: Value = serde_json::from_slice(&bytes).map_err(|_| "annotationCorrupt")?;
    if !annotations.is_array() {
        return Err("annotationCorrupt".into());
    }
    Ok(AnnotationSnapshot {
        annotations,
        revision: Some(revision(&bytes, &after)?),
    })
}

fn lock_path(path: &Path) -> Result<File, String> {
    let lock_path = path.with_extension("json.lock");
    safe_metadata(&lock_path)?;
    let lock = open_options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|_| "annotationWriteFailed")?;
    lock.try_lock().map_err(|_| "annotationBusy")?;
    Ok(lock)
}

fn with_locks<T>(paths: &[&Path], action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let Some((path, remaining)) = paths.split_first() else {
        return action();
    };
    let lock = lock_path(path)?;
    let result = with_locks(remaining, action);
    // Explicit unlock also releases the lock if a concurrently spawned child briefly inherited the fd.
    let unlocked = lock.unlock().map_err(|_| "annotationBusy".to_string());
    match (result, unlocked) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}

fn save(
    location: &Location,
    expected: Option<String>,
    annotations: Value,
) -> Result<AnnotationSnapshot, String> {
    if !annotations.is_array() {
        return Err("annotationCorrupt".into());
    }
    let bytes = serde_json::to_vec_pretty(&annotations).map_err(|_| "annotationCorrupt")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("annotationCorrupt".into());
    }
    let path = location.path(true)?;
    with_locks(&[&path], || {
        if read_snapshot(&path)?.revision != expected {
            return Err("annotationChanged".into());
        }
        let temporary = path.with_extension(format!(
            "json.{}.{}.tmp",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        let result: Result<(), String> = (|| {
            let mut file = open_options()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| "annotationWriteFailed")?;
            if let Some(meta) = safe_metadata(&path)? {
                file.set_permissions(meta.permissions())
                    .map_err(|_| "annotationWriteFailed")?;
            }
            file.write_all(&bytes)
                .map_err(|_| "annotationWriteFailed")?;
            file.sync_all().map_err(|_| "annotationWriteFailed")?;
            drop(file);
            // Recheck immediately before replacement as non-cooperating editors do not take our lock.
            if location.path(false)? != path || read_snapshot(&path)?.revision != expected {
                return Err("annotationChanged".into());
            }
            fs::rename(&temporary, &path).map_err(|_| "annotationWriteFailed")?;
            Ok(())
        })();
        if let Err(error) = result {
            if temporary.exists() && fs::remove_file(&temporary).is_err() {
                return Err("annotationCleanupFailed".into());
            }
            return Err(error.into());
        }
        read_snapshot(&path)
    })
}

fn relocate(from: &Location, to: &Location, expected: Option<String>) -> Result<(), String> {
    let source = from.path(true)?;
    let destination = to.path(true)?;
    if source == destination {
        return Ok(());
    }
    let mut paths = [&source, &destination];
    paths.sort();
    with_locks(&[paths[0], paths[1]], || {
        let snapshot = read_snapshot(&source)?;
        if snapshot.revision != expected {
            return Err("annotationChanged".into());
        }
        if safe_metadata(&destination)?.is_some() {
            return Err("annotationDestinationExists".into());
        }
        if snapshot.revision.is_some() {
            // Hard-link publication fails if another writer created the destination. It never overwrites.
            fs::hard_link(&source, &destination).map_err(|_| "annotationWriteFailed")?;
            if fs::remove_file(&source).is_err() {
                fs::remove_file(&destination).map_err(|_| "annotationCleanupFailed")?;
                return Err("annotationWriteFailed".into());
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn load_pdf_annotations<R: Runtime>(
    app: AppHandle<R>,
    roots: State<'_, ResearchRoot>,
    target: AnnotationTarget,
) -> Result<AnnotationSnapshot, String> {
    let location = location(
        target,
        &roots,
        &app.path()
            .app_data_dir()
            .map_err(|_| "annotationLocation")?,
    )?;
    tauri::async_runtime::spawn_blocking(move || read_snapshot(&location.path(false)?))
        .await
        .map_err(|_| "annotationReadFailed")?
}

#[tauri::command]
pub async fn save_pdf_annotations<R: Runtime>(
    app: AppHandle<R>,
    roots: State<'_, ResearchRoot>,
    target: AnnotationTarget,
    expected: Option<String>,
    annotations: Value,
) -> Result<AnnotationSnapshot, String> {
    let location = location(
        target,
        &roots,
        &app.path()
            .app_data_dir()
            .map_err(|_| "annotationLocation")?,
    )?;
    tauri::async_runtime::spawn_blocking(move || save(&location, expected, annotations))
        .await
        .map_err(|_| "annotationWriteFailed")?
}

#[tauri::command]
pub async fn move_pdf_annotations<R: Runtime>(
    app: AppHandle<R>,
    roots: State<'_, ResearchRoot>,
    from: AnnotationTarget,
    to: AnnotationTarget,
    expected: Option<String>,
) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "annotationLocation")?;
    let from = location(from, &roots, &app_data)?;
    let to = location(to, &roots, &app_data)?;
    if from.root != to.root {
        return Err("annotationLocation".into());
    }
    tauri::async_runtime::spawn_blocking(move || relocate(&from, &to, expected))
        .await
        .map_err(|_| "annotationWriteFailed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Location {
        let root = std::env::temp_dir().join(format!(
            "pdf-annotations-{}-{}",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("paper.pdf"), b"original PDF bytes").unwrap();
        Location {
            root,
            relative: PathBuf::from(".workbench/annotations/paper.pdf.json"),
        }
    }

    #[test]
    fn accepts_only_annotation_keys_and_relative_pdf_names() {
        for path in [
            "../paper.pdf",
            "/paper.pdf",
            "C:/paper.pdf",
            r"a\b.pdf",
            "x/../p.pdf",
            "a//p.pdf",
            "NUL.pdf",
            "x/COM1.pdf",
            "p.md",
            "a:stream.pdf",
        ] {
            assert!(relative_pdf(path).is_err(), "{path}");
        }
        assert_eq!(
            relative_pdf("论文/图 1.PDF").unwrap(),
            PathBuf::from("论文/图 1.PDF")
        );
        let roots = ResearchRoot::default();
        let base = Path::new("data");
        assert!(location(
            AnnotationTarget::Project {
                root_key: "a".repeat(64),
                relative_path: "a.pdf".into()
            },
            &roots,
            base
        )
        .is_err());
        assert!(location(
            AnnotationTarget::External {
                path_key: "../secret".into()
            },
            &roots,
            base
        )
        .is_err());
        let external = location(
            AnnotationTarget::External {
                path_key: "a".repeat(64),
            },
            &roots,
            base,
        )
        .unwrap();
        assert_eq!(
            external.relative,
            PathBuf::from("annotations/external").join(format!("{}.json", "a".repeat(64)))
        );
        assert!(serde_json::from_value::<AnnotationTarget>(
            json!({"kind":"external","pathKey":"a".repeat(64),"path":"/secret"})
        )
        .is_err());
    }

    #[test]
    fn atomically_saves_json_and_preserves_pdf_bytes_and_file_mode() {
        let location = fixture();
        let path = location.path(false).unwrap();
        assert!(read_snapshot(&path).unwrap().revision.is_none());
        let first = save(
            &location,
            None,
            json!([{ "id": "ABCDEFGH", "position": { "pageIndex": 0 } }]),
        )
        .unwrap();
        assert!(first.revision.is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        }
        save(&location, first.revision, json!([])).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o400
            );
        }
        assert_eq!(fs::read(&path).unwrap(), b"[]");
        assert_eq!(
            fs::read(location.root.join("paper.pdf")).unwrap(),
            b"original PDF bytes"
        );
        assert!(!fs::read_dir(path.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "tmp")));
        fs::remove_dir_all(location.root).unwrap();
    }

    #[test]
    fn rejects_lost_updates_busy_locks_corruption_and_oversize() {
        let location = fixture();
        let first = save(&location, None, json!([])).unwrap();
        let path = location.path(false).unwrap();
        assert_eq!(
            save(&location, None, json!([1])).unwrap_err(),
            "annotationChanged"
        );
        let lock = lock_path(&path).unwrap();
        assert_eq!(
            save(&location, first.revision.clone(), json!([1])).unwrap_err(),
            "annotationBusy"
        );
        lock.unlock().unwrap();
        drop(lock);
        fs::write(&path, "[2]").unwrap();
        assert_eq!(
            save(&location, first.revision, json!([1])).unwrap_err(),
            "annotationChanged"
        );
        for corrupt in ["{", "{}", "null"] {
            fs::write(&path, corrupt).unwrap();
            assert_eq!(read_snapshot(&path).unwrap_err(), "annotationCorrupt");
            assert!(save(&location, None, json!([])).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
        }
        File::create(&path).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert_eq!(read_snapshot(&path).unwrap_err(), "annotationCorrupt");
        fs::remove_dir_all(location.root).unwrap();
    }

    #[test]
    fn follows_rename_trash_restore_and_rollback_without_overwriting() {
        let source = fixture();
        let snapshot = save(&source, None, json!([{ "id": "ABCDEFGH" }])).unwrap();
        let renamed = Location {
            root: source.root.clone(),
            relative: PathBuf::from(".workbench/annotations/子目录/new.pdf.json"),
        };
        let trash = Location {
            root: source.root.clone(),
            relative: PathBuf::from(".workbench/trash/123/annotations.json"),
        };
        relocate(&source, &renamed, snapshot.revision.clone()).unwrap();
        assert!(!source.path(false).unwrap().exists());
        assert_eq!(
            read_snapshot(&renamed.path(false).unwrap())
                .unwrap()
                .annotations,
            snapshot.annotations
        );
        relocate(&renamed, &trash, snapshot.revision.clone()).unwrap();
        relocate(&trash, &source, snapshot.revision.clone()).unwrap();
        save(&renamed, None, json!([])).unwrap();
        assert_eq!(
            relocate(&source, &renamed, snapshot.revision.clone()).unwrap_err(),
            "annotationDestinationExists"
        );
        assert!(source.path(false).unwrap().exists());
        assert_eq!(
            relocate(&source, &trash, None).unwrap_err(),
            "annotationChanged"
        );
        fs::remove_dir_all(source.root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_directories_files_and_locks() {
        use std::os::unix::fs::symlink;
        let location = fixture();
        let outside = location.root.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, location.root.join(".workbench")).unwrap();
        assert!(location.path(true).is_err());
        fs::remove_file(location.root.join(".workbench")).unwrap();
        let path = location.path(true).unwrap();
        let victim = outside.join("secret.json");
        fs::write(&victim, "[]").unwrap();
        symlink(&victim, &path).unwrap();
        assert!(save(&location, None, json!([1])).is_err());
        assert!(read_snapshot(&path).is_err());
        fs::remove_file(&path).unwrap();
        symlink(&victim, path.with_extension("json.lock")).unwrap();
        assert!(save(&location, None, json!([1])).is_err());
        assert_eq!(fs::read_to_string(victim).unwrap(), "[]");
        fs::remove_dir_all(location.root).unwrap();
    }
}
