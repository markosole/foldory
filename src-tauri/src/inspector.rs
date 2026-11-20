use crate::{
    core::{hidden_or_system, link_or_reparse, Core},
    inspector_privacy::{clean_text, sensitive_path},
    models::FileDocument,
};
use ignore::{gitignore::Gitignore, gitignore::GitignoreBuilder, Match};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::Arc,
};

type Result<T> = std::result::Result<T, String>;

const OVERVIEW: &str = "PROJECT.md";
const MAX_VISITS: usize = 8_000;
const MAX_PER_DIRECTORY: usize = 2_000;
const MAX_PATH_BYTES: usize = 512;
const MAX_EVIDENCE_BYTES: usize = 32 * 1024;
const MAX_SAMPLE_BYTES: usize = 64 * 1024;
const MAX_SAMPLES: usize = 80;
const MAX_IGNORE_BYTES: usize = 64 * 1024;
const MAX_ALL_IGNORE_BYTES: usize = 512 * 1024;
pub(crate) const MAX_DRAFT_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ScanLevel {
    Outline,
    #[default]
    Standard,
    Deep,
}

impl ScanLevel {
    fn limits(self) -> (usize, usize, usize, usize) {
        match self {
            Self::Outline => (2, 100, 0, 0),
            Self::Standard => (5, 240, 16, 2 * 1024),
            Self::Deep => (8, 400, 30, 4 * 1024),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanOptions {
    pub level: ScanLevel,
    pub input_kib: usize,
    pub focus: String,
    pub additional_file: String,
    pub exclude_patterns: Vec<String>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            level: ScanLevel::Standard,
            input_kib: 32,
            focus: String::new(),
            additional_file: String::new(),
            exclude_patterns: vec![],
        }
    }
}

impl ScanOptions {
    pub fn validate(&self) -> Result<()> {
        if !(4..=96).contains(&self.input_kib)
            || self.focus.len() > MAX_PATH_BYTES
            || self.additional_file.len() > MAX_PATH_BYTES
        {
            return Err(
                "Use a 4–96 KiB input budget and project-relative paths up to 512 bytes.".into(),
            );
        }
        validate_exclusions(&self.exclude_patterns)
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Coverage {
    pub visited: usize,
    pub excluded: usize,
    pub withheld_documents: usize,
    pub redacted_documents: usize,
    pub omitted_documents: usize,
    pub omitted_paths: usize,
    pub traversal_limited: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectionEvidence {
    pub focus: Option<String>,
    pub tree: Vec<String>,
    pub documents: Vec<InspectionDocument>,
    pub coverage: Coverage,
    #[serde(skip)]
    pub overview_revision: Option<String>,
    #[serde(skip)]
    pub overview_issue: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectionDocument {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    #[serde(skip)]
    pub approved: bool,
}

struct Entry {
    path: String,
    depth: usize,
    directory: bool,
    priority: Option<u8>,
}

struct IgnoreRules {
    local: Gitignore,
    parent: Option<Arc<IgnoreRules>>,
}

impl IgnoreRules {
    fn skips(&self, path: &Path, directory: bool) -> bool {
        match self.local.matched(path, directory) {
            Match::Ignore(_) => true,
            Match::Whitelist(_) => false,
            Match::None => self
                .parent
                .as_ref()
                .is_some_and(|parent| parent.skips(path, directory)),
        }
    }
}

fn inspection_root(core: &Core, project_id: &str) -> Result<PathBuf> {
    let root = core.validated_path(project_id, "")?;
    if !root.is_dir() {
        return Err("The registered project folder is unavailable.".into());
    }
    Ok(root)
}

fn checked_entry(core: &Core, project_id: &str, root: &Path, relative: &str) -> Result<PathBuf> {
    let path = core.validated_path(project_id, relative)?;
    if path.starts_with(root) {
        Ok(path)
    } else {
        Err("The project path has changed. Inspect it again.".into())
    }
}

fn has_safe_file(root: &Path, name: &str) -> Result<bool> {
    match fs::symlink_metadata(root.join(name)) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not check {name}: {error}")),
        Ok(meta) if !meta.is_file() || link_or_reparse(&meta) || hidden_or_system(name, &meta) => {
            Err(format!(
                "{name} must be a visible, regular file inside the project."
            ))
        }
        Ok(_) => Ok(true),
    }
}

fn overview_snapshot(core: &Core, project_id: &str, root: &Path) -> Result<Option<FileDocument>> {
    if has_safe_file(root, OVERVIEW)? {
        checked_entry(core, project_id, root, OVERVIEW)?;
        core.read_file(project_id, OVERVIEW).map(Some)
    } else {
        Ok(None)
    }
}

fn excluded(name: &str, directory: bool) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    hard_excluded(name, directory)
        || matches!(
            stem,
            "secure" | "private" | "invoices" | "confidential" | "payroll" | "personal"
        )
}

fn hard_excluded(name: &str, directory: bool) -> bool {
    let extension = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    name.starts_with('.')
        || name.contains("credential")
        || name.contains("secret")
        || name.contains("password")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || name.starts_with("id_dsa")
        || matches!(
            name,
            "token.json" | "tokens.json" | "auth.json" | "token.txt" | "auth.txt"
        )
        || matches!(
            extension,
            "pem"
                | "p12"
                | "pfx"
                | "key"
                | "kdbx"
                | "ppk"
                | "jks"
                | "keystore"
                | "env"
                | "crt"
                | "cer"
                | "p7b"
                | "log"
                | "sql"
                | "sqlite"
                | "sqlite3"
                | "db"
                | "csv"
                | "tsv"
                | "parquet"
                | "jsonl"
                | "ndjson"
                | "zip"
                | "bak"
                | "dump"
                | "tgz"
                | "gz"
                | "7z"
                | "rar"
                | "tar"
                | "tfvars"
                | "tfstate"
        )
        || (directory
            && matches!(
                name,
                "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | "__pycache__"
                    | "venv"
                    | "vendor"
                    | "backups"
                    | "backup"
                    | "vault"
                    | "coverage"
                    | "obj"
                    | "bin"
                    | "out"
                    | "artifacts"
                    | "datasets"
                    | "dumps"
                    | "exports"
                    | "logs"
            ))
}

fn exclusion_builder(root: &Path, patterns: &[String]) -> Result<GitignoreBuilder> {
    let mut builder = GitignoreBuilder::new(root);
    builder
        .case_insensitive(cfg!(windows))
        .map_err(|e| e.to_string())?;
    for pattern in patterns.iter().map(|pattern| pattern.trim()) {
        if pattern.starts_with('!') {
            return Err("Inspector exclusions are additive. Remove any ! exceptions.".into());
        }
        builder
            .add_line(None, pattern)
            .map_err(|e| format!("Invalid inspector exclusion: {e}"))?;
    }
    Ok(builder)
}

pub(crate) fn validate_exclusions(patterns: &[String]) -> Result<()> {
    if patterns.len() > 128
        || patterns
            .iter()
            .any(|pattern| pattern.len() > 512 || pattern.chars().any(char::is_control))
    {
        return Err("Use up to 128 inspector exclusions, one pattern per line.".into());
    }
    exclusion_builder(Path::new("."), patterns)?
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn custom_rules(root: &Path, saved: &[String], run: &[String]) -> Result<Gitignore> {
    let patterns = saved.iter().chain(run).cloned().collect::<Vec<_>>();
    let mut builder = exclusion_builder(root, &patterns)?;
    match read_text(&root.join(".inspectorignore"), MAX_IGNORE_BYTES) {
        Ok((text, false)) => {
            for line in text.lines().map(str::trim) {
                if line.starts_with('!') || line.chars().any(char::is_control) {
                    return Err(".inspectorignore accepts additive exclusion patterns only.".into());
                }
                builder
                    .add_line(None, line)
                    .map_err(|e| format!("Invalid .inspectorignore pattern: {e}"))?;
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        _ => return Err("Could not safely read .inspectorignore within 64 KiB.".into()),
    }
    builder.build().map_err(|e| e.to_string())
}

fn document_priority(name: &str) -> Option<u8> {
    let (stem, extension) = name.rsplit_once('.').unwrap_or((name, ""));
    let prose = matches!(extension, "md" | "mdx" | "markdown" | "rst" | "adoc");
    if matches!(stem, "readme" | "project") && (prose || matches!(extension, "" | "txt")) {
        Some(0)
    } else if matches!(
        name,
        "package.json"
            | "deno.json"
            | "cargo.toml"
            | "pyproject.toml"
            | "requirements.txt"
            | "setup.py"
            | "setup.cfg"
            | "go.mod"
            | "pom.xml"
            | "build.gradle"
            | "build.gradle.kts"
            | "gemfile"
            | "composer.json"
            | "pubspec.yaml"
            | "mix.exs"
            | "package.swift"
            | "dockerfile"
            | "makefile"
            | "cmakelists.txt"
            | "tauri.conf.json"
            | "project.godot"
    ) || matches!(
        extension,
        "sln" | "slnx" | "csproj" | "fsproj" | "vbproj" | "uproject"
    ) {
        Some(1)
    } else if prose {
        Some(2)
    } else {
        None
    }
}

fn read_text(path: &Path, limit: usize) -> std::io::Result<(String, bool)> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || link_or_reparse(&meta) {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "Expected a regular file",
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if link_or_reparse(&file.metadata()?) {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "Expected a regular file",
        ));
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    if bytes.contains(&0) {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "Expected text"));
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).map_err(std::io::Error::other)?
        }
        Err(error) => return Err(std::io::Error::new(ErrorKind::InvalidData, error)),
    };
    Ok((text.trim_start_matches('\u{feff}').to_string(), truncated))
}

fn local_rules(
    directory: &Path,
    parent: Option<Arc<IgnoreRules>>,
    remaining: &mut usize,
) -> Result<Option<Arc<IgnoreRules>>> {
    let mut builder = GitignoreBuilder::new(directory);
    for name in [".gitignore", ".ignore"] {
        let path = directory.join(name);
        let limit = (*remaining).min(MAX_IGNORE_BYTES);
        let contents = match read_text(&path, limit) {
            Ok((contents, false)) => {
                *remaining -= contents.len();
                contents
            }
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            _ => {
                *remaining -= limit;
                return Err(
                    "Project ignore rules could not be read within inspection limits.".into(),
                );
            }
        };
        for line in contents.lines() {
            builder
                .add_line(Some(path.clone()), line)
                .map_err(|error| error.to_string())?;
        }
    }
    let local = builder.build().map_err(|error| error.to_string())?;
    Ok(if local.is_empty() {
        parent
    } else {
        Some(Arc::new(IgnoreRules { local, parent }))
    })
}

fn eligible_path(
    core: &Core,
    project_id: &str,
    root: &Path,
    relative: &str,
    directory: bool,
    allow_private: bool,
    custom: &Gitignore,
) -> Result<(String, Option<Arc<IgnoreRules>>)> {
    let path = checked_entry(core, project_id, root, relative)?;
    let mut ancestor = root.to_path_buf();
    let mut rules = None;
    let mut ignore_bytes = MAX_ALL_IGNORE_BYTES;
    let parts = path.strip_prefix(root).map_err(|e| e.to_string())?;
    if parts.as_os_str().is_empty() {
        return Err("Choose a file or folder inside the project.".into());
    }
    let mut components = parts.iter().peekable();
    while let Some(part) = components.next() {
        rules = local_rules(&ancestor, rules, &mut ignore_bytes)?;
        ancestor.push(part);
        let meta = fs::symlink_metadata(&ancestor).map_err(|e| e.to_string())?;
        let name = part.to_str().ok_or("Expected a UTF-8 project path.")?;
        let is_directory = directory || components.peek().is_some();
        let lower = name.to_lowercase();
        if (is_directory && !meta.is_dir())
            || (!is_directory && !meta.is_file())
            || hidden_or_system(name, &meta)
            || link_or_reparse(&meta)
            || sensitive_path(name)
            || if allow_private {
                hard_excluded(&lower, is_directory)
            } else {
                excluded(&lower, is_directory)
            }
            || custom.matched(&ancestor, is_directory).is_ignore()
            || rules
                .as_ref()
                .is_some_and(|rules| rules.skips(&ancestor, is_directory))
        {
            return Err(
                "The selected path is excluded by the inspector's privacy or ignore rules.".into(),
            );
        }
    }
    Ok((parts.to_string_lossy().replace('\\', "/"), rules))
}

pub(crate) fn review_additional_file(
    core: &Core,
    project_id: &str,
    options: &ScanOptions,
    saved: &[String],
) -> Result<String> {
    let root = inspection_root(core, project_id)?;
    let custom = custom_rules(&root, saved, &options.exclude_patterns)?;
    let (path, _) = eligible_path(
        core,
        project_id,
        &root,
        &options.additional_file,
        false,
        true,
        &custom,
    )?;
    let name = path.rsplit('/').next().unwrap_or(&path).to_lowercase();
    if document_priority(&name).is_none() && !source_file(&name) && !name.ends_with(".txt") {
        return Err("Choose a supported text document, manifest, or source file.".into());
    }
    Ok(path)
}

fn source_file(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, extension)| {
        matches!(
            extension,
            "ts" | "tsx"
                | "js"
                | "jsx"
                | "py"
                | "rs"
                | "go"
                | "java"
                | "kt"
                | "cs"
                | "c"
                | "cpp"
                | "h"
                | "hpp"
                | "rb"
                | "php"
                | "swift"
                | "vue"
                | "svelte"
        )
    })
}

