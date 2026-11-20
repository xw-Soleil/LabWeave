use super::pdf_annotations::{is_link, Location};
use super::research::ResearchRoot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const HISTORY: &str = ".workbench/history";
const MAX_FILE: u64 = 128 * 1024 * 1024;
const MAX_CAPTURE: u64 = 512 * 1024 * 1024;
const MAX_FILES: usize = 5000;
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
static CAPTURE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    path: String,
    hash: String,
    size: u64,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    version: u32,
    id: String,
    project_id: String,
    created_at: String,
    week_start: String,
    reason: String,
    files: Vec<SnapshotFile>,
    warnings: Vec<String>,
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "history.randomFailed")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 4096 || value.contains('\\') || value.contains(':') {
        return Err("history.invalidPath".into());
    }
    if value.split('/').any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "*?\"<>|".contains(c))
    }) {
        return Err("history.invalidPath".into());
    }
    let path = PathBuf::from(value);
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("history.invalidPath".into());
    }
    Ok(path)
}

fn location(root: &Path, relative: &str) -> Result<Location, String> {
    Ok(Location {
        root: root.to_path_buf(),
        relative: relative_path(relative)?,
    })
}

fn read_bytes(root: &Path, relative: &str, max: u64) -> Result<Vec<u8>, String> {
    let pinned = location(root, relative)?
        .pin(false)?
        .ok_or("history.fileMissing")?;
    let mut file = pinned.open(false, false)?.ok_or("history.fileMissing")?;
    let before = file.metadata().map_err(|_| "history.readFailed")?;
    if before.len() > max {
        return Err("history.fileTooLarge".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "history.readFailed")?;
    let after = file.metadata().map_err(|_| "history.readFailed")?;
    if bytes.len() as u64 > max {
        return Err("history.fileTooLarge".into());
    }
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || bytes.len() as u64 != after.len()
    {
        return Err("history.fileChanged".into());
    }
    Ok(bytes)
}

fn publish(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let target = location(root, relative)?
        .pin(true)?
        .ok_or("history.writeFailed")?;
    let temp = target.sibling(&format!("{}.tmp", random_id()?))?;
    let result = (|| {
        let mut file = temp.open(true, true)?.ok_or("history.writeFailed")?;
        file.write_all(bytes).map_err(|_| "history.writeFailed")?;
        file.sync_all().map_err(|_| "history.writeFailed")?;
        drop(file);
        temp.publish(&target, false)?;
        target.sync_parent()
    })();
    let cleanup = temp.remove();
    result.map_err(|_| "history.writeFailed".to_string())?;
    cleanup.map_err(|_| "history.cleanupFailed".to_string())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn u16_at(bytes: &[u8], offset: usize) -> Option<usize> {
    Some(u16::from_le_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?) as usize)
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<usize> {
    Some(u32::from_le_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?) as usize)
}

// Saved PRG entries are stored without compression. Hash entry payloads rather than ZIP
// timestamps/descriptors, so a repeated save or a new thumbnail is not research progress.
fn workspace_content_hash(bytes: &[u8]) -> Option<String> {
    let start = bytes.len().saturating_sub(65557);
    let eocd = (start..bytes.len().saturating_sub(21))
        .rev()
        .find(|&i| bytes.get(i..i + 4) == Some(b"PK\x05\x06"))?;
    if u16_at(bytes, eocd + 4)? != 0 || u16_at(bytes, eocd + 6)? != 0 {
        return None;
    }
    let count = u16_at(bytes, eocd + 10)?;
    if count == 0 || count == 65535 {
        return None;
    }
    let mut offset = u32_at(bytes, eocd + 16)?;
    let mut entries = Vec::new();
    let mut names = HashSet::new();
    for _ in 0..count {
        if bytes.get(offset..offset + 4) != Some(b"PK\x01\x02") {
            return None;
        }
        let flags = u16_at(bytes, offset + 8)?;
        let method = u16_at(bytes, offset + 10)?;
        if flags & 1 != 0 {
            return None;
        }
        let compressed = u32_at(bytes, offset + 20)?;
        let name_len = u16_at(bytes, offset + 28)?;
        let extra_len = u16_at(bytes, offset + 30)?;
        let comment_len = u16_at(bytes, offset + 32)?;
        let local = u32_at(bytes, offset + 42)?;
        let name = bytes.get(offset + 46..offset + 46 + name_len)?.to_vec();
        if !names.insert(name.clone()) {
            return None;
        }
        if bytes.get(local..local + 4) != Some(b"PK\x03\x04") {
            return None;
        }
        let payload =
            local.checked_add(30 + u16_at(bytes, local + 26)? + u16_at(bytes, local + 28)?)?;
        let data = bytes.get(payload..payload.checked_add(compressed)?)?;
        if name != b"thumbnail.png" {
            entries.push((name, method, digest(data)));
        }
        offset = offset.checked_add(46 + name_len + extra_len + comment_len)?;
    }
    if !names.contains(b"stage.msgpack".as_slice()) {
        return None;
    }
    entries.sort();
    Some(digest(&serde_json::to_vec(&entries).ok()?))
}

fn kind(path: &str, annotations: bool) -> Option<&'static str> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    if annotations {
        return (extension == "json").then_some("annotations");
    }
    match extension.as_str() {
        "prg" => Some("workspace"),
        "md" | "markdown" => Some("markdown"),
        "pdf" => Some("pdf"),
        "png" | "jpg" | "jpeg" | "webp" | "gif" => Some("image"),
        "txt" | "csv" | "tsv" | "litlib" => Some("other"),
        _ => None,
    }
}

