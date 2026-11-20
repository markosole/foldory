//! Explicit, local source snapshots. Reading a preview never grants AI access.
//! Excluded paths require a project-bound approval before their contents are opened.
use crate::{
    core::{link_or_reparse, Core},
    indexing, inspector, inspector_privacy,
    models::Settings,
    work, NativeState,
};
use calamine::{Data, DataRef, Reader, Xlsx};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::State;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_CONTEXT_BYTES: usize = 512 * 1024;
const MAX_FILES: usize = 500;
const MAX_ENTRIES: usize = 10_000;
const MAX_SELECTIONS: usize = 64;
const MAX_STORED_BYTES: usize = 16 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(30 * 60);
const APPROVAL_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_APPROVALS: usize = 8;
const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
const MAX_APPROVAL_PATHS: usize = 200;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub path: String,
    pub directory: bool,
    pub file_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSource {
    pub id: String,
    pub path: String,
    pub directory: bool,
    pub file_count: usize,
    pub files: Vec<String>,
    pub warnings: Vec<String>,
}

impl AssistantSource {
    fn metadata(&self) -> SourceMetadata {
        SourceMetadata {
            path: self.path.clone(),
            directory: self.directory,
            file_count: self.file_count,
            warnings: self.warnings.clone(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Snapshot {
    pub preview: AssistantSource,
    project_id: String,
    project_name: String,
    created: Instant,
    evidence: Vec<Value>,
    bytes: usize,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceApprovalKind {
    Excluded,
    Credentials,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceApproval {
    pub id: String,
    pub kind: SourceApprovalKind,
    pub paths: Vec<String>,
    pub total_paths: usize,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SourcePreparation {
    Ready { sources: Vec<AssistantSource> },
    ApprovalRequired { approval: SourceApproval },
    Cancelled,
}

enum PendingContent {
    Excluded(Plan),
    Credentials(Vec<Snapshot>),
}

struct PendingApproval {
    project_id: String,
    created: Instant,
    content: PendingContent,
    bytes: usize,
}

impl PendingContent {
    fn bytes(&self) -> usize {
        match self {
            Self::Excluded(plan) => {
                plan.restricted.iter().map(String::len).sum::<usize>()
                    + plan.restricted_paths.iter().map(String::len).sum::<usize>()
                    + plan
                        .selections
                        .iter()
                        .map(|selection| {
                            selection.path.len()
                                + selection.files.iter().map(String::len).sum::<usize>()
                                + selection.warnings.iter().map(String::len).sum::<usize>()
                        })
                        .sum::<usize>()
            }
            Self::Credentials(snapshots) => snapshots
                .iter()
                .map(|snapshot| {
                    snapshot.bytes
                        + snapshot
                            .preview
                            .files
                            .iter()
                            .map(String::len)
                            .sum::<usize>()
                })
                .sum(),
        }
    }
}

#[derive(Clone, Default)]
pub struct SourceStore(
    Arc<Mutex<HashMap<String, Snapshot>>>,
    Arc<Mutex<HashMap<String, PendingApproval>>>,
);

impl SourceStore {
    pub(crate) fn prepare_word(
        &self,
        core: &Core,
        project_id: &str,
        path: &str,
        content: String,
        warnings: Vec<String>,
    ) -> Result<SourcePreparation> {
        let _access = core.lock_assistant_actions()?;
        let project = core.project(project_id)?;
        let project_name = if project.alias.trim().is_empty() {
            project.name
        } else {
            project.alias
        };
        // Apply the same exclusion policy as ordinary source preparation before attaching AI output.
        let full = crate::assistant_actions::access_mode(core, project_id)?
            == crate::assistant_actions::AccessMode::Full;
        let plan = plan_with_access(core, project_id, &[path.into()], full)?;
        if !full && !plan.restricted.is_empty() {
            return Err("This Word file is excluded from AI sources. Change its exclusion rule or explicitly enable Full access before attaching the visual result.".into());
        }
        let evidence = vec![
            json!({"path":path,"format":"docx-visual-markdown","content":content,"warnings":warnings}),
        ];
        let bytes = serde_json::to_vec(&evidence).map_err(err)?.len();
        if bytes > MAX_CONTEXT_BYTES {
            return Err("The parsed document exceeds the 512 KiB attachment limit. Save it as Markdown and include smaller sections.".into());
        }
        let preview = AssistantSource {
            id: Uuid::new_v4().to_string(),
            path: path.into(),
            directory: false,
            file_count: 1,
            files: vec![path.into()],
            warnings,
        };
        let credentials = if inspector_privacy::contains_credential(&content) {
            vec![path.into()]
        } else {
            vec![]
        };
        self.after_extraction(
            core,
            project_id,
            vec![Snapshot {
                preview,
                project_id: project_id.into(),
                project_name,
                created: Instant::now(),
                evidence,
                bytes,
            }],
            credentials,
        )
    }
    fn require_approval(
        &self,
        project_id: &str,
        kind: SourceApprovalKind,
        paths: Vec<String>,
        content: PendingContent,
    ) -> Result<SourcePreparation> {
        let bytes = content.bytes();
        let mut pending = self.1.lock().map_err(err)?;
        pending.retain(|_, approval| approval.created.elapsed() < APPROVAL_TTL);
        if pending.len() >= MAX_PENDING_APPROVALS
            || bytes
                + pending
                    .values()
                    .map(|approval| approval.bytes)
                    .sum::<usize>()
                > MAX_PENDING_BYTES
        {
            return Err("Too many sources are waiting for permission. Close unused permission dialogs or select smaller folders, then try again.".into());
        }
        let id = Uuid::new_v4().to_string();
        let total_paths = paths.len();
        let paths = paths.into_iter().take(MAX_APPROVAL_PATHS).collect();
        pending.insert(
            id.clone(),
            PendingApproval {
                project_id: project_id.into(),
                created: Instant::now(),
                content,
                bytes,
            },
        );
        Ok(SourcePreparation::ApprovalRequired {
            approval: SourceApproval {
                id,
                kind,
                paths,
                total_paths,
            },
        })
    }

    fn take_approval(&self, project_id: &str, approval_id: &str) -> Result<PendingApproval> {
        let mut pending = self.1.lock().map_err(err)?;
        let Some(approval) = pending.get(approval_id) else {
            return Err("This source permission request has expired or was already answered. Include the sources again.".into());
        };
        if approval.project_id != project_id {
            return Err("This source permission request belongs to another project.".into());
        }
        if approval.created.elapsed() >= APPROVAL_TTL {
            pending.remove(approval_id);
            return Err(
                "This source permission request has expired. Include the sources again.".into(),
            );
        }
        pending
            .remove(approval_id)
            .ok_or_else(|| "This source permission request was already answered.".into())
    }

    fn after_extraction(
        &self,
        core: &Core,
        project_id: &str,
        snapshots: Vec<Snapshot>,
        credential_paths: Vec<String>,
    ) -> Result<SourcePreparation> {
        if !credential_paths.is_empty()
            && crate::assistant_actions::access_mode(core, project_id)?
                != crate::assistant_actions::AccessMode::Full
        {
            return self.require_approval(
                project_id,
                SourceApprovalKind::Credentials,
                credential_paths,
                PendingContent::Credentials(snapshots),
            );
        }
        self.insert(snapshots)
            .map(|sources| SourcePreparation::Ready { sources })
    }

    fn prepare(
        &self,
        core: &Core,
        project_id: &str,
        paths: &[String],
    ) -> Result<SourcePreparation> {
        let _access = core.lock_assistant_actions()?;
        let full = crate::assistant_actions::access_mode(core, project_id)?
            == crate::assistant_actions::AccessMode::Full;
        let planned = plan_with_access(core, project_id, paths, full)?;
        if !planned.restricted.is_empty() && !full {
            let paths = planned.restricted_paths.clone();
            return self.require_approval(
                project_id,
                SourceApprovalKind::Excluded,
                paths,
                PendingContent::Excluded(planned),
            );
        }
        let (snapshots, credentials) = extract_plan_with_access(core, project_id, planned, full)?;
        self.after_extraction(core, project_id, snapshots, credentials)
    }

    fn approve(
        &self,
        core: &Core,
        project_id: &str,
        approval_id: &str,
        allow: bool,
    ) -> Result<SourcePreparation> {
        // Taking the one-use request releases the mutex before any disk reads or
        // snapshot insertion; denial drops the plan/snapshot without opening files.
        let pending = self.take_approval(project_id, approval_id)?;
        if !allow {
            return Ok(SourcePreparation::Cancelled);
        }
        let _access = core.lock_assistant_actions()?;
        core.project(project_id)?;
        match pending.content {
            PendingContent::Excluded(planned) => {
                let full = crate::assistant_actions::access_mode(core, project_id)?
                    == crate::assistant_actions::AccessMode::Full;
                let (snapshots, credentials) =
                    extract_plan_with_access(core, project_id, planned, full)?;
                self.after_extraction(core, project_id, snapshots, credentials)
            }
            // The credential prompt approves these exact bytes, even if the
            // original file changes while the in-app dialog is open.
            PendingContent::Credentials(snapshots) => self
                .insert(snapshots)
                .map(|sources| SourcePreparation::Ready { sources }),
        }
    }

    fn insert(&self, snapshots: Vec<Snapshot>) -> Result<Vec<AssistantSource>> {
        let mut stored = self.0.lock().map_err(err)?;
        stored.retain(|_, source| source.created.elapsed() < TTL);
        let bytes = stored.values().map(|source| source.bytes).sum::<usize>()
            + snapshots.iter().map(|source| source.bytes).sum::<usize>();
        if stored.len() + snapshots.len() > 256 || bytes > MAX_STORED_BYTES {
            return Err(
                "Too many prepared sources. Remove unused attachments or restart the app.".into(),
            );
        }
        let previews = snapshots
            .iter()
            .map(|source| source.preview.clone())
            .collect();
        for source in snapshots {
            stored.insert(source.preview.id.clone(), source);
        }
        Ok(previews)
    }

    /// Hold the source lock until the pending message has been durably created.
    /// A validation or database failure leaves all attachment IDs usable.
    pub(crate) fn accept<T>(
        &self,
        project_id: Option<&str>,
        ids: &[String],
        operation: impl FnOnce(Vec<Value>, Vec<SourceMetadata>) -> Result<T>,
    ) -> Result<T> {
        if ids.is_empty() {
            return operation(vec![], vec![]);
        }
        if ids.len() > MAX_SELECTIONS {
            return Err("Include at most 64 source selections per request.".into());
        }
        let mut stored = self.0.lock().map_err(err)?;
        let mut unique_ids = HashSet::new();
        let mut files = HashSet::new();
        let mut evidence = vec![];
        let mut metadata = vec![];
        let mut bytes = 0;
        for id in ids {
            if !unique_ids.insert(id) {
                continue;
            }
            let source = stored
                .get(id)
                .ok_or("A source has expired or was already sent. Attach it again.")?;
            if project_id.is_some_and(|project_id| source.project_id != project_id)
                || source.created.elapsed() >= TTL
            {
                return Err(
                    "A source belongs to another project or has expired. Attach it again.".into(),
                );
            }
            let mut source_metadata = source.preview.metadata();
            if project_id.is_none() {
                source_metadata.path = if source_metadata.path.is_empty() {
                    source.project_name.clone()
                } else {
                    format!("{} / {}", source.project_name, source_metadata.path)
                };
            }
            metadata.push(source_metadata);
            for item in &source.evidence {
                let path = item["path"].as_str().unwrap_or_default();
                let file_key = if project_id.is_none() {
                    format!("{}:{path}", source.project_id).to_lowercase()
                } else {
                    path.to_lowercase()
                };
                if files.insert(file_key) {
                    let mut item = item.clone();
                    if project_id.is_none() {
                        item["projectId"] = json!(source.project_id);
                        item["project"] = json!(source.project_name);
                    }
                    bytes += serde_json::to_vec(&item).map_err(err)?.len();
                    if bytes > MAX_CONTEXT_BYTES || files.len() > MAX_FILES {
                        return Err("The combined attachments exceed 500 files or 512 KiB of extracted context. Select fewer files; nothing has been sent.".into());
                    }
                    evidence.push(item);
                }
            }
        }
        if bytes + serde_json::to_vec(&metadata).map_err(err)?.len() > MAX_CONTEXT_BYTES {
            return Err("The attachments and their coverage warnings exceed 512 KiB. Select fewer files or smaller subfolders; nothing has been sent.".into());
        }
        let result = operation(evidence, metadata)?;
        for id in ids {
            stored.remove(id);
        }
        Ok(result)
    }
}

/// Shares the same persisted exclusion profiles as search and inspection, with
/// inherited exclusions applied consistently to tree icons and attachment scans.
pub(crate) struct SourcePolicy {
    root: PathBuf,
    folders: Gitignore,
    files: Gitignore,
    custom: Gitignore,
    settings: Settings,
    ignore_cache: RefCell<HashMap<PathBuf, Gitignore>>,
}

impl SourcePolicy {
    pub(crate) fn new(core: &Core, project_id: &str) -> Result<Self> {
        let root = core.validated_path(project_id, "")?;
        let settings = core.settings()?;
        let (folders, files) = indexing::matchers(&root, &settings.indexing)?;
        let custom = inspector::custom_rules(&root, &settings.inspector.exclude_patterns, &[])?;
        Ok(Self {
            root,
            folders,
            files,
            custom,
            settings,
            ignore_cache: RefCell::new(HashMap::new()),
        })
    }

    fn local_ignore(&self, directory: &Path) -> Result<()> {
        if self.ignore_cache.borrow().contains_key(directory) {
            return Ok(());
        }
        let mut builder = GitignoreBuilder::new(directory);
        for name in [".gitignore", ".ignore"] {
            let path = directory.join(name);
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(err(error)),
                Ok(meta) if !meta.is_file() || link_or_reparse(&meta) || meta.len() > 64 * 1024 => {
                    return Err(
                        "Ignore rules cannot be safely read. Review the project's ignore files."
                            .into(),
                    );
                }
                Ok(_) => {}
            }
            let contents = read_limited(&path, 64 * 1024)?;
            let contents = std::str::from_utf8(&contents).map_err(err)?;
            for line in contents.lines() {
                builder.add_line(Some(path.clone()), line).map_err(err)?;
            }
        }
        self.ignore_cache
            .borrow_mut()
            .insert(directory.into(), builder.build().map_err(err)?);
        Ok(())
    }

    pub(crate) fn reason(&self, relative: &str, directory: bool) -> Result<Option<String>> {
        let mut full = self.root.clone();
        let mut ancestors = vec![];
        let parts = relative
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        for (index, name) in parts.iter().enumerate() {
            let is_directory = directory || index + 1 < parts.len();
            if private_name(name) || inspector_privacy::sensitive_path(name) {
                return Ok(Some(
                    "Private or credential-related path; permission is required to include it."
                        .into(),
                ));
            }
            if self.settings.indexing.follow_gitignore {
                self.local_ignore(&full)?;
                ancestors.push(full.clone());
            }
            full.push(name);
            if (is_directory && self.folders.matched(&full, true).is_ignore())
                || (!is_directory && self.files.matched(&full, false).is_ignore())
            {
                return Ok(Some("Excluded by the global exclusion settings.".into()));
            }
            if self.custom.matched(&full, is_directory).is_ignore() {
                return Ok(Some(
                    "Excluded by AI inspection settings or .inspectorignore.".into(),
                ));
            }
            let cache = self.ignore_cache.borrow();
            let mut ignored = false;
            for ancestor in &ancestors {
                let matched = cache[ancestor].matched(&full, is_directory);
                if matched.is_ignore() {
                    ignored = true;
                } else if matched.is_whitelist() {
                    ignored = false;
                }
            }
            if ignored {
                return Ok(Some(
                    "Excluded by project .gitignore or .ignore rules.".into(),
                ));
            }
        }
        Ok(None)
    }
}

fn private_name(name: &str) -> bool {
    let name = name.to_lowercase();
    let stem = name.split('.').next().unwrap_or(&name);
    let ext = name.rsplit('.').next().unwrap_or("");
    name.starts_with('.')
        || name.contains("credential")
        || name.contains("secret")
        || name.contains("password")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || matches!(
            stem,
            "secure" | "private" | "confidential" | "payroll" | "personal" | "vault"
        )
        || matches!(
            name.as_str(),
            "token.json" | "tokens.json" | "auth.json" | "auth.txt" | "token.txt"
        )
        || matches!(
            ext,
            "pem"
                | "p12"
                | "pfx"
                | "key"
                | "kdbx"
                | "ppk"
                | "keystore"
                | "env"
                | "tfstate"
                | "tfvars"
        )
}

struct PlannedSelection {
    path: String,
    directory: bool,
    files: Vec<String>,
    warnings: Vec<String>,
}

struct Plan {
    selections: Vec<PlannedSelection>,
    restricted: Vec<String>,
    restricted_paths: Vec<String>,
}

fn supported(path: &str) -> bool {
    let path = path.to_lowercase();
    let name = path.rsplit('/').next().unwrap_or(&path);
    let ext = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    matches!(
        ext,
        "md" | "mdx"
            | "markdown"
            | "txt"
            | "rst"
            | "adoc"
            | "csv"
            | "tsv"
            | "xlsx"
            | "docx"
            | "json"
            | "jsonc"
            | "jsonl"
            | "ndjson"
            | "xml"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "mjs"
            | "cjs"
            | "html"
            | "css"
            | "scss"
            | "less"
            | "rs"
            | "py"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "java"
            | "kt"
            | "go"
            | "rb"
            | "php"
            | "swift"
            | "sh"
            | "ps1"
            | "bat"
            | "sql"
            | "log"
            | "env"
            | "key"
            | "pem"
            | "lock"
    ) || matches!(
        name,
        "dockerfile"
            | "makefile"
            | "license"
            | "readme"
            | ".gitignore"
            | ".inspectorignore"
            | ".ignore"
    )
}

#[cfg(test)]
fn plan(core: &Core, project_id: &str, paths: &[String]) -> Result<Plan> {
    plan_with_access(core, project_id, paths, false)
}

fn plan_with_access(core: &Core, project_id: &str, paths: &[String], full: bool) -> Result<Plan> {
    if paths.is_empty() || paths.len() > MAX_SELECTIONS {
        return Err("Choose between 1 and 64 files or folders.".into());
    }
    let policy = if full {
        None
    } else {
        Some(SourcePolicy::new(core, project_id)?)
    };
    let mut selections = vec![];
    let mut restricted = HashSet::new();
    let mut restricted_paths = HashSet::new();
    let mut selected = HashSet::new();
    let mut total_files = HashSet::new();
    let mut visited = 0;
    for path in paths {
        let path = path.replace('\\', "/").trim_end_matches('/').to_string();
        if path.is_empty() || path.chars().any(char::is_control) {
            return Err("Choose a file or folder inside the project using a relative path.".into());
        }
        if !selected.insert(path.to_lowercase()) {
            continue;
        }
        let full = core.validated_path(project_id, &path)?;
        let directory = full.is_dir();
        let mut files = vec![];
        let mut warnings = vec![];
        let mut queue = vec![(path.clone(), 0)];
        while let Some((relative, depth)) = queue.pop() {
            visited += 1;
            if visited > MAX_ENTRIES || depth > 48 {
                return Err("This folder contains too many entries or nested levels. Select smaller subfolders.".into());
            }
            let full = core.validated_path(project_id, &relative)?;
            let meta = fs::symlink_metadata(&full).map_err(err)?;
            if let Some(reason) = match &policy {
                Some(policy) => policy.reason(&relative, meta.is_dir())?,
                None => None,
            } {
                restricted.insert(format!("{relative} — {reason}"));
                restricted_paths.insert(relative.clone());
            }
            if meta.is_dir() {
                let mut children = fs::read_dir(&full)
                    .map_err(err)?
                    .take(MAX_ENTRIES + 1)
                    .collect::<std::io::Result<Vec<_>>>()
                    .map_err(err)?;
                if children.len() > MAX_ENTRIES {
                    return Err(
                        "This folder contains more than 10,000 entries. Select smaller subfolders."
                            .into(),
                    );
                }
                children.sort_by_key(|entry| entry.file_name());
                for entry in children.into_iter().rev() {
                    let meta = fs::symlink_metadata(entry.path()).map_err(err)?;
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "A source contains a filename that is not UTF-8.")?;
                    let child = format!("{relative}/{name}");
                    if link_or_reparse(&meta) {
                        warnings.push(format!("Skipped linked path: {child}"));
                    } else {
                        queue.push((child, depth + 1));
                    }
                }
            } else if meta.is_file() {
                if !supported(&relative) {
                    if !directory {
                        return Err("This file type cannot be included. Supported sources include text, CSV, XLSX and DOCX.".into());
                    }
                    warnings.push(format!("Skipped unsupported file: {relative}"));
                    continue;
                }
                if meta.len() > MAX_FILE_BYTES as u64 {
                    return Err(format!("{relative} exceeds the 8 MiB file limit. Select smaller sources; no content was truncated."));
                }
                if total_files.insert(relative.to_lowercase()) && total_files.len() > MAX_FILES {
                    return Err("The selection contains more than 500 readable files. Select smaller subfolders.".into());
                }
                files.push(relative);
            } else {
                warnings.push(format!("Skipped non-regular entry: {relative}"));
            }
        }
        if files.is_empty() {
            return Err(format!(
                "{path} contains no supported, regular files to include."
            ));
        }
        files.sort();
        selections.push(PlannedSelection {
            path,
            directory,
            files,
            warnings,
        });
    }
    let mut restricted = restricted.into_iter().collect::<Vec<_>>();
    restricted.sort();
    let mut restricted_paths = restricted_paths.into_iter().collect::<Vec<_>>();
    restricted_paths.sort();
    Ok(Plan {
        selections,
        restricted,
        restricted_paths,
    })
}

#[cfg(test)]
fn extract_plan(core: &Core, project_id: &str, plan: Plan) -> Result<(Vec<Snapshot>, Vec<String>)> {
    extract_plan_with_access(core, project_id, plan, false)
}

fn extract_plan_with_access(
    core: &Core,
    project_id: &str,
    plan: Plan,
    full: bool,
) -> Result<(Vec<Snapshot>, Vec<String>)> {
    let project = core.project(project_id)?;
    let project_name = if project.alias.trim().is_empty() {
        project.name
    } else {
        project.alias
    };
    let policy = if full {
        None
    } else {
        Some(SourcePolicy::new(core, project_id)?)
    };
    let mut snapshots = vec![];
    let mut content_cache: HashMap<String, FileExamination> = HashMap::new();
    let mut credential_paths = vec![];
    let mut total_bytes = 0;
    for selection in plan.selections {
        let mut evidence = vec![];
        let mut warnings = selection.warnings;
        let mut bytes = 0;
        for path in &selection.files {
            if let Some(reason) = match &policy {
                Some(policy) => policy.reason(path, false)?,
                None => None,
            } {
                let entry = format!("{path} — {reason}");
                if !plan.restricted.contains(&entry) {
                    return Err("Exclusion rules changed while preparing sources. Attach the selection again.".into());
                }
            }
            if !content_cache.contains_key(path) {
                let extracted = examine(core, project_id, path)?;
                if inspector_privacy::contains_credential(
                    &serde_json::to_string(&extracted).map_err(err)?,
                ) {
                    credential_paths.push(path.clone());
                }
                total_bytes += extracted.content.len();
                if total_bytes > MAX_CONTEXT_BYTES {
                    return Err("The selection exceeds 512 KiB of extracted context. Select smaller subfolders; no content was truncated or sent.".into());
                }
                content_cache.insert(path.clone(), extracted);
            }
            let extracted = &content_cache[path];
            warnings.extend(
                extracted
                    .warnings
                    .iter()
                    .map(|warning| format!("{path}: {warning}")),
            );
            let item = json!({"path":path,"format":extracted.format,"content":extracted.content,"formatting":extracted.formatting,"warnings":extracted.warnings});
            bytes += serde_json::to_vec(&item).map_err(err)?.len();
            evidence.push(item);
        }
        let preview = AssistantSource {
            id: Uuid::new_v4().to_string(),
            path: selection.path,
            directory: selection.directory,
            file_count: selection.files.len(),
            files: selection.files,
            warnings,
        };
        bytes += serde_json::to_vec(&preview.metadata()).map_err(err)?.len();
        if bytes > MAX_CONTEXT_BYTES {
            return Err("The extracted source and its coverage warnings exceed 512 KiB. Select a smaller subfolder; no source content or warnings were truncated.".into());
        }
        snapshots.push(Snapshot {
            preview,
            project_id: project_id.into(),
            project_name: project_name.clone(),
            created: Instant::now(),
            evidence,
            bytes,
        });
    }
    Ok((snapshots, credential_paths))
}

#[tauri::command]
pub async fn prepare_assistant_sources(
    state: State<'_, NativeState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<SourcePreparation> {
    let store = state.assistant_sources.clone();
    work(state.core.clone(), move |core| {
        store.prepare(core, &project_id, &paths)
    })
    .await
}

#[tauri::command]
pub async fn approve_assistant_sources(
    state: State<'_, NativeState>,
    project_id: String,
    approval_id: String,
    allow: bool,
) -> Result<SourcePreparation> {
    let store = state.assistant_sources.clone();
    work(state.core.clone(), move |core| {
        store.approve(core, &project_id, &approval_id, allow)
    })
    .await
}

#[tauri::command]
pub async fn discard_assistant_sources(
    state: State<'_, NativeState>,
    project_id: String,
    source_ids: Vec<String>,
) -> Result<()> {
    let mut stored = state.assistant_sources.0.lock().map_err(err)?;
    for id in source_ids {
        if stored
            .get(&id)
            .is_some_and(|source| source.project_id == project_id)
        {
            stored.remove(&id);
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileExamination {
    path: String,
    format: String,
    content: String,
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    formatting: Option<Value>,
}

#[tauri::command]
pub async fn examine_file(
    state: State<'_, NativeState>,
    project_id: String,
    path: String,
) -> Result<FileExamination> {
    work(state.core.clone(), move |core| {
        examine(core, &project_id, &path)
    })
    .await
}

fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path).map_err(err)?;
    if !meta.is_file() || link_or_reparse(&meta) {
        return Err("Only regular, unlinked project files can be read.".into());
    }
    if meta.len() > limit as u64 {
        return Err(format!(
            "File exceeds the {} MiB read limit.",
            limit / 1024 / 1024
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(err)?;
    if link_or_reparse(&file.metadata().map_err(err)?) {
        return Err("Linked files are not followed.".into());
    }
    let mut bytes = vec![];
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > limit {
        return Err("File grew beyond the read limit. No content was truncated.".into());
    }
    Ok(bytes)
}

fn examine(core: &Core, project_id: &str, path: &str) -> Result<FileExamination> {
    let full = core.validated_path(project_id, path)?;
    let bytes = read_limited(&full, MAX_FILE_BYTES)?;
    let extension = path.rsplit('.').next().unwrap_or("").to_lowercase();
    let mut formatting = None;
    let (format, content, warnings) = match extension.as_str() {
        "csv" | "tsv" => ("csv", csv_text(&bytes, extension == "tsv")?, vec![]),
        "xlsx" => {
            let (text, warnings) = xlsx_text(bytes)?;
            ("xlsx", text, warnings)
        }
        "docx" => {
            let doc = crate::word_document::extract(&bytes)?;
            formatting = Some(json!({"paragraphs":doc.paragraphs,"sections":doc.sections}));
            ("docx", doc.markdown, doc.warnings)
        }
        _ => {
            if bytes.contains(&0) {
                return Err(format!(
                    "{path} contains binary data and cannot be included as text."
                ));
            }
            let content =
                String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8 text."))?;
            (
                "text",
                content.trim_start_matches('\u{feff}').to_string(),
                vec![],
            )
        }
    };
    if content.len() > MAX_CONTEXT_BYTES {
        return Err(format!("{path} exceeds the 512 KiB extracted-content limit. Open it externally or split the document; no content was truncated."));
    }
    Ok(FileExamination {
        path: path.replace('\\', "/"),
        format: format.into(),
        content,
        warnings,
        formatting,
    })
}

pub(crate) fn visual_word_input(core: &Core, project_id: &str, path: &str) -> Result<Vec<u8>> {
    if !path.to_lowercase().ends_with(".docx") {
        return Err("Visual Word parsing supports .docx files.".into());
    }
    let full = crate::assistant_actions::access_mode(core, project_id)?
        == crate::assistant_actions::AccessMode::Full;
    let planned = plan_with_access(core, project_id, &[path.into()], full)?;
    if !full && !planned.restricted.is_empty() {
        return Err("This file is excluded from AI access. Change its exclusion rule or enable Full access before visual parsing.".into());
    }
    let bytes = read_limited(&core.validated_path(project_id, path)?, MAX_FILE_BYTES)?;
    let doc = crate::word_document::extract(&bytes)?;
    if !full && inspector_privacy::contains_credential(&serde_json::to_string(&doc).map_err(err)?) {
        return Err("This document contains a possible credential. Remove it or explicitly enable Full access before sending page images to the selected model.".into());
    }
    Ok(bytes)
}

fn csv_text(bytes: &[u8], tsv: bool) -> Result<String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "CSV must be UTF-8 text (save as CSV UTF-8 in Excel).")?
        .trim_start_matches('\u{feff}');
    let mut best = (0usize, b',');
    for delimiter in if tsv {
        vec![b'\t']
    } else {
        vec![b',', b';', b'\t', b'|']
    } {
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .delimiter(delimiter)
            .from_reader(text.as_bytes());
        if let Some(Ok(first)) = reader.records().next() {
            let width = first.len();
            if width > best.0 {
                best = (width, delimiter);
            }
        }
    }
    let delimiter = if tsv { b'\t' } else { best.1 };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .delimiter(delimiter)
        .from_reader(text.as_bytes());
    let mut output = format!("CSV records, in original order; row 1 is the first record. Delimiter: {:?}. Values are JSON strings, preserving embedded newlines and decimal formatting.\n", delimiter as char);
    for (index, record) in reader.records().enumerate() {
        let record =
            record.map_err(|error| format!("CSV could not be parsed completely: {error}"))?;
        output.push_str(&format!(
            "Row {}: {}\n",
            index + 1,
            serde_json::to_string(&record.iter().collect::<Vec<_>>()).map_err(err)?
        ));
        if output.len() > MAX_CONTEXT_BYTES {
            return Err("CSV exceeds 512 KiB of extracted records. Select a smaller file; no rows were truncated.".into());
        }
    }
    Ok(output)
}

pub(crate) fn check_archive(bytes: &[u8]) -> Result<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Invalid Office document: {error}"))?;
    if archive.len() > 10_000 {
        return Err("Office document contains too many archive entries.".into());
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(err)?;
        total = total
            .checked_add(entry.size())
            .ok_or("Office archive size overflow.")?;
        if total > MAX_EXPANDED_BYTES {
            return Err("Office document expands beyond the 32 MiB extraction limit.".into());
        }
    }
    Ok(())
}

fn cell_address(row: u32, column: u32) -> String {
    let mut value = column + 1;
    let mut letters = vec![];
    while value > 0 {
        value -= 1;
        letters.push((b'A' + (value % 26) as u8) as char);
        value /= 26;
    }
    format!(
        "{}{}",
        letters.into_iter().rev().collect::<String>(),
        row + 1
    )
}

fn xlsx_text(bytes: Vec<u8>) -> Result<(String, Vec<String>)> {
    check_archive(&bytes)?;
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(bytes))
        .map_err(|error| format!("Excel document could not be opened: {error}"))?;
    let mut output = String::from("Excel workbook. Values are cached workbook values; formulas are shown and are not recalculated. Empty cells are omitted; addresses preserve their positions.\n");
    let mut warnings = vec!["Excel formulas are not recalculated. Cached values may be stale; verify totals in Excel when accuracy is critical. Charts, images and cell formatting are not extracted.".into()];
    for name in workbook.sheet_names() {
        output.push_str(&format!(
            "\n## Worksheet: {}\n",
            serde_json::to_string(&name).map_err(err)?
        ));
        // Streaming cells avoids allocating a potentially enormous rectangular range
        // when a sparse sheet declares a distant last cell.
        let mut reader = workbook
            .worksheet_cells_reader(&name)
            .map_err(|error| format!("Could not read worksheet {name}: {error}"))?;
        let mut count = 0;
        while let Some(cell) = reader.next_cell_with_formula().map_err(err)? {
            let (row, column) = cell.pos;
            let value = cell.value;
            let formula = cell.formula;
            if matches!(value, DataRef::Empty) && formula.is_none() {
                continue;
            }
            count += 1;
            if count > 100_000 {
                return Err("Worksheet exceeds 100,000 populated cells. Split the workbook; no cells were truncated.".into());
            }
            let address = cell_address(row, column);
            let rendered = match &value {
                DataRef::String(value) => serde_json::to_string(value).map_err(err)?,
                DataRef::SharedString(value) => serde_json::to_string(value).map_err(err)?,
                DataRef::Empty => "[no cached value]".into(),
                other => Data::from(other.clone()).to_string(),
            };
            output.push_str(&format!("{address}: {rendered}"));
            if let Some(formula) = formula {
                output.push_str(&format!(
                    "; formula = {}",
                    serde_json::to_string(&formula).map_err(err)?
                ));
                if matches!(value, DataRef::Empty) {
                    warnings.push(format!("{name}!{address} has no cached formula result."));
                }
            }
            output.push('\n');
            if output.len() > MAX_CONTEXT_BYTES {
                return Err("Excel exceeds 512 KiB of extracted cells. Split the workbook; no cells were truncated.".into());
            }
        }
        if count == 0 {
            output.push_str("[Empty worksheet]\n");
        }
    }
    Ok((output, warnings))
}

#[cfg(test)]
fn docx_text(bytes: Vec<u8>) -> Result<(String, Vec<String>)> {
    let doc = crate::word_document::extract(&bytes)?;
    Ok((doc.markdown, doc.warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture() -> (tempfile::TempDir, Core, String, PathBuf) {
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
        (temp, core, project.id, root)
    }

    fn office_archive(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(vec![]));
        for (name, content) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn require_pending(preparation: SourcePreparation) -> SourceApproval {
        match preparation {
            SourcePreparation::ApprovalRequired { approval } => approval,
            other => panic!("Expected a permission request, got {other:?}"),
        }
    }

    fn require_ready(preparation: SourcePreparation) -> Vec<AssistantSource> {
        match preparation {
            SourcePreparation::Ready { sources } => sources,
            other => panic!("Expected ready sources, got {other:?}"),
        }
    }

    #[test]
    fn full_access_bypasses_excluded_and_credential_source_approvals_within_project() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir(root.join("Secure")).unwrap();
        fs::write(root.join("Secure/note.md"), "password = fixture-value").unwrap();
        crate::assistant_actions::save_access(
            &core,
            &id,
            crate::assistant_actions::AccessMode::Write,
        )
        .unwrap();
        let store = SourceStore::default();
        let approval = require_pending(
            store
                .prepare(&core, &id, &["Secure/note.md".into()])
                .unwrap(),
        );
        assert!(matches!(approval.kind, SourceApprovalKind::Excluded));
        store.approve(&core, &id, &approval.id, false).unwrap();
        crate::assistant_actions::save_access(
            &core,
            &id,
            crate::assistant_actions::AccessMode::Full,
        )
        .unwrap();
        // Full access does not depend on parsing ignore rules that it explicitly bypasses.
        fs::write(root.join(".inspectorignore"), [255, 254]).unwrap();
        let ready = require_ready(
            store
                .prepare(&core, &id, &["Secure/note.md".into()])
                .unwrap(),
        );
        assert!(store.1.lock().unwrap().is_empty());
        store
            .accept(Some(&id), &[ready[0].id.clone()], |evidence, _| {
                assert_eq!(evidence[0]["content"], "password = fixture-value");
                Ok(())
            })
            .unwrap();
        assert!(store
            .prepare(&core, &id, &["../outside.md".into()])
            .is_err());
    }

    #[test]
    fn in_app_exclusion_approval_denial_never_reads_or_prepares_excluded_content() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir(root.join("Secure")).unwrap();
        // Reading this as source text would fail. Preparing/denying must still succeed.
        fs::write(root.join("Secure/note.md"), [255, 254, 253]).unwrap();
        let store = SourceStore::default();
        let response = store
            .prepare(&core, &id, &["Secure/note.md".into()])
            .unwrap();
        let serialized = serde_json::to_value(&response).unwrap();
        assert_eq!(serialized["status"], "approvalRequired");
        assert!(serialized["approval"].get("content").is_none());
        let approval = require_pending(response);
        assert!(matches!(approval.kind, SourceApprovalKind::Excluded));
        assert_eq!(approval.paths, ["Secure/note.md"]);
        assert_eq!(approval.total_paths, 1);
        // An approval ID is not an attachment ID and cannot bypass the second step.
        assert!(store
            .accept(Some(&id), &[approval.id.clone()], |_, _| Ok(()))
            .is_err());
        assert!(store.approve(&core, &id, "arbitrary-token", true).is_err());
        assert!(matches!(
            store.approve(&core, &id, &approval.id, false).unwrap(),
            SourcePreparation::Cancelled
        ));
        assert!(store.0.lock().unwrap().is_empty());
        assert!(store.1.lock().unwrap().is_empty());
        assert!(store.approve(&core, &id, &approval.id, true).is_err());
    }

    #[test]
    fn in_app_approvals_are_project_bound_and_one_use() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir(root.join("Secure")).unwrap();
        fs::write(
            root.join("Secure/a — b.md"),
            "APPROVED-ONLY-FOR-THIS-PROJECT",
        )
        .unwrap();
        let store = SourceStore::default();
        let approval = require_pending(
            store
                .prepare(&core, &id, &["Secure/a — b.md".into()])
                .unwrap(),
        );
        // Legitimate names containing the old reason delimiter remain exact paths.
        assert_eq!(approval.paths, ["Secure/a — b.md"]);
        assert!(store
            .approve(&core, "another-project", &approval.id, true)
            .is_err());
        let sources = require_ready(store.approve(&core, &id, &approval.id, true).unwrap());
        assert_eq!(sources.len(), 1);
        assert!(store.approve(&core, &id, &approval.id, true).is_err());
        store
            .accept(Some(&id), &[sources[0].id.clone()], |evidence, _| {
                assert_eq!(evidence[0]["content"], "APPROVED-ONLY-FOR-THIS-PROJECT");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn in_app_credential_step_approves_the_exact_snapshot_without_rereading_files() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir(root.join("Secure")).unwrap();
        fs::write(root.join("Secure/note.md"), "password = fixture-value").unwrap();
        let store = SourceStore::default();
        let excluded = require_pending(
            store
                .prepare(&core, &id, &["Secure/note.md".into()])
                .unwrap(),
        );
        let credentials = require_pending(store.approve(&core, &id, &excluded.id, true).unwrap());
        assert!(matches!(credentials.kind, SourceApprovalKind::Credentials));
        assert_eq!(credentials.paths, ["Secure/note.md"]);
        assert_ne!(excluded.id, credentials.id);
        assert!(store.0.lock().unwrap().is_empty());
        assert!(store.approve(&core, &id, &excluded.id, true).is_err());
        fs::write(root.join("Secure/note.md"), "NEW-UNREVIEWED-CONTENT").unwrap();
        let ready = require_ready(store.approve(&core, &id, &credentials.id, true).unwrap());
        assert!(store.approve(&core, &id, &credentials.id, true).is_err());
        store
            .accept(Some(&id), &[ready[0].id.clone()], |evidence, _| {
                assert_eq!(evidence[0]["content"], "password = fixture-value");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn in_app_credentials_can_be_denied_and_both_approval_kinds_expire() {
        let (_temp, core, id, root) = fixture();
        fs::write(root.join("note.md"), "password = fixture-value").unwrap();
        fs::create_dir(root.join("Secure")).unwrap();
        fs::write(root.join("Secure/another.md"), [255, 254]).unwrap();
        let store = SourceStore::default();
        let credentials = require_pending(store.prepare(&core, &id, &["note.md".into()]).unwrap());
        assert!(matches!(credentials.kind, SourceApprovalKind::Credentials));
        assert!(matches!(
            store.approve(&core, &id, &credentials.id, false).unwrap(),
            SourcePreparation::Cancelled
        ));
        assert!(store.0.lock().unwrap().is_empty());
        for path in ["note.md", "Secure/another.md"] {
            let approval = require_pending(store.prepare(&core, &id, &[path.into()]).unwrap());
            store
                .1
                .lock()
                .unwrap()
                .get_mut(&approval.id)
                .unwrap()
                .created = Instant::now() - APPROVAL_TTL - Duration::from_secs(1);
            assert!(store
                .approve(&core, &id, &approval.id, true)
                .unwrap_err()
                .contains("expired"));
            assert!(!store.1.lock().unwrap().contains_key(&approval.id));
        }
        assert!(store.0.lock().unwrap().is_empty());
    }

    #[test]
    fn pending_approval_capacity_is_bounded_and_expired_requests_are_pruned() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir(root.join("Secure")).unwrap();
        fs::write(root.join("Secure/note.md"), "content").unwrap();
        let store = SourceStore::default();
        for _ in 0..MAX_PENDING_APPROVALS {
            require_pending(
                store
                    .prepare(&core, &id, &["Secure/note.md".into()])
                    .unwrap(),
            );
        }
        assert!(store
            .prepare(&core, &id, &["Secure/note.md".into()])
            .unwrap_err()
            .contains("Too many sources"));
        for approval in store.1.lock().unwrap().values_mut() {
            approval.created = Instant::now() - APPROVAL_TTL - Duration::from_secs(1);
        }
        require_pending(
            store
                .prepare(&core, &id, &["Secure/note.md".into()])
                .unwrap(),
        );
        assert_eq!(store.1.lock().unwrap().len(), 1);
        let oversized = PendingContent::Excluded(Plan {
            selections: vec![],
            restricted: vec!["x".repeat(MAX_PENDING_BYTES + 1)],
            restricted_paths: vec![],
        });
        assert!(store
            .require_approval(&id, SourceApprovalKind::Excluded, vec![], oversized)
            .unwrap_err()
            .contains("Too many sources"));
    }

    #[test]
    fn approval_payload_caps_path_display_and_does_not_return_source_contents() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir(root.join("Secure")).unwrap();
        for index in 0..MAX_APPROVAL_PATHS + 1 {
            fs::write(
                root.join(format!("Secure/{index:04}.md")),
                "DO-NOT-RETURN-CONTENT-IN-APPROVAL",
            )
            .unwrap();
        }
        let store = SourceStore::default();
        let response = store.prepare(&core, &id, &["Secure".into()]).unwrap();
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(!serialized.contains("DO-NOT-RETURN-CONTENT"));
        let approval = require_pending(response);
        assert_eq!(approval.paths.len(), MAX_APPROVAL_PATHS);
        assert_eq!(approval.total_paths, MAX_APPROVAL_PATHS + 2);
        assert!(matches!(
            store.approve(&core, &id, &approval.id, false).unwrap(),
            SourcePreparation::Cancelled
        ));
    }

    #[test]
    fn recursive_sources_include_every_supported_descendant_and_report_unsupported_files() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir_all(root.join("Docs/nested")).unwrap();
        fs::write(root.join("Docs/one.md"), "FIRST-DOCUMENT").unwrap();
        fs::write(root.join("Docs/nested/two.md"), "SECOND-DOCUMENT").unwrap();
        fs::write(root.join("Docs/picture.png"), [0, 1, 2]).unwrap();
        let planned = plan(&core, &id, &["Docs".into()]).unwrap();
        assert!(planned.restricted.is_empty());
        let (sources, _) = extract_plan(&core, &id, planned).unwrap();
        assert_eq!(sources[0].preview.file_count, 2);
        assert_eq!(
            sources[0].preview.files,
            ["Docs/nested/two.md", "Docs/one.md"]
        );
        assert!(sources[0].preview.warnings[0].contains("picture.png"));
        let evidence = serde_json::to_string(&sources[0].evidence).unwrap();
        assert!(evidence.contains("FIRST-DOCUMENT") && evidence.contains("SECOND-DOCUMENT"));
        let store = SourceStore::default();
        let previews = store.insert(sources).unwrap();
        store
            .accept(Some(&id), &[previews[0].id.clone()], |_, metadata| {
                assert!(metadata[0]
                    .warnings
                    .iter()
                    .any(|warning| warning.contains("Skipped unsupported file: Docs/picture.png")));
                Ok(())
            })
            .unwrap();
        assert!(plan(&core, &id, &["../outside".into()]).is_err());
        assert!(plan(&core, &id, &[root.to_string_lossy().into_owned()]).is_err());
    }

    #[test]
    fn protected_paths_are_flagged_from_metadata_before_reading_their_content() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir_all(root.join("Docs/Secure/Other")).unwrap();
        // Invalid UTF-8 proves planning does not open source content; extraction would fail.
        fs::write(root.join("Docs/Secure/Other/note.md"), [255, 254, 253]).unwrap();
        let planned = plan(&core, &id, &["Docs".into()]).unwrap();
        assert!(planned
            .restricted
            .iter()
            .any(|path| path.contains("Docs/Secure/Other/note.md")));
        let entries = core.list_directory(&id, "Docs").unwrap();
        assert!(
            entries
                .iter()
                .find(|entry| entry.name == "Secure")
                .unwrap()
                .ai_excluded
        );
        assert!(extract_plan(&core, &id, planned).is_err());
    }

    #[test]
    fn global_ai_search_and_nested_project_exclusions_match_tree_and_source_plan() {
        let (_temp, core, id, root) = fixture();
        fs::create_dir_all(root.join("Docs/nested")).unwrap();
        for name in [
            "global.md",
            "ai.md",
            "git.md",
            "nested/local.md",
            "visible.md",
        ] {
            fs::write(root.join("Docs").join(name), "content").unwrap();
        }
        fs::write(root.join(".gitignore"), "Docs/git.md\n").unwrap();
        fs::write(root.join("Docs/nested/.gitignore"), "local.md\n").unwrap();
        fs::write(root.join(".inspectorignore"), "**/ai.md\n").unwrap();
        let mut settings = core.settings().unwrap();
        settings.indexing.file_patterns.push("**/global.md".into());
        core.save_settings(settings).unwrap();
        let policy = SourcePolicy::new(&core, &id).unwrap();
        for name in ["global.md", "ai.md", "git.md", "nested/local.md"] {
            assert!(
                policy
                    .reason(&format!("Docs/{name}"), false)
                    .unwrap()
                    .is_some(),
                "{name}"
            );
        }
        assert!(policy.reason("Docs/visible.md", false).unwrap().is_none());
        let planned = plan(&core, &id, &["Docs".into()]).unwrap();
        assert!(planned.restricted.len() >= 4);
        let entries = core.list_directory(&id, "Docs").unwrap();
        assert!(
            entries
                .iter()
                .find(|entry| entry.name == "global.md")
                .unwrap()
                .ai_excluded
        );
        assert!(
            !entries
                .iter()
                .find(|entry| entry.name == "visible.md")
                .unwrap()
                .ai_excluded
        );
    }

    #[test]
    fn exclusion_changes_after_review_fail_closed() {
        let (_temp, core, id, root) = fixture();
        fs::write(root.join("note.md"), "content").unwrap();
        let planned = plan(&core, &id, &["note.md".into()]).unwrap();
        let mut settings = core.settings().unwrap();
        settings.inspector.exclude_patterns.push("note.md".into());
        core.save_settings(settings).unwrap();
        assert!(extract_plan(&core, &id, planned)
            .err()
            .unwrap()
            .contains("rules changed"));
    }

    #[test]
    fn source_ids_are_project_bound_one_use_and_not_consumed_on_send_failure() {
        let (_temp, core, id, root) = fixture();
        fs::write(root.join("note.md"), "IMMUTABLE-SNAPSHOT").unwrap();
        let (snapshots, _) =
            extract_plan(&core, &id, plan(&core, &id, &["note.md".into()]).unwrap()).unwrap();
        let store = SourceStore::default();
        let preview = store.insert(snapshots).unwrap().remove(0);
        let ids = vec![preview.id.clone()];
        assert!(store
            .accept(Some("other-project"), &ids, |_, _| Ok(()))
            .is_err());
        let failed: Result<()> = store.accept(Some(&id), &ids, |_, _| Err("save failed".into()));
        assert!(failed.is_err());
        fs::write(root.join("note.md"), "CHANGED-AFTER-ATTACHMENT").unwrap();
        store
            .accept(Some(&id), &ids, |evidence, metadata| {
                assert_eq!(metadata[0].file_count, 1);
                assert_eq!(evidence[0]["content"], "IMMUTABLE-SNAPSHOT");
                Ok(())
            })
            .unwrap();
        assert!(store.accept(Some(&id), &ids, |_, _| Ok(())).is_err());
    }

    #[test]
    fn global_requests_accept_sources_from_multiple_projects_and_keep_paths_distinct() {
        let (_temp, core, first_id, first_root) = fixture();
        let second_root = first_root.parent().unwrap().join("Other");
        fs::create_dir_all(&second_root).unwrap();
        let second_id = core
            .scan_sources()
            .unwrap()
            .projects
            .into_iter()
            .find(|project| project.name == "Other")
            .unwrap()
            .id;
        fs::write(first_root.join("note.md"), "FIRST-PROJECT").unwrap();
        fs::write(second_root.join("note.md"), "SECOND-PROJECT").unwrap();
        let (mut snapshots, _) = extract_plan(
            &core,
            &first_id,
            plan(&core, &first_id, &["note.md".into()]).unwrap(),
        )
        .unwrap();
        let (second, _) = extract_plan(
            &core,
            &second_id,
            plan(&core, &second_id, &["note.md".into()]).unwrap(),
        )
        .unwrap();
        snapshots.extend(second);
        let store = SourceStore::default();
        let previews = store.insert(snapshots).unwrap();
        let ids = previews
            .into_iter()
            .map(|preview| preview.id)
            .collect::<Vec<_>>();
        store
            .accept(None, &ids, |evidence, metadata| {
                assert_eq!(metadata.len(), 2);
                assert!(metadata.iter().any(|item| item.path == "Example / note.md"));
                assert!(metadata.iter().any(|item| item.path == "Other / note.md"));
                assert_eq!(evidence.len(), 2);
                assert!(evidence.iter().any(|item| {
                    item["project"] == "Example" && item["content"] == "FIRST-PROJECT"
                }));
                assert!(evidence.iter().any(|item| {
                    item["project"] == "Other" && item["content"] == "SECOND-PROJECT"
                }));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn expired_sources_and_oversized_text_fail_without_silent_truncation() {
        let (_temp, core, id, root) = fixture();
        fs::write(root.join("note.md"), "content").unwrap();
        let (mut snapshots, _) =
            extract_plan(&core, &id, plan(&core, &id, &["note.md".into()]).unwrap()).unwrap();
        snapshots[0].created = Instant::now() - TTL - Duration::from_secs(1);
        let store = SourceStore::default();
        let source = store.insert(snapshots).unwrap().remove(0);
        assert!(store
            .accept(Some(&id), &[source.id], |_, _| Ok(()))
            .is_err());
        fs::write(root.join("big.md"), "x".repeat(MAX_CONTEXT_BYTES + 1)).unwrap();
        assert!(examine(&core, &id, "big.md")
            .unwrap_err()
            .contains("no content was truncated"));
    }

    #[test]
    fn csv_preserves_all_quoted_records_and_supports_semicolon_decimal_data() {
        let text = csv_text(b"\xef\xbb\xbfName;Billed;Notes\r\nAlpha;12,50;\"a;b\"\r\nBeta;20,00;\"line one\nline two\"\r\n", false).unwrap();
        assert!(text.contains("Row 3:"));
        assert!(
            text.contains("12,50") && text.contains("a;b") && text.contains("line one\\nline two")
        );
        assert!(csv_text(b"A,B\n1,2,3\n", false).is_err());
        assert!(csv_text(&[255, 0], false).is_err());
    }

    #[test]
    fn docx_extracts_headings_entities_paragraphs_and_tables_as_markdown() {
        let bytes = office_archive(&[(
            "word/document.xml",
            r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Sales &amp; billing</w:t></w:r></w:p>
            <w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Billed</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>Example</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>125</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:body></w:document>"#,
        )]);
        let (text, warnings) = docx_text(bytes).unwrap();
        assert!(text.contains("# Sales & billing"));
        assert!(text.contains("First paragraph."));
        assert!(
            text.contains("| Name | Billed |\n| --- | --- |\n| Example | 125 |"),
            "{text}"
        );
        assert!(!warnings.is_empty());
        assert!(docx_text(office_archive(&[("wrong.xml", "<p/>")])).is_err());
        assert!(docx_text(office_archive(&[("word/document.xml", "<!DOCTYPE x><x/>")])).is_err());
    }

    #[test]
    fn xlsx_preserves_all_sheets_cell_addresses_and_cached_and_uncached_formulas() {
        let bytes = office_archive(&[
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Invoices" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C3"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Billed</t></is></c></row><row r="2"><c r="A2"><v>125</v></c><c r="B2"><f>SUM(A2:A2)</f><v>125</v></c><c r="C2"><f>A2*2</f></c></row></sheetData></worksheet>"#,
            ),
            (
                "xl/worksheets/sheet2.xml",
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="D4"/><sheetData><row r="4"><c r="D4"><v>73.5</v></c></row></sheetData></worksheet>"#,
            ),
        ]);
        let (text, warnings) = xlsx_text(bytes).unwrap();
        assert!(
            text.contains("Worksheet: \"Invoices\"") && text.contains("Worksheet: \"Other\""),
            "{text}"
        );
        assert!(
            text.contains("A1: \"Billed\"") && text.contains("B2: 125; formula = \"SUM(A2:A2)\""),
            "{text}"
        );
        assert!(
            text.contains("C2: [no cached value]") && text.contains("D4: 73.5"),
            "{text}"
        );
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("C2 has no cached")));
    }
}