fn collect_entries(
    core: &Core,
    project_id: &str,
    root: &Path,
    level: ScanLevel,
    start: (String, usize, Option<Arc<IgnoreRules>>),
    custom: &Gitignore,
    coverage: &mut Coverage,
) -> Result<Vec<Entry>> {
    let mut pending = VecDeque::from([start]);
    let mut entries = Vec::new();
    let mut ignore_bytes = MAX_ALL_IGNORE_BYTES;
    let (max_depth, _, _, _) = level.limits();
    'scan: while let Some((relative, depth, parent_rules)) = pending.pop_front() {
        let children = checked_entry(core, project_id, root, &relative).and_then(|directory| {
            let rules = local_rules(&directory, parent_rules, &mut ignore_bytes)?;
            let children = fs::read_dir(directory).map_err(|error| error.to_string())?;
            Ok((rules, children))
        });
        let (rules, children) = match children {
            Ok(children) => children,
            Err(error) if depth == 0 => return Err(error),
            Err(_) => {
                coverage.traversal_limited = true;
                continue;
            }
        };
        for (index, child) in children.enumerate() {
            if coverage.visited == MAX_VISITS {
                coverage.traversal_limited = true;
                break 'scan;
            }
            if index == MAX_PER_DIRECTORY {
                coverage.traversal_limited = true;
                break;
            }
            coverage.visited += 1;
            let (path, name, meta) = match child.and_then(|child| {
                let path = child.path();
                let meta = fs::symlink_metadata(&path)?;
                Ok((path, child.file_name(), meta))
            }) {
                Ok(entry) => entry,
                Err(_) => {
                    coverage.traversal_limited = true;
                    continue;
                }
            };
            let Some(name) = name.to_str() else {
                coverage.traversal_limited = true;
                continue;
            };
            let lower = name.to_lowercase();
            let directory = meta.is_dir();
            if link_or_reparse(&meta)
                || hidden_or_system(name, &meta)
                || excluded(&lower, directory)
                || sensitive_path(name)
                || custom.matched(&path, directory).is_ignore()
                || !(directory || meta.is_file())
                || crate::core::validate_name(name).is_err()
                || rules
                    .as_ref()
                    .is_some_and(|rules| rules.skips(&path, directory))
            {
                coverage.excluded += 1;
                continue;
            }
            let relative = if relative.is_empty() {
                name.to_string()
            } else {
                format!("{relative}/{name}")
            };
            if relative.len() > MAX_PATH_BYTES {
                coverage.traversal_limited = true;
                continue;
            }
            if directory {
                if depth + 1 < max_depth {
                    pending.push_back((relative.clone(), depth + 1, rules.clone()));
                } else {
                    coverage.traversal_limited = true;
                }
            }
            entries.push(Entry {
                path: relative,
                depth: depth + 1,
                directory,
                priority: if directory {
                    None
                } else {
                    document_priority(&lower).or_else(|| {
                        (matches!(level, ScanLevel::Deep) && source_file(&lower)).then_some(3)
                    })
                },
            });
        }
    }
    Ok(entries)
}

