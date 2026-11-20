use super::pdf_annotations::{Location, PinnedPath};
use super::research::ResearchRoot;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const DIRECTORY: &str = "进展记录/周进展";
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_TOTAL: usize = 32 * 1024 * 1024;
const MAX_IMAGE: u64 = 8 * 1024 * 1024;
const MAX_PIXELS: u64 = 25_000_000;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyRecord {
    week_start: String,
    path: String,
    markdown: String,
    revision: String,
}

fn safe_error(error: String) -> String {
    match error.as_str() {
        "annotationLocation" => "weekly.invalidPath".into(),
        "annotationReadFailed" => "weekly.readFailed".into(),
        "annotationWriteFailed" => "weekly.writeFailed".into(),
        _ => error,
    }
}

fn valid_week(value: &str) -> bool {
    if value.len() != 10
        || !value.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        value[..4].parse::<u32>(),
        value[5..7].parse::<u32>(),
        value[8..].parse::<u32>(),
    ) else {
        return false;
    };
    if !(1900..=9999).contains(&year) || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day == 0 || day > months[month as usize - 1] {
        return false;
    }
    // 0001-01-01 was a Monday in the proleptic Gregorian calendar.
    let previous = year - 1;
    let days = previous * 365 + previous / 4 - previous / 100
        + previous / 400
        + months[..month as usize - 1].iter().sum::<u32>()
        + day
        - 1;
    days % 7 == 0
}

fn week_path(week: &str) -> Result<String, String> {
    if !valid_week(week) {
        return Err("weekly.invalidWeek".into());
    }
    Ok(format!("{DIRECTORY}/{week}.md"))
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 4096 || value.contains(['\\', ':']) {
        return Err("weekly.invalidPath".into());
    }
    if value.split('/').any(|part| {
        let device = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "*?\"<>|".contains(c))
            || ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
            || ((device.starts_with("COM") || device.starts_with("LPT"))
                && device.len() == 4
                && device.as_bytes()[3].is_ascii_digit())
    }) {
        return Err("weekly.invalidPath".into());
    }
    let path = PathBuf::from(value);
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("weekly.invalidPath".into());
    }
    Ok(path)
}

fn pin(root: &Path, relative: &str, create: bool) -> Result<Option<PinnedPath>, String> {
    Location {
        root: root.to_path_buf(),
        relative: relative_path(relative)?,
    }
    .pin(create)
    .map_err(safe_error)
}

fn read_pinned(pinned: &PinnedPath) -> Result<Option<(String, String)>, String> {
    let Some(mut file) = pinned.open(false, false).map_err(safe_error)? else {
        return Ok(None);
    };
    let before = file.metadata().map_err(|_| "weekly.readFailed")?;
    if before.len() > MAX_FILE {
        return Err("weekly.tooLarge".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "weekly.readFailed")?;
    let after = file.metadata().map_err(|_| "weekly.readFailed")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("weekly.tooLarge".into());
    }
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || bytes.len() as u64 != after.len()
    {
        return Err("weekly.conflict".into());
    }
    let revision = format!("{:x}", Sha256::digest(&bytes));
    let markdown = String::from_utf8(bytes).map_err(|_| "weekly.readFailed")?;
    Ok(Some((markdown, revision)))
}

fn load(root: &Path, week: &str) -> Result<Option<WeeklyRecord>, String> {
    let path = week_path(week)?;
    let Some(pinned) = pin(root, &path, false)? else {
        return Ok(None);
    };
    Ok(
        read_pinned(&pinned)?.map(|(markdown, revision)| WeeklyRecord {
            week_start: week.into(),
            path,
            markdown,
            revision,
        }),
    )
}

