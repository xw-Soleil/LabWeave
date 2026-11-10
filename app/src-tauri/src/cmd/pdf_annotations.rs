use super::research::ResearchRoot;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
#[cfg(unix)]
use std::{
    ffi::CString,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::ffi::OsStrExt,
};
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
            || part.len() > 200
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
                    .trim_end_matches(' ')
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
                    | "COM¹"
                    | "COM²"
                    | "COM³"
                    | "LPT¹"
                    | "LPT²"
                    | "LPT³"
                    | "CONIN$"
                    | "CONOUT$"
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
                relative: PathBuf::from(".workbench/annotations/.trash")
                    .join(format!("{entry_id}.json")),
            }
        }
    })
}

// Keep directory capabilities for the entire operation; checking a path then reopening it follows races.
struct PinnedPath {
    path: PathBuf,
    parent: File,
    #[cfg(windows)]
    _ancestors: Vec<File>,
}

#[cfg(unix)]
fn c_name(path: &Path) -> Result<CString, String> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| "annotationLocation".into())
}

impl Location {
    fn pin(&self, create: bool) -> Result<Option<PinnedPath>, String> {
        if !self.root.is_absolute()
            || !self
                .relative
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
        {
            return Err("annotationLocation".into());
        }
        let full = self.root.join(&self.relative);
        let parent_path = full.parent().ok_or("annotationLocation")?;
        let mut path = PathBuf::new();
        let mut parent: Option<File> = None;
        #[cfg(windows)]
        let mut ancestors = Vec::new();
        for component in parent_path.components() {
            path.push(component);
            #[cfg(windows)]
            if matches!(component, Component::Prefix(_)) {
                continue;
            }
            let open = || -> std::io::Result<File> {
                #[cfg(unix)]
                {
                    let name =
                        c_name(Path::new(component.as_os_str())).map_err(std::io::Error::other)?;
                    let fd = unsafe {
                        libc::openat(
                            parent.as_ref().map_or(libc::AT_FDCWD, AsRawFd::as_raw_fd),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    };
                    if fd < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(unsafe { File::from_raw_fd(fd) })
                    }
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::OpenOptionsExt;
                    OpenOptions::new()
                        .read(true)
                        .share_mode(3)
                        .custom_flags(0x02000000 | 0x00200000)
                        .open(&path)
                }
            };
            let file = match open() {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::NotFound && !create => return Ok(None),
                Err(error)
                    if error.kind() == ErrorKind::NotFound && path.starts_with(&self.root) =>
                {
                    #[cfg(unix)]
                    {
                        let name = c_name(Path::new(component.as_os_str()))?;
                        let fd = parent.as_ref().ok_or("annotationLocation")?.as_raw_fd();
                        if unsafe { libc::mkdirat(fd, name.as_ptr(), 0o700) } != 0
                            && std::io::Error::last_os_error().kind() != ErrorKind::AlreadyExists
                        {
                            return Err("annotationWriteFailed".into());
                        }
                    }
                    #[cfg(windows)]
                    fs::create_dir(&path)
                        .or_else(|error| {
                            if error.kind() == ErrorKind::AlreadyExists {
                                Ok(())
                            } else {
                                Err(error)
                            }
                        })
                        .map_err(|_| "annotationWriteFailed")?;
                    open().map_err(|_| "annotationLocation")?
                }
                Err(_) => return Err("annotationLocation".into()),
            };
            let meta = file.metadata().map_err(|_| "annotationReadFailed")?;
            if !meta.is_dir() || is_link(&meta) {
                return Err("annotationLocation".into());
            }
            #[cfg(windows)]
            if let Some(previous) = parent.take() {
                ancestors.push(previous);
            }
            parent = Some(file);
        }
        Ok(Some(PinnedPath {
            path: full,
            parent: parent.ok_or("annotationLocation")?,
            #[cfg(windows)]
            _ancestors: ancestors,
        }))
    }

    #[cfg(test)]
    fn path(&self, create: bool) -> Result<PathBuf, String> {
        if let Some(path) = self.pin(create)? {
            path.metadata()?;
        }
        Ok(self.root.join(&self.relative))
    }
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(unix)]
    {
        meta.is_symlink()
    }
}

impl PinnedPath {
    fn sibling(&self, extension: &str) -> Result<Self, String> {
        Ok(Self {
            path: self.path.with_extension(extension),
            parent: self
                .parent
                .try_clone()
                .map_err(|_| "annotationWriteFailed")?,
            #[cfg(windows)]
            _ancestors: self
                ._ancestors
                .iter()
                .map(File::try_clone)
                .collect::<std::io::Result<_>>()
                .map_err(|_| "annotationWriteFailed")?,
        })
    }