pub(crate) fn inspect_project(
    core: &Core,
    project_id: &str,
    options: &ScanOptions,
    saved_exclusions: &[String],
    approved: Option<&str>,
) -> Result<InspectionEvidence> {
    options.validate()?;
    let root = inspection_root(core, project_id)?;
    let custom = custom_rules(&root, saved_exclusions, &options.exclude_patterns)?;
    let mut coverage = Coverage::default();
    let (focus, rules) = if options.focus.is_empty() {
        (String::new(), None)
    } else {
        eligible_path(
            core,
            project_id,
            &root,
            &options.focus,
            true,
            false,
            &custom,
        )?
    };
    let mut entries = collect_entries(
        core,
        project_id,
        &root,
        options.level,
        (focus.clone(), 0, rules),
        &custom,
        &mut coverage,
    )?;
    if coverage.traversal_limited {
        retain_scope_anchors(core, project_id, &root, &focus, &custom, &mut entries);
    }
    let overview_result = has_safe_file(&root, OVERVIEW).and_then(|exists| {
        if !exists {
            return Ok(None);
        }
        eligible_path(core, project_id, &root, OVERVIEW, false, false, &custom)
            .map_err(|_| "The existing PROJECT.md is excluded. Inspector replacement is disabled.".to_string())?;
        let existing = overview_snapshot(core, project_id, &root)?;
        if existing.as_ref().is_some_and(|document| crate::inspector_privacy::contains_credential(&document.content)) {
            return Err("The existing PROJECT.md contains a possible credential. Inspector replacement is disabled.".into());
        }
        Ok(existing)
    });
    let (overview, overview_issue) = match overview_result {
        Ok(overview) => (overview, None),
        Err(error) => (None, Some(error)),
    };
    let (_, max_tree, max_docs, excerpt_limit) = options.level.limits();
    let mut documents = Vec::new();
    let mut blocked = HashSet::new();
    let mut excerpts = HashSet::new();
    if let Some(approved) = approved {
        let (path, _) = eligible_path(core, project_id, &root, approved, false, true, &custom)?;
        let document = sample_document(core, project_id, &root, &path, 4 * 1024, false, &mut coverage)
            .ok_or("The approved file contained possible credentials, was unreadable, or had no usable text.")?;
        excerpts.insert(document.content.clone());
        documents.push(InspectionDocument {
            approved: true,
            ..document
        });
    }
    let mut candidates = balanced_candidates(&entries, &focus);
    candidates.retain(|entry| approved != Some(entry.path.as_str()));
    for (index, entry) in candidates.iter().enumerate() {
        if documents.len() >= max_docs + usize::from(approved.is_some()) || index >= MAX_SAMPLES {
            coverage.omitted_documents += candidates.len() - index;
            break;
        }
        if let Some(document) = sample_document(
            core,
            project_id,
            &root,
            &entry.path,
            excerpt_limit,
            entry.priority == Some(3),
            &mut coverage,
        ) {
            if excerpts.insert(document.content.clone()) {
                documents.push(document);
            } else {
                coverage.omitted_documents += 1;
            }
        } else {
            blocked.insert(entry.path.as_str());
        }
    }
    let mut tree_entries: Vec<_> = entries
        .iter()
        .filter(|entry| !blocked.contains(entry.path.as_str()))
        .collect();
    tree_entries.sort_unstable_by_key(|entry| (entry.depth, !entry.directory, &entry.path));
    coverage.omitted_paths += tree_entries.len().saturating_sub(max_tree);
    let tree = tree_entries
        .into_iter()
        .take(max_tree)
        .map(|entry| {
            if entry.directory {
                format!("{}/", entry.path)
            } else {
                entry.path.clone()
            }
        })
        .collect();
    Ok(InspectionEvidence {
        focus: (!focus.is_empty()).then_some(focus),
        tree,
        documents,
        coverage,
        overview_revision: overview.map(|doc| doc.revision),
        overview_issue,
    })
}

