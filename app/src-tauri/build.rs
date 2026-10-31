fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var_os("CARGO_FEATURE_RESEARCH_SHELL").is_some() {
        // capabilities/upstream/ grants permissions for plugins the research build does not register.
        println!("cargo:rerun-if-changed=capabilities");
        attributes = attributes.capabilities_path_pattern("./capabilities/*.json");
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