    fn open(&self, write: bool, exclusive: bool) -> Result<Option<File>, String> {
        #[cfg(unix)]
        let result = {
            let name = c_name(Path::new(
                self.path.file_name().ok_or("annotationLocation")?,
            ))?;
            let flags = if write {
                libc::O_RDWR | libc::O_CREAT
            } else {
                libc::O_RDONLY
            };
            let fd = unsafe {
                libc::openat(
                    self.parent.as_raw_fd(),
                    name.as_ptr(),
                    flags
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC
                        | libc::O_NONBLOCK
                        | if exclusive { libc::O_EXCL } else { 0 },
                    0o600,
                )
            };
            if fd < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(unsafe { File::from_raw_fd(fd) })
            }
        };
        #[cfg(windows)]
        let result = {
            use std::os::windows::fs::OpenOptionsExt;
            OpenOptions::new()
                .read(true)
                .write(write)
                .create(write)
                .create_new(exclusive)
                .custom_flags(0x00200000)
                .open(&self.path)
        };
        match result {
            Ok(file) => {
                let meta = file.metadata().map_err(|_| "annotationReadFailed")?;
                if !meta.is_file() || is_link(&meta) {
                    return Err("annotationLocation".into());
                }
                Ok(Some(file))
            }
            Err(error) if !write && error.kind() == ErrorKind::NotFound => Ok(None),
            Err(_) => Err(if write {
                "annotationWriteFailed"
            } else {
                "annotationReadFailed"
            }
            .into()),
        }
    }

    fn metadata(&self) -> Result<Option<fs::Metadata>, String> {
        self.open(false, false)?
            .map(|file| file.metadata().map_err(|_| "annotationReadFailed".into()))
            .transpose()
    }

    fn remove(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            let name = c_name(Path::new(
                self.path.file_name().ok_or("annotationLocation")?,
            ))?;
            if unsafe { libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err("annotationWriteFailed".into());
            }
        }
        #[cfg(windows)]
        fs::remove_file(&self.path).map_err(|_| "annotationWriteFailed")?;
        Ok(())
    }

    fn publish(&self, to: &Self, replace: bool) -> Result<(), String> {
        #[cfg(unix)]
        {
            let from_name = c_name(Path::new(
                self.path.file_name().ok_or("annotationLocation")?,
            ))?;
            let to_name = c_name(Path::new(to.path.file_name().ok_or("annotationLocation")?))?;
            let result = unsafe {
                if replace {
                    libc::renameat(
                        self.parent.as_raw_fd(),
                        from_name.as_ptr(),
                        to.parent.as_raw_fd(),
                        to_name.as_ptr(),
                    )
                } else {
                    libc::linkat(
                        self.parent.as_raw_fd(),
                        from_name.as_ptr(),
                        to.parent.as_raw_fd(),
                        to_name.as_ptr(),
                        0,
                    )
                }
            };
            if result != 0 {
                return Err("annotationWriteFailed".into());
            }
        }
        #[cfg(windows)]
        if replace {
            fs::rename(&self.path, &to.path)
        } else {
            fs::hard_link(&self.path, &to.path)
        }
        .map_err(|_| "annotationWriteFailed")?;
        Ok(())
    }

    fn sync_parent(&self) -> Result<(), String> {
        #[cfg(unix)]
        self.parent
            .sync_all()
            .map_err(|_| "annotationWriteFailed")?;
        Ok(())
    }
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

