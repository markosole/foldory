use crate::models::*;
use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[path = "file_operations.rs"]
mod file_operations;
pub use file_operations::{FileOperationPlan, FileOperationRequest, FileOperationResult};

type Result<T> = std::result::Result<T, String>;
const MAX_EDIT: u64 = 2 * 1024 * 1024;
const MAX_INDEX_FILE: u64 = 512 * 1024;
const MAX_INDEX_TEXT: usize = 64 * 1024;
const SCHEMA: &str = include_str!("migrations/schema.sql");
const SCHEMA_VERSION: i64 = 1;
/// Development builds stored this same final shape as schema 7.
const PRE_COMMIT_SCHEMA_VERSION: i64 = 7;

pub struct Core {
    pub data_dir: PathBuf,
    db: Mutex<Connection>,
    pub(crate) index: Mutex<IndexStatus>,
    writes: Mutex<()>,
    assistant_action_writes: Mutex<()>,
    pub(crate) index_work: Mutex<()>,
    mutations: Mutex<()>,
    discovery: Mutex<()>,
}

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(err)
}
fn decode<T: DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(err)
}
fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    if let Some(tail) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", tail)
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
}
fn modified(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_millis() as i64)
        .unwrap_or(0)
}
fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn link_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
pub(crate) fn hidden_or_system(name: &str, meta: &fs::Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x6 != 0 {
            return true;
        }
    }
    let _ = meta;
    false
}
pub fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty()
        || name != name.trim()
        || name.len() > 200
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || name == "."
        || name == ".."
    {
        return Err(
            "Use a valid Windows folder or file name without separators, trailing dots or spaces."
                .into(),
        );
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("That name is reserved by Windows.".into());
    }
    Ok(())
}
pub(crate) fn relative(path: &str, allow_empty: bool) -> Result<PathBuf> {
    if path.is_empty() && allow_empty {
        return Ok(PathBuf::new());
    }
    if path.is_empty() || path.starts_with('/') || path.starts_with('\\') || path.contains(':') {
        return Err("A relative path inside the project is required.".into());
    }
    let normal = path.replace('\\', "/");
    if normal
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err("Path traversal and empty path components are not allowed.".into());
    }
    for part in normal.split('/') {
        validate_name(part)?;
    }
    let result = PathBuf::from(normal);
    if result
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid project-relative path.".into());
    }
    Ok(result)
}
fn default_template() -> Template {
    Template { id: "default".into(), name: "Standard project".into(), directories: ["Docs", "Design", "Project info", "Invoices", "Secure/Access", "Secure/Other", "Backups", "App"].iter().map(|s| s.to_string()).collect(), files: vec![TemplateFile { path: "PROJECT.md".into(), content: "# {{name}}\n\n**Client:** {{client}}\n\n## Overview\n\nDescribe the purpose of this project.\n\n## Tasks\n\n- [ ] Define the next step\n\n## Notes\n\n".into() }] }
}

