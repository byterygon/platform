// Generates the plugin's `allow-*`/`deny-*` permissions for each command (Tauri ACL). The app's
// capability decides which windows get them (Ambidex spec §8: only the bundled `main` window).
const COMMANDS: &[&str] = &["connect", "send", "close"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