fn validate_annotations(value: &Value) -> Result<(), String> {
    let items = value.as_array().ok_or("annotationCorrupt")?;
    let mut ids = std::collections::HashSet::new();
    let date = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
        .map_err(|_| "annotationCorrupt")?;
    let finite = |value: &Value| value.as_f64().is_some_and(f64::is_finite);
    let rects = |value: &Value| {
        value.as_array().is_some_and(|rects| {
            !rects.is_empty()
                && rects.iter().all(|rect| {
                    rect.as_array().is_some_and(|r| {
                        r.len() == 4
                            && r.iter().all(finite)
                            && r[0].as_f64() <= r[2].as_f64()
                            && r[1].as_f64() <= r[3].as_f64()
                    })
                })
        })
    };
    for item in items {
        let id = item["id"].as_str().ok_or("annotationCorrupt")?;
        let kind = item["type"].as_str().ok_or("annotationCorrupt")?;
        let color = item["color"].as_str().ok_or("annotationCorrupt")?;
        let sort = item["sortIndex"].as_str().ok_or("annotationCorrupt")?;
        let p = &item["position"];
        let valid = !id.is_empty()
            && ids.insert(id)
            && matches!(
                kind,
                "highlight" | "underline" | "note" | "text" | "image" | "ink"
            )
            && color.len() == 7
            && color.starts_with('#')
            && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            && sort.len() == 18
            && sort.bytes().enumerate().all(|(i, b)| {
                if i == 5 || i == 12 {
                    b == b'|'
                } else {
                    b.is_ascii_digit()
                }
            })
            && item["pageLabel"].is_string()
            && item["comment"].is_string()
            && ["text", "authorName"]
                .iter()
                .all(|key| item.get(key).is_none_or(Value::is_string))
            && ["dateCreated", "dateModified"]
                .iter()
                .all(|key| match item.get(key) {
                    Some(value) => value.as_str().is_some_and(|s| date.is_match(s)),
                    None => *key == "dateCreated",
                })
            && ["readOnly", "isAuthorNameAuthoritative"]
                .iter()
                .all(|key| item.get(key).is_none_or(Value::is_boolean))
            && item["tags"].as_array().is_some_and(|tags| {
                tags.iter().all(|tag| {
                    tag["name"].is_string() && tag.get("color").is_none_or(Value::is_string)
                })
            })
            && p["pageIndex"].as_u64().is_some()
            && p.get("nextPageRects").is_none_or(rects)
            && ["width", "fontSize"].iter().all(|key| {
                p.get(key)
                    .is_none_or(|n| finite(n) && n.as_f64().is_some_and(|v| v > 0.0))
            })
            && p.get("rotation").is_none_or(finite)
            && if kind == "ink" {
                p.get("rects").is_none()
                    && p.get("width").is_some()
                    && p["paths"].as_array().is_some_and(|paths| {
                        !paths.is_empty()
                            && paths.iter().all(|path| {
                                path.as_array().is_some_and(|points| {
                                    points.len() >= 2
                                        && points.len() % 2 == 0
                                        && points.iter().all(finite)
                                })
                            })
                    })
            } else {
                p.get("paths").is_none() && rects(&p["rects"])
            };
        if !valid {
            return Err("annotationCorrupt".into());
        }
    }
    Ok(())
}

fn read_snapshot(path: &PinnedPath) -> Result<AnnotationSnapshot, String> {
    let Some(mut file) = path.open(false, false)? else {
        return Ok(AnnotationSnapshot {
            annotations: Value::Array(vec![]),
            revision: None,
        });
    };
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
    validate_annotations(&annotations)?;
    Ok(AnnotationSnapshot {
        annotations,
        revision: Some(revision(&bytes, &after)?),
    })
}

fn lock_path(path: &PinnedPath) -> Result<File, String> {
    let lock = path
        .sibling("json.lock")?
        .open(true, false)?
        .ok_or("annotationWriteFailed")?;
    lock.try_lock().map_err(|_| "annotationBusy")?;
    Ok(lock)
}

fn with_locks<T>(
    paths: &[&PinnedPath],
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
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
    validate_annotations(&annotations)?;
    let bytes = serde_json::to_vec_pretty(&annotations).map_err(|_| "annotationCorrupt")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("annotationCorrupt".into());
    }
    let path = location.pin(true)?.ok_or("annotationLocation")?;
    with_locks(&[&path], || {
        if read_snapshot(&path)?.revision != expected {
            return Err("annotationChanged".into());
        }
        let temporary = path.sibling(&format!(
            "json.{}.{}.tmp",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ))?;
        let mut created = false;
        let result: Result<(), String> = (|| {
            let mut file = temporary.open(true, true)?.ok_or("annotationWriteFailed")?;
            created = true;
            if let Some(meta) = path.metadata()? {
                file.set_permissions(meta.permissions())
                    .map_err(|_| "annotationWriteFailed")?;
            }
            file.write_all(&bytes)
                .map_err(|_| "annotationWriteFailed")?;
            file.sync_all().map_err(|_| "annotationWriteFailed")?;
            drop(file);
            // Recheck immediately before replacement as non-cooperating editors do not take our lock.
            if read_snapshot(&path)?.revision != expected {
                return Err("annotationChanged".into());
            }
            temporary.publish(&path, true)?;
            created = false;
            path.sync_parent()?;
            Ok(())
        })();
        if let Err(error) = result {
            if created && temporary.remove().is_err() {
                return Err("annotationCleanupFailed".into());
            }
            return Err(error);
        }
        read_snapshot(&path)
    })
}

