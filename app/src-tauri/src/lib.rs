#[cfg(debug_assertions)]
mod cli_desktop_acceptance;
mod cmd;
#[cfg(target_os = "windows")]
mod custom_drag_drop;
mod local_agent;
#[cfg(target_os = "macos")]
mod macos_resize_cursor;
mod project_ownership;
pub mod project_reference_store;
mod project_runtime_bridge;

pub mod ownership_helper {
    pub use crate::project_ownership::{
        acquire_project_ownership, try_acquire_project_ownership, CanonicalProjectPath,
        ProjectOwner, ProjectOwnership, ProjectOwnershipError,
    };
}

use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Manager, State};

#[cfg(target_os = "linux")]
use std::path::Path;

pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Files the OS asked us to open (macOS Finder double-click / "Open With").
/// Until the frontend has called `take_pending_open_files` they are queued here; afterwards they
/// are emitted as `open-file-from-os` events.
#[derive(Default)]
struct PendingOpenFiles(Mutex<PendingOpenFilesState>);

#[derive(Default)]
struct PendingOpenFilesState {
    files: Vec<String>,
    taken: bool,
}

#[tauri::command]
fn take_pending_open_files(state: State<PendingOpenFiles>) -> Vec<String> {
    let mut guard = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.taken = true;
    std::mem::take(&mut guard.files)
}

#[cfg(target_os = "macos")]
fn handle_os_open_urls(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    use tauri::Emitter;

    // Deep links (rwb://) also arrive as Opened events; tauri-plugin-deep-link handles those.
    let paths: Vec<String> = urls
        .iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("prg"))
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let state = app.state::<PendingOpenFiles>();
    {
        let mut guard = state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !guard.taken {
            guard.files.extend(paths);
            return;
        }
    }
    for path in paths {
        if let Err(error) = app.emit("open-file-from-os", &path) {
            eprintln!("[open-file-from-os] failed to forward {path}: {error}");
        }
    }
}

#[tauri::command]
fn write_stdout(content: String) {
    println!("{}", content);
}

#[tauri::command]
fn write_stderr(content: String) {
    eprintln!("{}", content);
}

#[tauri::command]
async fn exit(state: State<'_, local_agent::LocalAgentManager>, code: i32) -> Result<(), String> {
    let manager = state.inner().clone();
    if let Err(error) = tauri::async_runtime::spawn_blocking(move || manager.stop_all())
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result)
    {
        eprintln!("[local-agent] 退出时清理失败: {error}");
    }
    std::process::exit(code);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 在 Linux 上禁用 DMA-BUF 渲染器
    // 否则无法在 Linux 上运行
    // 相同的bug: https://github.com/tauri-apps/tauri/issues/10702
    #[cfg(target_os = "linux")]
    {
        if Path::new("/proc/driver/nvidia/gpus").exists() {
            std::env::set_var("__GL_THREADED_OPTIMIZATIONS", "0");
            std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
        }
    }

    let app = tauri::Builder::default()
        .manage(PendingOpenFiles::default())
        .manage(Arc::new(
            project_ownership::DesktopProjectOwnershipManager::default(),
        ))
        .manage(cmd::research::ResearchRoot::default())
        .manage(local_agent::LocalAgentManager::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                macos_resize_cursor::install(&window)?;
            }
            app.manage(project_runtime_bridge::ProjectRuntimeBridgeManager::start(
                app.handle().clone(),
            )?);
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(tauri_plugin_devtools::init())?;
                if let Some(window) = app.handle().get_webview_window("main") {
                    let _ = window.show();
                }
            }
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_cli::init())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle().plugin(tauri_plugin_system_info::init())?;
                app.handle()
                    .plugin(tauri_plugin_window_state::Builder::new().build())?;
            }
            #[cfg(target_os = "windows")]
            custom_drag_drop::install(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "macos")]
            cmd::macos_menu::style_macos_menu_icons,
            cmd::device::get_device_id,
            #[cfg(debug_assertions)]
            cli_desktop_acceptance::load_cli_desktop_acceptance_manifest,
            #[cfg(debug_assertions)]
            cli_desktop_acceptance::write_cli_desktop_acceptance_state,
            #[cfg(debug_assertions)]
            cli_desktop_acceptance::wait_for_cli_desktop_acceptance_completion,
            write_stdout,
            write_stderr,
            exit,
            take_pending_open_files,
            project_ownership::acquire_desktop_project_ownership,
            project_ownership::acquire_desktop_project_ownership_for_save,
            project_ownership::make_desktop_project_ownership_connectable,
            project_ownership::release_desktop_project_ownership,
            project_reference_store::load_project_reference_snapshot,
            project_reference_store::save_project_reference_snapshot,
            project_runtime_bridge::respond_project_runtime_bridge,
            cmd::research::set_research_root,
            cmd::research::authorize_research_project,
            cmd::research::external_ai_mcp_launch,
            cmd::research::read_clipboard_file_paths,
            local_agent::local_agent_catalog,
            local_agent::local_agent_start,
            local_agent::local_agent_write,
            local_agent::local_agent_stop,
            local_agent::local_agent_open_terminal,
            // Called by "generate from folder" and the recent-files folder import.
            cmd::fs::read_folder_structure,
            cmd::fs::read_folder_recursive,
            cmd::device::get_distribution,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Err(error) = app_handle
                .state::<local_agent::LocalAgentManager>()
                .stop_all()
            {
                eprintln!("[local-agent] 退出时清理失败: {error}");
            }
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            handle_os_open_urls(app_handle, urls);
        }
    });
}
