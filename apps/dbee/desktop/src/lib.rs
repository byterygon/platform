//! DBee desktop shell (DBee spec §2, §11; Ambidex spec §4 "Desktop transport", §8 "Desktop
//! authentication"): a Tauri 2 app around the same [`dbee_core::Core`] the web shell serves.
//!
//! - Transport: the `ambidex-tauri` plugin (`plugin:ambidex|connect/send/close`, one Tauri
//!   `Channel` per connection, raw bytes both ways). The capability `capabilities/main.json`
//!   grants it to the bundled `main` window only, `local: true`, no `remote` section; the hub
//!   refuses other webviews as defence in depth.
//! - CSP: `tauri.conf.json` carries [`ambidex_tauri::CSP`] verbatim (`'self'`, the IPC origins,
//!   `worker-src 'self'` for the Arrow Worker, nothing remote); `tests/desktop.rs` pins it.
//! - No network listener: nothing binds a port, `devUrl` is unset, the UI is bundled from
//!   `frontendDist` (a placeholder page until batch 4 points it at `apps/dbee/ui/dist`).
//! - Identity: `human:local:<os-user>` from [`LocalIdentity::from_env`], tenant `local`; the same
//!   Authorizer and audit sink as on web, through the core.
//! - `files.chooseSavePath`: the core opens the native save dialog through [`TauriSaveDialog`]
//!   (`tauri-plugin-dialog`, parented to the main window) and keeps the path behind a one-time
//!   handle; the webview never sees a path it did not ask for.
//! - Window material: on Windows 11 the main window gets Mica when the page's setting allows it
//!   and tells the page, see [`material`].
//! - Cold start: the time from process start to the main webview's first finished page load is
//!   printed on stderr; with `DBEE_COLD_START_EXIT=1` the app then exits, which is how CI
//!   measures it under Xvfb (spec §14).

pub mod material;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use ambidex_tauri::{Builder as AmbidexBuilder, HubConfig, LocalIdentity};
use dbee_core::api::SaveDialog;
use dbee_core::authz::LOCAL_TENANT;
use dbee_core::types::FileFilter;
use dbee_core::{AppMode, Core, CoreConfig, CoreError};
use security_types::{BoxFuture, TenantId};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Label of the one window the capability grants the IPC to.
pub const MAIN_WINDOW: &str = "main";

/// Environment variable: exit right after the first page load, printing the cold-start time.
pub const COLD_START_EXIT_ENV: &str = "DBEE_COLD_START_EXIT";

/// The local human: `human:local:<os-user>` in tenant `local`, no roles (the static Authorizer
/// grants the local human everything).
pub fn local_identity() -> Result<LocalIdentity, ambidex_tauri::InvalidOsUser> {
    LocalIdentity::from_env(TenantId::new(LOCAL_TENANT), vec![])
}

/// A save dialog the core can hold before the Tauri app exists: it forwards to whatever is
/// attached (the native dialog once the app is set up, a fake in tests) and answers "cancelled"
/// while nothing is.
#[derive(Default)]
pub struct LateDialog(RwLock<Option<Arc<dyn SaveDialog>>>);

impl LateDialog {
    pub fn attach(&self, dialog: Arc<dyn SaveDialog>) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = Some(dialog);
    }
}

impl SaveDialog for LateDialog {
    fn choose(
        &self,
        suggested_name: String,
        filters: Vec<FileFilter>,
    ) -> BoxFuture<'static, Option<PathBuf>> {
        let inner = self.0.read().unwrap_or_else(|e| e.into_inner()).clone();
        Box::pin(async move {
            match inner {
                Some(dialog) => dialog.choose(suggested_name, filters).await,
                None => None,
            }
        })
    }
}

/// The native save dialog, parented to the main window.
pub struct TauriSaveDialog<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> SaveDialog for TauriSaveDialog<R> {
    fn choose(
        &self,
        suggested_name: String,
        filters: Vec<FileFilter>,
    ) -> BoxFuture<'static, Option<PathBuf>> {
        let app = self.app.clone();
        Box::pin(async move {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut dialog = app.dialog().file().set_file_name(suggested_name);
            for filter in &filters {
                let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                dialog = dialog.set_parent(&window);
            }
            // The plugin shows the dialog on the main thread and calls back from there.
            dialog.save_file(move |chosen| {
                let _ = tx.send(chosen.and_then(|p| p.into_path().ok()));
            });
            rx.await.ok().flatten()
        })
    }
}

/// The started core and what the Tauri builder needs from it.
pub struct Desktop {
    core: Core,
    dialog: Arc<LateDialog>,
    identity: LocalIdentity,
    started: Instant,
    workspace: PathBuf,
}

impl Desktop {
    /// Starts the core on `workspace` in standalone mode with the late-bound save dialog;
    /// `customize` may replace the secret store, resolver or driver factory (tests).
    pub async fn start(
        workspace: PathBuf,
        identity: LocalIdentity,
        started: Instant,
        customize: impl FnOnce(&mut CoreConfig),
    ) -> Result<Desktop, CoreError> {
        let dialog = Arc::new(LateDialog::default());
        let mut config = CoreConfig::new(workspace.clone(), AppMode::Standalone);
        config.save_dialog = Some(Arc::clone(&dialog) as Arc<dyn SaveDialog>);
        customize(&mut config);
        let core = Core::start(config).await?;
        Ok(Desktop {
            core,
            dialog,
            identity,
            started,
            workspace,
        })
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    pub fn dialog(&self) -> &Arc<LateDialog> {
        &self.dialog
    }

    /// Adds the Ambidex plugin (the core's router and engine configuration), the dialog plugin,
    /// the native save dialog and the cold-start report to `builder`. The core is kept as
    /// managed state for the app's lifetime.
    pub fn configure<R: Runtime>(self, builder: tauri::Builder<R>) -> tauri::Builder<R> {
        let Desktop {
            core,
            dialog,
            identity,
            started,
            workspace,
        } = self;
        let plugin = AmbidexBuilder::new(identity, core.server_config(), core.router())
            .hub_config(HubConfig::default())
            .build();
        let exit_after_load = std::env::var_os(COLD_START_EXIT_ENV).is_some();
        builder
            .plugin(plugin)
            .plugin(tauri_plugin_dialog::init())
            .manage(core)
            .manage(material::Applied::default())
            .setup(move |app| {
                dialog.attach(Arc::new(TauriSaveDialog {
                    app: app.handle().clone(),
                }));
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    let chosen = material::choose(
                        material::requested(&workspace),
                        &material::WindowBackdrop(&window),
                    );
                    *app.state::<material::Applied>()
                        .0
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = chosen;
                }
                Ok(())
            })
            .on_page_load(move |webview, payload| {
                if webview.label() == MAIN_WINDOW && payload.event() == PageLoadEvent::Finished {
                    eprintln!(
                        "dbee-desktop: main page loaded {} ms after process start",
                        started.elapsed().as_millis()
                    );
                    if let Some(script) =
                        material::report_script(webview.state::<material::Applied>().get())
                    {
                        let _ = webview.eval(script);
                    }
                    if exit_after_load {
                        webview.app_handle().exit(0);
                    }
                }
            })
    }
}