fn relocate(from: &Location, to: &Location, expected: Option<String>) -> Result<(), String> {
    let source = from.pin(true)?.ok_or("annotationLocation")?;
    let destination = to.pin(true)?.ok_or("annotationLocation")?;
    if source.path == destination.path {
        return if read_snapshot(&source)?.revision == expected {
            Ok(())
        } else {
            Err("annotationChanged".into())
        };
    }
    let mut paths = [&source, &destination];
    paths.sort_by_key(|path| &path.path);
    with_locks(&[paths[0], paths[1]], || {
        let snapshot = read_snapshot(&source)?;
        if snapshot.revision != expected {
            return Err("annotationChanged".into());
        }
        if destination.metadata()?.is_some() {
            return Err("annotationDestinationExists".into());
        }
        if snapshot.revision.is_some() {
            // Hard-link publication fails if another writer created the destination. It never overwrites.
            source.publish(&destination, false)?;
            if read_snapshot(&destination)?.revision != expected
                || read_snapshot(&source)?.revision != expected
            {
                return Err("annotationChanged".into());
            }
            if source.remove().is_err() {
                destination
                    .remove()
                    .map_err(|_| "annotationCleanupFailed")?;
                return Err("annotationWriteFailed".into());
            }
            destination.sync_parent()?;
            source.sync_parent()?;
        }
        Ok(())
    })
}

