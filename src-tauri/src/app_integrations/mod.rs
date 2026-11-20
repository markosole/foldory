//! App integrations are independent of library sources, launchers and AI credentials.
//! Providers declare capabilities and configuration; the host owns lifecycle and storage.
mod cursor;

use crate::core::{now, Core};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

type Result<T> = std::result::Result<T, String>;
const PREFIX: &str = "integration.v1.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigField {
    key: String,
    label: String,
    kind: String,
    default_value: String,
    help: String,
    extensions: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    id: String,
    name: String,
    description: String,
    config_version: u32,
    capabilities: Vec<String>,
    permissions: Vec<String>,
    fields: Vec<ConfigField>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub id: String,
    pub provider_id: String,
    pub name: String,
    pub enabled: bool,
    pub config_version: u32,
    pub config: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub groups: Vec<Group>,
    pub warnings: Vec<String>,
    pub checked_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub projects: Vec<WorkspaceProject>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
    pub path_status: String,
    pub path_message: String,
}

trait Provider: Sync {
    fn manifest(&self) -> Manifest;
    fn validate(&self, config: &Value) -> Result<()>;
    fn workspace(&self, _config: &Value) -> Result<Workspace> {
        Err("This integration does not provide a project workspace.".into())
    }
}

// The only provider registration point. UI and lifecycle never branch on provider IDs.
static PROVIDERS: &[&dyn Provider] = &[&cursor::Cursor];

pub fn catalog() -> Vec<Manifest> {
    PROVIDERS
        .iter()
        .map(|provider| provider.manifest())
        .collect()
}

fn provider(id: &str) -> Result<&'static dyn Provider> {
    PROVIDERS
        .iter()
        .copied()
        .find(|p| p.manifest().id == id)
        .ok_or_else(|| {
            "This integration provider is not installed. You can remove its saved connection."
                .into()
        })
}

fn key(id: &str) -> Result<String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid integration ID.".to_string())?;
    Ok(format!("{PREFIX}{id}"))
}

pub fn list(core: &Core) -> Result<Vec<Integration>> {
    let db = core.db()?;
    let mut stmt = db
        .prepare("SELECT value FROM kv WHERE key LIKE 'integration.v1.%' ORDER BY key")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(
            serde_json::from_str::<Integration>(&row.map_err(|e| e.to_string())?)
                .map_err(|_| "A saved integration configuration could not be read.".to_string())?,
        );
    }
    result.sort_by_key(|item| item.name.to_lowercase());
    Ok(result)
}

fn get(core: &Core, id: &str) -> Result<Integration> {
    let json: Option<String> = core
        .db()?
        .query_row("SELECT value FROM kv WHERE key=?1", [key(id)?], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json.ok_or("Integration not found.")?)
        .map_err(|_| "Saved integration configuration could not be read.".into())
}

pub fn save(core: &Core, mut item: Integration) -> Result<Integration> {
    let storage_key = key(&item.id)?;
    item.name = item.name.trim().into();
    if item.name.is_empty() || item.name.len() > 160 {
        return Err("Give this integration a name of up to 160 bytes.".into());
    }
    let adapter = provider(&item.provider_id)?;
    if item.config_version != adapter.manifest().config_version {
        return Err("This integration configuration version is not supported.".into());
    }
    adapter.validate(&item.config)?;
    let json = serde_json::to_string(&item).map_err(|e| e.to_string())?;
    if json.len() > 64 * 1024 {
        return Err("Integration configuration is too large.".into());
    }
    // Per-instance rows avoid lost updates with other settings and integrations.
    core.db()?.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [&storage_key, &json]).map_err(|e| e.to_string())?;
    Ok(item)
}

pub fn remove(core: &Core, id: &str) -> Result<()> {
    core.db()?
        .execute("DELETE FROM kv WHERE key=?1", [key(id)?])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn workspace(core: &Core, id: &str) -> Result<Workspace> {
    let item = get(core, id)?;
    if !item.enabled {
        return Err("This integration is disabled. Enable it in Settings → Integrations.".into());
    }
    let adapter = provider(&item.provider_id)?;
    if item.config_version != adapter.manifest().config_version {
        return Err("This integration configuration version is not supported.".into());
    }
    adapter.validate(&item.config)?;
    adapter.workspace(&item.config)
}

fn project_directory(core: &Core, id: &str, project_id: &str) -> Result<std::path::PathBuf> {
    // Resolve the opaque project ID from the saved provider, never a renderer-supplied path.
    let project = workspace(core, id)?
        .groups
        .into_iter()
        .flat_map(|g| g.projects)
        .find(|p| p.id == project_id)
        .ok_or("Project no longer exists in this integration. Refresh the workspace.")?;
    let path = Path::new(&project.path);
    if project.path_status != "available" || !path.is_absolute() || !path.is_dir() {
        return Err(
            "The project folder is unavailable. Reconnect its drive and refresh the workspace."
                .into(),
        );
    }
    path.canonicalize()
        .map_err(|e| format!("Cannot open project folder: {e}"))
}

pub fn open_project(core: &Core, id: &str, project_id: &str) -> Result<()> {
    let directory = project_directory(core, id, project_id)?;
    crate::integrations::shell_open(directory.as_os_str(), Some(&directory))
}

pub fn file_extensions(provider_id: &str, field_key: &str) -> Result<Vec<String>> {
    provider(provider_id)?
        .manifest()
        .fields
        .into_iter()
        .find(|f| f.key == field_key && f.kind == "file")
        .map(|f| f.extensions)
        .ok_or_else(|| "Unknown integration file field.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(core: &Core, file: &Path) -> Integration {
        save(
            core,
            Integration {
                id: uuid::Uuid::new_v4().to_string(),
                provider_id: "cursor-dashboard".into(),
                name: "Cursor projects".into(),
                enabled: true,
                config_version: 1,
                config: serde_json::json!({"settingsPath": file.to_string_lossy()}),
            },
        )
        .unwrap()
    }

    #[test]
    fn lifecycle_is_persistent_isolated_and_read_only() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        let folder = tmp.path().join("project");
        std::fs::create_dir(&folder).unwrap();
        let content = serde_json::json!({"secret": "never-return", "dashboard.projectData": [
            {"groupName": "Projects", "projects": [{"name": "Example", "path": folder}]}]})
        .to_string();
        std::fs::write(&path, &content).unwrap();
        let core = Core::new(tmp.path().join("data")).unwrap();
        let mut a = fixture(&core, &path);
        let b = fixture(&core, &path);
        let view = workspace(&core, &a.id).unwrap();
        assert!(!serde_json::to_string(&view)
            .unwrap()
            .contains("never-return"));
        assert_eq!(view.groups[0].projects[0].path_status, "available");
        assert!(project_directory(&core, &a.id, "arbitrary-path").is_err());
        assert!(project_directory(&core, &a.id, &view.groups[0].projects[0].id).is_ok());
        a.enabled = false;
        save(&core, a.clone()).unwrap();
        assert!(workspace(&core, &a.id).is_err());
        drop(core);
        let core = Core::new(tmp.path().join("data")).unwrap();
        assert_eq!(list(&core).unwrap().len(), 2);
        assert!(!get(&core, &a.id).unwrap().enabled);
        remove(&core, &a.id).unwrap();
        assert!(workspace(&core, &a.id).is_err());
        assert!(workspace(&core, &b.id).is_ok());
        assert!(core.bootstrap().unwrap().projects.is_empty());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        assert!(folder.is_dir());
        let mut invalid = b;
        invalid.provider_id = "uninstalled".into();
        assert!(save(&core, invalid).is_err());
    }
}
