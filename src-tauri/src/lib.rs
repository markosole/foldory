mod ai;
mod ai_cli;
mod app_integrations;
mod assistant_actions;
mod assistant_sources;
mod chat;
mod core;
mod indexing;
mod inspector;
mod inspector_commands;
mod inspector_privacy;
mod integrations;
mod launchers;
mod models;
#[cfg(windows)]
mod runtime_setup;
mod word_document;
mod word_parser;

use core::Core;
use models::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

const LEGACY_APP_IDENTIFIER: &str = "com.deskproject.manager";

fn copy_directory_contents(
    source: &std::path::Path,
    target: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for item in std::fs::read_dir(source)? {
        let item = item?;
        let file_type = item.file_type()?;
        let destination = target.join(item.file_name());
        if file_type.is_dir() {
            copy_directory_contents(&item.path(), &destination)?;
        } else if file_type.is_file() && !destination.exists() {
            std::fs::copy(item.path(), destination)?;
        }
    }
    Ok(())
}

fn migrate_legacy_directory(
    target: std::path::PathBuf,
    marker: &std::path::Path,
) -> std::path::PathBuf {
    if target.join(marker).exists() {
        return target;
    }
    let Some(parent) = target.parent() else {
        return target;
    };
    let legacy = parent.join(LEGACY_APP_IDENTIFIER);
    if !legacy.join(marker).exists() {
        return target;
    }
    if copy_directory_contents(&legacy, &target).is_ok() && target.join(marker).exists() {
        target
    } else {
        legacy
    }
}

struct NativeState {
    core: Arc<Core>,
    ai: Arc<ai::AiState>,
    inspector: inspector_commands::InspectorPreview,
    chat_jobs: chat::ChatJobs,
    assistant_sources: assistant_sources::SourceStore,
    word_parser: word_parser::WordParserStore,
    maintenance: Arc<AtomicBool>,
    reindex: Arc<AtomicBool>,
    force_reindex: Arc<AtomicBool>,
}

async fn work<T, F>(core: Arc<Core>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Core) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || operation(&core))
        .await
        .map_err(|error| format!("The background task could not complete: {error}"))?
}

struct MaintenanceGuard(Arc<AtomicBool>);
impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn acquire(flag: &Arc<AtomicBool>) -> Option<MaintenanceGuard> {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| MaintenanceGuard(flag.clone()))
}

fn decorate(mut data: Bootstrap) -> Bootstrap {
    decorate_settings(&mut data.settings);
    data
}

fn decorate_settings(settings: &mut Settings) {
    settings.normalize_ai_providers();
    for endpoint in &mut settings.ai_providers {
        endpoint.has_key = integrations::has_ai_key(endpoint.provider);
    }
    settings.normalize_ai_providers();
}

fn queue_index(state: &NativeState, app: tauri::AppHandle) {
    state.reindex.store(true, Ordering::Release);
    let Some(guard) = acquire(&state.maintenance) else {
        return;
    };
    let core = state.core.clone();
    let maintenance = state.maintenance.clone();
    let pending = state.reindex.clone();
    let force = state.force_reindex.clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_indexes(&core, &maintenance, &pending, &force, &app, guard);
    });
}

fn process_indexes(
    core: &Core,
    flag: &Arc<AtomicBool>,
    pending: &AtomicBool,
    force: &AtomicBool,
    app: &tauri::AppHandle,
    mut guard: MaintenanceGuard,
) {
    loop {
        pending.store(false, Ordering::Release);
        let explicit = force.swap(false, Ordering::AcqRel);
        if let Err(error) = if explicit {
            core.rebuild_index()
        } else {
            core.refresh_index()
        } {
            let _ = app.emit("maintenance-error", error);
        }
        let _ = app.emit("library-changed", ());
        drop(guard);
        if !pending.load(Ordering::Acquire) {
            break;
        }
        // A source added while a scan was running must be indexed immediately afterwards.
        // Releasing before reacquiring also lets a new caller take responsibility for the queued work.
        let Some(next) = acquire(flag) else {
            break;
        };
        guard = next;
    }
}