fn migrate_database(db: &Connection) -> Result<()> {
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(err)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(err)?;
    if version == 0 {
        db.execute_batch(SCHEMA)
            .map_err(|error| format!("Cannot create the workspace database: {error}"))?;
        return Ok(());
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    if version == PRE_COMMIT_SCHEMA_VERSION {
        db.execute_batch(&format!("PRAGMA user_version={SCHEMA_VERSION};"))
            .map_err(err)?;
        return Ok(());
    }
    if version > PRE_COMMIT_SCHEMA_VERSION {
        return Err("This workspace database was created by a newer version of Foldory. Update the app before opening it.".into());
    }
    Err("This workspace database is from a pre-release build and cannot be upgraded. Remove workspace.sqlite3 from the app data folder to start with an empty library.".into())
}

impl Core {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data_dir).map_err(|e| format!("Cannot create app data folder: {e}"))?;
        // The installer ships no database. This path is the per-user app-data
        // file; opening it creates an empty workspace.sqlite3 on first launch.
        let db = Connection::open(data_dir.join("workspace.sqlite3")).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(30))
            .map_err(err)?;
        let fresh_database = db
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .map_err(err)?
            == 0;
        migrate_database(&db)?;
        if fresh_database {
            db.execute(
                "INSERT OR IGNORE INTO kv(key,value) VALUES('onboarding.v1','pending')",
                [],
            )
            .map_err(err)?;
        }
        db.create_scalar_function(
            "dpm_lower",
            1,
            rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
                | rusqlite::functions::FunctionFlags::SQLITE_UTF8,
            |context| Ok(context.get::<String>(0)?.to_lowercase()),
        )
        .map_err(err)?;
        db.execute("UPDATE project_indexes SET json=json_set(json,'$.status','error','$.message','The previous indexing pass was interrupted; its committed index is retained.') WHERE json_extract(json,'$.status')='running'", []).map_err(err)?;
        db.execute("UPDATE chat_messages SET status='stopped',content='The app closed before this request finished.' WHERE status='pending'", [])
            .map_err(err)?;
        db.execute("UPDATE chat_file_actions SET status='failed',error='The app closed while this write was in progress. The file may already contain the proposed content; review it before requesting another change.' WHERE status='applying'", []).map_err(err)?;
        db.execute("UPDATE chat_file_actions SET status='failed',error='This assistant response stopped before its file changes were finalized. Request the change again.' WHERE status='pending' AND message_id IN (SELECT id FROM chat_messages WHERE status IN ('stopped','failed'))", []).map_err(err)?;
        db.execute(
            "INSERT OR IGNORE INTO templates(id,json) VALUES(?1,?2)",
            params!["default", encode(&default_template())?],
        )
        .map_err(err)?;
        let mut status: IndexStatus = db
            .query_row("SELECT value FROM kv WHERE key='index'", [], |r| {
                r.get::<_, String>(0)
            })
            .ok()
            .and_then(|v| decode(&v).ok())
            .unwrap_or_default();
        status.running = false;
        Ok(Self {
            data_dir,
            db: Mutex::new(db),
            index: Mutex::new(status),
            writes: Mutex::new(()),
            assistant_action_writes: Mutex::new(()),
            index_work: Mutex::new(()),
            mutations: Mutex::new(()),
            discovery: Mutex::new(()),
        })
    }
    pub(crate) fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| "Database lock failed. Restart the app.".into())
    }
    fn rows<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        let db = self.db()?;
        let mut stmt = db.prepare(sql).map_err(err)?;
        let values = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        values.iter().map(|s| decode(s)).collect()
    }
    pub(crate) fn projects(&self) -> Result<Vec<Project>> {
        self.rows("SELECT p.json FROM projects p JOIN sources s ON s.id=p.source_id WHERE s.connected=1 ORDER BY p.path COLLATE NOCASE")
    }
    fn sources(&self) -> Result<Vec<Source>> {
        Ok(self
            .all_sources()?
            .into_iter()
            .filter(|source| source.connected)
            .collect())
    }
    fn all_sources(&self) -> Result<Vec<Source>> {
        let db = self.db()?;
        let mut stmt = db
            .prepare("SELECT json,connected FROM sources ORDER BY path COLLATE NOCASE")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        rows.into_iter()
            .map(|(json, connected)| {
                let mut source: Source = decode(&json)?;
                source.connected = connected;
                Ok(source)
            })
            .collect()
    }
    pub fn project(&self, project_id: &str) -> Result<Project> {
        let json = self
            .db()?
            .query_row(
                "SELECT p.json FROM projects p JOIN sources s ON s.id=p.source_id WHERE p.id=?1 AND s.connected=1",
                [project_id],
                |r| r.get::<_, String>(0),
            )
            .map_err(|_| "Project not found. Refresh your library.".to_string())?;
        decode(&json)
    }
    fn put_project(&self, project: &Project) -> Result<()> {
        self.db()?.execute("INSERT INTO projects(id,source_id,path,json) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json,path=excluded.path", params![project.id,project.source_id,project.path,encode(project)?]).map_err(err)?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Settings> {
        let value = self
            .db()?
            .query_row("SELECT value FROM kv WHERE key='settings'", [], |r| {
                r.get::<_, String>(0)
            })
            .ok();
        // Existing libraries predate the wizard. Only a fresh library should
        // automatically open setup; saved false explicitly means unfinished.
        let legacy_settings = value.as_ref().is_some_and(|json| {
            serde_json::from_str::<serde_json::Value>(json)
                .is_ok_and(|settings| settings.get("onboardingCompleted").is_none())
        });
        let first_run_pending = self
            .db()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM kv WHERE key='onboarding.v1')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(err)?;
        let existing_sources =
            value.is_none() && !first_run_pending && !self.all_sources()?.is_empty();
        let mut settings: Settings = value
            .map(|s| decode(&s))
            .unwrap_or_else(|| Ok(Settings::default()))?;
        if legacy_settings || existing_sources {
            settings.onboarding_completed = true;
        }
        settings.normalize_ai_providers();
        Ok(settings)
    }
    pub fn save_settings(&self, mut settings: Settings) -> Result<Settings> {
        settings.normalize_ai_providers();
        settings.inspector.validate()?;
        settings.files.validate()?;
        crate::indexing::validate_settings(&settings.indexing)?;
        if settings.tools.len() > 100
            || settings.tools.iter().any(|t| {
                t.name.trim().is_empty()
                    || t.executable.trim().is_empty()
                    || t.args.len() > 100
                    || t.executable.contains(['\n', '\r', '\0'])
            })
        {
            return Err("Tools need a name, executable and a bounded argument list.".into());
        }
        let mut ids = HashSet::new();
        for tool in &settings.tools {
            if tool.id.is_empty()
                || !ids.insert(tool.id.to_lowercase())
                || [
                    "explorer",
                    "cmd",
                    "powershell",
                    "cursor",
                    "claude",
                    "codex",
                    "open",
                    "default",
                ]
                .contains(&tool.id.to_lowercase().as_str())
                || crate::launchers::parse_launcher_id(&tool.id.to_lowercase()).is_some()
            {
                return Err("Tool IDs must be unique and cannot replace built-in actions.".into());
            }
        }
        if settings.scan_interval_seconds != 0 {
            settings.scan_interval_seconds = settings.scan_interval_seconds.clamp(30, 3600);
        }
        let mut endpoint_ids = HashSet::new();
        if settings
            .ai_providers
            .iter()
            .any(|provider| !endpoint_ids.insert(provider.provider))
        {
            return Err("AI providers must be unique.".into());
        }
        if settings.ai_providers.iter().any(|provider| {
            provider.base_url.len() > 2000
                || provider.model.len() > 200
                || provider.base_url.contains(['\r', '\n', '\0'])
                || provider.model.chars().any(char::is_control)
        }) {
            return Err("AI endpoint or model is too long.".into());
        }
        self.db()?.execute("INSERT INTO kv(key,value) VALUES('settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [encode(&settings)?]).map_err(err)?;
        Ok(settings)
    }
    pub fn bootstrap(&self) -> Result<Bootstrap> {
        Ok(Bootstrap {
            sources: self.all_sources()?,
            projects: self.projects()?,
            templates: self.rows("SELECT json FROM templates ORDER BY id='default' DESC,id")?,
            settings: self.settings()?,
            index_status: self.index_status()?,
        })
    }
    pub fn add_source(&self, path: &str) -> Result<Bootstrap> {
        let guard = self.discovery.lock().map_err(err)?;
        let supplied = PathBuf::from(path.trim());
        if !supplied.is_absolute() {
            return Err("Choose an existing absolute source directory.".into());
        }
        let canonical = supplied
            .canonicalize()
            .map_err(|e| format!("Cannot open source directory: {e}"))?;
        if !canonical.is_dir() {
            return Err("Project source must be a directory.".into());
        }
        let normalized = display_path(&canonical);
        let cmp = normalized.trim_end_matches(['\\', '/']).to_lowercase();
        for mut source in self.all_sources()? {
            let other = source.path.trim_end_matches(['\\', '/']).to_lowercase();
            if cmp == other {
                let connected: bool = self
                    .db()?
                    .query_row(
                        "SELECT connected FROM sources WHERE id=?1",
                        [&source.id],
                        |row| row.get(0),
                    )
                    .map_err(err)?;
                if connected {
                    return Err("This source is already connected.".into());
                }
                source.available = true;
                source.connected = true;
                self.db()?
                    .execute(
                        "UPDATE sources SET connected=1,json=?2 WHERE id=?1",
                        params![source.id, encode(&source)?],
                    )
                    .map_err(err)?;
                drop(guard);
                return self.scan_sources();
            }
            if cmp.starts_with(&format!("{other}\\"))
                || other.starts_with(&format!("{cmp}\\"))
                || cmp.starts_with(&format!("{other}/"))
                || other.starts_with(&format!("{cmp}/"))
            {
                return Err(
                    "This source overlaps an existing source. Choose separate root folders.".into(),
                );
            }
        }
        let source = Source {
            id: id(),
            path: normalized,
            name: canonical
                .file_name()
                .unwrap_or(canonical.as_os_str())
                .to_string_lossy()
                .to_string(),
            available: true,
            connected: true,
        };
        self.db()?
            .execute(
                "INSERT INTO sources(id,path,json) VALUES(?1,?2,?3)",
                params![source.id, source.path, encode(&source)?],
            )
            .map_err(err)?;
        drop(guard);
        self.scan_sources()
    }
    pub fn set_source_connected(&self, source_id: &str, connected: bool) -> Result<Bootstrap> {
        let _discovery = self.discovery.lock().map_err(err)?;
        let _guard = self.mutations.lock().map_err(err)?;
        let json: String = self
            .db()?
            .query_row("SELECT json FROM sources WHERE id=?1", [source_id], |row| {
                row.get(0)
            })
            .map_err(|_| "Saved source not found.".to_string())?;
        let mut source: Source = decode(&json)?;
        source.connected = connected;
        if !connected {
            source.available = false;
        }
        self.db()?
            .execute(
                "UPDATE sources SET connected=?2,json=?3 WHERE id=?1",
                params![source_id, connected, encode(&source)?],
            )
            .map_err(err)?;
        drop(_guard);
        drop(_discovery);
        if connected {
            self.scan_sources()
        } else {
            self.bootstrap()
        }
    }
    pub fn remove_source(&self, source_id: &str) -> Result<Bootstrap> {
        let _discovery = self.discovery.lock().map_err(err)?;
        let _guard = self.mutations.lock().map_err(err)?;
        let mut db = self.db()?;
        let tx = db.transaction().map_err(err)?;
        tx.execute("DELETE FROM file_contents WHERE project_id IN (SELECT id FROM projects WHERE source_id=?1)",[source_id]).map_err(err)?;
        let removed = tx
            .execute("DELETE FROM sources WHERE id=?1", [source_id])
            .map_err(err)?;
        if removed == 0 {
            return Err("Saved source not found.".into());
        }
        tx.commit().map_err(err)?;
        drop(db);
        self.bootstrap()
    }
    pub fn scan_sources(&self) -> Result<Bootstrap> {
        let _discovery = self.discovery.lock().map_err(err)?;
        let sources = self.sources()?;
        let projects = self.projects()?;
        for mut source in sources {
            let entries = fs::read_dir(&source.path);
            source.available = entries.is_ok();
            self.db()?
                .execute(
                    "UPDATE sources SET json=?2 WHERE id=?1",
                    params![source.id, encode(&source)?],
                )
                .map_err(err)?;
            let mut seen = HashSet::new();
            if let Ok(entries) = entries {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = entry.file_name().to_string_lossy().to_string();
                    let Ok(meta) = fs::symlink_metadata(&path) else {
                        continue;
                    };
                    if !meta.is_dir() || link_or_reparse(&meta) || hidden_or_system(&name, &meta) {
                        continue;
                    }
                    let path = display_path(&path);
                    let key = path.to_lowercase();
                    seen.insert(key.clone());
                    let _guard = self.mutations.lock().map_err(err)?;
                    let source_exists: bool = self
                        .db()?
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM sources WHERE id=?1)",
                            [&source.id],
                            |r| r.get(0),
                        )
                        .map_err(err)?;
                    if !source_exists {
                        continue;
                    }
                    let existing = self
                        .db()?
                        .query_row(
                            "SELECT json FROM projects WHERE path=?1 COLLATE NOCASE",
                            [&path],
                            |r| r.get::<_, String>(0),
                        )
                        .ok();
                    let mut project = existing
                        .map(|json| decode::<Project>(&json))
                        .transpose()?
                        .unwrap_or_else(|| Project {
                            id: id(),
                            source_id: source.id.clone(),
                            path: path.clone(),
                            name: name.clone(),
                            alias: String::new(),
                            client: String::new(),
                            tags: vec![],
                            color: "#a7b4d5".into(),
                            pinned: false,
                            hidden: false,
                            last_opened: 0,
                            modified_at: modified(&meta),
                            available: true,
                        });
                    project.available = true;
                    project.modified_at = modified(&meta);
                    project.name = name;
                    self.put_project(&project)?;
                }
            }
            for old in projects
                .iter()
                .filter(|p| p.source_id == source.id && !seen.contains(&p.path.to_lowercase()))
            {
                let _guard = self.mutations.lock().map_err(err)?;
                let Ok(mut p) = self.project(&old.id) else {
                    continue;
                };
                p.available = false;
                self.put_project(&p)?;
            }
        }
        self.bootstrap()
    }
    pub fn update_project(&self, project_id: &str, patch: ProjectPatch) -> Result<Project> {
        let _guard = self.mutations.lock().map_err(err)?;
        let mut p = self.project(project_id)?;
        if let Some(v) = patch.alias {
            if v.len() > 300 {
                return Err("Alias is too long.".into());
            }
            p.alias = v.trim().into();
        }
        if let Some(v) = patch.client {
            if v.len() > 300 {
                return Err("Client is too long.".into());
            }
            p.client = v.trim().into();
        }
        if let Some(v) = patch.tags {
            if v.len() > 50 || v.iter().any(|t| t.len() > 100) {
                return Err("Use at most 50 short tags.".into());
            }
            p.tags = v
                .into_iter()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
        }
        if let Some(v) = patch.color {
            if v.len() != 7 || !v.starts_with('#') || !v[1..].chars().all(|c| c.is_ascii_hexdigit())
            {
                return Err("Choose a valid hexadecimal colour.".into());
            }
            p.color = v;
        }
        if let Some(v) = patch.pinned {
            p.pinned = v;
        }
        if let Some(v) = patch.hidden {
            p.hidden = v;
        }
        self.put_project(&p)?;
        Ok(p)
    }
    pub fn touch_project(&self, project_id: &str) -> Result<Project> {
        let _guard = self.mutations.lock().map_err(err)?;
        let mut p = self.project(project_id)?;
        p.last_opened = now();
        self.put_project(&p)?;
        Ok(p)
    }
    fn validate_template(template: &Template) -> Result<()> {
        if template.name.trim().is_empty()
            || template.name.len() > 200
            || template.directories.len() + template.files.len() > 1000
        {
            return Err("Template needs a name and at most 1,000 entries.".into());
        }
        let mut paths = HashSet::new();
        let mut files = HashSet::new();
        if template
            .files
            .iter()
            .map(|file| file.content.len())
            .sum::<usize>()
            > 8 * 1024 * 1024
        {
            return Err("Template contents must total no more than 8 MiB.".into());
        }
        for dir in &template.directories {
            relative(dir, false)?;
            if !paths.insert(dir.replace('\\', "/").to_lowercase()) {
                return Err("Template has duplicate paths.".into());
            }
        }
        for file in &template.files {
            relative(&file.path, false)?;
            let path = file.path.replace('\\', "/").to_lowercase();
            if !paths.insert(path.clone()) {
                return Err("Template has duplicate paths.".into());
            }
            files.insert(path);
            if file.content.len() > MAX_EDIT as usize {
                return Err("Template file exceeds 2 MiB.".into());
            }
        }
        for path in &paths {
            let parts: Vec<_> = path.split('/').collect();
            for i in 1..parts.len() {
                if files.contains(&parts[..i].join("/")) {
                    return Err("A template file cannot also be a parent directory.".into());
                }
            }
        }
        Ok(())
    }
    pub fn save_template(&self, mut template: Template) -> Result<Template> {
        Self::validate_template(&template)?;
        if template.id.is_empty() {
            template.id = id();
        }
        self.db()?.execute("INSERT INTO templates(id,json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json",params![template.id,encode(&template)?]).map_err(err)?;
        Ok(template)
    }
    pub fn delete_template(&self, template_id: &str) -> Result<()> {
        if template_id == "default" {
            return Err("Keep the standard template; you can edit it or create another.".into());
        }
        self.db()?
            .execute("DELETE FROM templates WHERE id=?1", [template_id])
            .map_err(err)?;
        Ok(())
    }
    pub fn create_project(
        &self,
        source_id: &str,
        name: &str,
        template_id: &str,
        client: &str,
    ) -> Result<Project> {
        let _discovery = self.discovery.lock().map_err(err)?;
        validate_name(name)?;
        if client.len() > 300 {
            return Err("Client name is too long.".into());
        }
        let source = self
            .sources()?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or("Source not found.")?;
        let template: Template = decode(
            &self
                .db()?
                .query_row(
                    "SELECT json FROM templates WHERE id=?1",
                    [template_id],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|_| "Template not found.")?,
        )?;
        Self::validate_template(&template)?;
        let root = PathBuf::from(&source.path)
            .canonicalize()
            .map_err(|e| format!("Source is unavailable: {e}"))?;
        let destination = root.join(name);
        fs::create_dir(&destination)
            .map_err(|e| format!("Cannot create project; the folder may already exist: {e}"))?;
        let result = (|| -> Result<()> {
            for dir in &template.directories {
                fs::create_dir_all(destination.join(relative(dir, false)?)).map_err(err)?;
            }
            for file in &template.files {
                let path = destination.join(relative(&file.path, false)?);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(err)?;
                }
                let content = file
                    .content
                    .replace("{{name}}", name)
                    .replace("{{client}}", client);
                let mut handle = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map_err(err)?;
                handle.write_all(content.as_bytes()).map_err(err)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&destination);
            return Err(format!("Project creation failed: {error}"));
        }
        let p = Project {
            id: id(),
            source_id: source.id,
            path: display_path(&destination),
            name: name.into(),
            alias: String::new(),
            client: client.trim().into(),
            tags: vec![],
            color: "#a7b4d5".into(),
            pinned: false,
            hidden: false,
            last_opened: now(),
            modified_at: now(),
            available: true,
        };
        self.put_project(&p)?;
        Ok(p)
    }
    pub fn validated_path(&self, project_id: &str, path: &str) -> Result<PathBuf> {
        let p = self.project(project_id)?;
        let root = PathBuf::from(&p.path);
        let root_meta =
            fs::symlink_metadata(&root).map_err(|e| format!("Project is unavailable: {e}"))?;
        if link_or_reparse(&root_meta) {
            return Err("Linked project folders are not followed.".into());
        }
        let root = root.canonicalize().map_err(err)?;
        if display_path(&root) != p.path {
            return Err("The registered project folder has been redirected.".into());
        }
        let rel = relative(path, true)?;
        let mut cursor = root.clone();
        for component in rel.components() {
            cursor.push(component.as_os_str());
            let meta = fs::symlink_metadata(&cursor)
                .map_err(|e| format!("Cannot access {}: {e}", display_path(&cursor)))?;
            if link_or_reparse(&meta) {
                return Err("Symbolic links and junctions are not followed.".into());
            }
        }
        let canonical = cursor.canonicalize().map_err(err)?;
        if !canonical.starts_with(&root) {
            return Err("Path is outside the project.".into());
        }
        Ok(canonical)
    }
    fn new_path(&self, project_id: &str, path: &str) -> Result<PathBuf> {
        let rel = relative(path, false)?;
        let parent = rel.parent().unwrap_or(Path::new(""));
        let parent_path =
            self.validated_path(project_id, &parent.to_string_lossy().replace('\\', "/"))?;
        if !parent_path.is_dir() {
            return Err("Parent is not a directory.".into());
        }
        Ok(parent_path.join(rel.file_name().ok_or("A file name is required.")?))
    }
    pub fn list_directory(&self, project_id: &str, path: &str) -> Result<Vec<FileEntry>> {
        let directory = self.validated_path(project_id, path)?;
        let policy = crate::assistant_sources::SourcePolicy::new(self, project_id);
        let mut entries = vec![];
        for entry in fs::read_dir(directory).map_err(err)? {
            let entry = entry.map_err(err)?;
            let meta = fs::symlink_metadata(entry.path()).map_err(err)?;
            if link_or_reparse(&meta) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = if path.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", path.trim_end_matches('/'), name)
            };
            let ai_exclusion_reason = match &policy {
                Ok(policy) => policy.reason(&rel, meta.is_dir()).unwrap_or_else(|error| {
                    Some(format!("AI exclusion rules could not be checked: {error}"))
                }),
                Err(error) => Some(format!("AI exclusion rules could not be checked: {error}")),
            };
            entries.push(FileEntry {
                name,
                path: rel,
                directory: meta.is_dir(),
                size: meta.len(),
                modified_at: modified(&meta),
                ai_excluded: ai_exclusion_reason.is_some(),
                ai_exclusion_reason,
            });
            if entries.len() >= 20_000 {
                return Err(
                    "This folder has more than 20,000 entries. Open it in Explorer.".into(),
                );
            }
        }
        entries.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }
    pub fn read_image(&self, project_id: &str, path: &str) -> Result<String> {
        use base64::Engine;
        const LIMIT: u64 = 32 * 1024 * 1024;
        let target = self.validated_path(project_id, path)?;
        let extension = target
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["png", "jpg", "jpeg"].contains(&extension.as_str()) {
            return Err("Image previews support PNG and JPEG files.".into());
        }
        let meta = fs::metadata(&target).map_err(err)?;
        if !meta.is_file() || meta.len() > LIMIT {
            return Err(
                "Choose an image up to 32 MiB, or open it in an external application.".into(),
            );
        }
        let mut bytes = Vec::new();
        fs::File::open(target)
            .map_err(err)?
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > LIMIT as usize {
            return Err("Image grew beyond the 32 MiB preview limit.".into());
        }
        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            "image/jpeg"
        } else {
            return Err("This file does not contain a PNG or JPEG image.".into());
        };
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    pub fn read_file(&self, project_id: &str, path: &str) -> Result<FileDocument> {
        let target = self.validated_path(project_id, path)?;
        let meta = fs::metadata(&target).map_err(err)?;
        if !meta.is_file() {
            return Err("Select a text file to edit.".into());
        }
        if meta.len() > MAX_EDIT {
            return Err(
                "This file exceeds the 2 MiB editor limit. Open it in an external application."
                    .into(),
            );
        }
        let mut bytes = Vec::new();
        fs::File::open(target)
            .map_err(err)?
            .take(MAX_EDIT + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > MAX_EDIT as usize {
            return Err("File grew beyond the editor limit.".into());
        }
        if bytes.contains(&0) {
            return Err(
                "Binary files cannot be edited here. Open in an external application.".into(),
            );
        }
        let content = String::from_utf8(bytes.clone())
            .map_err(|_| "This file is not UTF-8 text. Open it in an external application.")?;
        Ok(FileDocument {
            path: path.replace('\\', "/"),
            content,
            revision: revision(&bytes),
        })
    }
    pub fn write_file(
        &self,
        project_id: &str,
        path: &str,
        content: &str,
        expected_revision: Option<&str>,
        force: bool,
    ) -> Result<FileDocument> {
        if content.len() > MAX_EDIT as usize {
            return Err("File exceeds the 2 MiB editor limit.".into());
        }
        if content.contains('\0') {
            return Err("Binary content is not supported.".into());
        }
        let _guard = self.writes.lock().map_err(err)?;
        let target = self.new_path(project_id, path)?;
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                let current = self.read_file(project_id, path)?;
                if !force && expected_revision != Some(current.revision.as_str()) {
                    return Err(
                        "CONFLICT: This file changed on disk. Reload it or explicitly overwrite it."
                            .into(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if expected_revision.is_some() && !force {
                    return Err(
                        "CONFLICT: This file was removed on disk. Reload or explicitly overwrite it."
                            .into(),
                    );
                }
            }
            Err(error) => return Err(err(error)),
        }
        let parent = target.parent().ok_or("A parent directory is required.")?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".foldory-")
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(err)?;
        temporary.write_all(content.as_bytes()).map_err(err)?;
        temporary.as_file().sync_all().map_err(err)?;
        if !force && expected_revision.is_none() {
            temporary.persist_noclobber(&target).map_err(|error| {
                if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                    "CONFLICT: This file was created on disk. Reload it before saving.".into()
                } else {
                    format!("Could not create the file atomically: {}", error.error)
                }
            })?;
        } else {
            if !force
                && self.read_file(project_id, path)?.revision.as_str()
                    != expected_revision.unwrap_or_default()
            {
                return Err(
                    "CONFLICT: This file changed on disk. Reload it or explicitly overwrite it."
                        .into(),
                );
            }
            temporary.persist(&target).map_err(|error| {
                format!("Could not replace the file atomically: {}", error.error)
            })?;
        }
        Ok(FileDocument {
            path: path.replace('\\', "/"),
            content: content.into(),
            revision: revision(content.as_bytes()),
        })
    }
    pub fn create_entry(&self, project_id: &str, path: &str, directory: bool) -> Result<()> {
        let target = self.new_path(project_id, path)?;
        if directory {
            fs::create_dir(target).map_err(err)
        } else {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map(|_| ())
                .map_err(err)
        }
    }
    /// Validate an existing or future target without creating anything. Every
    /// existing component must remain an unlinked path inside the project.
    pub(crate) fn assistant_destination(&self, project_id: &str, path: &str) -> Result<PathBuf> {
        let relative = relative(path, false)?;
        let root = self.validated_path(project_id, "")?;
        let mut current = root.clone();
        let mut prefix = PathBuf::new();
        let mut components = relative.components().peekable();
        while let Some(component) = components.next() {
            prefix.push(component.as_os_str());
            current.push(component.as_os_str());
            match fs::symlink_metadata(&current) {
                Ok(meta) => {
                    if link_or_reparse(&meta) {
                        return Err("Symbolic links and junctions are not followed.".into());
                    }
                    if components.peek().is_some() && !meta.is_dir() {
                        return Err("A parent path is not a directory.".into());
                    }
                    self.validated_path(project_id, &prefix.to_string_lossy().replace('\\', "/"))?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(err(error)),
            }
        }
        Ok(root.join(relative))
    }
    pub(crate) fn write_assistant_file(
        &self,
        project_id: &str,
        path: &str,
        content: &str,
        expected_revision: Option<&str>,
    ) -> Result<FileDocument> {
        self.assistant_destination(project_id, path)?;
        let relative = relative(path, false)?;
        let parent = relative.parent().unwrap_or(Path::new(""));
        let mut prefix = PathBuf::new();
        for component in parent.components() {
            prefix.push(component.as_os_str());
            let prefix = prefix.to_string_lossy().replace('\\', "/");
            match self.validated_path(project_id, &prefix) {
                Ok(existing) if existing.is_dir() => {}
                Ok(_) => return Err("A parent path is not a directory.".into()),
                Err(_) => {
                    if let Err(error) = self.create_entry(project_id, &prefix, true) {
                        match self.validated_path(project_id, &prefix) {
                            Ok(existing) if existing.is_dir() => {}
                            _ => return Err(error),
                        }
                    }
                }
            }
        }
        self.write_file(project_id, path, content, expected_revision, false)
    }
    pub(crate) fn lock_project_mutations(&self) -> Result<MutexGuard<'_, ()>> {
        self.mutations.lock().map_err(err)
    }
    pub(crate) fn lock_assistant_actions(&self) -> Result<MutexGuard<'_, ()>> {
        self.assistant_action_writes.lock().map_err(err)
    }
}
pub(crate) fn indexed_content(path: &Path, name: &str, size: u64) -> Result<(String, bool)> {
    let lower = name.to_lowercase();
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let sensitive = lower.starts_with(".env")
        || lower.contains("credential")
        || lower.contains("secret")
        || lower.contains("password")
        || lower == "id_rsa"
        || lower == "id_ed25519"
        || ["pem", "p12", "pfx", "key", "kdbx"].contains(&extension.as_str());
    if sensitive || !text_extension(&lower) || size > MAX_INDEX_FILE {
        return Ok((String::new(), false));
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect {}: {e}", path.display()))?;
    if link_or_reparse(&meta) {
        return Err("File changed to a link while indexing.".into());
    }
    let file = fs::File::open(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_INDEX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let after = fs::symlink_metadata(path).map_err(err)?;
    if link_or_reparse(&after)
        || meta.len() != after.len()
        || meta.modified().ok() != after.modified().ok()
    {
        return Err(format!(
            "{} changed during indexing; it will be retried.",
            path.display()
        ));
    }
    if bytes.len() > MAX_INDEX_FILE as usize || bytes.contains(&0) {
        return Ok((String::new(), false));
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok((String::new(), false));
    };
    let mut boundary = text.len().min(MAX_INDEX_TEXT);
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    Ok((text[..boundary].to_string(), boundary < text.len()))
}

fn text_extension(name: &str) -> bool {
    matches!(name, "readme" | "license" | "makefile" | "dockerfile")
        || name
            .rsplit('.')
            .next()
            .map(|ext| {
                matches!(
                    ext,
                    "md" | "mdx"
                        | "txt"
                        | "js"
                        | "jsx"
                        | "ts"
                        | "tsx"
                        | "json"
                        | "html"
                        | "htm"
                        | "css"
                        | "scss"
                        | "sass"
                        | "less"
                        | "rs"
                        | "py"
                        | "cpp"
                        | "cc"
                        | "c"
                        | "h"
                        | "hpp"
                        | "cs"
                        | "java"
                        | "go"
                        | "rb"
                        | "php"
                        | "vue"
                        | "svelte"
                        | "toml"
                        | "yaml"
                        | "yml"
                        | "xml"
                        | "sql"
                        | "sh"
                        | "ps1"
                        | "bat"
                        | "ini"
                        | "cfg"
                        | "csv"
                        | "log"
                        | "dart"
                        | "kt"
                        | "kts"
                        | "swift"
                        | "scala"
                        | "lua"
                        | "r"
                        | "ex"
                        | "exs"
                        | "erl"
                        | "hrl"
                        | "clj"
                        | "cljs"
                        | "hs"
                        | "lhs"
                        | "fs"
                        | "fsx"
                        | "f90"
                        | "pl"
                        | "pm"
                        | "cmake"
                        | "gradle"
                        | "groovy"
                        | "tex"
                        | "rst"
                        | "adoc"
                        | "properties"
                )
            })
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_presets_migrate_legacy_connections_and_persist_independent_edits() {
        use crate::models::{AiEndpointSettings, EndpointProvider};
        let temp = tempfile::tempdir().unwrap();
        let core = Core::new(temp.path().to_path_buf()).unwrap();
        let mut settings = core.settings().unwrap();
        settings.ai_providers = vec![
            AiEndpointSettings::new(EndpointProvider::Local, false, "http://localhost:4321/v1"),
            AiEndpointSettings::new(EndpointProvider::Unsloth, true, "http://localhost:8889/v1"),
            AiEndpointSettings::new(
                EndpointProvider::Custom,
                true,
                "https://custom.example.test/v1",
            ),
        ];
        settings.ai_providers[1].model = "my-local-model".into();
        let mut saved = core.save_settings(settings).unwrap();
        assert_eq!(saved.ai_providers.len(), 10);
        assert_eq!(saved.ai_base_url, "http://localhost:4321/v1");
        assert_eq!(
            saved.endpoint(EndpointProvider::Unsloth).unwrap().model,
            "my-local-model"
        );
        assert_eq!(
            saved.endpoint(EndpointProvider::Custom).unwrap().base_url,
            "https://custom.example.test/v1"
        );
        for endpoint in &mut saved.ai_providers {
            if endpoint.provider == EndpointProvider::Openai {
                endpoint.enabled = true;
                endpoint.base_url = "https://gateway.example.test/v1".into();
                endpoint.model = "my-cloud-model".into();
            }
        }
        core.save_settings(saved).unwrap();
        drop(core);
        let reopened = Core::new(temp.path().to_path_buf()).unwrap();
        let saved = reopened.settings().unwrap();
        assert!(saved.endpoint(EndpointProvider::Openai).unwrap().enabled);
        assert_eq!(
            saved.endpoint(EndpointProvider::Openai).unwrap().model,
            "my-cloud-model"
        );
        assert_eq!(
            saved.endpoint(EndpointProvider::Openai).unwrap().base_url,
            "https://gateway.example.test/v1"
        );
        assert!(!saved.endpoint(EndpointProvider::Groq).unwrap().enabled);
        let mut duplicated = saved.clone();
        duplicated.ai_providers.push(saved.ai_providers[0].clone());
        assert!(reopened
            .save_settings(duplicated)
            .unwrap_err()
            .contains("unique"));
    }

    #[test]
    fn onboarding_tracks_fresh_libraries_and_survives_configuration_and_restart() {
        let temp = tempfile::tempdir().unwrap();
        let core = Core::new(temp.path().join("data")).unwrap();
        assert!(!core.settings().unwrap().onboarding_completed);
        let projects = temp.path().join("projects");
        fs::create_dir_all(projects.join("Sample")).unwrap();
        core.add_source(projects.to_str().unwrap()).unwrap();
        drop(core);
        let core = Core::new(temp.path().join("data")).unwrap();
        assert!(!core.settings().unwrap().onboarding_completed);
        let mut settings = core.settings().unwrap();
        settings.onboarding_completed = true;
        settings.default_template_id = "default".into();
        core.save_settings(settings).unwrap();
        drop(core);
        let core = Core::new(temp.path().join("data")).unwrap();
        assert!(core.settings().unwrap().onboarding_completed);
        assert_eq!(core.settings().unwrap().default_template_id, "default");
    }

    #[test]
    fn onboarding_does_not_interrupt_legacy_users() {
        let temp = tempfile::tempdir().unwrap();
        let core = Core::new(temp.path().to_path_buf()).unwrap();
        let mut legacy = serde_json::to_value(Settings::default()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("onboardingCompleted");
        legacy.as_object_mut().unwrap().remove("defaultTemplateId");
        core.db()
            .unwrap()
            .execute(
                "INSERT INTO kv(key,value) VALUES('settings',?1)",
                [legacy.to_string()],
            )
            .unwrap();
        assert!(core.settings().unwrap().onboarding_completed);
        assert!(core.settings().unwrap().default_template_id.is_empty());
        core.db()
            .unwrap()
            .execute(
                "DELETE FROM kv WHERE key IN ('settings', 'onboarding.v1')",
                [],
            )
            .unwrap();
        let projects = temp.path().join("projects");
        fs::create_dir_all(projects.join("Sample")).unwrap();
        core.add_source(projects.to_str().unwrap()).unwrap();
        assert!(core.settings().unwrap().onboarding_completed);
    }

    #[test]
    fn fresh_install_creates_an_empty_workspace_database() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workspace.sqlite3");
        assert!(
            !path.exists(),
            "first launch must create the database; it is not shipped with the app"
        );
        let core = Core::new(temp.path().to_path_buf()).unwrap();
        assert!(path.is_file());
        let data = core.bootstrap().unwrap();
        assert!(data.sources.is_empty());
        assert!(data.projects.is_empty());
        assert!(data.settings.tools.is_empty());
        assert!(data.settings.ai_model.is_empty());
        assert!(!data.settings.ai_has_key);
        assert_eq!(data.templates.len(), 1);
        assert_eq!(data.templates[0].id, "default");
        assert_eq!(data.templates[0].name, "Standard project");
        let db = core.db().unwrap();
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        for table in [
            "sources",
            "projects",
            "files",
            "file_contents",
            "project_indexes",
            "chats",
            "chat_messages",
            "chat_selection",
            "chat_message_sources",
            "chat_file_actions",
            "assistant_access",
            "inspector_write_access",
        ] {
            let count: i64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} must be empty on first launch");
        }
        let saved_library: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM kv WHERE key='settings' OR key LIKE 'integration.v1.%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(saved_library, 0);
        drop(db);
        let reopened = Core::new(temp.path().to_path_buf()).unwrap();
        let again = reopened.bootstrap().unwrap();
        assert!(again.sources.is_empty());
        assert!(again.projects.is_empty());
        assert_eq!(again.templates.len(), 1);
    }

    #[test]
    fn pre_commit_schema_seven_is_accepted_and_older_builds_are_refused() {
        let current = tempfile::tempdir().unwrap();
        let core = Core::new(current.path().to_path_buf()).unwrap();
        core.db()
            .unwrap()
            .execute_batch("PRAGMA user_version=7;")
            .unwrap();
        drop(core);
        let reopened = Core::new(current.path().to_path_buf()).unwrap();
        let version: i64 = reopened
            .db()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(reopened.bootstrap().unwrap().templates.len(), 1);

        let legacy = tempfile::tempdir().unwrap();
        let db = Connection::open(legacy.path().join("workspace.sqlite3")).unwrap();
        db.execute_batch("PRAGMA user_version=4;").unwrap();
        drop(db);
        match Core::new(legacy.path().to_path_buf()) {
            Err(error) => assert!(error.contains("pre-release"), "{error}"),
            Ok(_) => panic!("a pre-release database must not be opened"),
        }

        let newer = tempfile::tempdir().unwrap();
        let db = Connection::open(newer.path().join("workspace.sqlite3")).unwrap();
        db.execute_batch("PRAGMA user_version=8;").unwrap();
        drop(db);
        match Core::new(newer.path().to_path_buf()) {
            Err(error) => assert!(error.contains("newer version"), "{error}"),
            Ok(_) => panic!("a newer database must not be opened"),
        }
    }

    #[test]
    fn inspector_settings_persist_valid_profiles_and_reject_an_unknown_default() {
        let temp = tempfile::tempdir().unwrap();
        let core = Core::new(temp.path().into()).unwrap();
        let mut settings = core.settings().unwrap();
        settings.inspector.output_tokens = 60_000;
        settings.inspector.timeout_minutes = 70;
        settings.inspector.profiles.push(InspectorProfile {
            id: "handover".into(),
            name: "Handover".into(),
            prompt: "Draft a handover.".into(),
            templates: vec!["## Runbook".into(), "## Contacts".into()],
        });
        settings.inspector.default_profile_id = "handover".into();
        core.save_settings(settings.clone()).unwrap();
        settings.inspector.default_profile_id = "missing".into();
        assert!(core.save_settings(settings).is_err());
        drop(core);
        let stored = Core::new(temp.path().into())
            .unwrap()
            .settings()
            .unwrap()
            .inspector;
        assert_eq!(stored.output_tokens, 60_000);
        assert_eq!(stored.timeout_minutes, 70);
        assert_eq!(stored.default_profile_id, "handover");
        assert_eq!(stored.profiles[1].templates, ["## Runbook", "## Contacts"]);
    }
    #[test]
    fn supported_launcher_preferences_migrate_persist_and_gate_launches() {
        let (_dir, core, _source, project) = fixture();
        let mut legacy = serde_json::to_value(Settings::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("supportedTools");
        let migrated: Settings = serde_json::from_value(legacy).unwrap();
        assert!(migrated.supported_tools.cursor.enabled);
        assert!(migrated.supported_tools.cursor.desktop);
        assert!(!migrated.supported_tools.codex.enabled);
        let mut settings = migrated;
        settings.supported_tools.cursor.enabled = false;
        settings.supported_tools.codex.enabled = true;
        settings.supported_tools.codex.cli = true;
        core.save_settings(settings.clone()).unwrap();
        let stored = core.settings().unwrap();
        assert!(!stored.supported_tools.cursor.enabled);
        assert!(stored.supported_tools.codex.cli);
        assert!(!stored.supported_tools.codex.desktop);
        for id in ["cursor", "cursor-desktop", "codex-desktop", "claude-cli"] {
            let error = crate::integrations::launch_tool(&core, &project.id, id, None).unwrap_err();
            assert!(error.contains("disabled"));
        }
        for id in ["codex-cli", "Claude-Desktop", "CURSOR"] {
            settings.tools = vec![Tool {
                id: id.into(),
                name: "Custom".into(),
                executable: "editor.exe".into(),
                args: vec![],
            }];
            assert!(core.save_settings(settings.clone()).is_err());
        }
    }

    fn fixture() -> (tempfile::TempDir, Core, Source, Project) {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("projects");
        fs::create_dir_all(source.join("Alpha")).unwrap();
        let core = Core::new(dir.path().join("data")).unwrap();
        let data = core.add_source(source.to_str().unwrap()).unwrap();
        (dir, core, data.sources[0].clone(), data.projects[0].clone())
    }
    #[test]
    fn metadata_survives_scans_and_restarts() {
        let (dir, core, _, p) = fixture();
        core.update_project(
            &p.id,
            ProjectPatch {
                alias: Some("💡 Alpha".into()),
                pinned: Some(true),
                client: Some("Client".into()),
                ..Default::default()
            },
        )
        .unwrap();
        core.scan_sources().unwrap();
        let data_dir = core.data_dir.clone();
        drop(core);
        let reopened = Core::new(data_dir).unwrap();
        let p = reopened.project(&p.id).unwrap();
        assert_eq!(p.alias, "💡 Alpha");
        assert!(p.pinned);
        assert!(dir.path().join("projects/Alpha").exists());
    }
    #[test]
    fn templates_validate_and_create_without_overwrite() {
        let (_dir, core, s, _) = fixture();
        let p = core
            .create_project(&s.id, "Beta", "default", "Acme")
            .unwrap();
        assert!(Path::new(&p.path).join("Secure/Access").is_dir());
        assert!(core
            .read_file(&p.id, "PROJECT.md")
            .unwrap()
            .content
            .contains("Acme"));
        assert!(core.create_project(&s.id, "Beta", "default", "").is_err());
        for name in ["../Escape", "CON", "trailing.", "bad:name", "."] {
            assert!(core.create_project(&s.id, name, "default", "").is_err());
        }
        let t = Template {
            id: String::new(),
            name: "bad".into(),
            directories: vec!["../escape".into()],
            files: vec![],
        };
        assert!(core.save_template(t).is_err());
    }
    #[test]
    fn file_conflict_and_boundaries() {
        let (_dir, core, _, p) = fixture();
        core.create_entry(&p.id, "note.md", false).unwrap();
        let f = core.read_file(&p.id, "note.md").unwrap();
        let saved = core
            .write_file(&p.id, "note.md", "first", Some(&f.revision), false)
            .unwrap();
        fs::write(Path::new(&p.path).join("note.md"), "external").unwrap();
        assert!(core
            .write_file(&p.id, "note.md", "second", Some(&saved.revision), false)
            .unwrap_err()
            .starts_with("CONFLICT"));
        assert_eq!(
            core.read_file(&p.id, "note.md").unwrap().content,
            "external"
        );
        core.write_file(&p.id, "note.md", "override", Some(&saved.revision), true)
            .unwrap();
        assert!(core.read_file(&p.id, "../escape").is_err());
        assert!(core.create_entry(&p.id, "/absolute", false).is_err());
    }
    #[test]
    fn image_previews_read_supported_local_files_and_enforce_boundaries() {
        let (_dir, core, _, project) = fixture();
        let root = Path::new(&project.path);
        fs::write(root.join("small.PNG"), b"\x89PNG\r\n\x1a\nexample").unwrap();
        fs::write(root.join("small.jpeg"), [0xff, 0xd8, 0xff, 0xe0]).unwrap();
        assert!(core
            .read_image(&project.id, "small.PNG")
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(core
            .read_image(&project.id, "small.jpeg")
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        fs::write(root.join("invalid.png"), "This is text").unwrap();
        assert!(core.read_image(&project.id, "invalid.png").is_err());
        assert!(core.read_image(&project.id, "../outside.png").is_err());
        assert!(core.read_image(&project.id, "PROJECT.md").is_err());
        fs::File::create(root.join("large.png"))
            .unwrap()
            .set_len(32 * 1024 * 1024 + 1)
            .unwrap();
        assert!(core
            .read_image(&project.id, "large.png")
            .unwrap_err()
            .contains("32 MiB"));
    }
    #[test]
    fn file_preferences_migrate_validate_and_survive_restart() {
        let (_dir, core, _, _) = fixture();
        let mut legacy = serde_json::to_value(Settings::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("files");
        let migrated: Settings = serde_json::from_value(legacy).unwrap();
        assert!(migrated.files.remember_session);
        assert_eq!(migrated.files.editor_font_size, 12);
        assert_eq!(migrated.files.preview_font_size, 13);
        let mut settings = core.settings().unwrap();
        settings.files.preview_layout = "full".into();
        settings.files.preview_width = 1200;
        settings.files.preview_font_size = 46;
        settings.files.restore_open_files = false;
        core.save_settings(settings.clone()).unwrap();
        settings.files.editor_font_size = 47;
        assert!(core.save_settings(settings.clone()).is_err());
        settings.files.editor_font_size = 12;
        settings.files.default_mode = "invalid".into();
        assert!(core.save_settings(settings).is_err());
        let data_dir = core.data_dir.clone();
        drop(core);
        let saved = Core::new(data_dir).unwrap().settings().unwrap().files;
        assert_eq!(saved.preview_layout, "full");
        assert_eq!(saved.preview_width, 1200);
        assert_eq!(saved.preview_font_size, 46);
        assert!(!saved.restore_open_files);
    }
    #[test]
    fn index_search_excludes_private_content_and_ignores() {
        let (_dir, core, _, p) = fixture();
        let root = Path::new(&p.path);
        fs::write(root.join("visible.md"), "uniqueorange project guide").unwrap();
        fs::create_dir(root.join("Secure")).unwrap();
        fs::write(root.join("Secure/passwords.txt"), "hiddenorange").unwrap();
        fs::write(root.join("credentials.txt"), "hiddenorange").unwrap();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("ignored.txt"), "ignoreorange").unwrap();
        core.rebuild_index().unwrap();
        assert_eq!(
            core.search_files("uniqueorange", None, "content")
                .unwrap()
                .len(),
            1
        );
        assert!(core
            .search_files("hiddenorange", None, "content")
            .unwrap()
            .is_empty());
        assert!(core
            .search_files("ignoreorange", None, "content")
            .unwrap()
            .is_empty());
        assert_eq!(
            core.search_files("visible", Some(&p.id), "filename")
                .unwrap()
                .len(),
            1
        );
        fs::remove_file(root.join("visible.md")).unwrap();
        core.rebuild_index().unwrap();
        assert!(core
            .search_files("visible", None, "filename")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn source_disconnect_stays_saved_across_restart_and_reconnects() {
        let (_dir, core, s, p) = fixture();
        let path = PathBuf::from(&p.path);
        let data_dir = core.data_dir.clone();
        core.update_project(
            &p.id,
            ProjectPatch {
                alias: Some("Saved name".into()),
                pinned: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let disconnected = core.set_source_connected(&s.id, false).unwrap();
        assert!(path.exists());
        assert_eq!(disconnected.sources.len(), 1);
        assert!(!disconnected.sources[0].connected);
        assert!(disconnected.projects.is_empty());
        assert!(core.project(&p.id).is_err());
        drop(core);

        let core = Core::new(data_dir).unwrap();
        let saved = core.bootstrap().unwrap();
        assert_eq!(saved.sources.len(), 1);
        assert!(!saved.sources[0].connected);
        assert!(saved.projects.is_empty());

        let reconnected = core.set_source_connected(&s.id, true).unwrap();
        assert_eq!(reconnected.sources[0].id, s.id);
        assert_eq!(reconnected.projects[0].id, p.id);
        assert_eq!(reconnected.projects[0].alias, "Saved name");
        assert!(reconnected.projects[0].pinned);
    }
    #[test]
    fn source_data_is_deleted_only_when_requested() {
        let (_dir, core, source, project) = fixture();
        core.remove_source(&source.id).unwrap();
        assert!(core.project(&project.id).is_err());

        let reconnected = core.add_source(&source.path).unwrap();
        assert_ne!(reconnected.sources[0].id, source.id);
        assert_ne!(reconnected.projects[0].id, project.id);
    }
    #[test]
    fn overlapping_sources_and_binary_files_rejected() {
        let (_dir, core, s, p) = fixture();
        assert!(core.add_source(&s.path).is_err());
        assert!(core.add_source(&p.path).is_err());
        fs::write(Path::new(&p.path).join("binary.bin"), [0u8, 1, 2]).unwrap();
        assert!(core.read_file(&p.id, "binary.bin").is_err());
    }
    #[test]
    fn offline_source_preserves_annotations() {
        let (dir, core, source, project) = fixture();
        core.update_project(
            &project.id,
            ProjectPatch {
                pinned: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let offline = dir.path().join("temporarily-offline");
        fs::rename(&source.path, &offline).unwrap();
        let data = core.scan_sources().unwrap();
        assert!(!data.sources[0].available);
        assert!(!data.projects[0].available);
        assert!(data.projects[0].pinned);
        fs::rename(&offline, &source.path).unwrap();
        let data = core.scan_sources().unwrap();
        assert!(data.projects[0].available);
        assert!(data.projects[0].pinned);
    }
    #[test]
    fn directory_listing_and_template_paths_are_bounded() {
        let (_dir, core, _, p) = fixture();
        core.create_entry(&p.id, "a.txt", false).unwrap();
        core.create_entry(&p.id, "ZFolder", true).unwrap();
        let entries = core.list_directory(&p.id, "").unwrap();
        assert!(entries[0].directory);
        assert_eq!(entries[0].name, "ZFolder");
        for path in [
            "../x",
            "a/../../x",
            r"C:\outside",
            r"\\server\share",
            r"folder\..\x",
            "NUL.txt",
            "bad:stream",
            "a//b",
        ] {
            assert!(
                core.create_entry(&p.id, path, false).is_err(),
                "accepted {path}"
            );
        }
        let invalid = Template {
            id: String::new(),
            name: "Conflict".into(),
            directories: vec!["docs".into()],
            files: vec![TemplateFile {
                path: "DOCS".into(),
                content: String::new(),
            }],
        };
        assert!(core.save_template(invalid).is_err());
    }
    #[test]
    fn index_rescans_changes_and_disconnected_source_has_no_search_rows() {
        let (_dir, core, s, p) = fixture();
        let path = Path::new(&p.path).join("change.md");
        fs::write(&path, "oldcontent").unwrap();
        core.rebuild_index().unwrap();
        core.rebuild_index().unwrap();
        fs::write(&path, "newcontent-longer").unwrap();
        core.rebuild_index().unwrap();
        assert!(core
            .search_files("oldcontent", None, "content")
            .unwrap()
            .is_empty());
        assert_eq!(
            core.search_files("newcontent", None, "content")
                .unwrap()
                .len(),
            1
        );
        for query in ["\"", "()", "NOT", "a OR b", "%_", "тест"] {
            assert!(
                core.search_files(query, None, "content").is_ok(),
                "query failed {query}"
            );
        }
        core.set_source_connected(&s.id, false).unwrap();
        assert!(core
            .search_files("newcontent", None, "content")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn concurrent_scan_does_not_overwrite_project_annotations() {
        let (_dir, core, _, p) = fixture();
        let core = std::sync::Arc::new(core);
        let scanner = core.clone();
        let worker = std::thread::spawn(move || {
            for _ in 0..20 {
                scanner.scan_sources().unwrap();
            }
        });
        for index in 0..20 {
            core.update_project(
                &p.id,
                ProjectPatch {
                    alias: Some(format!("Alias {index}")),
                    ..Default::default()
                },
            )
            .unwrap();
            core.touch_project(&p.id).unwrap();
        }
        worker.join().unwrap();
        let project = core.project(&p.id).unwrap();
        assert_eq!(project.alias, "Alias 19");
        assert!(project.last_opened > 0);
    }
    #[test]
    fn concurrent_project_creation_and_scan_preserve_one_identity() {
        let (_dir, core, source, _) = fixture();
        let core = std::sync::Arc::new(core);
        let scanner = core.clone();
        let worker = std::thread::spawn(move || {
            for _ in 0..20 {
                scanner.scan_sources().unwrap();
            }
        });
        let mut created = Vec::new();
        for index in 0..10 {
            created.push(
                core.create_project(&source.id, &format!("Created {index}"), "default", "Client")
                    .unwrap(),
            );
        }
        worker.join().unwrap();
        let data = core.scan_sources().unwrap();
        assert_eq!(data.projects.len(), 11);
        for project in created {
            assert_eq!(
                data.projects
                    .iter()
                    .find(|p| p.path == project.path)
                    .unwrap()
                    .id,
                project.id
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn windows_junctions_are_not_discovered_read_written_or_indexed() {
        use std::os::windows::process::CommandExt;
        let (dir, core, source, project) = fixture();
        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("external.md"), "junctionprivatecontent").unwrap();
        let linked = Path::new(&project.path).join("linked");
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&linked)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Could not create test junction: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(core.read_file(&project.id, "linked/external.md").is_err());
        assert!(core
            .write_file(&project.id, "linked/external.md", "changed", None, true)
            .is_err());
        assert!(core
            .create_entry(&project.id, "linked/created.md", false)
            .is_err());
        core.rebuild_index().unwrap();
        assert!(core
            .search_files("junctionprivatecontent", None, "content")
            .unwrap()
            .is_empty());
        let source_link = Path::new(&source.path).join("LinkedProject");
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&source_link)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(core.scan_sources().unwrap().projects.len(), 1);
        assert_eq!(
            fs::read_to_string(outside.join("external.md")).unwrap(),
            "junctionprivatecontent"
        );
    }
    #[test]
    #[ignore = "Synthetic performance fixture; run explicitly with --ignored --nocapture"]
    fn synthetic_index_benchmark() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        fs::create_dir(&source).unwrap();
        let count = std::env::var("DPM_BENCH_FILES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(10_000)
            .clamp(1, 1_000_000);
        for index in 0..count {
            let project = source.join(format!("Project-{:03}", index / (count / 100).max(1)));
            fs::create_dir_all(&project).unwrap();
            fs::write(project.join(format!("file-{index:06}.md")),format!("# File {index}\n\nneedlebenchmarkcontent for searchable project documentation.\n")).unwrap();
        }
        let core = Core::new(directory.path().join("data")).unwrap();
        let begin = std::time::Instant::now();
        core.add_source(source.to_str().unwrap()).unwrap();
        let discovery = begin.elapsed();
        let begin = std::time::Instant::now();
        let first = core.rebuild_index().unwrap();
        let first_time = begin.elapsed();
        assert_eq!(first.files, count as u64);
        let begin = std::time::Instant::now();
        core.refresh_index().unwrap();
        let warm_time = begin.elapsed();
        let begin = std::time::Instant::now();
        let result = core
            .search_files("needlebenchmarkcontent", None, "content")
            .unwrap();
        let search_time = begin.elapsed();
        let last_name = format!("file-{:06}.md", count - 1);
        assert_eq!(
            core.search_files(&last_name, None, "filename")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(result.len(), count.min(150));
        println!("BENCH {count} files: discovery={discovery:?}, first_index={first_time:?}, warm_index={warm_time:?}, content_search={search_time:?}");
    }
}
