fn main() {
    // Wtyczka `secret` (src/secret.rs) jest w tej skrzynce; uprawnienia do jej poleceń generuje build.
    // Wtyczka `bridge` przekazuje polecenia do Kotlina (BridgePlugin.kt); tu tylko ich lista do uprawnień.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "secret",
                tauri_build::InlinedPlugin::new()
                    .commands(&["get", "set", "delete"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "termux",
                tauri_build::InlinedPlugin::new()
                    .commands(&["status", "permission", "open", "run", "save_download"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "bridge",
                tauri_build::InlinedPlugin::new()
                    .commands(&["status", "discover", "scan", "pair", "unpair", "kick", "dismiss", "settings", "perm", "rec"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            ),
    )
    .expect("błąd build.rs");
}