#[tauri::command]
async fn bootstrap(state: State<'_, NativeState>) -> Result<Bootstrap, String> {
    work(state.core.clone(), |core| core.bootstrap().map(decorate)).await
}

#[tauri::command]
async fn add_source(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
    path: String,
) -> Result<Bootstrap, String> {
    let result = work(state.core.clone(), move |core| {
        core.add_source(&path).map(decorate)
    })
    .await?;
    queue_index(&state, app);
    Ok(result)
}

#[tauri::command]
async fn set_source_connected(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
    id: String,
    connected: bool,
) -> Result<Bootstrap, String> {
    let jobs = state.chat_jobs.clone();
    let result = work(state.core.clone(), move |core| {
        let data = core.set_source_connected(&id, connected)?;
        jobs.cancel_removed_projects(core);
        Ok(decorate(data))
    })
    .await?;
    if connected {
        queue_index(&state, app);
    }
    Ok(result)
}

#[tauri::command]
async fn remove_source(state: State<'_, NativeState>, id: String) -> Result<Bootstrap, String> {
    let jobs = state.chat_jobs.clone();
    work(state.core.clone(), move |core| {
        let data = core.remove_source(&id)?;
        jobs.cancel_removed_projects(core);
        Ok(decorate(data))
    })
    .await
}

#[tauri::command]
async fn scan_sources(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
) -> Result<Bootstrap, String> {
    let result = work(state.core.clone(), |core| core.scan_sources().map(decorate)).await?;
    queue_index(&state, app);
    Ok(result)
}

#[tauri::command]
async fn update_project(
    state: State<'_, NativeState>,
    id: String,
    patch: ProjectPatch,
) -> Result<Project, String> {
    work(state.core.clone(), move |core| {
        core.update_project(&id, patch)
    })
    .await
}

#[tauri::command]
async fn touch_project(state: State<'_, NativeState>, id: String) -> Result<Project, String> {
    work(state.core.clone(), move |core| core.touch_project(&id)).await
}

#[tauri::command]
async fn create_project(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
    source_id: String,
    name: String,
    template_id: String,
    client: String,
) -> Result<Project, String> {
    let project = work(state.core.clone(), move |core| {
        core.create_project(&source_id, &name, &template_id, &client)
    })
    .await?;
    queue_index(&state, app);
    Ok(project)
}

#[tauri::command]
async fn save_template(
    state: State<'_, NativeState>,
    template: Template,
) -> Result<Template, String> {
    work(state.core.clone(), move |core| core.save_template(template)).await
}

#[tauri::command]
async fn delete_template(state: State<'_, NativeState>, id: String) -> Result<(), String> {
    work(state.core.clone(), move |core| core.delete_template(&id)).await
}

#[tauri::command]
async fn list_directory(
    state: State<'_, NativeState>,
    project_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    work(state.core.clone(), move |core| {
        core.list_directory(&project_id, &path)
    })
    .await
}

#[tauri::command]
async fn preview_file_operation(
    state: State<'_, NativeState>,
    project_id: String,
    request: core::FileOperationRequest,
) -> Result<core::FileOperationPlan, String> {
    work(state.core.clone(), move |core| {
        core.preview_file_operation(&project_id, &request)
    })
    .await
}

#[tauri::command]
async fn execute_file_operation(
    state: State<'_, NativeState>,
    project_id: String,
    request: core::FileOperationRequest,
    confirmation_token: String,
) -> Result<core::FileOperationResult, String> {
    work(state.core.clone(), move |core| {
        core.execute_file_operation(&project_id, &request, &confirmation_token)
    })
    .await
}

#[tauri::command]
async fn read_file(
    state: State<'_, NativeState>,
    project_id: String,
    path: String,
) -> Result<FileDocument, String> {
    work(state.core.clone(), move |core| {
        core.read_file(&project_id, &path)
    })
    .await
}