fn list(root: &Path) -> Result<Vec<WeeklyRecord>, String> {
    // Pin this directory by a synthetic child path, without creating that child.
    // No project material folders or old snapshot objects are visited.
    let Some(_directory) = pin(root, &format!("{DIRECTORY}/.directory-check"), false)? else {
        return Ok(vec![]);
    };
    let mut weeks = Vec::new();
    for entry in fs::read_dir(root.join(DIRECTORY)).map_err(|_| "weekly.readFailed")? {
        let entry = entry.map_err(|_| "weekly.readFailed")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(week) = name.strip_suffix(".md").filter(|week| valid_week(week)) {
            weeks.push(week.to_owned());
            if weeks.len() > 1000 {
                return Err("weekly.tooLarge".into());
            }
        }
    }
    weeks.sort_by(|a, b| b.cmp(a));
    let mut total = 0;
    let mut records = Vec::new();
    for week in weeks {
        if let Some(record) = load(root, &week)? {
            total += record.markdown.len();
            if total > MAX_TOTAL {
                return Err("weekly.tooLarge".into());
            }
            records.push(record);
        }
    }
    Ok(records)
}

fn save(
    root: &Path,
    week: &str,
    markdown: &str,
    expected: Option<&str>,
) -> Result<WeeklyRecord, String> {
    if markdown.len() as u64 > MAX_FILE {
        return Err("weekly.tooLarge".into());
    }
    let path = week_path(week)?;
    let _guard = WRITE_LOCK.lock().map_err(|_| "weekly.writeFailed")?;
    let target = pin(root, &path, true)?.ok_or("weekly.writeFailed")?;
    let current = read_pinned(&target)?;
    if current.as_ref().map(|(_, revision)| revision.as_str()) != expected {
        return Err("weekly.conflict".into());
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "weekly.writeFailed")?;
    let suffix = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let temp = target
        .sibling(&format!("{suffix}.tmp"))
        .map_err(safe_error)?;
    let mut published = false;
    let result = (|| {
        let mut file = temp
            .open(true, true)
            .map_err(safe_error)?
            .ok_or("weekly.writeFailed")?;
        file.write_all(markdown.as_bytes())
            .map_err(|_| "weekly.writeFailed")?;
        file.sync_all().map_err(|_| "weekly.writeFailed")?;
        drop(file);
        // Re-read immediately before publishing, including external editor changes
        // made while the replacement file was being written.
        if read_pinned(&target)?
            .as_ref()
            .map(|(_, revision)| revision.as_str())
            != expected
        {
            return Err("weekly.conflict".to_string());
        }
        temp.publish(&target, current.is_some())
            .map_err(safe_error)?;
        published = current.is_some();
        target.sync_parent().map_err(safe_error)
    })();
    let cleanup = if published {
        Ok(())
    } else {
        temp.remove().map_err(safe_error)
    };
    result?;
    cleanup?;
    Ok(WeeklyRecord {
        week_start: week.into(),
        path,
        markdown: markdown.into(),
        revision: format!("{:x}", Sha256::digest(markdown.as_bytes())),
    })
}

fn resolve_link(root: &Path, path: &str) -> Result<String, String> {
    let pinned = pin(root, path, false)?.ok_or("weekly.fileNotFound")?;
    let _file = pinned
        .open(false, false)
        .map_err(safe_error)?
        .ok_or("weekly.fileNotFound")?;
    Ok(root
        .join(relative_path(path)?)
        .to_string_lossy()
        .into_owned())
}

fn image_info(bytes: &[u8]) -> Result<(&'static str, u32, u32), String> {
    if bytes.len() as u64 > MAX_IMAGE {
        return Err("weekly.imageTooLarge".into());
    }
    let info = if bytes.len() >= 33
        && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes[8..16] == [0, 0, 0, 13, b'I', b'H', b'D', b'R']
    {
        Some((
            "png",
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        ))
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        let mut offset = 2;
        let mut dimensions = None;
        while offset + 3 < bytes.len() {
            if bytes[offset] != 0xff {
                break;
            }
            while offset < bytes.len() && bytes[offset] == 0xff {
                offset += 1;
            }
            if offset >= bytes.len() {
                break;
            }
            let marker = bytes[offset];
            offset += 1;
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                continue;
            }
            if offset + 2 > bytes.len() {
                break;
            }
            let length = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
            if length < 2 || offset + length > bytes.len() {
                break;
            }
            if [
                0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
            ]
            .contains(&marker)
                && length >= 8
            {
                dimensions = Some((
                    "jpg",
                    u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32,
                    u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u32,
                ));
                break;
            }
            offset += length;
        }
        dimensions
    } else if bytes.len() >= 25 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        let little24 =
            |offset| u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], 0]);
        match &bytes[12..16] {
            b"VP8X" if bytes.len() >= 30 => Some(("webp", little24(24) + 1, little24(27) + 1)),
            b"VP8L" if bytes[20] == 0x2f => {
                let bits = u32::from_le_bytes(bytes[21..25].try_into().unwrap());
                Some(("webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"VP8 " if bytes.len() >= 30 && bytes[23..26] == [0x9d, 0x01, 0x2a] => Some((
                "webp",
                (u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff) as u32,
                (u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff) as u32,
            )),
            _ => None,
        }
    } else {
        None
    };
    let (extension, width, height) = info.ok_or("weekly.imageUnsupported")?;
    if width == 0 || height == 0 || width as u64 * height as u64 > MAX_PIXELS {
        return Err("weekly.imageTooLarge".into());
    }
    Ok((extension, width, height))
}