fn retain_scope_anchors(
    core: &Core,
    project_id: &str,
    root: &Path,
    focus: &str,
    custom: &Gitignore,
    entries: &mut Vec<Entry>,
) {
    // A very wide directory can hit its visit limit before its key docs appear.
    for name in [
        OVERVIEW,
        "README.md",
        "README",
        "README.txt",
        "README.markdown",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        "pom.xml",
        "Makefile",
    ] {
        let relative = if focus.is_empty() {
            name.to_string()
        } else {
            format!("{focus}/{name}")
        };
        let Ok((path, _)) = eligible_path(core, project_id, root, &relative, false, false, custom)
        else {
            continue;
        };
        if path.len() <= MAX_PATH_BYTES && !entries.iter().any(|entry| entry.path == path) {
            entries.push(Entry {
                path,
                depth: 1,
                directory: false,
                priority: document_priority(&name.to_lowercase()),
            });
        }
    }
}

fn balanced_candidates<'a>(entries: &'a [Entry], focus: &str) -> Vec<&'a Entry> {
    let mut candidates: Vec<_> = entries
        .iter()
        .filter(|entry| entry.priority.is_some())
        .collect();
    candidates.sort_unstable_by_key(|entry| (entry.priority, entry.depth, &entry.path));
    let mut ordered = Vec::new();
    let mut folders: BTreeMap<&str, VecDeque<&Entry>> = BTreeMap::new();
    for entry in candidates {
        if entry.depth == 1 && entry.priority <= Some(1) {
            ordered.push(entry);
        } else {
            let relative = entry
                .path
                .strip_prefix(focus)
                .unwrap_or(&entry.path)
                .trim_start_matches('/');
            let group = relative
                .split_once('/')
                .map(|(folder, _)| folder)
                .unwrap_or("");
            folders.entry(group).or_default().push_back(entry);
        }
    }
    while !folders.is_empty() {
        folders.retain(|_, group| {
            if let Some(entry) = group.pop_front() {
                ordered.push(entry);
            }
            !group.is_empty()
        });
    }
    ordered
}

