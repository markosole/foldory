//! Reviewable text-file writes scoped to one registered project and assistant turn.
//! Provider output is a proposal; only the native access policy can apply it.
use crate::{
    assistant_sources::SourcePolicy,
    core::{now, Core},
    inspector_privacy, work, NativeState,
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs};
use tauri::{Emitter, State};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const MAX_ACTIONS: usize = 8;
const MAX_ACTION_BYTES: usize = 1024 * 1024;
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AccessMode {
    #[default]
    ReadOnly,
    Write,
    Full,
}

impl AccessMode {
    fn value(self) -> &'static str {
        match self {
            Self::ReadOnly => "readOnly",
            Self::Write => "write",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AssistantAccess {
    pub mode: AccessMode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WriteProposal {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAction {
    pub id: String,
    pub project_id: String,
    pub chat_id: String,
    pub message_id: String,
    pub path: String,
    pub status: String,
    pub content: String,
    pub before_content: Option<String>,
    pub expected_revision: Option<String>,
    pub reason: String,
    pub error: Option<String>,
    pub created_at: i64,
}

const ACTION_COLUMNS: &str = "id,project_id,chat_id,message_id,path,status,content,before_content,expected_revision,reason,error,created_at";
fn action_row(row: &Row<'_>) -> rusqlite::Result<FileAction> {
    let status: String = row.get(5)?;
    Ok(FileAction {
        id: row.get(0)?,
        project_id: row.get(1)?,
        chat_id: row.get(2)?,
        message_id: row.get(3)?,
        path: row.get(4)?,
        status: if status == "applying" {
            "pending".into()
        } else {
            status
        },
        content: row.get(6)?,
        before_content: row.get(7)?,
        expected_revision: row.get(8)?,
        reason: row.get(9)?,
        error: row.get(10)?,
        created_at: row.get(11)?,
    })
}

pub fn read_access(core: &Core, project_id: &str) -> Result<AccessMode> {
    core.project(project_id)?;
    let mode: Option<String> = core
        .db()?
        .query_row(
            "SELECT mode FROM assistant_access WHERE project_id=?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    match mode.as_deref() {
        None | Some("readOnly") => Ok(AccessMode::ReadOnly),
        Some("write") => Ok(AccessMode::Write),
        Some("full") => Ok(AccessMode::Full),
        _ => Err("The assistant access setting is invalid. Choose an access mode again.".into()),
    }
}

pub(crate) fn access_mode(core: &Core, project_id: &str) -> Result<AccessMode> {
    read_access(core, project_id)
}

pub fn save_access(core: &Core, project_id: &str, mode: AccessMode) -> Result<AccessMode> {
    let _actions = core.lock_assistant_actions()?;
    core.project(project_id)?;
    core.db()?.execute("INSERT INTO assistant_access(project_id,mode) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode", params![project_id,mode.value()]).map_err(err)?;
    Ok(mode)
}

#[tauri::command]
pub async fn get_assistant_access(
    state: State<'_, NativeState>,
    project_id: String,
) -> Result<AssistantAccess> {
    work(state.core.clone(), move |core| {
        read_access(core, &project_id).map(|mode| AssistantAccess { mode })
    })
    .await
}

#[tauri::command]
pub async fn set_assistant_access(
    state: State<'_, NativeState>,
    project_id: String,
    mode: AccessMode,
) -> Result<AssistantAccess> {
    work(state.core.clone(), move |core| {
        save_access(core, &project_id, mode).map(|mode| AssistantAccess { mode })
    })
    .await
}

/// Validation and normalization only: this helper never reads the filesystem.
pub fn validate_proposals(proposals: Vec<WriteProposal>) -> Result<Vec<WriteProposal>> {
    if proposals.len() > MAX_ACTIONS {
        return Err(
            "The assistant proposed more than 8 file changes. Ask for a smaller group of changes."
                .into(),
        );
    }
    let mut paths = HashSet::new();
    let mut result = vec![];
    let mut bytes = 0;
    for proposal in proposals {
        if proposal.path.starts_with('\\')
            || proposal.path.starts_with("//")
            || proposal.path.len() > 4096
        {
            return Err(
                "Assistant file paths must be relative paths inside the current project.".into(),
            );
        }
        let path = proposal
            .path
            .strip_prefix('/')
            .unwrap_or(&proposal.path)
            .replace('\\', "/");
        crate::core::relative(&path, false)?;
        if binary_output_path(&path) {
            return Err(format!("The assistant can save UTF-8 text files, but cannot create or edit the binary format of {path}. Use a text output such as .md or .csv, or export the document with an application that supports that format. Nothing was written."));
        }
        if proposal.content.contains('\0') || proposal.content.len() > MAX_FILE_BYTES {
            return Err("Assistant writes must contain plain text up to 2 MiB per file, without binary data.".into());
        }
        bytes += proposal.content.len();
        if bytes > MAX_ACTION_BYTES {
            return Err("The proposed file contents exceed the 1 MiB action limit. Ask for smaller changes.".into());
        }
        if !paths.insert(path.to_lowercase()) {
            return Err("The assistant proposed the same file more than once. Ask for one complete change per file.".into());
        }
        result.push(WriteProposal {
            path,
            content: proposal.content,
        });
    }
    for path in &paths {
        if paths
            .iter()
            .any(|other| path != other && path.starts_with(&format!("{other}/")))
        {
            return Err("A proposed file is also used as another file's parent folder. Ask for distinct file targets.".into());
        }
    }
    Ok(result)
}

fn binary_output_path(path: &str) -> bool {
    let extension = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        extension.as_str(),
        "doc"
            | "docx"
            | "docm"
            | "dot"
            | "dotx"
            | "dotm"
            | "xls"
            | "xlsx"
            | "xlsm"
            | "xlsb"
            | "xlt"
            | "xltx"
            | "xltm"
            | "ppt"
            | "pptx"
            | "pptm"
            | "pps"
            | "ppsx"
            | "pot"
            | "potx"
            | "odt"
            | "ods"
            | "odp"
            | "pdf"
            | "epub"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "tif"
            | "tiff"
            | "heic"
            | "avif"
            | "psd"
            | "zip"
            | "7z"
            | "rar"
            | "tar"
            | "gz"
            | "tgz"
            | "bz2"
            | "xz"
            | "zst"
            | "br"
            | "exe"
            | "dll"
            | "so"
            | "dylib"
            | "bin"
            | "msi"
            | "appx"
            | "apk"
            | "jar"
            | "war"
            | "vsix"
            | "crx"
            | "pyc"
            | "pyo"
            | "class"
            | "o"
            | "obj"
            | "rlib"
            | "pdb"
            | "mp3"
            | "wav"
            | "flac"
            | "ogg"
            | "opus"
            | "aac"
            | "m4a"
            | "wma"
            | "mp4"
            | "mov"
            | "avi"
            | "mkv"
            | "webm"
            | "wmv"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "eot"
            | "db"
            | "sqlite"
            | "sqlite3"
            | "duckdb"
            | "parquet"
            | "arrow"
            | "feather"
            | "avro"
            | "orc"
            | "h5"
            | "hdf5"
            | "npy"
            | "npz"
    )
}

fn verify_binding(
    db: &Connection,
    project_id: &str,
    chat_id: &str,
    message_id: &str,
    require_pending: bool,
) -> Result<()> {
    let archived: bool = db
        .query_row(
            "SELECT archived FROM chats WHERE id=?1 AND project_id=?2",
            params![chat_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?
        .unwrap_or(false);
    if archived {
        return Err(
            "This conversation is archived. Restore it before deciding or preparing file changes."
                .into(),
        );
    }
    let status: Option<String> = db.query_row("SELECT m.status FROM chat_messages m JOIN chats c ON c.id=m.chat_id WHERE m.id=?1 AND m.chat_id=?2 AND c.project_id=?3 AND m.role='assistant'", params![message_id,chat_id,project_id], |row| row.get(0)).optional().map_err(err)?;
    match status.as_deref() {
        Some("pending") => Ok(()),
        Some("complete") if !require_pending => Ok(()),
        _ => Err("This file action is not attached to an active assistant response in this project and chat.".into()),
    }
}

pub fn message_actions(db: &Connection, message_id: &str) -> Result<Vec<FileAction>> {
    let mut query = db.prepare(&format!("SELECT {ACTION_COLUMNS} FROM chat_file_actions WHERE message_id=?1 ORDER BY created_at,rowid")).map_err(err)?;
    let rows = query.query_map([message_id], action_row).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

fn find_action(
    db: &Connection,
    project_id: &str,
    chat_id: &str,
    action_id: &str,
) -> Result<FileAction> {
    db.query_row(&format!("SELECT {ACTION_COLUMNS} FROM chat_file_actions WHERE id=?1 AND project_id=?2 AND chat_id=?3"), params![action_id,project_id,chat_id], action_row).optional().map_err(err)?.ok_or_else(|| "This file action was not found in the current project and chat.".into())
}

/// Stage every proposal atomically before applying any file. Malformed targets,
/// unreadable originals and oversized review payloads leave no partial batch.
pub fn prepare_actions(
    core: &Core,
    project_id: &str,
    chat_id: &str,
    message_id: &str,
    proposals: Vec<WriteProposal>,
) -> Result<Vec<FileAction>> {
    let proposals = validate_proposals(proposals)?;
    if proposals.is_empty() {
        return Ok(vec![]);
    }
    let _actions = core.lock_assistant_actions()?;
    let mode = read_access(core, project_id)?;
    {
        let db = core.db()?;
        verify_binding(&db, project_id, chat_id, message_id, true)?;
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM chat_file_actions WHERE message_id=?1",
                [message_id],
                |row| row.get(0),
            )
            .map_err(err)?;
        if count != 0 {
            return Err("File changes for this assistant response were already prepared.".into());
        }
    }
    let policy = if mode == AccessMode::Full {
        None
    } else {
        Some(SourcePolicy::new(core, project_id))
    };
    let mut staged = vec![];
    let mut automatic = HashSet::new();
    let mut bytes = 0;
    for proposal in proposals {
        let target = core.assistant_destination(project_id, &proposal.path)?;
        let before = match fs::symlink_metadata(&target) {
            Ok(_) => Some(core.read_file(project_id, &proposal.path)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(err(error)),
        };
        bytes += proposal.path.len()
            + proposal.content.len()
            + before.as_ref().map(|file| file.content.len()).unwrap_or(0);
        if bytes > MAX_ACTION_BYTES {
            return Err("The proposed changes and their before/after previews exceed 1 MiB. Ask to change fewer or smaller files; nothing was written.".into());
        }
        let protected = match &policy {
            None => None,
            Some(Ok(policy)) => policy
                .reason(&proposal.path, false)
                .unwrap_or_else(|error| {
                    Some(format!("Exclusion rules could not be checked: {error}"))
                }),
            Some(Err(error)) => Some(format!("Exclusion rules could not be checked: {error}")),
        };
        let credentials = inspector_privacy::contains_credential(&proposal.content)
            || before
                .as_ref()
                .is_some_and(|file| inspector_privacy::contains_credential(&file.content));
        let (auto, reason) = match mode {
            AccessMode::ReadOnly => (
                false,
                "Read only access: approve this exact file change once.".to_string(),
            ),
            AccessMode::Write if protected.is_some() => (
                false,
                format!(
                    "This target is excluded or protected: {} Approve this exact change once.",
                    protected.unwrap_or_default()
                ),
            ),
            AccessMode::Write if credentials => (
                false,
                "Possible credentials in this file require approval for this exact change.".into(),
            ),
            AccessMode::Write => (
                true,
                "Allow write access permits changes to ordinary project files.".into(),
            ),
            AccessMode::Full => (
                true,
                "Full access permits file changes inside this project.".into(),
            ),
        };
        let action = FileAction {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            chat_id: chat_id.into(),
            message_id: message_id.into(),
            path: proposal.path,
            status: "pending".into(),
            content: proposal.content,
            before_content: before.as_ref().map(|file| file.content.clone()),
            expected_revision: before.map(|file| file.revision),
            reason,
            error: None,
            created_at: now(),
        };
        if auto {
            automatic.insert(action.id.clone());
        }
        staged.push(action);
    }
    {
        let mut db = core.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        verify_binding(&tx, project_id, chat_id, message_id, true)?;
        for action in &staged {
            tx.execute("INSERT INTO chat_file_actions(id,project_id,chat_id,message_id,path,status,content,before_content,expected_revision,reason,error,created_at) VALUES(?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,NULL,?10)", params![action.id,action.project_id,action.chat_id,action.message_id,action.path,action.content,action.before_content,action.expected_revision,action.reason,action.created_at]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
    }
    for action in &mut staged {
        if automatic.contains(&action.id) {
            *action = decide_locked(core, project_id, chat_id, &action.id, true)?;
        }
    }
    Ok(staged)
}

fn decide_locked(
    core: &Core,
    project_id: &str,
    chat_id: &str,
    action_id: &str,
    approve: bool,
) -> Result<FileAction> {
    core.project(project_id)?;
    let action = {
        let mut db = core.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let action = find_action(&tx, project_id, chat_id, action_id)?;
        verify_binding(&tx, project_id, chat_id, &action.message_id, false)?;
        let changed = tx
            .execute(
                "UPDATE chat_file_actions SET status=?2 WHERE id=?1 AND status='pending'",
                params![action_id, if approve { "applying" } else { "declined" }],
            )
            .map_err(err)?;
        if changed != 1 {
            return Err("This file action was already decided or is being applied. Refresh the conversation to see its result.".into());
        }
        tx.commit().map_err(err)?;
        action
    };
    if approve {
        let result = core.write_assistant_file(
            project_id,
            &action.path,
            &action.content,
            action.expected_revision.as_deref(),
        );
        let (status, error) = match result {
            Ok(_) => ("applied", None),
            Err(message) => ("failed", Some(message)),
        };
        core.db()?
            .execute(
                "UPDATE chat_file_actions SET status=?2,error=?3 WHERE id=?1 AND status='applying'",
                params![action_id, status, error],
            )
            .map_err(err)?;
    }
    let db = core.db()?;
    find_action(&db, project_id, chat_id, action_id)
}

pub fn decide_action(
    core: &Core,
    project_id: &str,
    chat_id: &str,
    action_id: &str,
    approve: bool,
) -> Result<FileAction> {
    let _actions = core.lock_assistant_actions()?;
    decide_locked(core, project_id, chat_id, action_id, approve)
}

#[tauri::command]
pub async fn decide_assistant_action(
    state: State<'_, NativeState>,
    app: tauri::AppHandle,
    project_id: String,
    chat_id: String,
    action_id: String,
    approve: bool,
) -> Result<FileAction> {
    work(state.core.clone(), move |core| {
        let action = decide_action(core, &project_id, &chat_id, &action_id, approve)?;
        let _ = app.emit(
            "assistant-changed",
            serde_json::json!({"projectId":project_id,"chatId":chat_id}),
        );
        if action.status == "applied" {
            let _ = app.emit(
                "assistant-files-changed",
                serde_json::json!({"projectId":project_id,"paths":[action.path]}),
            );
        }
        Ok(action)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{Arc, Barrier},
        thread,
    };

    fn fixture() -> (tempfile::TempDir, Core, String, PathBuf, String, String) {
        let temp = tempfile::tempdir().unwrap();
        let sources = temp.path().join("projects");
        let root = sources.join("Example");
        fs::create_dir_all(&root).unwrap();
        let core = Core::new(temp.path().join("data")).unwrap();
        let project = core
            .add_source(sources.to_str().unwrap())
            .unwrap()
            .projects
            .remove(0);
        let chat = Uuid::new_v4().to_string();
        let message = Uuid::new_v4().to_string();
        {
            let db = core.db().unwrap();
            db.execute(
                "INSERT INTO chats(id,project_id,title,updated_at) VALUES(?1,?2,'Write test',?3)",
                params![chat, project.id, now()],
            )
            .unwrap();
            db.execute("INSERT INTO chat_messages(id,chat_id,role,content,status,created_at) VALUES(?1,?2,'assistant','','pending',?3)", params![message,chat,now()]).unwrap();
        }
        (temp, core, project.id, root, chat, message)
    }

    fn write(path: &str, content: &str) -> WriteProposal {
        WriteProposal {
            path: path.into(),
            content: content.into(),
        }
    }

    #[test]
    fn access_defaults_per_project_and_persists_after_restart() {
        let (_temp, core, project, root, _chat, _message) = fixture();
        assert_eq!(read_access(&core, &project).unwrap(), AccessMode::ReadOnly);
        save_access(&core, &project, AccessMode::Write).unwrap();
        assert_eq!(read_access(&core, &project).unwrap(), AccessMode::Write);
        save_access(&core, &project, AccessMode::Full).unwrap();
        fs::create_dir(root.parent().unwrap().join("Other")).unwrap();
        let other = core
            .scan_sources()
            .unwrap()
            .projects
            .into_iter()
            .find(|entry| entry.name == "Other")
            .unwrap();
        assert_eq!(read_access(&core, &other.id).unwrap(), AccessMode::ReadOnly);
        let data = core.data_dir.clone();
        drop(core);
        let core = Core::new(data).unwrap();
        assert_eq!(read_access(&core, &project).unwrap(), AccessMode::Full);
        assert_eq!(read_access(&core, &other.id).unwrap(), AccessMode::ReadOnly);
    }

    #[test]
    fn readonly_stages_review_then_approve_once_writes_and_decline_never_creates() {
        let (_temp, core, project, root, chat, message) = fixture();
        fs::write(root.join("existing.md"), "BEFORE").unwrap();
        let actions = prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![write("existing.md", "AFTER"), write("Notes/new.md", "NEW")],
        )
        .unwrap();
        assert!(actions.iter().all(|action| action.status == "pending"));
        assert_eq!(actions[0].before_content.as_deref(), Some("BEFORE"));
        assert!(actions[0].expected_revision.is_some());
        assert_eq!(
            fs::read_to_string(root.join("existing.md")).unwrap(),
            "BEFORE"
        );
        assert!(!root.join("Notes").exists());
        assert!(decide_action(&core, "wrong-project", &chat, &actions[0].id, true).is_err());
        assert!(decide_action(&core, &project, "wrong-chat", &actions[0].id, true).is_err());
        let applied = decide_action(&core, &project, &chat, &actions[0].id, true).unwrap();
        assert_eq!(applied.status, "applied");
        assert_eq!(
            fs::read_to_string(root.join("existing.md")).unwrap(),
            "AFTER"
        );
        assert!(decide_action(&core, &project, &chat, &actions[0].id, true).is_err());
        let declined = decide_action(&core, &project, &chat, &actions[1].id, false).unwrap();
        assert_eq!(declined.status, "declined");
        assert!(!root.join("Notes").exists());
        assert!(decide_action(&core, &project, &chat, &actions[1].id, true).is_err());
        assert_eq!(read_access(&core, &project).unwrap(), AccessMode::ReadOnly);
    }

    #[test]
    fn write_mode_applies_ordinary_files_but_keeps_excluded_and_credentials_pending() {
        let (_temp, core, project, root, chat, message) = fixture();
        save_access(&core, &project, AccessMode::Write).unwrap();
        let actions = prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![
                write("Notes/new.md", "CREATED"),
                write("Secure/private.md", "PRIVATE"),
                write("config.txt", "password = fixture-value"),
            ],
        )
        .unwrap();
        assert_eq!(actions[0].status, "applied");
        assert_eq!(
            fs::read_to_string(root.join("Notes/new.md")).unwrap(),
            "CREATED"
        );
        assert_eq!(actions[1].status, "pending");
        assert_eq!(actions[2].status, "pending");
        assert!(!root.join("Secure").exists() && !root.join("config.txt").exists());
        assert_eq!(
            decide_action(&core, &project, &chat, &actions[1].id, true)
                .unwrap()
                .status,
            "applied"
        );
        assert_eq!(
            fs::read_to_string(root.join("Secure/private.md")).unwrap(),
            "PRIVATE"
        );
        assert_eq!(read_access(&core, &project).unwrap(), AccessMode::Write);
    }

    #[test]
    fn full_mode_applies_excluded_files_and_retains_safe_project_boundaries() {
        let (_temp, core, project, root, chat, message) = fixture();
        save_access(&core, &project, AccessMode::Full).unwrap();
        let actions = prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![write("/Secure/Other/result.md", "password = fixture-value")],
        )
        .unwrap();
        assert_eq!(actions[0].status, "applied");
        assert_eq!(actions[0].path, "Secure/Other/result.md");
        assert_eq!(
            fs::read_to_string(root.join("Secure/Other/result.md")).unwrap(),
            "password = fixture-value"
        );
        for path in [
            "../outside.md",
            "//server/share.txt",
            "C:/outside.md",
            "\\outside.md",
            "CON.txt",
            "Notes/../other.md",
            "Notes/bad\nname.md",
        ] {
            assert!(
                validate_proposals(vec![write(path, "unsafe")]).is_err(),
                "{path}"
            );
        }
        assert!(!root.parent().unwrap().join("outside.md").exists());
    }

    #[test]
    fn changed_created_and_removed_targets_fail_without_force_overwrite() {
        for scenario in ["changed", "created", "removed"] {
            let (_temp, core, project, root, chat, message) = fixture();
            if scenario != "created" {
                fs::write(root.join("note.md"), "ORIGINAL").unwrap();
            }
            let actions = prepare_actions(
                &core,
                &project,
                &chat,
                &message,
                vec![write("note.md", "PROPOSED")],
            )
            .unwrap();
            if scenario == "removed" {
                fs::remove_file(root.join("note.md")).unwrap();
            } else {
                fs::write(root.join("note.md"), "USER-EDIT").unwrap();
            }
            let failed = decide_action(&core, &project, &chat, &actions[0].id, true).unwrap();
            assert_eq!(failed.status, "failed");
            assert!(failed.error.as_deref().unwrap().contains("CONFLICT"));
            if scenario == "removed" {
                assert!(!root.join("note.md").exists());
            } else {
                assert_eq!(
                    fs::read_to_string(root.join("note.md")).unwrap(),
                    "USER-EDIT"
                );
            }
            assert!(decide_action(&core, &project, &chat, &actions[0].id, true).is_err());
        }
    }

    #[test]
    fn malformed_batches_and_invalid_bindings_have_no_staged_actions_or_disk_changes() {
        let (_temp, core, project, root, chat, message) = fixture();
        save_access(&core, &project, AccessMode::Full).unwrap();
        assert!(prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![write("good.md", "GOOD"), write("../bad.md", "BAD")]
        )
        .is_err());
        assert!(prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![write("a", "A"), write("a/b.md", "B")]
        )
        .is_err());
        assert!(prepare_actions(
            &core,
            &project,
            "other-chat",
            &message,
            vec![write("good.md", "GOOD")]
        )
        .is_err());
        assert!(message_actions(&core.db().unwrap(), &message)
            .unwrap()
            .is_empty());
        assert!(!root.join("good.md").exists());
        assert!(validate_proposals(
            (0..9)
                .map(|index| write(&format!("{index}.md"), "text"))
                .collect()
        )
        .is_err());
        assert!(
            validate_proposals(vec![write("large.md", &"x".repeat(MAX_ACTION_BYTES + 1))]).is_err()
        );
        assert!(validate_proposals(vec![write("a.md", "a"), write("A.md", "b")]).is_err());
        core.db()
            .unwrap()
            .execute(
                "UPDATE chat_messages SET status='stopped' WHERE id=?1",
                [&message],
            )
            .unwrap();
        assert!(prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![write("good.md", "GOOD")]
        )
        .is_err());
    }

    #[test]
    fn binary_output_formats_are_rejected_before_staging_even_for_new_files_in_full_mode() {
        let (_temp, core, project, root, chat, message) = fixture();
        save_access(&core, &project, AccessMode::Full).unwrap();
        for path in [
            "example.docx",
            "example.XLSX",
            "example.pdf",
            "example.png",
            "example.jpg",
            "example.zip",
            "example.exe",
        ] {
            let result = prepare_actions(
                &core,
                &project,
                &chat,
                &message,
                vec![
                    write("ordinary.md", "DO-NOT-PARTIALLY-APPLY"),
                    write(path, "# This text is not a binary document"),
                ],
            );
            let error = result.unwrap_err();
            assert!(
                error.contains("cannot create or edit the binary format"),
                "{path}: {error}"
            );
            assert!(error.contains(".md or .csv"));
            assert!(!root.join(path).exists() && !root.join("ordinary.md").exists());
            assert!(message_actions(&core.db().unwrap(), &message)
                .unwrap()
                .is_empty());
        }
        let actions = prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![
                write("example.md", "# Valid Markdown\n"),
                write("example.csv", "Name,Billed\nExample,125\n"),
            ],
        )
        .unwrap();
        assert!(actions.iter().all(|action| action.status == "applied"));
        assert_eq!(
            fs::read_to_string(root.join("example.md")).unwrap(),
            "# Valid Markdown\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("example.csv")).unwrap(),
            "Name,Billed\nExample,125\n"
        );
    }

    #[test]
    fn concurrent_approvals_apply_only_once_and_mode_changes_do_not_expand_pending_actions() {
        let (_temp, core, project, root, chat, message) = fixture();
        let actions = prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![write("note.md", "EXACT-PROPOSED-CONTENT")],
        )
        .unwrap();
        save_access(&core, &project, AccessMode::Full).unwrap();
        assert!(!root.join("note.md").exists());
        let core = Arc::new(core);
        let barrier = Arc::new(Barrier::new(2));
        let mut joins = vec![];
        for _ in 0..2 {
            let core = core.clone();
            let barrier = barrier.clone();
            let project = project.clone();
            let chat = chat.clone();
            let action = actions[0].id.clone();
            joins.push(thread::spawn(move || {
                barrier.wait();
                decide_action(&core, &project, &chat, &action, true)
            }));
        }
        let results = joins
            .into_iter()
            .map(|join| join.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert_eq!(
            fs::read_to_string(root.join("note.md")).unwrap(),
            "EXACT-PROPOSED-CONTENT"
        );
    }

    #[test]
    fn actions_survive_restart_and_cascade_with_messages_and_projects() {
        let (_temp, core, project, root, chat, message) = fixture();
        let actions = prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![write("note.md", "PENDING")],
        )
        .unwrap();
        core.db()
            .unwrap()
            .execute(
                "UPDATE chat_messages SET status='complete' WHERE id=?1",
                [&message],
            )
            .unwrap();
        let data = core.data_dir.clone();
        drop(core);
        let core = Core::new(data).unwrap();
        assert_eq!(
            message_actions(&core.db().unwrap(), &message).unwrap()[0].status,
            "pending"
        );
        assert_eq!(
            decide_action(&core, &project, &chat, &actions[0].id, true)
                .unwrap()
                .status,
            "applied"
        );
        assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "PENDING");
        core.db()
            .unwrap()
            .execute("DELETE FROM chat_messages WHERE id=?1", [&message])
            .unwrap();
        assert!(message_actions(&core.db().unwrap(), &message)
            .unwrap()
            .is_empty());
        save_access(&core, &project, AccessMode::Full).unwrap();
        core.db()
            .unwrap()
            .execute("DELETE FROM projects WHERE id=?1", [&project])
            .unwrap();
        assert_eq!(
            core.db()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM assistant_access", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn full_access_rejects_junction_targets_before_staging() {
        let (temp, core, project, root, chat, message) = fixture();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let link = root.join("linked");
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(output.status.success());
        save_access(&core, &project, AccessMode::Full).unwrap();
        assert!(prepare_actions(
            &core,
            &project,
            &chat,
            &message,
            vec![write("linked/note.md", "OUTSIDE")]
        )
        .is_err());
        assert!(!outside.join("note.md").exists());
        assert!(message_actions(&core.db().unwrap(), &message)
            .unwrap()
            .is_empty());
        // Remove the junction itself, never recurse through its destination.
        fs::remove_dir(&link).unwrap();
    }
}
