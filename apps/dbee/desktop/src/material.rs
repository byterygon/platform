//! Window material (TSK-54): real Mica behind the Aurora theme on Windows 11.
//!
//! The Windows build of the app has a transparent main window (`tauri.windows.conf.json`; the
//! page paints its own opaque canvas, so Windows 10 looks as before). At setup the shell asks the
//! OS for Mica ([`Backdrop::apply_mica`]); only when DWM accepted it does it tell the page, with
//! `window.__DBEE_SHELL__ = { material: "mica" }` and a `dbee:shell` event ([`report_script`]).
//! The UI then makes its canvas transparent; it never guesses from the user agent. Windows 10,
//! macOS, Linux and the web server never report a material and keep the gradient/canvas.
//!
//! The setting `windowMaterial` of `settings.json` (written by the UI, default on) is read at
//! start: off means the material is not applied. Turning it off while running takes effect at once
//! in the UI (the opaque canvas covers the material); turning it on again after a start without it
//! needs a restart, because the shell has no IPC command for it (and gets no new Tauri permission).
//!
//! No new crate on other platforms: `window-vibrancy` is Tauri's own dependency; the Windows
//! build names it directly because Tauri's `set_effects` swallows the error and the shell must
//! know whether the material was applied.

use std::path::Path;

/// Event the page listens for after the shell reports its material.
pub const SHELL_EVENT: &str = "dbee:shell";

/// The settings key (in `settings.json`, under `settings`) that turns the material off.
pub const SETTING_KEY: &str = "windowMaterial";

/// A window material the shell applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Material {
    Mica,
}

impl Material {
    pub fn name(self) -> &'static str {
        match self {
            Material::Mica => "mica",
        }
    }
}

/// What the OS can be asked for; fails where the material is unavailable (not Windows 11).
pub trait Backdrop {
    fn apply_mica(&self) -> Result<(), String>;
}

/// Whether the user wants the material: `settings.json` of `workspace` does not say
/// `settings.windowMaterial: false`. A missing or unreadable file means on (the default).
pub fn requested(workspace: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(workspace.join("settings.json")) else {
        return true;
    };
    requested_in(&text)
}

/// [`requested`] for the text of the document.
pub fn requested_in(settings_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()
        .and_then(|doc| doc.pointer(&format!("/settings/{SETTING_KEY}")).cloned())
        != Some(serde_json::Value::Bool(false))
}

/// The material to show: Mica when wanted and the OS accepted it, nothing otherwise.
pub fn choose(requested: bool, backdrop: &impl Backdrop) -> Option<Material> {
    if !requested {
        return None;
    }
    backdrop.apply_mica().ok().map(|()| Material::Mica)
}

/// The script that tells the page which material was applied; `None` when none was.
pub fn report_script(material: Option<Material>) -> Option<String> {
    material.map(|m| {
        format!(
            "window.__DBEE_SHELL__ = {{ material: \"{}\" }}; window.dispatchEvent(new Event(\"{SHELL_EVENT}\"));",
            m.name()
        )
    })
}

/// What the app has applied, kept as managed state for the page loads.
#[derive(Debug, Default)]
pub struct Applied(pub std::sync::Mutex<Option<Material>>);

impl Applied {
    pub fn get(&self) -> Option<Material> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The OS call on the real window: Mica on Windows 11 (build 22000 and later), an error anywhere
/// else.
pub struct WindowBackdrop<'a, R: tauri::Runtime>(pub &'a tauri::WebviewWindow<R>);

impl<R: tauri::Runtime> Backdrop for WindowBackdrop<'_, R> {
    #[cfg(windows)]
    fn apply_mica(&self) -> Result<(), String> {
        window_vibrancy::apply_mica(self.0, None).map_err(|e| e.to_string())
    }

    #[cfg(not(windows))]
    fn apply_mica(&self) -> Result<(), String> {
        Err("window material is only applied on Windows 11".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Result<(), String>);
    impl Backdrop for Fake {
        fn apply_mica(&self) -> Result<(), String> {
            self.0.clone()
        }
    }

    #[test]
    fn mica_only_when_wanted_and_accepted() {
        assert_eq!(choose(true, &Fake(Ok(()))), Some(Material::Mica));
        assert_eq!(choose(false, &Fake(Ok(()))), None);
        assert_eq!(choose(true, &Fake(Err("windows 10".into()))), None);
    }

    #[test]
    fn the_setting_defaults_on_and_only_false_turns_it_off() {
        assert!(requested_in("{}"));
        assert!(requested_in("not json"));
        assert!(requested_in(r#"{"settings":{"preset":"default"}}"#));
        assert!(requested_in(r#"{"settings":{"windowMaterial":true}}"#));
        assert!(!requested_in(r#"{"settings":{"windowMaterial":false}}"#));
        assert!(requested(Path::new("/nonexistent-dbee-workspace")));
    }

    #[test]
    fn requested_reads_settings_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"version":1,"settings":{"windowMaterial":false}}"#,
        )
        .unwrap();
        assert!(!requested(dir.path()));
    }

    #[test]
    fn the_report_names_the_material_and_the_event() {
        assert_eq!(report_script(None), None);
        let script = report_script(Some(Material::Mica)).unwrap();
        assert!(script.contains(r#"material: "mica""#) && script.contains(SHELL_EVENT));
    }

    #[test]
    fn a_non_windows_backdrop_never_applies() {
        if !cfg!(windows) {
            let (_app, window) = {
                use tauri::test::{mock_builder, mock_context, noop_assets};
                let app = mock_builder().build(mock_context(noop_assets())).unwrap();
                let window = tauri::WebviewWindowBuilder::new(&app, "t", Default::default())
                    .build()
                    .unwrap();
                (app, window)
            };
            assert_eq!(choose(true, &WindowBackdrop(&window)), None);
        }
    }
}
