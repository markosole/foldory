use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, io::Read, path::PathBuf};

pub(super) struct Cursor;
const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Config {
    settings_path: String,
}

#[derive(Deserialize)]
struct Settings {
    // Deliberately deserialize only this setting. No other settings leave the provider.
    #[serde(rename = "dashboard.projectData")]
    project_data: Option<Value>,
}

fn config(value: &Value) -> Result<Config> {
    let config: Config = serde_json::from_value(value.clone())
        .map_err(|_| "Choose a Cursor settings.json file.".to_string())?;
    if config.settings_path.trim().is_empty()
        || config.settings_path.len() > 32768
        || !Path::new(&config.settings_path).is_absolute()
    {
        return Err("The settings file must use an absolute path.".into());
    }
    Ok(config)
}

impl Provider for Cursor {
    fn manifest(&self) -> Manifest {
        let default_path = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("Cursor/User/settings.json"))
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        Manifest {
            id: "cursor-dashboard".into(), name: "Cursor dashboard".into(),
            description: "Bring your Cursor project groups into a separate workspace, with their names, paths and colors.".into(),
            config_version: 1, capabilities: vec!["workspace".into()],
            permissions: vec!["Read dashboard.projectData from the selected settings file".into(),
                "Check project folder availability".into(), "Open a project folder when you select it".into()],
            fields: vec![ConfigField {
                key: "settingsPath".into(), label: "Settings file".into(), kind: "file".into(),
                default_value: default_path, extensions: vec!["json".into(), "jsonc".into()],
                help: "Only dashboard.projectData is used. Cursor settings are never modified.".into(),
            }],
        }
    }
    fn validate(&self, value: &Value) -> Result<()> {
        config(value).map(|_| ())
    }
    fn workspace(&self, value: &Value) -> Result<Workspace> {
        let config = config(value)?;
        let file = File::open(&config.settings_path)
            .map_err(|e| format!("Cannot read Cursor settings file: {e}"))?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("Select a settings file, not a folder.".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Cannot read Cursor settings: {e}"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Cursor settings exceed the 16 MB read limit.".into());
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "Cursor settings must be UTF-8.".to_string())?;
        parse(text.trim_start_matches('\u{feff}'))
    }
}

fn stable_id(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part.len().to_le_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn path_status(path: &str) -> (String, String) {
    let path = Path::new(path);
    if !path.is_absolute() {
        return ("invalid".into(), "Project path must be absolute".into());
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => ("available".into(), "Folder exists".into()),
        Ok(_) => ("not-directory".into(), "Path is not a folder".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            ("missing".into(), "Folder not found".into())
        }
        Err(_) => ("unavailable".into(), "Folder could not be accessed".into()),
    }
}

fn color(value: &str) -> String {
    if value.starts_with('#')
        && [4, 5, 7, 9].contains(&value.len())
        && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return value.into();
    }
    // Cursor theme variables have no meaning in our webview. Map familiar accents,
    // and never pass arbitrary CSS from another application's settings to the UI.
    match value {
        "var(--vscode-gitDecoration-modifiedResourceForeground)" => "#e9b466",
        "var(--vscode-gitDecoration-addedResourceForeground)" => "#83c99c",
        "var(--vscode-gitDecoration-deletedResourceForeground)" => "#e88585",
        _ => "#b4c6ec",
    }
    .into()
}