fn sample_document(
    core: &Core,
    project_id: &str,
    root: &Path,
    relative: &str,
    limit: usize,
    source: bool,
    coverage: &mut Coverage,
) -> Option<InspectionDocument> {
    let sample = checked_entry(core, project_id, root, relative)
        .ok()
        .and_then(|path| read_text(&path, MAX_SAMPLE_BYTES).ok());
    let Some((sample, clipped)) = sample else {
        coverage.withheld_documents += 1;
        return None;
    };
    let Some((mut text, redacted)) = clean_text(&sample) else {
        coverage.withheld_documents += 1;
        return None;
    };
    if clipped {
        // Only retain complete lines from a bounded read.
        text.truncate(text.rfind('\n').unwrap_or(0));
    }
    let name = relative
        .rsplit('/')
        .next()
        .unwrap_or(relative)
        .to_ascii_lowercase();
    let structured = matches!(
        name.as_str(),
        "package.json" | "composer.json" | "deno.json" | "tauri.conf.json"
    );
    let compacted = structured || source || text.len() > limit;
    let content = if structured {
        manifest_facts(&text)
            .map(|facts| compact_excerpt(&facts, limit, false))
            .unwrap_or_default()
    } else {
        compact_excerpt(&text, limit, source)
    };
    if content.trim().is_empty() {
        coverage.withheld_documents += 1;
        return None;
    }
    coverage.redacted_documents += usize::from(redacted);
    Some(InspectionDocument {
        path: relative.to_string(),
        content,
        truncated: clipped || compacted,
        approved: false,
    })
}

fn manifest_facts(text: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut facts = Vec::new();
    for key in ["name", "productName", "version", "type"] {
        if let Some(value) = json[key]
            .as_str()
            .filter(|value| value.len() <= 120 && !value.contains(['\n', '\r']))
        {
            facts.push(format!("{key}: {value}"));
        }
    }
    for key in [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "require",
        "imports",
        "scripts",
        "tasks",
    ] {
        if let Some(values) = json[key].as_object() {
            let keys: Vec<_> = values
                .keys()
                .filter(|key| key.len() <= 80 && !sensitive_path(key))
                .take(24)
                .map(String::as_str)
                .collect();
            facts.push(format!(
                "{key} ({} entries): {}",
                values.len(),
                keys.join(", ")
            ));
        }
    }
    Some(facts.join("\n"))
}

fn compact_excerpt(text: &str, limit: usize, source: bool) -> String {
    if !source && text.len() <= limit {
        return text.trim().to_string();
    }
    let lines: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let mut output = String::new();
    let mut seen = HashSet::new();
    let selected: Vec<_> = if source {
        lines
            .iter()
            .copied()
            .filter(|line| {
                [
                    "import ",
                    "export ",
                    "use ",
                    "pub ",
                    "fn ",
                    "def ",
                    "class ",
                    "interface ",
                    "namespace ",
                    "type ",
                    "func ",
                    "package ",
                    "function ",
                    "#include ",
                ]
                .iter()
                .any(|prefix| line.starts_with(prefix))
            })
            .map(|line| {
                if line.starts_with("import ")
                    || line.starts_with("use ")
                    || line.starts_with("#include ")
                {
                    line
                } else {
                    line.split(['=', '{', ';'])
                        .next()
                        .unwrap_or_default()
                        .trim_end()
                }
            })
            .collect()
    } else {
        lines
            .iter()
            .take(6)
            .copied()
            .chain(lines.iter().copied().filter(|line| line.starts_with('#')))
            .chain(lines.iter().skip(6).copied())
            .collect()
    };
    for line in selected {
        if !seen.insert(line) {
            continue;
        }
        let remaining = limit.saturating_sub(output.len());
        if remaining < 16 {
            break;
        }
        let boundary = line.floor_char_boundary(line.len().min(remaining - 1).min(240));
        output.push_str(&line[..boundary]);
        output.push('\n');
    }
    output.trim_end().to_string()
}

