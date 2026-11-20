//! Search is derived app data. Traversal only reads project files; every write is
//! confined to the application's SQLite database and SQLite temporary storage.
use crate::{
    core::{indexed_content, link_or_reparse, now, Core},
    models::*,
};
use ignore::{
    gitignore::{Gitignore, GitignoreBuilder},
    WalkBuilder,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn defaults() -> IndexSettings {
    let profile =
        |id: &str, name: &str, enabled, folders: &[&str], files: &[&str], description: &str| {
            ExclusionProfile {
                id: id.into(),
                name: name.into(),
                description: description.into(),
                enabled,
                folder_patterns: folders.iter().map(|s| s.to_string()).collect(),
                file_patterns: files.iter().map(|s| s.to_string()).collect(),
            }
        };
    IndexSettings {
        follow_gitignore: true, folder_patterns: vec![], file_patterns: vec![],
        profiles: vec![
            profile("vcs-os", "Version control and operating systems", true, &[".git", ".hg", ".svn"], &[".DS_Store", "Thumbs.db", "desktop.ini"], "Repository internals and operating-system metadata."),
            profile("javascript", "JavaScript / TypeScript", true, &["node_modules", ".npm", ".pnpm-store", "**/.yarn/cache", ".next", ".nuxt", ".svelte-kit", "**/.angular/cache", ".turbo", ".parcel-cache", ".nyc_output"], &["*.tsbuildinfo"], "Installed dependencies and framework caches; source and lockfiles remain searchable."),
            profile("python", "Python", true, &["__pycache__", ".venv", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache"], &["*.pyc", "*.pyo"], "Virtual environments, bytecode and test/type-checker caches."),
            profile("rust", "Rust / Cargo outputs", false, &["target"], &[], "Cargo output. Optional because a folder named target can contain source in other projects."),
            profile("jvm", "Java / Kotlin / Gradle", true, &[".gradle", ".kotlin"], &["*.class"], "Gradle/Kotlin caches and compiled classes. Build/target are in the optional build-output list."),
            profile("dotnet", ".NET / Visual Studio", false, &[".vs", "bin", "obj", "packages"], &["*.user", "*.suo"], "Optional .NET output and package folders; these names may hold source in other ecosystems."),
            profile("php", "PHP / Composer", false, &["vendor", ".phpunit.cache"], &[".phpunit.result.cache"], "Optional Composer dependencies and PHPUnit cache. Vendor may include maintained source."),
            profile("ruby", "Ruby / Bundler", true, &[".bundle", "**/vendor/bundle", ".yardoc"], &[], "Bundler state, installed bundle and generated documentation cache."),
            profile("flutter", "Dart / Flutter", true, &[".dart_tool", ".pub-cache", ".pub", "**/flutter/ephemeral"], &[".flutter-plugins", ".flutter-plugins-dependencies"], "Dart tooling and generated Flutter state. lib and packages are deliberately included."),
            profile("cpp", "C / C++ / CMake", true, &["CMakeFiles", "cmake-build-*", ".cxx"], &["CMakeCache.txt", "*.o", "*.obj", "*.pch", "*.gch"], "CMake caches and compiler intermediates."),
            profile("swift", "Swift / Xcode", true, &[".build", "DerivedData", "xcuserdata"], &[], "Swift package builds and per-user Xcode caches."),
            profile("go", "Go dependencies", false, &["vendor"], &["*.test"], "Optional vendored modules and test executables. Go source and module lockfiles remain included."),
            profile("unity", "Unity generated folders", false, &["/Library", "/Temp", "/Obj", "/Logs"], &[], "Enable only when these project-root folders are generated Unity data. Library elsewhere may be source."),
            profile("unreal", "Unreal generated folders", false, &["DerivedDataCache", "Intermediate", "Binaries", "Saved"], &[], "Optional Unreal outputs and caches; Saved may contain work you want to search."),
            profile("build-output", "General build outputs", false, &["dist", "build", "out", "coverage", "library"], &[], "Broad names are opt-in: existing archives, libraries and deployment files may be important."),
            profile("private", "Private workspace folders", true, &["Secure"], &[], "Preserves the workspace's existing exclusion of Secure folders. Sensitive file contents are never indexed."),
        ],
    }
}

fn compile_patterns(
    root: &Path,
    patterns: impl Iterator<Item = String>,
    directory: bool,
) -> Result<Gitignore> {
    let mut builder = GitignoreBuilder::new(root);
    builder.case_insensitive(true).map_err(err)?;
    for raw in patterns {
        let pattern = raw.trim();
        if pattern.is_empty() || pattern.starts_with('#') {
            continue;
        }
        if pattern.len() > 1024
            || pattern.contains(['\0', '\n', '\r', ':', '\\'])
            || pattern.split('/').any(|part| part == "..")
        {
            return Err(format!(
                "Invalid exclusion pattern {pattern:?}. Use project-relative / paths or globs."
            ));
        }
        let pattern = if directory && !pattern.ends_with('/') {
            format!("{pattern}/")
        } else {
            pattern.into()
        };
        builder
            .add_line(None, &pattern)
            .map_err(|e| format!("Invalid exclusion pattern {pattern:?}: {e}"))?;
    }
    builder.build().map_err(err)
}

pub(crate) fn matchers(root: &Path, settings: &IndexSettings) -> Result<(Gitignore, Gitignore)> {
    let folders = settings
        .profiles
        .iter()
        .filter(|p| p.enabled)
        .flat_map(|p| p.folder_patterns.clone())
        .chain(settings.folder_patterns.clone());
    let files = settings
        .profiles
        .iter()
        .filter(|p| p.enabled)
        .flat_map(|p| p.file_patterns.clone())
        .chain(settings.file_patterns.clone());
    Ok((
        compile_patterns(root, folders, true)?,
        compile_patterns(root, files, false)?,
    ))
}

pub fn validate_settings(settings: &IndexSettings) -> Result<()> {
    if settings.profiles.len() > 100
        || settings.folder_patterns.len()
            + settings.file_patterns.len()
            + settings
                .profiles
                .iter()
                .map(|p| p.folder_patterns.len() + p.file_patterns.len())
                .sum::<usize>()
            > 5000
    {
        return Err("Use at most 100 exclusion lists and 5,000 patterns.".into());
    }
    let mut ids = HashSet::new();
    for p in &settings.profiles {
        if p.id.trim().is_empty()
            || p.id.len() > 100
            || !ids.insert(&p.id)
            || p.name.trim().is_empty()
            || p.name.len() > 200
            || p.description.len() > 2000
        {
            return Err(
                "Exclusion lists need unique IDs and a name of up to 200 characters.".into(),
            );
        }
        // Disabled lists are validated too, so enabling them cannot break a scan.
        compile_patterns(Path::new("."), p.folder_patterns.clone().into_iter(), true)?;
        compile_patterns(Path::new("."), p.file_patterns.clone().into_iter(), false)?;
    }
    matchers(Path::new("."), settings)?;
    Ok(())
}

impl Core {
    pub fn index_status(&self) -> Result<IndexStatus> {
        self.index.lock().map(|s| s.clone()).map_err(err)
    }

    pub fn index_statistics(&self) -> Result<Vec<ProjectIndexStats>> {
        let projects = self.projects()?;
        let db = self.db()?;
        projects
            .into_iter()
            .map(|p| {
                let stored: Option<String> = db
                    .query_row(
                        "SELECT json FROM project_indexes WHERE project_id=?1",
                        [&p.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(err)?;
                let mut stats: ProjectIndexStats = stored
                    .map(|s| serde_json::from_str(&s).map_err(err))
                    .transpose()?
                    .unwrap_or_else(|| ProjectIndexStats {
                        status: "neverIndexed".into(),
                        ..Default::default()
                    });
                stats.project_name = project_name(&p);
                stats.project_id = p.id;
                Ok(stats)
            })
            .collect()
    }

    pub fn rebuild_index(&self) -> Result<IndexStatus> {
        self.run_index(None, true)
    }

    pub fn refresh_index(&self) -> Result<IndexStatus> {
        self.run_index(None, false)
    }

    pub fn reindex_project(&self, project_id: &str) -> Result<IndexStatus> {
        self.project(project_id)?;
        self.run_index(Some(project_id), true)
    }

    fn run_index(&self, project_id: Option<&str>, force: bool) -> Result<IndexStatus> {
        let _operation = self.index_work.lock().map_err(err)?;
        let settings = self.settings()?.indexing;
        validate_settings(&settings)?;
        let settings_hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&settings).map_err(err)?)
        );
        {
            let mut status = self.index.lock().map_err(err)?;
            status.running = true;
            status.message = "Reading project metadata…".into();
        }
        let result = (|| -> Result<String> {
            let projects = self.projects()?;
            let previous: HashMap<_, _> = self
                .index_statistics()?
                .into_iter()
                .map(|s| (s.project_id.clone(), s))
                .collect();
            let mut completed = 0;
            let mut failed = 0;
            for project in projects
                .iter()
                .filter(|p| project_id.is_none_or(|id| p.id == id))
            {
                let old = previous.get(&project.id).cloned().unwrap_or_default();
                if !force && old.status == "cleared" {
                    continue;
                }
                let mut stats = old.clone();
                stats.project_id = project.id.clone();
                stats.project_name = project_name(project);
                stats.status = "running".into();
                self.save_index_stats(&stats, None)?;
                {
                    self.index.lock().map_err(err)?.message =
                        format!("Indexing {}…", project_name(project));
                }
                match self.index_one_project(project, &settings, &settings_hash, force) {
                    Ok(()) => completed += 1,
                    Err(error) => {
                        failed += 1;
                        stats = old;
                        stats.project_id = project.id.clone();
                        stats.project_name = project_name(project);
                        stats.status = "error".into();
                        stats.message = format!("Previous index retained: {error}");
                        self.save_index_stats(&stats, None)?;
                    }
                }
            }
            Ok(format!(
                "Refreshed {completed} projects.{} No global file-count limit.",
                if failed > 0 {
                    format!(" {failed} projects could not be read; their previous indexes were retained.")
                } else {
                    String::new()
                }
            ))
        })();
        let mut status = self.index.lock().map_err(err)?;
        status.running = false;
        status.message = match &result {
            Ok(s) => s.clone(),
            Err(e) => format!("Index interrupted: {e}"),
        };
        if result.is_ok() {
            status.last_indexed = now();
        }
        drop(status);
        self.refresh_index_totals()?;
        let status = self.index_status()?;
        self.db()?.execute("INSERT INTO kv(key,value) VALUES('index',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&status).map_err(err)?]).map_err(err)?;
        result?;
        Ok(status)
    }

    fn save_index_stats(&self, stats: &ProjectIndexStats, hash: Option<&str>) -> Result<()> {
        self.db()?.execute("INSERT INTO project_indexes(project_id,settings_hash,json) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM projects WHERE id=?1) ON CONFLICT(project_id) DO UPDATE SET json=excluded.json,settings_hash=CASE WHEN ?4 THEN excluded.settings_hash ELSE project_indexes.settings_hash END", params![stats.project_id, hash.unwrap_or(""), serde_json::to_string(stats).map_err(err)?, hash.is_some()]).map_err(err)?;
        Ok(())
    }

    fn refresh_index_totals(&self) -> Result<()> {
        let totals: (i64, i64) = self.db()?.query_row("SELECT COUNT(CASE WHEN f.directory=0 THEN 1 END),COUNT(DISTINCT f.project_id) FROM files f JOIN projects p ON p.id=f.project_id JOIN sources s ON s.id=p.source_id WHERE s.connected=1", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(err)?;
        let mut status = self.index.lock().map_err(err)?;
        status.files = totals.0 as u64;
        status.projects = totals.1 as u64;
        Ok(())
    }

    pub fn clear_project_index(&self, project_id: &str) -> Result<IndexStatus> {
        let _operation = self.index_work.lock().map_err(err)?;
        let project = self.project(project_id)?;
        let mut db = self.db()?;
        let tx = db.transaction().map_err(err)?;
        tx.execute(
            "DELETE FROM file_contents WHERE project_id=?1",
            [project_id],
        )
        .map_err(err)?;
        tx.execute("DELETE FROM files WHERE project_id=?1", [project_id])
            .map_err(err)?;
        let stats = ProjectIndexStats {
            project_id: project_id.into(),
            project_name: project_name(&project),
            status: "cleared".into(),
            message: "Index cleared. Reindex this project to make its files searchable again."
                .into(),
            ..Default::default()
        };
        tx.execute("INSERT INTO project_indexes(project_id,settings_hash,json) VALUES(?1,'',?2) ON CONFLICT(project_id) DO UPDATE SET settings_hash='',json=excluded.json", params![project_id,serde_json::to_string(&stats).map_err(err)?]).map_err(err)?;
        tx.commit().map_err(err)?;
        drop(db);
        self.refresh_index_totals()?;
        self.index.lock().map_err(err)?.message = format!(
            "Cleared the index for {}. Project files were not changed.",
            project_name(&project)
        );
        let status = self.index_status()?;
        self.db()?.execute("INSERT INTO kv(key,value) VALUES('index',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&status).map_err(err)?]).map_err(err)?;
        Ok(status)
    }

    fn index_one_project(
        &self,
        project: &Project,
        settings: &IndexSettings,
        settings_hash: &str,
        force: bool,
    ) -> Result<()> {
        let start = Instant::now();
        if !project.available {
            return Err("Project is unavailable.".into());
        }
        let root = self.validated_path(&project.id, "")?;
        let (folders, files) = matchers(&root, settings)?;
        let excluded = Arc::new(AtomicU64::new(0));
        let count = excluded.clone();
        let mut walker = WalkBuilder::new(&root);
        walker
            .hidden(false)
            .ignore(false)
            .git_ignore(settings.follow_gitignore)
            .git_global(false)
            .git_exclude(false)
            .parents(false)
            .require_git(false)
            .follow_links(false)
            .filter_entry(move |entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let directory = entry.file_type().is_some_and(|t| t.is_dir());
                let excluded = if directory {
                    folders
                        .matched_path_or_any_parents(entry.path(), true)
                        .is_ignore()
                } else {
                    files.matched(entry.path(), false).is_ignore()
                };
                let linked = entry
                    .metadata()
                    .map(|m| link_or_reparse(&m))
                    .unwrap_or(false);
                if excluded || linked {
                    count.fetch_add(1, Ordering::Relaxed);
                    false
                } else {
                    true
                }
            });
        let mut db = Connection::open(self.data_dir.join("workspace.sqlite3")).map_err(err)?;
        db.busy_timeout(Duration::from_secs(30)).map_err(err)?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; CREATE TEMP TABLE index_stage(path TEXT PRIMARY KEY,name TEXT,directory INTEGER,depth INTEGER,size INTEGER,modified TEXT,content_state INTEGER,content TEXT,changed INTEGER);").map_err(err)?;
        let old_hash: Option<String> = db
            .query_row(
                "SELECT settings_hash FROM project_indexes WHERE project_id=?1",
                [&project.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let force_content = force || old_hash.as_deref() != Some(settings_hash);
        let mut stats = ProjectIndexStats {
            project_id: project.id.clone(),
            project_name: project_name(project),
            status: "indexed".into(),
            ..Default::default()
        };
        let mut batch = Vec::with_capacity(256);
        for entry in walker.build() {
            let entry = entry.map_err(err)?;
            let meta = entry.metadata().map_err(err)?;
            if link_or_reparse(&meta) {
                continue;
            }
            if !meta.is_file() && !meta.is_dir() {
                continue;
            }
            let path = entry
                .path()
                .strip_prefix(&root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/");
            let directory = meta.is_dir();
            let name = if path.is_empty() {
                project_name(project)
            } else {
                entry.file_name().to_string_lossy().into_owned()
            };
            let depth = entry.depth() as u32;
            let modified = meta
                .modified()
                .map_err(err)?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_string();
            let size = if directory { 0 } else { meta.len() };
            let old: Option<(i64, String, bool, i32)> = db.query_row("SELECT size,modified,directory,content_state FROM files WHERE project_id=?1 AND path=?2", params![project.id,path], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(err)?;
            let changed = force_content
                || old.as_ref().is_none_or(|(s, m, d, _)| {
                    *s != size as i64 || *m != modified || *d != directory
                });
            let (content, content_state) = if !directory && changed {
                let (content, truncated) = indexed_content(entry.path(), &name, size)?;
                let state = if content.is_empty() {
                    0
                } else if truncated {
                    2
                } else {
                    1
                };
                (content, state)
            } else {
                (String::new(), old.as_ref().map(|o| o.3).unwrap_or(0))
            };
            if directory {
                stats.folders += 1;
            } else {
                stats.files += 1;
                if content_state > 0 {
                    stats.content_files += 1;
                } else {
                    stats.skipped_files += 1;
                }
                if content_state == 2 {
                    stats.truncated_files += 1;
                }
            }
            batch.push((
                path,
                name,
                directory,
                depth,
                size,
                modified,
                content_state,
                content,
                changed,
            ));
            if batch.len() >= 256 {
                stage_batch(&mut db, &mut batch)?;
            }
        }
        stage_batch(&mut db, &mut batch)?;
        stats.excluded_entries = excluded.load(Ordering::Relaxed);
        stats.message = "Names include all file types. Text: supported UTF-8 files up to 512 KiB, first 64 KiB; binary/private content omitted. Excluded counts include explicit entries and links, with pruned folders counted once; .gitignore omissions are not counted.".into();
        // Only the final diff needs the main database write lock. A failed walk
        // leaves previous searchable rows intact; temp staging is discarded.
        // Acquire the write reservation before checking source state. Chat may
        // commit on the other connection; a deferred read-to-write upgrade in
        // WAL mode would fail immediately with SQLITE_BUSY(_SNAPSHOT).
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let connected: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects p JOIN sources s ON s.id=p.source_id WHERE p.id=?1 AND s.connected=1)", [&project.id], |r| r.get(0)).map_err(err)?;
        if !connected {
            return Err("Source was disconnected during the scan.".into());
        }
        tx.execute("DELETE FROM file_contents WHERE project_id=?1 AND (path NOT IN (SELECT path FROM index_stage) OR path IN (SELECT path FROM index_stage WHERE changed=1))", [&project.id]).map_err(err)?;
        tx.execute(
            "DELETE FROM files WHERE project_id=?1 AND path NOT IN (SELECT path FROM index_stage)",
            [&project.id],
        )
        .map_err(err)?;
        tx.execute("INSERT INTO files(project_id,path,name,directory,depth,size,modified,content_state) SELECT ?1,path,name,directory,depth,size,modified,content_state FROM index_stage WHERE 1 ON CONFLICT(project_id,path) DO UPDATE SET name=excluded.name,directory=excluded.directory,depth=excluded.depth,size=excluded.size,modified=excluded.modified,content_state=excluded.content_state WHERE files.name<>excluded.name OR files.directory<>excluded.directory OR files.depth<>excluded.depth OR files.size<>excluded.size OR files.modified<>excluded.modified OR files.content_state<>excluded.content_state", [&project.id]).map_err(err)?;
        tx.execute("INSERT INTO file_contents(project_id,path,content) SELECT ?1,path,content FROM index_stage WHERE changed=1 AND content<>''", [&project.id]).map_err(err)?;
        // Include metadata reconciliation and FTS maintenance in the scan timing.
        stats.duration_ms = start.elapsed().as_millis() as u64;
        stats.last_indexed = now();
        tx.execute("INSERT INTO project_indexes(project_id,settings_hash,json) VALUES(?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET settings_hash=excluded.settings_hash,json=excluded.json", params![project.id,settings_hash,serde_json::to_string(&stats).map_err(err)?]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }

    pub fn search_files(
        &self,
        query: &str,
        project_id: Option<&str>,
        mode: &str,
    ) -> Result<Vec<SearchResult>> {
        self.query_index(query, project_id, mode, None, 150)
    }

    pub fn search_folders(&self, query: &str) -> Result<Vec<SearchResult>> {
        self.query_index(query, None, "folder", Some(3), 300)
    }

    fn query_index(
        &self,
        query: &str,
        project_id: Option<&str>,
        mode: &str,
        max_depth: Option<u32>,
        limit: usize,
    ) -> Result<Vec<SearchResult>> {
        let query = query.trim().replace('\\', "/");
        if query.is_empty() {
            return Ok(vec![]);
        }
        if query.len() > 500 {
            return Err("Search query is too long.".into());
        }
        if !["filename", "folder", "content"].contains(&mode) {
            return Err("Unknown search mode.".into());
        }
        let db = self.db()?;
        let mut result = if mode == "content" {
            let fts = query
                .split_whitespace()
                .take(20)
                .map(|s| format!("\"{}\"*", s.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND ");
            let mut statement = db.prepare("SELECT f.project_id,f.path,snippet(file_text,2,'','', ' … ',24),p.json FROM file_text f JOIN projects p ON p.id=f.project_id JOIN sources s ON s.id=p.source_id WHERE s.connected=1 AND file_text MATCH ?1 AND (?2 IS NULL OR f.project_id=?2) ORDER BY rank,f.path LIMIT ?3").map_err(err)?;
            let rows = statement
                .query_map(params![fts, project_id, limit as i64], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)?;
            rows.into_iter()
                .map(|(id, path, excerpt, json)| {
                    let p: Project = serde_json::from_str(&json).map_err(err)?;
                    Ok(SearchResult {
                        project_id: id,
                        project_name: project_name(&p),
                        name: path.rsplit('/').next().unwrap_or(&path).into(),
                        depth: path.split('/').count() as u32,
                        path,
                        excerpt,
                        directory: false,
                        match_kind: "content".into(),
                    })
                })
                .collect::<Result<Vec<_>>>()?
        } else {
            let pattern = format!(
                "%{}%",
                query
                    .to_lowercase()
                    .replace('!', "!!")
                    .replace('%', "!%")
                    .replace('_', "!_")
            );
            // MATCH uses trigrams for literal substring candidates, so '%' and
            // '_' stay ordinary filename characters. Short queries use LIKE.
            let use_trigrams = query.chars().count() >= 3;
            let from = if use_trigrams {
                "files f JOIN file_names n ON n.rowid=f.rowid"
            } else {
                "files f"
            };
            let filter = if use_trigrams {
                "AND file_names MATCH ?6"
            } else {
                "AND (?6 IS NOT NULL)"
            };
            let names_only = max_depth.is_some() && !query.contains('/');
            let substring = if use_trigrams {
                "(?1 IS NOT NULL)"
            } else if names_only {
                "dpm_lower(f.name) LIKE ?1 ESCAPE '!'"
            } else {
                "(dpm_lower(f.name) LIKE ?1 ESCAPE '!' OR dpm_lower(f.path) LIKE ?1 ESCAPE '!')"
            };
            let sql = format!("SELECT f.project_id,f.path,f.name,f.directory,f.depth,p.json FROM {from} JOIN projects p ON p.id=f.project_id JOIN sources s ON s.id=p.source_id WHERE s.connected=1 AND f.path<>'' AND {substring} AND (?2 IS NULL OR f.project_id=?2) AND (?3=0 OR f.directory=1) AND (?4 IS NULL OR f.depth<=?4) {filter} ORDER BY CASE WHEN dpm_lower(f.name)=?5 THEN 0 WHEN dpm_lower(f.name) LIKE ?7 ESCAPE '!' THEN 1 ELSE 2 END,length(f.path),f.path COLLATE NOCASE,p.path COLLATE NOCASE LIMIT ?8");
            let literal = format!(
                "{}\"{}\"",
                if names_only { "name : " } else { "" },
                query.replace('"', "\"\"")
            );
            let prefix = format!(
                "{}%",
                query
                    .to_lowercase()
                    .replace('!', "!!")
                    .replace('%', "!%")
                    .replace('_', "!_")
            );
            let mut statement = db.prepare(&sql).map_err(err)?;
            let rows = statement
                .query_map(
                    params![
                        pattern,
                        project_id,
                        mode == "folder",
                        max_depth,
                        query.to_lowercase(),
                        literal,
                        prefix,
                        limit as i64
                    ],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, bool>(3)?,
                            r.get::<_, u32>(4)?,
                            r.get::<_, String>(5)?,
                        ))
                    },
                )
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)?;
            rows.into_iter()
                .map(|(id, path, name, directory, depth, json)| {
                    let p: Project = serde_json::from_str(&json).map_err(err)?;
                    let kind = if name.to_lowercase() == query.to_lowercase() {
                        "exact"
                    } else {
                        "substring"
                    };
                    Ok(SearchResult {
                        project_id: id,
                        project_name: project_name(&p),
                        path,
                        name,
                        directory,
                        depth,
                        excerpt: String::new(),
                        match_kind: kind.into(),
                    })
                })
                .collect::<Result<Vec<_>>>()?
        };
        if mode != "content" {
            // Project roots are searchable immediately after discovery, even
            // while their first filesystem scan is still running.
            let lower = query.to_lowercase();
            let mut statement = db.prepare("SELECT p.json FROM projects p JOIN sources s ON s.id=p.source_id WHERE s.connected=1 AND (?1 IS NULL OR p.id=?1) ORDER BY p.path COLLATE NOCASE").map_err(err)?;
            let roots = statement
                .query_map([project_id], |r| r.get::<_, String>(0))
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)?;
            for json in roots {
                let p: Project = serde_json::from_str(&json).map_err(err)?;
                let name = project_name(&p);
                if (name.to_lowercase().contains(&lower) || p.name.to_lowercase().contains(&lower))
                    && !result
                        .iter()
                        .any(|r| r.project_id == p.id && r.path.is_empty())
                {
                    result.push(SearchResult {
                        project_id: p.id,
                        project_name: name.clone(),
                        path: String::new(),
                        name: name.clone(),
                        directory: true,
                        depth: 0,
                        excerpt: String::new(),
                        match_kind: if name.to_lowercase() == query.to_lowercase() {
                            "exact"
                        } else {
                            "substring"
                        }
                        .into(),
                    });
                }
            }
            result.sort_by_key(|r| {
                (
                    if r.match_kind == "exact" {
                        0
                    } else if r.name.to_lowercase().starts_with(&lower) {
                        1
                    } else {
                        2
                    },
                    r.path.len(),
                    r.path.to_lowercase(),
                    r.project_name.to_lowercase(),
                )
            });
            result.truncate(limit);
        }
        Ok(result)
    }
}

fn project_name(p: &Project) -> String {
    if p.alias.is_empty() {
        p.name.clone()
    } else {
        p.alias.clone()
    }
}
type StageRow = (String, String, bool, u32, u64, String, i32, String, bool);
fn stage_batch(db: &mut Connection, batch: &mut Vec<StageRow>) -> Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    let tx = db.transaction().map_err(err)?;
    {
        let mut insert = tx.prepare("INSERT INTO index_stage(path,name,directory,depth,size,modified,content_state,content,changed) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)").map_err(err)?;
        for (path, name, directory, depth, size, modified, state, content, changed) in
            batch.drain(..)
        {
            insert
                .execute(params![
                    path,
                    name,
                    directory,
                    depth,
                    size as i64,
                    modified,
                    state,
                    content,
                    changed
                ])
                .map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> (tempfile::TempDir, Core, Project) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir_all(source.join("Project Atlas")).unwrap();
        let core = Core::new(temp.path().join("data")).unwrap();
        let project = core
            .add_source(source.to_str().unwrap())
            .unwrap()
            .projects
            .remove(0);
        (temp, core, project)
    }

    #[test]
    fn archive_names_punctuation_unicode_and_hidden_files_are_searchable() {
        let (_temp, core, project) = fixture();
        let root = Path::new(&project.path);
        fs::create_dir(root.join("Other")).unwrap();
        fs::write(root.join("Other/backup_package-10.5.0.zip"), [0, 1, 2]).unwrap();
        fs::write(root.join("100%_ready!.txt"), "searchablecontent").unwrap();
        fs::write(root.join("100xyready!.txt"), "unrelated").unwrap();
        fs::write(root.join("Šarm-ČĆŽ.md"), "Croatian").unwrap();
        fs::write(root.join(".hidden.md"), "dotfile").unwrap();
        core.rebuild_index().unwrap();
        for query in [
            "backup_package",
            "backup_package-10.5.0.zip",
            "BACKUP_PACKAGE",
            "Other/backup_package",
            "Other\\backup_package",
        ] {
            let results = core.search_files(query, None, "filename").unwrap();
            assert_eq!(results.len(), 1, "{query}");
            assert_eq!(results[0].path, "Other/backup_package-10.5.0.zip");
            assert!(!results[0].directory);
        }
        assert_eq!(
            core.search_files("100%_", None, "filename").unwrap().len(),
            1
        );
        assert_eq!(core.search_files("_", None, "filename").unwrap().len(), 2);
        assert_eq!(
            core.search_files("šarm", None, "filename").unwrap().len(),
            1
        );
        assert_eq!(core.search_files("š", None, "filename").unwrap().len(), 1);
        assert_eq!(
            core.search_files(".hidden", None, "filename")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            core.search_files("searchablecontent", None, "content")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn sidebar_folders_include_root_and_three_levels_but_full_search_goes_deeper() {
        let (_temp, core, project) = fixture();
        fs::create_dir_all(Path::new(&project.path).join("borea/level2/borea3/borea4")).unwrap();
        core.rebuild_index().unwrap();
        let folders = core.search_folders("borea").unwrap();
        assert!(folders.iter().all(|r| r.directory && r.depth <= 3));
        assert!(folders
            .iter()
            .any(|r| r.path == "borea/level2/borea3" && r.depth == 3));
        assert!(!folders.iter().any(|r| r.name == "borea4"));
        assert!(!folders.iter().any(|r| r.name == "level2"));
        assert!(core
            .search_files("borea4", None, "folder")
            .unwrap()
            .iter()
            .any(|r| r.depth == 4));
        assert!(core
            .search_folders("Atlas")
            .unwrap()
            .iter()
            .any(|r| r.path.is_empty() && r.depth == 0));
    }

    #[test]
    fn exclusions_are_editable_and_gitignore_nested_negations_can_be_disabled() {
        let (_temp, core, project) = fixture();
        let root = Path::new(&project.path);
        fs::create_dir_all(root.join("App/node_modules")).unwrap();
        fs::create_dir_all(root.join("App/.yarn/cache")).unwrap();
        fs::create_dir_all(root.join("App/lib")).unwrap();
        fs::create_dir_all(root.join("App/packages")).unwrap();
        fs::write(root.join("App/.gitignore"), "*.zip\n!keep.zip\n").unwrap();
        for name in [
            "App/ignored.zip",
            "App/keep.zip",
            "App/node_modules/dependency.txt",
            "App/.yarn/cache/cache.txt",
            "App/lib/source.dart",
            "App/packages/source.dart",
        ] {
            fs::write(root.join(name), "uniquefilecontent").unwrap();
        }
        core.rebuild_index().unwrap();
        assert!(core
            .search_files("ignored.zip", None, "filename")
            .unwrap()
            .is_empty());
        assert_eq!(
            core.search_files("keep.zip", None, "filename")
                .unwrap()
                .len(),
            1
        );
        assert!(core
            .search_files("dependency.txt", None, "filename")
            .unwrap()
            .is_empty());
        assert!(core
            .search_files("cache.txt", None, "filename")
            .unwrap()
            .is_empty());
        assert_eq!(
            core.search_files("source.dart", None, "filename")
                .unwrap()
                .len(),
            2
        );
        let mut settings = core.settings().unwrap();
        settings.indexing.follow_gitignore = false;
        settings
            .indexing
            .profiles
            .iter_mut()
            .find(|p| p.id == "javascript")
            .unwrap()
            .enabled = false;
        settings.indexing.file_patterns.push("keep.zip".into());
        core.save_settings(settings).unwrap();
        core.refresh_index().unwrap();
        assert_eq!(
            core.search_files("ignored.zip", None, "filename")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            core.search_files("dependency.txt", None, "filename")
                .unwrap()
                .len(),
            1
        );
        assert!(core
            .search_files("keep.zip", None, "filename")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn per_project_clear_survives_refresh_restart_and_reindex_forces_content_read() {
        let (temp, core, project) = fixture();
        let root = Path::new(&project.path);
        let file = root.join("note.txt");
        fs::write(&file, "oldword").unwrap();
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        let other = root.parent().unwrap().join("Second project");
        fs::create_dir(&other).unwrap();
        fs::write(other.join("retained.txt"), "retainedword").unwrap();
        core.scan_sources().unwrap();
        core.rebuild_index().unwrap();
        fs::write(&file, "newword").unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        core.reindex_project(&project.id).unwrap();
        assert_eq!(
            core.search_files("newword", None, "content").unwrap().len(),
            1
        );
        core.clear_project_index(&project.id).unwrap();
        core.refresh_index().unwrap();
        assert!(core
            .search_files("note.txt", None, "filename")
            .unwrap()
            .is_empty());
        assert_eq!(
            core.search_files("retainedword", None, "content")
                .unwrap()
                .len(),
            1
        );
        drop(core);
        let core = Core::new(temp.path().join("data")).unwrap();
        core.refresh_index().unwrap();
        assert!(core
            .search_files("note.txt", None, "filename")
            .unwrap()
            .is_empty());
        assert_eq!(
            core.index_statistics()
                .unwrap()
                .iter()
                .find(|s| s.project_id == project.id)
                .unwrap()
                .status,
            "cleared"
        );
        core.reindex_project(&project.id).unwrap();
        assert_eq!(
            core.search_files("note.txt", None, "filename")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn unchanged_content_is_reused_and_changed_deleted_files_are_reconciled() {
        let (temp, core, project) = fixture();
        let root = Path::new(&project.path);
        fs::write(root.join("one.md"), "originalword").unwrap();
        fs::write(root.join("two.md"), "retainedword").unwrap();
        core.rebuild_index().unwrap();
        let row: i64 = core
            .db()
            .unwrap()
            .query_row(
                "SELECT rowid FROM file_contents WHERE path='two.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        drop(core);
        let core = Core::new(temp.path().join("data")).unwrap();
        core.refresh_index().unwrap();
        assert_eq!(
            core.db()
                .unwrap()
                .query_row(
                    "SELECT rowid FROM file_contents WHERE path='two.md'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            row
        );
        fs::write(root.join("one.md"), "changedcontentlonger").unwrap();
        fs::remove_file(root.join("two.md")).unwrap();
        core.refresh_index().unwrap();
        assert!(core
            .search_files("originalword", None, "content")
            .unwrap()
            .is_empty());
        assert!(core
            .search_files("two.md", None, "filename")
            .unwrap()
            .is_empty());
        assert_eq!(
            core.search_files("changedcontentlonger", None, "content")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn unavailable_project_retains_old_index_and_reports_error() {
        let (_temp, core, project) = fixture();
        fs::write(Path::new(&project.path).join("note.md"), "retainedword").unwrap();
        core.rebuild_index().unwrap();
        fs::rename(&project.path, format!("{}-moved", project.path)).unwrap();
        core.scan_sources().unwrap();
        core.reindex_project(&project.id).unwrap();
        assert_eq!(
            core.search_files("retainedword", None, "content")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            core.index_statistics()
                .unwrap()
                .iter()
                .find(|s| s.project_id == project.id)
                .unwrap()
                .status,
            "error"
        );
    }

    #[test]
    fn settings_reject_malformed_patterns_including_disabled_lists() {
        let mut settings = defaults();
        settings.profiles[0].enabled = false;
        settings.profiles[0]
            .folder_patterns
            .push("../outside".into());
        assert!(validate_settings(&settings).is_err());
        let mut settings = defaults();
        settings.profiles[0]
            .file_patterns
            .push("C:/absolute".into());
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn file_patterns_do_not_exclude_parent_directories_and_renamed_roots_are_current() {
        let (_temp, core, project) = fixture();
        let root = Path::new(&project.path);
        fs::create_dir(root.join("scratch.tmp")).unwrap();
        fs::write(root.join("scratch.tmp/keep.txt"), "keepword").unwrap();
        fs::write(root.join("note.tmp"), "omitword").unwrap();
        let mut settings = core.settings().unwrap();
        settings.indexing.file_patterns.push("*.tmp".into());
        core.save_settings(settings).unwrap();
        core.rebuild_index().unwrap();
        assert_eq!(
            core.search_files("keep.txt", None, "filename")
                .unwrap()
                .len(),
            1
        );
        assert!(core
            .search_files("note.tmp", None, "filename")
            .unwrap()
            .is_empty());
        core.update_project(
            &project.id,
            ProjectPatch {
                alias: Some("Renamed root".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let results = core.search_folders("Renamed").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Renamed root");
    }

    #[test]
    #[ignore = "Read-only audit of one explicitly selected real project; all database writes use a temporary directory"]
    fn audit_existing_project_read_only() {
        let source = std::env::var("DPM_AUDIT_SOURCE").expect("Set DPM_AUDIT_SOURCE");
        let project_name = std::env::var("DPM_AUDIT_PROJECT").expect("Set DPM_AUDIT_PROJECT");
        let query = std::env::var("DPM_AUDIT_QUERY").expect("Set DPM_AUDIT_QUERY");
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        assert!(
            !root.starts_with(Path::new(&source).canonicalize().unwrap()),
            "Audit DB must be outside source"
        );
        let core = Core::new(root.join("audit-data")).unwrap();
        let project = core
            .add_source(&source)
            .unwrap()
            .projects
            .into_iter()
            .find(|p| p.name == project_name)
            .expect("Project not found");
        core.reindex_project(&project.id).unwrap();
        let results = core
            .search_files(&query, Some(&project.id), "filename")
            .unwrap();
        println!("AUDIT RESULTS {}", serde_json::to_string(&results).unwrap());
        println!(
            "AUDIT STATS {}",
            serde_json::to_string(
                &core
                    .index_statistics()
                    .unwrap()
                    .into_iter()
                    .find(|s| s.project_id == project.id)
            )
            .unwrap()
        );
        assert!(!results.is_empty(), "Requested file was not found");
    }
}
