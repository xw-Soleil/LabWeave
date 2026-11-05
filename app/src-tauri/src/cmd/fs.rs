use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderEntry {
    name: String,
    is_file: bool,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FolderEntry>>,
}

/// 递归读取文件夹结构，返回嵌套的文件夹结构
#[tauri::command]
pub fn read_folder_structure(path: String) -> FolderEntry {
    let path_buf = std::path::PathBuf::from(&path);
    let name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let mut children = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&path) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                let child_name = entry.file_name().to_string_lossy().to_string();
                let path_str = path.to_string_lossy().to_string();

                if path.is_file() {
                    children.push(FolderEntry {
                        name: child_name,
                        is_file: true,
                        path: path_str,
                        children: None,
                    });
                } else if path.is_dir() {
                    children.push(read_folder_structure(path_str));
                }
            }
        }
    }

    FolderEntry {
        name,
        is_file: false,
        path,
        children: Some(children),
    }
}

/// 读取一个文件夹中的全部文件，递归的读取
/// 如果文件夹不存在，返回空列表
/// fileExts: 要读取的文件扩展名列表，例如：[".txt", ".md"]
#[tauri::command]
pub fn read_folder_recursive(path: String, file_exts: Vec<String>) -> Vec<String> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() {
                    if let Some(file_name) = path.to_str() {
                        if file_exts.iter().any(|ext| file_name.ends_with(ext)) {
                            files.push(file_name.to_string());
                        }
                    }
                } else if path.is_dir() {
                    let mut sub_files = read_folder_recursive(
                        path.to_string_lossy().into_owned(),
                        file_exts.clone(),
                    );
                    files.append(&mut sub_files);
                }
            }
        }
    }
    files
}