#[tauri::command]
async fn read_image(
    state: State<'_, NativeState>,
    project_id: String,
    path: String,
) -> Result<String, String> {
    work(state.core.clone(), move |core| {
        core.read_image(&project_id, &path)
    })
    .await
}

#[tauri::command]
async fn write_file(
    state: State<'_, NativeState>,
    project_id: String,
    path: String,
    content: String,
    revision: Option<String>,
    force: bool,
) -> Result<FileDocument, String> {
    work(state.core.clone(), move |core| {
        core.write_file(&project_id, &path, &content, revision.as_deref(), force)
    })
    .await
}

#[tauri::command]
async fn create_entry(
    state: State<'_, NativeState>,
    project_id: String,
    path: String,
    directory: bool,
) -> Result<(), String> {
    work(state.core.clone(), move |core| {
        core.create_entry(&project_id, &path, directory)
    })
    .await
}

#[tauri::command]
async fn search_files(
    state: State<'_, NativeState>,
    query: String,
    project_id: Option<String>,
    mode: String,
) -> Result<Vec<SearchResult>, String> {
    work(state.core.clone(), move |core| {
        core.search_files(&query, project_id.as_deref(), &mode)
    })
    .await
}

#[tauri::command]
async fn rebuild_index(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
) -> Result<IndexStatus, String> {
    state.force_reindex.store(true, Ordering::Release);
    queue_index(&state, app);
    work(state.core.clone(), Core::index_status).await
}

#[tauri::command]
async fn index_status(state: State<'_, NativeState>) -> Result<IndexStatus, String> {
    work(state.core.clone(), Core::index_status).await
}

#[tauri::command]
fn index_defaults() -> IndexSettings {
    indexing::defaults()
}

#[tauri::command]
async fn index_statistics(state: State<'_, NativeState>) -> Result<Vec<ProjectIndexStats>, String> {
    work(state.core.clone(), Core::index_statistics).await
}

#[tauri::command]
async fn search_folders(
    state: State<'_, NativeState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    work(state.core.clone(), move |core| core.search_folders(&query)).await
}

#[tauri::command]
async fn clear_project_index(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
    project_id: String,
) -> Result<IndexStatus, String> {
    let result = work(state.core.clone(), move |core| {
        core.clear_project_index(&project_id)
    })
    .await?;
    let _ = app.emit("library-changed", ());
    Ok(result)
}

#[tauri::command]
async fn reindex_project(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
    project_id: String,
) -> Result<IndexStatus, String> {
    let result = work(state.core.clone(), move |core| {
        core.reindex_project(&project_id)
    })
    .await?;
    let _ = app.emit("library-changed", ());
    Ok(result)
}

#[tauri::command]
async fn save_settings(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
    mut settings: Settings,
) -> Result<Settings, String> {
    decorate_settings(&mut settings);
    let old_indexing = work(state.core.clone(), |core| Ok(core.settings()?.indexing)).await?;
    let mut saved = work(state.core.clone(), move |core| core.save_settings(settings)).await?;
    if old_indexing != saved.indexing {
        queue_index(&state, app);
    }
    decorate_settings(&mut saved);
    Ok(saved)
}

