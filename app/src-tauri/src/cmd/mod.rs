pub mod device;
pub mod fs;
#[cfg(target_os = "macos")]
pub mod macos_menu;
#[cfg(all(desktop, not(feature = "research-shell")))]
pub mod mcp;
pub mod research;
#[cfg(not(feature = "research-shell"))]
pub mod shell;