pub(crate) fn sensitive_material(text: &str) -> bool {
    text.lines()
        .any(|line| line.contains("-----BEGIN ") && line.contains("PRIVATE KEY-----"))
}

pub(crate) fn read_root_doc_excerpt(
    core: &Core,
    project_id: &str,
    name: &str,
    limit: usize,
) -> Result<Option<(String, bool)>> {
    if !matches!(
        name,
        OVERVIEW | "README.md" | "readme.md" | "README.markdown" | "README" | "README.txt"
    ) {
        return Err("Select a supported root documentation file.".into());
    }
    read_project_excerpt(core, project_id, name, limit)
}

pub(crate) fn read_project_excerpt(
    core: &Core,
    project_id: &str,
    relative: &str,
    limit: usize,
) -> Result<Option<(String, bool)>> {
    let root = inspection_root(core, project_id)?;
    if limit == 0 {
        return Ok(None);
    }
    let Ok(path) = checked_entry(core, project_id, &root, relative) else {
        return Ok(None);
    };
    let relative_path = path
        .strip_prefix(&root)
        .map_err(|error| error.to_string())?;
    let mut directory = root;
    let mut rules = None;
    let mut ignore_bytes = MAX_ALL_IGNORE_BYTES;
    let mut components = relative_path.iter().peekable();
    while let Some(part) = components.next() {
        rules = local_rules(&directory, rules, &mut ignore_bytes)?;
        directory.push(part);
        let meta = fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
        let Some(name) = part.to_str() else {
            return Ok(None);
        };
        let is_directory = components.peek().is_some();
        let expected_kind = if is_directory {
            meta.is_dir()
        } else {
            meta.is_file()
        };
        if link_or_reparse(&meta)
            || hidden_or_system(name, &meta)
            || excluded(&name.to_lowercase(), is_directory)
            || !expected_kind
            || rules
                .as_ref()
                .is_some_and(|rules| rules.skips(&directory, is_directory))
        {
            return Ok(None);
        }
    }
    let (text, truncated) = read_text(&path, limit.min(MAX_EVIDENCE_BYTES))
        .map_err(|error| format!("Could not read {relative}: {error}"))?;
    Ok((!text.is_empty() && !sensitive_material(&text)).then_some((text, truncated)))
}

pub(crate) fn write_access(core: &Core, project_id: &str) -> Result<bool> {
    core.project(project_id)?;
    core.db()?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM inspector_write_access WHERE project_id=?1)",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

pub(crate) fn set_write_access(core: &Core, project_id: &str, enabled: bool) -> Result<bool> {
    let _guard = core.lock_project_mutations()?;
    core.project(project_id)?;
    let statement = if enabled {
        "INSERT OR IGNORE INTO inspector_write_access(project_id) VALUES(?1)"
    } else {
        "DELETE FROM inspector_write_access WHERE project_id=?1"
    };
    core.db()?
        .execute(statement, [project_id])
        .map_err(|error| error.to_string())?;
    Ok(enabled)
}

