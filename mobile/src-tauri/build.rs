fn main() {
    // Wtyczka `secret` (src/secret.rs) jest w tej skrzynce; uprawnienia do jej poleceń generuje build.
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "secret",
        tauri_build::InlinedPlugin::new()
            .commands(&["get", "set", "delete"])
            .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
    ))
    .expect("błąd build.rs");
}