fn scan(
    root: &Path,
    relative: &str,
    depth: usize,
    files: &mut Vec<(String, String)>,
    warnings: &mut Vec<String>,
) {
    if files.len() >= MAX_FILES {
        warnings.push("最多记录 5000 份资料，部分文件未纳入快照。".into());
        return;
    }
    if depth > 12 {
        warnings.push(format!("目录层级过深，未读取：{relative}"));
        return;
    }
    let directory = root.join(relative);
    // The root itself is already canonical and authorized; child directories are pinned.
    let _guard = if relative.is_empty() {
        None
    } else {
        match location(root, &format!("{relative}/.history-scan")).and_then(|loc| loc.pin(false)) {
            Ok(Some(pin)) => Some(pin),
            _ => {
                warnings.push(format!("目录不可读取：{relative}"));
                return;
            }
        }
    };
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(_) => {
            warnings.push(format!("目录不可读取：{relative}"));
            return;
        }
    };
    let mut entries: Vec<_> = entries
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(_) => {
                warnings.push(format!("目录中存在不可读取条目：{relative}"));
                None
            }
        })
        .collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if files.len() >= MAX_FILES {
            warnings.push("最多记录 5000 份资料，部分文件未纳入快照。".into());
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if name.starts_with('.')
            || name.starts_with("~$")
            || lower.ends_with(".tmp")
            || lower.contains("_backup")
            || lower.ends_with(".ai.md")
            || matches!(lower.as_str(), "node_modules" | "target" | "dist")
            || (relative.is_empty() && matches!(lower.as_str(), "汇报" | "reports"))
        {
            continue;
        }
        let path = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(_) => {
                warnings.push(format!("资料不可读取：{path}"));
                continue;
            }
        };
        if is_link(&metadata) {
            warnings.push(format!("未跟随链接：{path}"));
            continue;
        }
        if metadata.is_dir() {
            scan(root, &path, depth + 1, files, warnings);
        } else if metadata.is_file() {
            if let Some(kind) = kind(&path, relative.starts_with(".workbench/annotations")) {
                if relative_path(&path).is_err() {
                    warnings.push(format!("路径不受支持：{path}"));
                    continue;
                }
                files.push((path, kind.into()));
            }
        }
    }
}