fn read_image_pinned(pinned: &PinnedPath) -> Result<Option<Vec<u8>>, String> {
    let Some(mut file) = pinned.open(false, false).map_err(safe_error)? else {
        return Ok(None);
    };
    let before = file.metadata().map_err(|_| "weekly.imageReadFailed")?;
    if before.len() > MAX_IMAGE {
        return Err("weekly.imageTooLarge".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_IMAGE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "weekly.imageReadFailed")?;
    let after = file.metadata().map_err(|_| "weekly.imageReadFailed")?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || bytes.len() as u64 != after.len()
    {
        return Err("weekly.conflict".into());
    }
    image_info(&bytes)?;
    Ok(Some(bytes))
}

fn read_image(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
        return Err("weekly.imageUnsupported".into());
    }
    let pinned = pin(root, path, false)?.ok_or("weekly.fileNotFound")?;
    read_image_pinned(&pinned)?.ok_or("weekly.fileNotFound".into())
}

fn save_image(root: &Path, week: &str, bytes: &[u8]) -> Result<String, String> {
    week_path(week)?;
    let (extension, _, _) = image_info(bytes)?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    let path = format!("{DIRECTORY}/附件/{week}/{hash}.{extension}");
    let _guard = WRITE_LOCK.lock().map_err(|_| "weekly.imageWriteFailed")?;
    let target = pin(root, &path, true)?.ok_or("weekly.imageWriteFailed")?;
    if let Some(existing) = read_image_pinned(&target)? {
        if existing == bytes {
            return Ok(path);
        }
        return Err("weekly.conflict".into());
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "weekly.imageWriteFailed")?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temp = target
        .sibling(&format!("{suffix}.tmp"))
        .map_err(safe_error)?;
    let result = (|| {
        let mut file = temp
            .open(true, true)
            .map_err(safe_error)?
            .ok_or("weekly.imageWriteFailed")?;
        file.write_all(bytes)
            .map_err(|_| "weekly.imageWriteFailed")?;
        file.sync_all().map_err(|_| "weekly.imageWriteFailed")?;
        drop(file);
        temp.publish(&target, false).map_err(safe_error)?;
        target.sync_parent().map_err(safe_error)
    })();
    let cleanup = temp.remove().map_err(safe_error);
    result?;
    cleanup?;
    Ok(path)
}

#[tauri::command]
pub async fn load_weekly_progress(
    root: String,
    week_start: String,
    roots: State<'_, ResearchRoot>,
) -> Result<Option<WeeklyRecord>, String> {
    let root = roots.authorized_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || load(&root, &week_start))
        .await
        .map_err(|_| "weekly.readFailed")?
}

#[tauri::command]
pub async fn list_weekly_progress(
    root: String,
    roots: State<'_, ResearchRoot>,
) -> Result<Vec<WeeklyRecord>, String> {
    let root = roots.authorized_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || list(&root))
        .await
        .map_err(|_| "weekly.readFailed")?
}

#[tauri::command]
pub async fn save_weekly_progress(
    root: String,
    week_start: String,
    markdown: String,
    expected_revision: Option<String>,
    roots: State<'_, ResearchRoot>,
) -> Result<WeeklyRecord, String> {
    let root = roots.authorized_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || {
        save(&root, &week_start, &markdown, expected_revision.as_deref())
    })
    .await
    .map_err(|_| "weekly.writeFailed")?
}