pub(crate) fn apply_overview(
    core: &Core,
    project_id: &str,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<FileDocument> {
    if content.trim().is_empty() || content.len() > MAX_DRAFT_BYTES || content.contains('\0') {
        return Err("PROJECT.md must contain text and fit within 128 KiB.".into());
    }
    // Keep permission changes and source removal serialized with the checked write.
    let _guard = core.lock_project_mutations()?;
    if !write_access(core, project_id)? {
        return Err("Enable AI write access for this project before applying a draft.".into());
    }
    let root = inspection_root(core, project_id)?;
    if has_safe_file(&root, OVERVIEW)? != expected_revision.is_some() {
        return Err(
            "CONFLICT: PROJECT.md changed after inspection. Inspect the project again.".into(),
        );
    }
    core.write_file(project_id, OVERVIEW, content, expected_revision, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Project;

    fn standard(core: &Core, project: &Project) -> Result<InspectionEvidence> {
        inspect_project(core, &project.id, &ScanOptions::default(), &[], None)
    }

    fn fixture() -> (tempfile::TempDir, Core, Project, Project) {
        let temp = tempfile::tempdir().unwrap();
        let sources = temp.path().join("projects");
        for project in ["Alpha", "Beta"] {
            fs::create_dir_all(sources.join(project)).unwrap();
        }
        let core = Core::new(temp.path().join("data")).unwrap();
        let mut projects = core.add_source(sources.to_str().unwrap()).unwrap().projects;
        let beta = projects.pop().unwrap();
        let alpha = projects.pop().unwrap();
        (temp, core, alpha, beta)
    }

    #[test]
    fn inspector_prioritizes_documentation_and_excludes_private_and_ignored_paths() {
        let (_temp, core, project, _) = fixture();
        let root = Path::new(&project.path);
        for directory in ["Docs", "node_modules", "Secure"] {
            fs::create_dir(root.join(directory)).unwrap();
        }
        for (path, content) in [
            ("Readme.MD", "# Purpose"),
            ("Docs/readme.md", "# Nested purpose"),
            ("Docs/notes.md", "# Development notes"),
            ("package.json", "{\"name\":\"alpha\"}"),
            (".gitignore", "ignored.md\n"),
            ("Docs/.ignore", "internal.md\n"),
            ("Docs/internal.md", "private content"),
            ("ignored.md", "private content"),
            ("node_modules/readme.md", "private content"),
            ("Secure/readme.md", "private content"),
            ("passwords.md", "private content"),
            (".hidden.md", "private content"),
        ] {
            fs::write(root.join(path), content).unwrap();
        }
        let evidence = standard(&core, &project).unwrap();
        let paths: Vec<_> = evidence
            .documents
            .iter()
            .map(|doc| doc.path.as_str())
            .collect();
        assert_eq!(
            paths,
            [
                "Readme.MD",
                "package.json",
                "Docs/readme.md",
                "Docs/notes.md"
            ]
        );
        assert_eq!(
            evidence.tree,
            [
                "Docs/",
                "Readme.MD",
                "package.json",
                "Docs/notes.md",
                "Docs/readme.md"
            ]
        );
        assert!(evidence.overview_revision.is_none());
        assert!(evidence.overview_issue.is_none());
        assert!(!root.join(OVERVIEW).exists());
    }

    #[test]
    fn inspector_write_access_is_per_project_persists_and_requires_matching_revision() {
        let (temp, core, alpha, beta) = fixture();
        assert!(!write_access(&core, &alpha.id).unwrap());
        assert!(apply_overview(&core, &alpha.id, "# Draft", None).is_err());
        assert!(!Path::new(&alpha.path).join(OVERVIEW).exists());
        assert!(set_write_access(&core, &alpha.id, true).unwrap());
        assert!(!write_access(&core, &beta.id).unwrap());
        drop(core);

        let core = Core::new(temp.path().join("data")).unwrap();
        assert!(write_access(&core, &alpha.id).unwrap());
        let written = apply_overview(&core, &alpha.id, "# Approved", None).unwrap();
        assert!(apply_overview(&core, &alpha.id, "# Would overwrite", None).is_err());
        let evidence = standard(&core, &alpha).unwrap();
        assert_eq!(
            evidence.overview_revision.as_deref(),
            Some(written.revision.as_str())
        );
        assert_eq!(evidence.documents[0].content, "# Approved");
        fs::write(Path::new(&alpha.path).join(OVERVIEW), "# External edit").unwrap();
        assert!(apply_overview(&core, &alpha.id, "# Stale", Some(&written.revision)).is_err());
        let current = core.read_file(&alpha.id, OVERVIEW).unwrap();
        assert_eq!(current.content, "# External edit");
        let written =
            apply_overview(&core, &alpha.id, "# Updated", Some(&current.revision)).unwrap();
        assert!(!set_write_access(&core, &alpha.id, false).unwrap());
        assert!(apply_overview(&core, &alpha.id, "# Revoked", Some(&written.revision)).is_err());
        assert_eq!(
            core.read_file(&alpha.id, OVERVIEW).unwrap().content,
            "# Updated"
        );
    }

    #[test]
    fn inspector_bounds_utf8_excerpts_and_blocks_unusable_overviews() {
        let (_temp, core, project, _) = fixture();
        let root = Path::new(&project.path);
        fs::write(
            root.join("README.md"),
            format!("# Purpose\n{}\n# Later section\n", "€".repeat(3000)),
        )
        .unwrap();
        fs::create_dir(root.join(OVERVIEW)).unwrap();
        let evidence = standard(&core, &project).unwrap();
        assert!(evidence.documents[0].truncated);
        assert!(evidence.documents[0].content.len() <= 2 * 1024);
        assert!(evidence.documents[0].content.contains("# Later section"));
        assert!(evidence.overview_revision.is_none());
        assert!(evidence.overview_issue.is_some());
        set_write_access(&core, &project.id, true).unwrap();
        assert!(apply_overview(&core, &project.id, "# Draft", None).is_err());
        assert!(root.join(OVERVIEW).is_dir());
    }

    #[test]
    fn root_context_skips_ignored_docs_and_private_keys() {
        let (_temp, core, project, _) = fixture();
        let root = Path::new(&project.path);
        fs::write(root.join(OVERVIEW), "# Overview").unwrap();
        fs::write(
            root.join("README.md"),
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        )
        .unwrap();
        assert_eq!(
            read_root_doc_excerpt(&core, &project.id, OVERVIEW, 100).unwrap(),
            Some(("# Overview".into(), false))
        );
        assert!(read_root_doc_excerpt(&core, &project.id, "README.md", 100)
            .unwrap()
            .is_none());
        fs::write(root.join(".gitignore"), "PROJECT.md\n").unwrap();
        assert!(read_root_doc_excerpt(&core, &project.id, OVERVIEW, 100)
            .unwrap()
            .is_none());
    }

    #[cfg(windows)]
    #[test]
    fn inspector_refuses_linked_evidence_and_redirected_project_roots() {
        use std::os::windows::process::CommandExt;

        fn junction(link: &Path, target: &Path) {
            let output = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
        }

        let (temp, core, project, _) = fixture();
        let root = Path::new(&project.path);
        let redirected_source = temp.path().join("redirected");
        let outside = redirected_source.join("Alpha");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("README.md"), "# Outside project").unwrap();
        let linked = root.join(OVERVIEW);
        junction(&linked, &outside);

        let evidence = standard(&core, &project).unwrap();
        assert!(evidence.tree.is_empty());
        assert!(evidence.documents.is_empty());
        assert!(evidence.overview_issue.is_some());
        set_write_access(&core, &project.id, true).unwrap();
        assert!(apply_overview(&core, &project.id, "# Draft", None).is_err());
        fs::remove_dir(&linked).unwrap();

        let registered_source = root.parent().unwrap();
        fs::rename(registered_source, temp.path().join("moved")).unwrap();
        junction(registered_source, &redirected_source);
        assert!(standard(&core, &project).is_err());
        assert!(apply_overview(&core, &project.id, "# Draft", None).is_err());
        assert!(!outside.join(OVERVIEW).exists());
        fs::remove_dir(registered_source).unwrap();
    }

    #[test]
    fn scoped_scan_composes_exclusions_and_keeps_credentials_out_of_the_payload() {
        let (_temp, core, project, _) = fixture();
        let root = Path::new(&project.path);
        for directory in ["app/src", "app/private", "app/dist", "outside"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        for (path, content) in [
            (".inspectorignore", "app/from-project.md"),
            ("app/.gitignore", "!from-project.md\nignored.md"),
            ("app/from-project.md", "excluded by project"),
            ("app/from-settings.md", "excluded by settings"),
            ("app/from-run.md", "excluded this time"),
            ("app/ignored.md", "excluded by git"),
            (
                "app/private/notes.md",
                "# Approved notes\nfixture@example.invalid",
            ),
            ("app/dist/README.md", "build output"),
            ("app/.env", "TOKEN=fixture-test-value"),
            ("app/sample.csv", "private data dump"),
            ("app/readme.md", "# Kept"),
            ("app/notes.md", "client_secret: fixture-secret-value"),
            (
                "app/src/main.ts",
                "export const setup = \"implementation detail\";",
            ),
            ("outside/README.md", "# Outside"),
        ] {
            fs::write(root.join(path), content).unwrap();
        }
        let saved = vec!["**/from-settings.md".into()];
        let mut options = ScanOptions {
            level: ScanLevel::Deep,
            focus: "app".into(),
            additional_file: "app/private/notes.md".into(),
            exclude_patterns: vec!["**/from-run.md".into()],
            ..ScanOptions::default()
        };
        let preview = inspect_project(&core, &project.id, &options, &saved, None).unwrap();
        let unapproved = serde_json::to_string(&preview).unwrap();
        assert!(!unapproved.contains("Approved notes"));
        let approved = review_additional_file(&core, &project.id, &options, &saved).unwrap();
        let evidence =
            inspect_project(&core, &project.id, &options, &saved, Some(&approved)).unwrap();
        let payload = serde_json::to_string(&evidence).unwrap();
        for text in [
            "fixture@example",
            "fixture-secret-value",
            "app/notes.md",
            "Outside",
            "from-project.md",
            "from-settings.md",
            "from-run.md",
            "ignored.md",
            "app/dist",
            "app/.env",
            "sample.csv",
            "implementation detail",
        ] {
            assert!(!payload.contains(text), "{text}");
        }
        assert!(payload.contains("export const setup"));
        assert!(payload.contains("[email redacted]"));
        assert!(evidence.documents[0].approved);
        assert_eq!(evidence.coverage.withheld_documents, 1);
        options.additional_file = "app/.env".into();
        assert!(review_additional_file(&core, &project.id, &options, &saved).is_err());
        options.additional_file = "app/from-project.md".into();
        assert!(review_additional_file(&core, &project.id, &options, &saved).is_err());
        assert!(validate_exclusions(&["!node_modules/".into()]).is_err());
    }

    #[test]
    fn levels_cap_depth_and_balance_documents_across_folders() {
        let (_temp, core, project, _) = fixture();
        let root = Path::new(&project.path);
        fs::create_dir_all(root.join("a/one/two/three")).unwrap();
        fs::create_dir_all(root.join("z")).unwrap();
        for i in 0..24 {
            fs::write(root.join(format!("a/doc{i}.md")), format!("# Section {i}")).unwrap();
        }
        fs::write(root.join("z/guide.md"), "# Other subsystem").unwrap();
        fs::write(root.join("a/one/two/three/guide.md"), "# Nested").unwrap();
        let outline = inspect_project(
            &core,
            &project.id,
            &ScanOptions {
                level: ScanLevel::Outline,
                ..ScanOptions::default()
            },
            &[],
            None,
        )
        .unwrap();
        assert!(outline.documents.is_empty());
        assert!(outline.coverage.traversal_limited);
        assert!(!outline
            .tree
            .iter()
            .any(|path| path.starts_with("a/one/two")));
        let standard = standard(&core, &project).unwrap();
        assert_eq!(standard.documents.len(), 16);
        assert!(standard
            .documents
            .iter()
            .any(|doc| doc.path == "z/guide.md"));
        assert!(standard.coverage.omitted_documents > 0);
    }
}