fn load_snapshot(root: &Path, id: &str) -> Result<Snapshot, String> {
    if !hex(id, 32) {
        return Err("history.invalidSnapshot".into());
    }
    let bytes = read_bytes(
        root,
        &format!("{HISTORY}/snapshots/{id}.json"),
        MAX_MANIFEST,
    )?;
    let snapshot: Snapshot =
        serde_json::from_slice(&bytes).map_err(|_| "history.corruptSnapshot")?;
    let mut paths = HashSet::new();
    if snapshot.version != 1
        || snapshot.id != id
        || !hex(&snapshot.project_id, 32)
        || snapshot.files.len() > MAX_FILES
        || snapshot.files.iter().any(|file| {
            relative_path(&file.path).is_err()
                || !hex(&file.hash, 64)
                || file.size > MAX_FILE
                || !paths.insert(&file.path)
                || file
                    .content_hash
                    .as_ref()
                    .is_some_and(|hash| !hex(hash, 64))
        })
    {
        return Err("history.corruptSnapshot".into());
    }
    Ok(snapshot)
}

fn list(root: &Path) -> Result<Vec<Snapshot>, String> {
    let guard = location(root, &format!("{HISTORY}/snapshots/.scan"))?.pin(false)?;
    if guard.is_none() {
        return Ok(Vec::new());
    }
    let mut snapshots = Vec::new();
    for entry in
        fs::read_dir(root.join(HISTORY).join("snapshots")).map_err(|_| "history.readFailed")?
    {
        let entry = entry.map_err(|_| "history.readFailed")?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(id) = name.strip_suffix(".json").filter(|id| hex(id, 32)) {
            if snapshots.len() >= 10000 {
                return Err("history.tooManySnapshots".into());
            }
            snapshots.push(load_snapshot(root, id)?);
        }
    }
    snapshots.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(snapshots)
}

fn project_id(root: &Path) -> Result<String, String> {
    let relative = format!("{HISTORY}/project.json");
    match read_bytes(root, &relative, 1024) {
        Ok(bytes) => {
            let id: String =
                serde_json::from_slice(&bytes).map_err(|_| "history.corruptProject")?;
            if hex(&id, 32) {
                Ok(id)
            } else {
                Err("history.corruptProject".into())
            }
        }
        Err(error) if error == "history.fileMissing" => {
            let id = random_id()?;
            publish(
                root,
                &relative,
                &serde_json::to_vec(&id).map_err(|_| "history.writeFailed")?,
            )?;
            Ok(id)
        }
        Err(error) => Err(error),
    }
}