#[tauri::command]
async fn choose_directory() -> Result<Option<String>, String> {
    let selection = rfd::AsyncFileDialog::new()
        .set_title("Choose a project source directory")
        .pick_folder()
        .await;
    Ok(selection.map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[tauri::command]
fn integration_catalog() -> Vec<app_integrations::Manifest> {
    app_integrations::catalog()
}

#[tauri::command]
async fn list_integrations(
    state: State<'_, NativeState>,
) -> Result<Vec<app_integrations::Integration>, String> {
    work(state.core.clone(), app_integrations::list).await
}

#[tauri::command]
async fn save_integration(
    state: State<'_, NativeState>,
    integration: app_integrations::Integration,
) -> Result<app_integrations::Integration, String> {
    work(state.core.clone(), move |core| {
        app_integrations::save(core, integration)
    })
    .await
}

#[tauri::command]
async fn remove_integration(state: State<'_, NativeState>, id: String) -> Result<(), String> {
    work(state.core.clone(), move |core| {
        app_integrations::remove(core, &id)
    })
    .await
}

#[tauri::command]
async fn integration_workspace(
    state: State<'_, NativeState>,
    id: String,
) -> Result<app_integrations::Workspace, String> {
    work(state.core.clone(), move |core| {
        app_integrations::workspace(core, &id)
    })
    .await
}

#[tauri::command]
async fn open_integration_project(
    state: State<'_, NativeState>,
    id: String,
    project_id: String,
) -> Result<(), String> {
    work(state.core.clone(), move |core| {
        app_integrations::open_project(core, &id, &project_id)
    })
    .await
}

#[tauri::command]
async fn choose_integration_file(
    provider_id: String,
    field_key: String,
) -> Result<Option<String>, String> {
    let extensions = app_integrations::file_extensions(&provider_id, &field_key)?;
    let file = rfd::AsyncFileDialog::new()
        .set_title("Choose an integration settings file")
        .add_filter("Settings", &extensions)
        .pick_file()
        .await;
    Ok(file.map(|file| file.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn launch_tool(
    state: State<'_, NativeState>,
    project_id: String,
    tool_id: String,
    path: Option<String>,
) -> Result<(), String> {
    work(state.core.clone(), move |core| {
        integrations::launch_tool(core, &project_id, &tool_id, path.as_deref())
    })
    .await
}

#[tauri::command]
async fn detect_supported_tools() -> Result<launchers::Detection, String> {
    tauri::async_runtime::spawn_blocking(launchers::detect)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn git_info(state: State<'_, NativeState>, project_id: String) -> Result<GitInfo, String> {
    work(state.core.clone(), move |core| {
        integrations::git_info(core, &project_id)
    })
    .await
}

#[tauri::command]
async fn save_ai_key(provider: EndpointProvider, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || integrations::save_ai_key(provider, &key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || integrations::open_external_url(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ask_ai(
    state: State<'_, NativeState>,
    project_id: String,
    prompt: String,
    include_overview: bool,
) -> Result<String, String> {
    let (settings, messages) = work(state.core.clone(), move |core| {
        integrations::prepare_legacy_ai(core, &project_id, &prompt, include_overview)
    })
    .await?;
    integrations::complete_ai(settings, messages).await
}

fn start_maintenance(
    core: &Arc<Core>,
    flag: Arc<AtomicBool>,
    pending: Arc<AtomicBool>,
    force: Arc<AtomicBool>,
    app: tauri::AppHandle,
) {
    let weak = Arc::downgrade(core);
    std::thread::Builder::new()
        .name("project-reconciliation".into())
        .spawn(move || {
            let mut last_run: Option<Instant> = None;
            loop {
                let Some(core) = weak.upgrade() else {
                    break;
                };
                let interval = core
                    .settings()
                    .map(|s| s.scan_interval_seconds)
                    .unwrap_or(120);
                let due = last_run.is_none()
                    || (interval > 0
                        && last_run.is_some_and(|time| {
                            time.elapsed() >= Duration::from_secs((interval as u64).max(30))
                        }));
                if due {
                    if let Some(guard) = acquire(&flag) {
                        if let Err(error) = core.scan_sources() {
                            let _ = app.emit("maintenance-error", error);
                        }
                        process_indexes(&core, &flag, &pending, &force, &app, guard);
                        last_run = Some(Instant::now());
                    }
                }
                drop(core);
                std::thread::sleep(Duration::from_secs(1));
            }
        })
        .expect("Could not start project reconciliation worker");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // This must run before Tauri creates any windows: the setup UI itself cannot
    // depend on the WebView2 runtime it is about to install.
    #[cfg(windows)]
    if !runtime_setup::ensure_runtime() {
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                // The lightweight frontend reveal normally shows the window as
                // soon as the startup shell is parsed. This native fallback
                // guarantees startup still succeeds if that script cannot run.
                let _ = webview.window().show();
                let _ = webview.window().set_focus();
            }
        })
        .setup(|app| {
            let (data_dir, ai_dir) =
                if let Some(override_path) = std::env::var_os("FOLDORY_DATA_DIR") {
                    let path = std::path::PathBuf::from(override_path);
                    if !path.is_absolute() {
                        return Err(std::io::Error::other(
                            "FOLDORY_DATA_DIR must be an absolute directory path.",
                        )
                        .into());
                    }
                    let ai = path.join("ai");
                    (path, ai)
                } else {
                    let data = migrate_legacy_directory(
                        app.path().app_data_dir()?,
                        std::path::Path::new("workspace.sqlite3"),
                    );
                    let local = migrate_legacy_directory(
                        app.path().app_local_data_dir()?,
                        std::path::Path::new("ai"),
                    );
                    (data, local.join("ai"))
                };
            let core = Arc::new(Core::new(data_dir).map_err(std::io::Error::other)?);
            let maintenance = Arc::new(AtomicBool::new(false));
            let reindex = Arc::new(AtomicBool::new(false));
            let force_reindex = Arc::new(AtomicBool::new(false));
            app.manage(NativeState {
                core: core.clone(),
                ai: Arc::new(ai::AiState::new(ai_dir)),
                inspector: inspector_commands::InspectorPreview::default(),
                chat_jobs: chat::ChatJobs::default(),
                assistant_sources: assistant_sources::SourceStore::default(),
                word_parser: word_parser::WordParserStore::default(),
                maintenance: maintenance.clone(),
                reindex: reindex.clone(),
                force_reindex: force_reindex.clone(),
            });
            start_maintenance(
                &core,
                maintenance,
                reindex,
                force_reindex,
                app.handle().clone(),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            integration_catalog,
            list_integrations,
            save_integration,
            remove_integration,
            integration_workspace,
            open_integration_project,
            choose_integration_file,
            bootstrap,
            add_source,
            set_source_connected,
            remove_source,
            scan_sources,
            update_project,
            touch_project,
            create_project,
            save_template,
            delete_template,
            list_directory,
            preview_file_operation,
            execute_file_operation,
            read_file,
            read_image,
            write_file,
            create_entry,
            search_files,
            rebuild_index,
            index_status,
            index_defaults,
            index_statistics,
            search_folders,
            clear_project_index,
            reindex_project,
            save_settings,
            choose_directory,
            launch_tool,
            detect_supported_tools,
            git_info,
            save_ai_key,
            ai::ai_preferences,
            ai::set_ai_selection,
            ai::save_preferred_local_models,
            ai::ai_provider_catalog,
            ai::test_ai_provider,
            ai::open_ai_provider,
            open_external_url,
            inspector_commands::get_inspector_write_access,
            inspector_commands::set_inspector_write_access,
            inspector_commands::draft_project_overview,
            inspector_commands::prepare_inspector_context,
            inspector_commands::discard_inspector_context,
            inspector_commands::apply_project_overview,
            ask_ai,
            chat::list_chats,
            assistant_sources::prepare_assistant_sources,
            assistant_sources::approve_assistant_sources,
            assistant_sources::discard_assistant_sources,
            assistant_sources::examine_file,
            word_parser::prepare_word_document,
            word_parser::parse_word_page,
            word_parser::complete_word_document,
            word_parser::prepare_word_source,
            assistant_actions::get_assistant_access,
            assistant_actions::set_assistant_access,
            assistant_actions::decide_assistant_action,
            chat::create_chat,
            chat::open_chat,
            chat::set_chat_archived,
            chat::get_chat,
            chat::send_chat_message,
            chat::stop_chat,
            chat::delete_chat,
            chat::delete_chat_message
        ])
        .run(tauri::generate_context!())
        .expect("Foldory could not start");
}