#[tauri::command]
pub async fn resolve_weekly_progress_link(
    root: String,
    path: String,
    roots: State<'_, ResearchRoot>,
) -> Result<String, String> {
    let root = roots.authorized_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || resolve_link(&root, &path))
        .await
        .map_err(|_| "weekly.readFailed")?
}

#[tauri::command]
pub async fn read_weekly_progress_image(
    root: String,
    path: String,
    roots: State<'_, ResearchRoot>,
) -> Result<Vec<u8>, String> {
    let root = roots.authorized_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || read_image(&root, &path))
        .await
        .map_err(|_| "weekly.imageReadFailed")?
}

#[tauri::command]
pub async fn save_weekly_progress_image(
    root: String,
    week_start: String,
    bytes: Vec<u8>,
    roots: State<'_, ResearchRoot>,
) -> Result<String, String> {
    let root = roots.authorized_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || save_image(&root, &week_start, &bytes))
        .await
        .map_err(|_| "weekly.imageWriteFailed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut bytes = [0u8; 12];
            getrandom::fill(&mut bytes).unwrap();
            let name = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
            let path = std::env::temp_dir().join(format!("labweave-weekly-{name}"));
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn weeks_are_real_mondays_and_paths_stay_in_project() {
        for week in ["2026-11-16", "2026-11-23", "2026-12-28", "2024-02-26"] {
            assert!(valid_week(week));
        }
        for week in [
            "2026-11-22",
            "2026-02-30",
            "2026-13-01",
            "../a",
            "２０２６-11-16",
            "2026-+1-16",
        ] {
            assert!(!valid_week(week));
        }
        for path in [
            "../a.md",
            "C:/x.md",
            "/tmp/a.md",
            "a/../b",
            "a/NUL.md",
            "a\\b",
            "a//b",
        ] {
            assert!(relative_path(path).is_err());
        }
    }

    #[test]
    fn only_one_markdown_per_week_and_stale_changes_are_rejected() {
        let dir = Fixture::new();
        fs::write(dir.0.join("large-source.pdf"), b"leave the source alone").unwrap();
        assert!(list(&dir.0).unwrap().is_empty());
        assert!(!dir.0.join(DIRECTORY).exists());
        let first = save(&dir.0, "2026-11-16", "# First\r\n", None).unwrap();
        assert!(save(&dir.0, "2026-11-16", "duplicate", None)
            .unwrap_err()
            .contains("conflict"));
        let next = save(&dir.0, "2026-11-16", "# Updated\r\n", Some(&first.revision)).unwrap();
        assert_ne!(first.revision, next.revision);
        assert!(save(&dir.0, "2026-11-16", "stale", Some(&first.revision)).is_err());
        assert_eq!(fs::read_dir(dir.0.join(DIRECTORY)).unwrap().count(), 1);
        assert!(!dir.0.join(".workbench/history").exists());
        fs::write(dir.0.join(&next.path), "external edit").unwrap();
        assert!(save(&dir.0, "2026-11-16", "overwrite", Some(&next.revision)).is_err());
        assert_eq!(
            load(&dir.0, "2026-11-16").unwrap().unwrap().markdown,
            "external edit"
        );
        assert_eq!(list(&dir.0).unwrap().len(), 1);
        assert_eq!(
            fs::read(dir.0.join("large-source.pdf")).unwrap(),
            b"leave the source alone"
        );
    }

    #[test]
    fn concurrent_updates_have_one_winner_and_old_weeks_stay_unchanged() {
        let dir = Fixture::new();
        let old = save(&dir.0, "2026-11-09", "old week", None).unwrap();
        let record = save(&dir.0, "2026-11-16", "initial", None).unwrap();
        let outcomes = std::thread::scope(|scope| {
            let a = scope.spawn(|| save(&dir.0, "2026-11-16", "one", Some(&record.revision)));
            let b = scope.spawn(|| save(&dir.0, "2026-11-16", "two", Some(&record.revision)));
            [a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(
            outcomes.iter().filter(|result| result.is_ok()).count(),
            1,
            "{outcomes:?}"
        );
        assert_eq!(
            load(&dir.0, "2026-11-09").unwrap().unwrap().revision,
            old.revision
        );
        assert_eq!(list(&dir.0).unwrap()[0].week_start, "2026-11-16");
    }

    #[test]
    fn refuses_symlink_sources() {
        let dir = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("outside.md"), "private").unwrap();
        fs::write(outside.0.join("outside.png"), tiny_png()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.0.join("outside.md"), dir.0.join("link.md")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.0.join("outside.png"), dir.0.join("link.png")).unwrap();
        #[cfg(windows)]
        {
            // Directory junctions exercise Windows reparse-point protection without
            // requiring Developer Mode or the symbolic-link creation privilege.
            let output = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(dir.0.join("linked"))
                .arg(&outside.0)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(resolve_link(&dir.0, "linked/outside.md").is_err());
            assert!(read_image(&dir.0, "linked/outside.png").is_err());
        }
        #[cfg(unix)]
        assert!(resolve_link(&dir.0, "link.md").is_err());
        #[cfg(unix)]
        assert!(read_image(&dir.0, "link.png").is_err());
    }

    fn tiny_png() -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    #[test]
    fn explicit_images_are_deduplicated_and_preserve_original_bytes() {
        let dir = Fixture::new();
        let bytes = tiny_png();
        let first = save_image(&dir.0, "2026-11-16", &bytes).unwrap();
        let second = save_image(&dir.0, "2026-11-16", &bytes).unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("进展记录/周进展/附件/2026-11-16/"));
        assert_eq!(read_image(&dir.0, &first).unwrap(), bytes);
        assert_eq!(
            fs::read_dir(dir.0.join(DIRECTORY).join("附件/2026-11-16"))
                .unwrap()
                .count(),
            1
        );
        assert!(list(&dir.0).unwrap().is_empty());
        assert!(!dir.0.join(".workbench/history").exists());
        assert!(save_image(&dir.0, "2026-11-22", &bytes).is_err());
    }

    #[test]
    fn rejects_oversized_unsupported_and_escaping_image_materials() {
        let dir = Fixture::new();
        assert_eq!(
            image_info(b"<svg onload='bad'>").unwrap_err(),
            "weekly.imageUnsupported"
        );
        let mut huge = tiny_png();
        huge[16..20].copy_from_slice(&10000u32.to_be_bytes());
        huge[20..24].copy_from_slice(&10000u32.to_be_bytes());
        assert_eq!(image_info(&huge).unwrap_err(), "weekly.imageTooLarge");
        assert_eq!(
            image_info(&vec![0; MAX_IMAGE as usize + 1]).unwrap_err(),
            "weekly.imageTooLarge"
        );
        assert!(save_image(&dir.0, "2026-11-16", &huge).is_err());
        assert!(!dir.0.join(DIRECTORY).exists());
        assert!(read_image(&dir.0, "../outside.png").is_err());
        assert!(read_image(&dir.0, "C:/outside.png").is_err());
        fs::write(dir.0.join("note.md"), tiny_png()).unwrap();
        assert!(read_image(&dir.0, "note.md").is_err());
    }

    #[test]
    fn image_headers_support_jpeg_and_webp_without_reencoding() {
        let jpeg = [0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 3, 0, 4, 1];
        assert_eq!(image_info(&jpeg).unwrap(), ("jpg", 4, 3));
        let mut webp = b"RIFF\x16\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0\x03\0\0\x02\0\0".to_vec();
        assert_eq!(image_info(&webp).unwrap(), ("webp", 4, 3));
        webp[12..16].copy_from_slice(b"VP8L");
        webp[20] = 0x2f;
        webp[21..25].copy_from_slice(&(3u32 | (2u32 << 14)).to_le_bytes());
        assert_eq!(image_info(&webp).unwrap(), ("webp", 4, 3));
        let dir = Fixture::new();
        let path = save_image(&dir.0, "2026-11-16", &jpeg).unwrap();
        assert!(path.ends_with(".jpg"));
        assert_eq!(read_image(&dir.0, &path).unwrap(), jpeg);
    }
}