fn capture(
    root: &Path,
    reason: &str,
    week_start: &str,
    created_at: &str,
) -> Result<Snapshot, String> {
    if !matches!(reason, "manual" | "auto" | "report") {
        return Err("history.invalidReason".into());
    }
    let _lock = CAPTURE_LOCK.lock().map_err(|_| "history.busy")?;
    let previous = list(root)?.into_iter().next();
    let mut paths = Vec::new();
    let mut warnings = Vec::new();
    scan(root, "", 0, &mut paths, &mut warnings);
    let annotations = root.join(".workbench/annotations");
    if fs::symlink_metadata(&annotations).is_ok() {
        scan(root, ".workbench/annotations", 0, &mut paths, &mut warnings);
    }
    paths.sort();
    let expected_paths = paths.clone();
    let had_candidates = !paths.is_empty();
    if paths.is_empty()
        && previous
            .as_ref()
            .is_none_or(|snapshot| snapshot.files.is_empty())
    {
        return Err("history.noMaterials".into());
    }
    let mut files = Vec::new();
    let mut size = 0u64;
    for (path, kind) in paths {
        let bytes = match read_bytes(root, &path, MAX_FILE) {
            Ok(bytes) => bytes,
            Err(error) => {
                warnings.push(format!("未纳入 {path}：{error}"));
                continue;
            }
        };
        size += bytes.len() as u64;
        if size > MAX_CAPTURE {
            warnings.push(format!("超过单次 512 MiB 限额，未纳入：{path}"));
            continue;
        }
        let hash = digest(&bytes);
        let content_hash = if kind == "workspace" {
            workspace_content_hash(&bytes)
        } else {
            None
        };
        if let Some(old) = previous
            .as_ref()
            .and_then(|snapshot| snapshot.files.iter().find(|old| old.path == path))
        {
            if old.hash == hash || (content_hash.is_some() && old.content_hash == content_hash) {
                let frozen = read_bytes(
                    root,
                    &format!("{HISTORY}/objects/{}.bin", old.hash),
                    MAX_FILE,
                )?;
                if digest(&frozen) != old.hash || frozen.len() as u64 != old.size {
                    return Err("history.corruptObject".into());
                }
                files.push(old.clone());
                continue;
            }
        }
        let object = format!("{HISTORY}/objects/{hash}.bin");
        match read_bytes(root, &object, MAX_FILE) {
            Ok(existing) if digest(&existing) == hash => {}
            Ok(_) => return Err("history.corruptObject".into()),
            Err(error) if error == "history.fileMissing" => publish(root, &object, &bytes)?,
            Err(error) => return Err(error),
        }
        files.push(SnapshotFile {
            path,
            hash,
            size: bytes.len() as u64,
            kind,
            content_hash,
        });
    }
    if files.is_empty() && had_candidates {
        return Err(format!(
            "history.noReadableMaterials: {}",
            warnings.join("；")
        ));
    }
    // Recheck the whole collected version set before publishing. In particular, a note
    // saved after its first read must not be paired with a later board revision.
    for file in &files {
        let current = read_bytes(root, &file.path, MAX_FILE)?;
        if digest(&current) != file.hash
            && (file.kind != "workspace"
                || file.content_hash.is_none()
                || workspace_content_hash(&current) != file.content_hash)
        {
            return Err("history.fileChanged".into());
        }
    }
    let mut checked_paths = Vec::new();
    let mut checked_warnings = Vec::new();
    scan(root, "", 0, &mut checked_paths, &mut checked_warnings);
    if fs::symlink_metadata(&annotations).is_ok() {
        scan(
            root,
            ".workbench/annotations",
            0,
            &mut checked_paths,
            &mut checked_warnings,
        );
    }
    checked_paths.sort();
    if checked_paths != expected_paths {
        return Err("history.fileChanged".into());
    }
    warnings.extend(checked_warnings);
    warnings.sort();
    warnings.dedup();
    if reason == "auto" {
        if let Some(previous) = previous {
            if previous.week_start == week_start
                && previous.files == files
                && previous.warnings == warnings
            {
                return Ok(previous);
            }
        }
    }
    let snapshot = Snapshot {
        version: 1,
        id: random_id()?,
        project_id: project_id(root)?,
        created_at: created_at.into(),
        week_start: week_start.into(),
        reason: reason.into(),
        files,
        warnings,
    };
    let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|_| "history.writeFailed")?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("history.manifestTooLarge".into());
    }
    publish(
        root,
        &format!("{HISTORY}/snapshots/{}.json", snapshot.id),
        &bytes,
    )?;
    Ok(snapshot)
}