fn parse(input: &str) -> Result<Workspace> {
    let settings: Settings = jsonc_parser::parse_to_serde_value(input, &jsonc_parser::ParseOptions {
        allow_comments: true, allow_trailing_commas: true,
        allow_loose_object_property_names: false, allow_missing_commas: false,
        allow_single_quoted_strings: false, allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false, allow_bare_decimal_point_numbers: false,
        allow_non_finite_numbers: false, allow_extended_string_escapes: false,
    }).map_err(|_| "Invalid Cursor settings JSON. Comments and trailing commas are supported; fix the JSON and refresh.".to_string())?;
    let data = settings
        .project_data
        .ok_or("Cursor settings do not contain dashboard.projectData.")?;
    let groups = data
        .as_array()
        .ok_or("dashboard.projectData must be an array of project groups.")?;
    if groups.len() > 1000 {
        return Err("Dashboard exceeds the 1,000 group limit.".into());
    }
    let mut result = Workspace {
        groups: vec![],
        warnings: vec![],
        checked_at: now(),
    };
    let mut statuses = HashMap::new();
    let mut skipped = 0;
    let mut total = 0;
    let mut group_ids = HashMap::<String, usize>::new();
    for group in groups {
        let Some(projects) = group.get("projects").and_then(Value::as_array) else {
            skipped += 1;
            continue;
        };
        total += projects.len();
        if total > 20000 {
            return Err("Dashboard exceeds the 20,000 project limit.".into());
        }
        let name = text(group, "groupName").unwrap_or("Ungrouped projects");
        let group_key = text(group, "id").unwrap_or(name);
        let occurrence = group_ids.entry(group_key.to_owned()).or_default();
        let group_id = stable_id(&[group_key, &occurrence.to_string()]);
        *occurrence += 1;
        let mut output = Group {
            id: group_id,
            name: name.into(),
            projects: vec![],
        };
        let mut project_ids = HashMap::<String, usize>::new();
        for project in projects {
            let Some(path) = text(project, "path") else {
                skipped += 1;
                continue;
            };
            let name = text(project, "name").unwrap_or_else(|| {
                path.rsplit(['/', '\\'])
                    .find(|s| !s.is_empty())
                    .unwrap_or(path)
            });
            let project_key = text(project, "id").unwrap_or(path);
            let occurrence = project_ids.entry(project_key.to_owned()).or_default();
            let id = stable_id(&[&output.id, project_key, &occurrence.to_string()]);
            *occurrence += 1;
            let (status, message) = statuses
                .entry(path.to_owned())
                .or_insert_with(|| path_status(path));
            output.projects.push(WorkspaceProject {
                id,
                name: name.into(),
                path: path.into(),
                color: color(text(project, "color").unwrap_or("")),
                path_status: status.clone(),
                path_message: message.clone(),
            });
        }
        result.groups.push(output);
    }
    if skipped > 0 {
        result.warnings.push(format!(
            "Skipped {skipped} malformed groups or projects without a path."
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_jsonc_preserves_groups_and_checks_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("file.txt");
        std::fs::write(&file, "test").unwrap();
        let input = serde_json::json!({"dashboard.projectData": [
            {"groupName":"Ž Projects", "projects":[
                {"id":"duplicate", "name":"One", "path":tmp.path(), "color":"#123abc"},
                {"id":"duplicate", "name":"Two", "path":file, "color":"url(https://invalid)"},
                {"path":tmp.path().join("missing")}, {"path":"relative"}, {"name":"bad"}]},
            {"groupName":"Empty", "projects": []}, {"bad":true}]})
        .to_string();
        let jsonc = format!("// comment\n{},\n}}", input.strip_suffix('}').unwrap());
        let view = parse(&jsonc).unwrap();
        assert_eq!(view.groups.len(), 2);
        assert_eq!(view.groups[0].name, "Ž Projects");
        let projects = &view.groups[0].projects;
        assert_eq!(
            projects
                .iter()
                .map(|p| p.path_status.as_str())
                .collect::<Vec<_>>(),
            ["available", "not-directory", "missing", "invalid"]
        );
        assert_ne!(projects[0].id, projects[1].id);
        assert_eq!(projects[0].color, "#123abc");
        assert_eq!(projects[1].color, "#b4c6ec");
        assert_eq!(view.warnings.len(), 1);
        assert!(parse("{}").is_err());
        assert!(parse(r#"{"dashboard.projectData":{}}"#).is_err());
        assert!(parse(r#"{"dashboard.projectData": [}"#).is_err());
        assert!(parse(r#"{"dashboard.projectData": [] "other":1}"#).is_err());
        assert!(parse(r#"{"dashboard.projectData": []}"#)
            .unwrap()
            .groups
            .is_empty());
    }

    #[test]
    fn file_reads_are_bounded_and_accept_utf8_bom_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        let config = serde_json::json!({"settingsPath": path});
        assert!(Cursor
            .workspace(&config)
            .unwrap_err()
            .contains("Cannot read"));
        std::fs::write(&path, "\u{feff}{/*comment*/\"dashboard.projectData\":[],}").unwrap();
        assert!(Cursor.workspace(&config).unwrap().groups.is_empty());
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(Cursor.workspace(&config).unwrap_err().contains("UTF-8"));
        File::create(&path).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(Cursor.workspace(&config).unwrap_err().contains("16 MB"));
        assert!(Cursor
            .validate(&serde_json::json!({"settingsPath":"relative.json"}))
            .is_err());
        assert!(Cursor
            .validate(&serde_json::json!({"settingsPath":path,"execute":"no"}))
            .is_err());
    }

    #[test]
    #[ignore = "Read-only smoke test against a user-selected Cursor settings file"]
    fn real_cursor_settings() {
        let path = std::env::var("FOLDORY_CURSOR_SETTINGS").expect("Set FOLDORY_CURSOR_SETTINGS");
        let before = std::fs::read(&path).unwrap();
        let view = Cursor
            .workspace(&serde_json::json!({"settingsPath":path}))
            .unwrap();
        let projects: Vec<_> = view.groups.iter().flat_map(|g| &g.projects).collect();
        println!(
            "Cursor dashboard: {} groups, {} projects, {} available, {} warnings",
            view.groups.len(),
            projects.len(),
            projects
                .iter()
                .filter(|p| p.path_status == "available")
                .count(),
            view.warnings.len()
        );
        assert_eq!(before, std::fs::read(&path).unwrap());
    }
}