fn migrate_trash(location: &Location) -> Result<(), String> {
    if location.relative.parent() != Some(Path::new(".workbench/annotations/.trash")) {
        return Ok(());
    }
    if let Some(path) = location.pin(false)? {
        if path.metadata()?.is_some() {
            return Ok(());
        }
    }
    let id = location.relative.file_stem().ok_or("annotationLocation")?;
    let legacy = Location {
        root: location.root.clone(),
        relative: PathBuf::from(".workbench/trash")
            .join(id)
            .join("annotations.json"),
    };
    if let Some(path) = legacy.pin(false)? {
        let snapshot = read_snapshot(&path)?;
        if snapshot.revision.is_some() {
            // Keep the old sidecar as a recovery copy; all new annotation writes stay under annotations/.
            save(location, None, snapshot.annotations)?;
        }
    }
    Ok(())
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
    tauri::async_runtime::spawn_blocking(move || {
        migrate_trash(&location)?;
        match location.pin(false)? {
            Some(path) => read_snapshot(&path),
            None => Ok(AnnotationSnapshot {
                annotations: Value::Array(vec![]),
                revision: None,
            }),
        }
    })
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
    tauri::async_runtime::spawn_blocking(move || {
        migrate_trash(&location)?;
        save(&location, expected, annotations)
    })
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
    tauri::async_runtime::spawn_blocking(move || {
        migrate_trash(&from)?;
        migrate_trash(&to)?;
        relocate(&from, &to, expected)
    })
    .await
    .map_err(|_| "annotationWriteFailed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record() -> Value {
        json!([{"id":"ABCDEFGH","type":"note","color":"#ffd400","sortIndex":"00000|000000|00020","pageLabel":"1","position":{"pageIndex":0,"rects":[[10,20,32,42]]},"comment":"","tags":[],"dateModified":"2026-11-10T00:00:00.000Z"}])
    }

    fn read_snapshot(path: &Path) -> Result<AnnotationSnapshot, String> {
        let location = Location {
            root: path.parent().ok_or("annotationLocation")?.to_path_buf(),
            relative: path.file_name().ok_or("annotationLocation")?.into(),
        };
        match location.pin(false)? {
            Some(path) => super::read_snapshot(&path),
            None => Ok(AnnotationSnapshot {
                annotations: json!([]),
                revision: None,
            }),
        }
    }

    fn lock_path(path: &Path) -> Result<File, String> {
        let location = Location {
            root: path.parent().ok_or("annotationLocation")?.to_path_buf(),
            relative: path.file_name().ok_or("annotationLocation")?.into(),
        };
        super::lock_path(&location.pin(true)?.ok_or("annotationLocation")?)
    }

    fn fixture() -> Location {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
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
        let first = save(&location, None, record()).unwrap();
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
            save(&location, None, record()).unwrap_err(),
            "annotationChanged"
        );
        let lock = lock_path(&path).unwrap();
        assert_eq!(
            save(&location, first.revision.clone(), record()).unwrap_err(),
            "annotationBusy"
        );
        lock.unlock().unwrap();
        drop(lock);
        fs::write(&path, serde_json::to_vec(&record()).unwrap()).unwrap();
        assert_eq!(
            save(&location, first.revision, record()).unwrap_err(),
            "annotationChanged"
        );
        for corrupt in ["{", "{}", "null", "[2]", "[{}]", "[{\"id\":\"broken\"}]"] {
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
        let snapshot = save(&source, None, record()).unwrap();
        let renamed = Location {
            root: source.root.clone(),
            relative: PathBuf::from(".workbench/annotations/子目录/new.pdf.json"),
        };
        let trash = Location {
            root: source.root.clone(),
            relative: PathBuf::from(
                ".workbench/annotations/.trash/12345678-1234-1234-1234-123456789012.json",
            ),
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
        assert!(save(&location, None, record()).is_err());
        assert!(read_snapshot(&path).is_err());
        fs::remove_file(&path).unwrap();
        fs::remove_file(path.with_extension("json.lock")).unwrap();
        symlink(&victim, path.with_extension("json.lock")).unwrap();
        assert!(save(&location, None, record()).is_err());
        assert_eq!(fs::read_to_string(victim).unwrap(), "[]");
        fs::remove_dir_all(location.root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pinned_operations_never_follow_replaced_parent_directories() {
        use std::os::unix::fs::symlink;
        let location = fixture();
        let pinned = location.pin(true).unwrap().unwrap();
        let annotations = location.root.join(".workbench/annotations");
        let original = location.root.join(".workbench/original");
        let outside = location.root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("paper.pdf.json"), b"outside").unwrap();
        fs::rename(&annotations, &original).unwrap();
        symlink(&outside, &annotations).unwrap();
        assert!(location.pin(true).is_err());
        let temporary = pinned.sibling("json.test.tmp").unwrap();
        temporary
            .open(true, true)
            .unwrap()
            .unwrap()
            .write_all(b"[]")
            .unwrap();
        temporary.publish(&pinned, true).unwrap();
        assert_eq!(fs::read(original.join("paper.pdf.json")).unwrap(), b"[]");
        assert_eq!(
            fs::read(outside.join("paper.pdf.json")).unwrap(),
            b"outside"
        );
        assert!(!outside.join("paper.pdf.json.test.tmp").exists());
        drop(pinned);
        fs::remove_dir_all(location.root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_replaced_ancestors_above_the_registered_root() {
        use std::os::unix::fs::symlink;
        let location = fixture();
        let ancestor = location.root.join("ancestor");
        let outside = location.root.join("outside");
        fs::create_dir_all(ancestor.join("project")).unwrap();
        fs::create_dir_all(outside.join("project")).unwrap();
        let nested = Location {
            root: ancestor.join("project"),
            relative: location.relative.clone(),
        };
        fs::remove_dir_all(&ancestor).unwrap();
        symlink(&outside, &ancestor).unwrap();
        assert!(save(&nested, None, record()).is_err());
        assert!(!outside.join("project/.workbench").exists());
        fs::remove_dir_all(location.root).unwrap();
    }

    #[test]
    fn rejects_device_aliases_overlong_components_and_duplicate_ids() {
        for path in ["con.pdf", "CON .pdf", "COM¹.pdf", "LPT².pdf", "CONOUT$.pdf"] {
            assert!(relative_pdf(path).is_err(), "{path}");
        }
        assert!(relative_pdf(&format!("{}.pdf", "a".repeat(256))).is_err());
        assert!(relative_pdf(&format!("{}/p.pdf", "a/".repeat(2050))).is_err());
        let location = fixture();
        let record = record()[0].clone();
        assert!(save(&location, None, json!([record, record])).is_err());
        fs::remove_dir_all(location.root).unwrap();
    }

    #[test]
    fn migrates_legacy_trash_sidecars_into_the_annotation_directory_without_overwriting() {
        let original = fixture();
        let id = "12345678-1234-1234-1234-123456789012";
        let legacy = Location {
            root: original.root.clone(),
            relative: PathBuf::from(".workbench/trash")
                .join(id)
                .join("annotations.json"),
        };
        let current = Location {
            root: original.root.clone(),
            relative: PathBuf::from(".workbench/annotations/.trash").join(format!("{id}.json")),
        };
        save(&legacy, None, record()).unwrap();
        migrate_trash(&current).unwrap();
        let snapshot = read_snapshot(&current.path(false).unwrap()).unwrap();
        assert_eq!(snapshot.annotations, record());
        assert!(legacy.path(false).unwrap().exists());
        save(&current, snapshot.revision, json!([])).unwrap();
        migrate_trash(&current).unwrap();
        assert_eq!(
            read_snapshot(&current.path(false).unwrap())
                .unwrap()
                .annotations,
            json!([])
        );
        fs::remove_dir_all(original.root).unwrap();
    }
}