fn read_file(root: &Path, snapshot_id: &str, path: &str) -> Result<Vec<u8>, String> {
    relative_path(path)?;
    let snapshot = load_snapshot(root, snapshot_id)?;
    let entry = snapshot
        .files
        .iter()
        .find(|file| file.path == path)
        .ok_or("history.fileNotInSnapshot")?;
    let bytes = read_bytes(
        root,
        &format!("{HISTORY}/objects/{}.bin", entry.hash),
        MAX_FILE,
    )?;
    if bytes.len() as u64 != entry.size || digest(&bytes) != entry.hash {
        return Err("history.corruptObject".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn capture_research_snapshot(
    state: State<'_, ResearchRoot>,
    root: String,
    reason: String,
    week_start: String,
    created_at: String,
) -> Result<Snapshot, String> {
    let root = state.authorized_path(&root)?;
    let valid_week =
        regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").map_err(|_| "history.invalidDate")?;
    let valid_time = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        .map_err(|_| "history.invalidDate")?;
    if !valid_week.is_match(&week_start) || !valid_time.is_match(&created_at) {
        return Err("history.invalidDate".into());
    }
    tauri::async_runtime::spawn_blocking(move || capture(&root, &reason, &week_start, &created_at))
        .await
        .map_err(|_| "history.operationFailed".to_string())?
}

#[tauri::command]
pub async fn list_research_snapshots(
    state: State<'_, ResearchRoot>,
    root: String,
) -> Result<Vec<Snapshot>, String> {
    let root = state.authorized_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || list(&root))
        .await
        .map_err(|_| "history.operationFailed".to_string())?
}

#[tauri::command]
pub async fn read_research_snapshot_file(
    state: State<'_, ResearchRoot>,
    root: String,
    snapshot_id: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let root = state.authorized_path(&root)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_file(&root, &snapshot_id, &path))
        .await
        .map_err(|_| "history.operationFailed".to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("labweave-history-{}", random_id().unwrap()));
        fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    #[test]
    fn keeps_immutable_bytes_and_deduplicates_auto_snapshots() {
        let root = fixture();
        fs::write(root.join("note.md"), "first").unwrap();
        let first = capture(&root, "auto", "2026-11-16", "2026-11-20T00:00:00.000Z").unwrap();
        let unchanged = capture(&root, "auto", "2026-11-16", "2026-11-20T01:00:00.000Z").unwrap();
        assert_eq!(first.id, unchanged.id);
        fs::write(root.join("note.md"), "second").unwrap();
        let second = capture(&root, "manual", "2026-11-16", "2026-11-20T02:00:00.000Z").unwrap();
        fs::remove_file(root.join("note.md")).unwrap();
        assert_eq!(read_file(&root, &first.id, "note.md").unwrap(), b"first");
        assert_eq!(read_file(&root, &second.id, "note.md").unwrap(), b"second");
        assert_eq!(list(&root).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn includes_annotations_excludes_generated_reports_and_does_not_invent_weeks() {
        let root = fixture();
        fs::create_dir_all(root.join(".workbench/annotations")).unwrap();
        fs::create_dir_all(root.join("汇报")).unwrap();
        fs::write(root.join(".workbench/annotations/paper.pdf.json"), "[]").unwrap();
        fs::write(root.join("汇报/report.md"), "generated").unwrap();
        fs::write(root.join("note.md"), "source").unwrap();
        let first = capture(&root, "auto", "2026-11-16", "2026-11-20T00:00:00.000Z").unwrap();
        assert_eq!(first.files.len(), 2);
        let later = capture(&root, "auto", "2026-11-30", "2026-12-01T00:00:00.000Z").unwrap();
        assert_ne!(first.id, later.id);
        assert_eq!(list(&root).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_traversal_corrupt_objects_and_empty_capture() {
        let root = fixture();
        assert_eq!(
            capture(&root, "auto", "2026-11-16", "2026-11-20T00:00:00.000Z").unwrap_err(),
            "history.noMaterials"
        );
        for path in [
            "../secret",
            "a/../secret",
            "/secret",
            "C:/secret",
            "a\\secret",
            "x:stream",
            "a//b",
        ] {
            assert!(relative_path(path).is_err());
        }
        fs::write(root.join("note.md"), "first").unwrap();
        let snapshot = capture(&root, "manual", "2026-11-16", "2026-11-20T00:00:00.000Z").unwrap();
        assert!(read_file(&root, &snapshot.id, "../secret").is_err());
        fs::write(
            root.join(format!("{HISTORY}/objects/{}.bin", snapshot.files[0].hash)),
            "bad",
        )
        .unwrap();
        assert_eq!(
            read_file(&root, &snapshot.id, "note.md").unwrap_err(),
            "history.corruptObject"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn records_oversized_sources_as_incomplete_instead_of_silently_dropping_them() {
        let root = fixture();
        fs::write(root.join("note.md"), "source").unwrap();
        fs::File::create(root.join("large.pdf"))
            .unwrap()
            .set_len(MAX_FILE + 1)
            .unwrap();
        let snapshot = capture(&root, "manual", "2026-11-16", "2026-11-20T00:00:00.000Z").unwrap();
        assert_eq!(snapshot.files.len(), 1);
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains("large.pdf")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_the_last_material_is_a_real_change_not_an_empty_initial_project() {
        let root = fixture();
        fs::write(root.join("note.md"), "source").unwrap();
        let before = capture(&root, "auto", "2026-11-16", "2026-11-20T00:00:00.000Z").unwrap();
        fs::remove_file(root.join("note.md")).unwrap();
        let after = capture(&root, "auto", "2026-11-16", "2026-11-20T01:00:00.000Z").unwrap();
        assert!(after.files.is_empty());
        assert_ne!(before.id, after.id);
        assert_eq!(read_file(&root, &before.id, "note.md").unwrap(), b"source");
        assert_eq!(
            capture(&root, "auto", "2026-11-23", "2026-11-24T01:00:00.000Z").unwrap_err(),
            "history.noMaterials"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn stored_zip(data: &[u8], date: u16) -> Vec<u8> {
        let name = b"stage.msgpack";
        let mut bytes = vec![0u8; 30];
        bytes[0..4].copy_from_slice(b"PK\x03\x04");
        bytes[12..14].copy_from_slice(&date.to_le_bytes());
        bytes[18..22].copy_from_slice(&(data.len() as u32).to_le_bytes());
        bytes[22..26].copy_from_slice(&(data.len() as u32).to_le_bytes());
        bytes[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
        bytes.extend(name);
        bytes.extend(data);
        let central_offset = bytes.len();
        let mut central = vec![0u8; 46];
        central[0..4].copy_from_slice(b"PK\x01\x02");
        central[14..16].copy_from_slice(&date.to_le_bytes());
        central[20..24].copy_from_slice(&(data.len() as u32).to_le_bytes());
        central[24..28].copy_from_slice(&(data.len() as u32).to_le_bytes());
        central[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
        bytes.extend(central);
        bytes.extend(name);
        let central_len = bytes.len() - central_offset;
        let mut end = vec![0u8; 22];
        end[0..4].copy_from_slice(b"PK\x05\x06");
        end[8..10].copy_from_slice(&1u16.to_le_bytes());
        end[10..12].copy_from_slice(&1u16.to_le_bytes());
        end[12..16].copy_from_slice(&(central_len as u32).to_le_bytes());
        end[16..20].copy_from_slice(&(central_offset as u32).to_le_bytes());
        bytes.extend(end);
        bytes
    }

    #[test]
    fn repeated_zip_save_ignores_container_timestamps_and_reuses_the_existing_object() {
        let root = fixture();
        let original = stored_zip(b"stage", 1);
        fs::write(root.join("board.prg"), &original).unwrap();
        let first = capture(&root, "auto", "2026-11-16", "2026-11-20T00:00:00.000Z").unwrap();
        fs::write(root.join("board.prg"), stored_zip(b"stage", 2)).unwrap();
        let second = capture(&root, "auto", "2026-11-16", "2026-11-20T01:00:00.000Z").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(read_file(&root, &first.id, "board.prg").unwrap(), original);
        assert_ne!(
            workspace_content_hash(&stored_zip(b"stage", 2)),
            workspace_content_hash(&stored_zip(b"new stage", 2))
        );
        assert_eq!(workspace_content_hash(b"not zip"), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks_and_refuses_redirected_history() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let outside = fixture();
        fs::write(outside.join("outside.md"), "private").unwrap();
        fs::write(root.join("note.md"), "source").unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        let snapshot = capture(&root, "manual", "2026-11-16", "2026-11-20T00:00:00.000Z").unwrap();
        assert_eq!(snapshot.files.len(), 1);
        assert!(!snapshot.warnings.is_empty());
        fs::remove_dir_all(root.join(HISTORY)).unwrap();
        symlink(&outside, root.join(HISTORY)).unwrap();
        assert!(capture(&root, "manual", "2026-11-16", "2026-11-20T00:00:00.000Z").is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
