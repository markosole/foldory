use super::*;
use crate::assistant_sources::SourcePolicy;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileOperationKind {
    Copy,
    Move,
    Delete,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileOperationRequest {
    pub kind: FileOperationKind,
    pub paths: Vec<String>,
    pub destination: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationItem {
    pub source: String,
    pub destination: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionChange {
    pub source: String,
    pub destination: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationPlan {
    pub items: Vec<FileOperationItem>,
    pub protection_changes: Vec<ProtectionChange>,
    pub protected_count: usize,
    pub confirmation_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationResult {
    pub completed: Vec<FileOperationItem>,
    pub error: Option<String>,
}

fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.into()
    }
}

fn contains_path(parent: &str, path: &str) -> bool {
    let parent = path_key(parent);
    let path = path_key(path);
    path == parent || path.starts_with(&format!("{parent}/"))
}

fn absent(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(err(error)),
    }
}

// Metadata only: planning never reads protected file contents. Reject links and
// special files before starting any member of a batch, including nested links.
fn inventory(root: &Path, path: &str, entries: &mut Vec<(String, bool, u64, u128)>) -> Result<()> {
    if entries.len() >= 100_000 {
        return Err("This operation exceeds 100,000 entries. Use Explorer for this folder.".into());
    }
    let full = root.join(path);
    let meta = fs::symlink_metadata(&full).map_err(err)?;
    if link_or_reparse(&meta) || (!meta.is_dir() && !meta.is_file()) {
        return Err(format!("Cannot operate on {path}: symbolic links, junctions and special files are not followed. Use Explorer to manage them."));
    }
    let modified = meta
        .modified()
        .map_err(err)?
        .duration_since(UNIX_EPOCH)
        .map_err(err)?
        .as_nanos();
    entries.push((path.into(), meta.is_dir(), meta.len(), modified));
    if meta.is_dir() {
        let mut children = fs::read_dir(&full)
            .map_err(err)?
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(err)?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| "A file name is not valid Unicode. Use Explorer for this folder.")?;
            validate_name(&name)?;
            inventory(root, &format!("{path}/{name}"), entries)?;
        }
    }
    Ok(())
}

impl Core {
    pub fn preview_file_operation(
        &self,
        project_id: &str,
        request: &FileOperationRequest,
    ) -> Result<FileOperationPlan> {
        let _guard = self.writes.lock().map_err(err)?;
        self.plan_file_operation(project_id, request)
    }

    fn plan_file_operation(
        &self,
        project_id: &str,
        request: &FileOperationRequest,
    ) -> Result<FileOperationPlan> {
        if request.paths.is_empty() || request.paths.len() > 1000 {
            return Err("Select between 1 and 1,000 files or folders.".into());
        }
        let root = self.validated_path(project_id, "")?;
        let mut paths = Vec::new();
        for path in &request.paths {
            // Disallow operating on the project itself or on any outside path.
            let path = relative(path, false)?.to_string_lossy().replace('\\', "/");
            self.validated_path(project_id, &path)?;
            if !paths
                .iter()
                .any(|other: &String| path_key(other) == path_key(&path))
            {
                paths.push(path);
            }
        }
        let selected = paths.clone();
        paths.retain(|path| {
            !selected
                .iter()
                .any(|parent| parent != path && contains_path(parent, path))
        });
        let destination = if request.kind == FileOperationKind::Delete {
            None
        } else {
            let destination = request
                .destination
                .as_deref()
                .ok_or("Choose a destination folder.")?;
            let destination = relative(destination, true)?
                .to_string_lossy()
                .replace('\\', "/");
            if !self.validated_path(project_id, &destination)?.is_dir() {
                return Err("The destination must be a folder.".into());
            }
            Some(destination)
        };
        let policy = SourcePolicy::new(self, project_id)?;
        let mut plan = FileOperationPlan {
            items: vec![],
            protection_changes: vec![],
            protected_count: 0,
            confirmation_token: String::new(),
        };
        let mut snapshots = Vec::new();
        let mut destinations = HashSet::new();
        for source in paths {
            let target = if let Some(destination) = &destination {
                if contains_path(&source, destination) {
                    return Err(format!(
                        "Cannot place {source} inside itself or one of its subfolders."
                    ));
                }
                let name = source
                    .rsplit('/')
                    .next()
                    .ok_or("A file name is required.")?;
                let target = if destination.is_empty() {
                    name.into()
                } else {
                    format!("{destination}/{name}")
                };
                if path_key(&target) == path_key(&source) {
                    return Err(format!(
                        "{source} is already in this folder. Choose another destination."
                    ));
                }
                if !destinations.insert(path_key(&target)) || !absent(&root.join(&target))? {
                    return Err(format!("{target} already exists. Nothing was changed. Choose another folder or rename the existing item first."));
                }
                Some(target)
            } else {
                None
            };
            let start = snapshots.len();
            inventory(&root, &source, &mut snapshots)?;
            for (path, directory, _, _) in &snapshots[start..] {
                if let Some(reason) = policy.reason(path, *directory)? {
                    plan.protected_count += 1;
                    if let Some(target) = &target {
                        let moved = format!("{target}{}", &path[source.len()..]);
                        if policy.reason(&moved, *directory)?.is_none() {
                            plan.protection_changes.push(ProtectionChange {
                                source: path.clone(),
                                destination: moved,
                                reason,
                            });
                        }
                    }
                }
            }
            plan.items.push(FileOperationItem {
                source,
                destination: target,
            });
        }
        // Bind execution to the exact paths, metadata and current exclusion
        // decision that the user reviewed, including all nested entries.
        let snapshot = serde_json::to_vec(&(project_id, request, &plan, snapshots)).map_err(err)?;
        plan.confirmation_token = revision(&snapshot);
        Ok(plan)
    }

    pub fn execute_file_operation(
        &self,
        project_id: &str,
        request: &FileOperationRequest,
        confirmation_token: &str,
    ) -> Result<FileOperationResult> {
        let _guard = self.writes.lock().map_err(err)?;
        let plan = self.plan_file_operation(project_id, request)?;
        if plan.confirmation_token != confirmation_token {
            return Err("The selected items or exclusion rules changed. Review the operation again before continuing.".into());
        }
        let mut result = FileOperationResult {
            completed: vec![],
            error: None,
        };
        for item in plan.items {
            let operation = (|| -> Result<()> {
                let source = self.validated_path(project_id, &item.source)?;
                match request.kind {
                    FileOperationKind::Delete => {
                        if source.is_dir() {
                            fs::remove_dir_all(&source).map_err(err)
                        } else {
                            fs::remove_file(&source).map_err(err)
                        }
                    }
                    FileOperationKind::Move | FileOperationKind::Copy => {
                        let target = self.new_path(
                            project_id,
                            item.destination
                                .as_deref()
                                .ok_or("A destination is required.")?,
                        )?;
                        if !absent(&target)? {
                            return Err(
                                "The destination now exists. It was not overwritten.".into()
                            );
                        }
                        if request.kind == FileOperationKind::Move {
                            move_without_replace(&source, &target)
                        } else {
                            copy_entry(&source, &target)
                        }
                    }
                }
            })();
            match operation {
                Ok(()) => result.completed.push(item),
                Err(error) => {
                    result.error = Some(format!("Could not {} {}: {error}. {} item(s) completed. Refresh the folder before retrying; a failed folder operation may have partially completed.", match request.kind { FileOperationKind::Copy => "copy", FileOperationKind::Move => "move", FileOperationKind::Delete => "delete" }, item.source, result.completed.len()));
                    break;
                }
            }
        }
        Ok(result)
    }
}

// Windows rename otherwise replaces existing files. No replacement is allowed,
// including if another app creates a destination after the preview.
#[cfg(windows)]
fn move_without_replace(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
        Err(err(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_without_replace(source: &Path, target: &Path) -> Result<()> {
    if !absent(target)? {
        return Err("The destination already exists.".into());
    }
    fs::rename(source, target).map_err(err)
}

fn copy_entry(source: &Path, target: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(source).map_err(err)?;
    if link_or_reparse(&meta) {
        return Err("Symbolic links and junctions are not followed.".into());
    }
    if meta.is_dir() {
        fs::create_dir(target).map_err(err)?;
        for child in fs::read_dir(source).map_err(err)? {
            let child = child.map_err(err)?;
            copy_entry(&child.path(), &target.join(child.file_name()))?;
        }
    } else if meta.is_file() {
        let mut input = fs::File::open(source).map_err(err)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(err)?;
        std::io::copy(&mut input, &mut output).map_err(err)?;
        output.sync_all().map_err(err)?;
    } else {
        return Err("Special files cannot be copied.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Core, Project, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("projects");
        fs::create_dir_all(source.join("Alpha/Docs")).unwrap();
        let core = Core::new(temp.path().join("data")).unwrap();
        let project = core.add_source(source.to_str().unwrap()).unwrap().projects[0].clone();
        let root = PathBuf::from(&project.path);
        (temp, core, project, root)
    }

    fn request(
        kind: FileOperationKind,
        paths: &[&str],
        destination: Option<&str>,
    ) -> FileOperationRequest {
        FileOperationRequest {
            kind,
            paths: paths.iter().map(|path| (*path).into()).collect(),
            destination: destination.map(String::from),
        }
    }

    fn run(core: &Core, id: &str, request: &FileOperationRequest) -> FileOperationResult {
        let plan = core.preview_file_operation(id, request).unwrap();
        core.execute_file_operation(id, request, &plan.confirmation_token)
            .unwrap()
    }

    #[test]
    fn copies_binary_nested_folders_and_collapses_selected_descendants() {
        let (_temp, core, p, root) = fixture();
        fs::create_dir_all(root.join("Bundle/Nested/Empty")).unwrap();
        fs::write(root.join("Bundle/Nested/image.bin"), [0, 255, 1, 0]).unwrap();
        let request = request(
            FileOperationKind::Copy,
            &["Bundle", "Bundle/Nested/image.bin", "Bundle"],
            Some("Docs"),
        );
        let result = run(&core, &p.id, &request);
        assert!(result.error.is_none());
        assert_eq!(result.completed.len(), 1);
        assert_eq!(
            fs::read(root.join("Docs/Bundle/Nested/image.bin")).unwrap(),
            [0, 255, 1, 0]
        );
        assert!(root.join("Docs/Bundle/Nested/Empty").is_dir());
        assert!(root.join("Bundle/Nested/image.bin").exists());
    }

    #[test]
    fn moves_files_and_folders_between_folders_and_back_to_project_root() {
        let (_temp, core, p, root) = fixture();
        fs::create_dir_all(root.join("Bundle/Nested")).unwrap();
        fs::write(root.join("Bundle/Nested/note.txt"), "nested").unwrap();
        fs::write(root.join("first.txt"), "first").unwrap();
        let result = run(
            &core,
            &p.id,
            &request(
                FileOperationKind::Move,
                &["Bundle", "first.txt"],
                Some("Docs"),
            ),
        );
        assert!(result.error.is_none());
        assert_eq!(result.completed.len(), 2);
        assert!(!root.join("Bundle").exists());
        assert!(!root.join("first.txt").exists());
        assert_eq!(
            fs::read_to_string(root.join("Docs/Bundle/Nested/note.txt")).unwrap(),
            "nested"
        );
        assert!(run(
            &core,
            &p.id,
            &request(FileOperationKind::Move, &["Docs/first.txt"], Some(""))
        )
        .error
        .is_none());
        assert!(root.join("first.txt").is_file());
    }

    #[test]
    fn deletes_recursively_only_with_the_reviewed_confirmation() {
        let (_temp, core, p, root) = fixture();
        fs::create_dir_all(root.join("Secure/Nested")).unwrap();
        fs::write(root.join("Secure/Nested/note.txt"), "private").unwrap();
        let request = request(
            FileOperationKind::Delete,
            &["Secure", "Secure/Nested"],
            None,
        );
        let plan = core.preview_file_operation(&p.id, &request).unwrap();
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.protected_count, 3);
        assert!(root.join("Secure/Nested/note.txt").exists());
        assert!(core.execute_file_operation(&p.id, &request, "").is_err());
        assert!(root.join("Secure/Nested/note.txt").exists());
        let result = core
            .execute_file_operation(&p.id, &request, &plan.confirmation_token)
            .unwrap();
        assert!(result.error.is_none());
        assert!(!root.join("Secure").exists());
        assert!(root.join("Docs").is_dir());
    }

    #[test]
    fn warns_for_moves_and_copies_that_lose_inherited_protection() {
        let (_temp, core, p, root) = fixture();
        fs::create_dir_all(root.join("Secure/Bundle/Nested")).unwrap();
        fs::write(root.join("Secure/Bundle/Nested/note.bin"), [255, 254]).unwrap();
        for kind in [FileOperationKind::Move, FileOperationKind::Copy] {
            let request = request(kind, &["Secure/Bundle"], Some("Docs"));
            let plan = core.preview_file_operation(&p.id, &request).unwrap();
            assert_eq!(plan.protection_changes.len(), 3);
            assert!(plan
                .protection_changes
                .iter()
                .any(|change| change.destination == "Docs/Bundle/Nested/note.bin"));
            assert!(core
                .execute_file_operation(&p.id, &request, "unconfirmed")
                .is_err());
        }
        fs::create_dir(root.join("Private")).unwrap();
        assert!(core
            .preview_file_operation(
                &p.id,
                &request(FileOperationKind::Move, &["Secure/Bundle"], Some("Private"))
            )
            .unwrap()
            .protection_changes
            .is_empty());
        // Keeping a Secure folder's name keeps its descendants protected.
        assert!(core
            .preview_file_operation(
                &p.id,
                &request(FileOperationKind::Move, &["Secure"], Some("Docs"))
            )
            .unwrap()
            .protection_changes
            .is_empty());
    }

    #[test]
    fn checks_nested_custom_exclusions_and_gitignore_rules() {
        let (_temp, core, p, root) = fixture();
        fs::create_dir_all(root.join("Bundle/Nested")).unwrap();
        fs::write(root.join("Bundle/Nested/roadmap.txt"), "roadmap").unwrap();
        fs::write(
            root.join(".inspectorignore"),
            "/Bundle/Nested/roadmap.txt\n",
        )
        .unwrap();
        let request = request(FileOperationKind::Move, &["Bundle"], Some("Docs"));
        let plan = core.preview_file_operation(&p.id, &request).unwrap();
        assert_eq!(plan.protection_changes.len(), 1);
        assert_eq!(
            plan.protection_changes[0].source,
            "Bundle/Nested/roadmap.txt"
        );
        fs::remove_file(root.join(".inspectorignore")).unwrap();
        fs::write(root.join(".gitignore"), "/Bundle/Nested/roadmap.txt\n").unwrap();
        let mut settings = core.settings().unwrap();
        settings.indexing.follow_gitignore = true;
        core.save_settings(settings).unwrap();
        assert_eq!(
            core.preview_file_operation(&p.id, &request)
                .unwrap()
                .protection_changes
                .len(),
            1
        );
    }

    #[test]
    fn conflict_preflight_leaves_every_source_and_existing_destination_untouched() {
        let (_temp, core, p, root) = fixture();
        fs::write(root.join("first.txt"), "first").unwrap();
        fs::write(root.join("second.txt"), "second").unwrap();
        fs::write(root.join("Docs/second.txt"), "existing").unwrap();
        for kind in [FileOperationKind::Move, FileOperationKind::Copy] {
            let request = request(kind, &["first.txt", "second.txt"], Some("Docs"));
            assert!(core
                .preview_file_operation(&p.id, &request)
                .unwrap_err()
                .contains("already exists"));
            assert!(!root.join("Docs/first.txt").exists());
            assert_eq!(fs::read_to_string(root.join("first.txt")).unwrap(), "first");
            assert_eq!(
                fs::read_to_string(root.join("Docs/second.txt")).unwrap(),
                "existing"
            );
        }
    }

    #[test]
    fn rejects_root_traversal_and_recursive_or_same_folder_destinations() {
        let (_temp, core, p, root) = fixture();
        fs::create_dir_all(root.join("Bundle/Nested")).unwrap();
        for path in ["", ".", "../outside", "Docs/../../outside", "C:\\outside"] {
            assert!(core
                .preview_file_operation(&p.id, &request(FileOperationKind::Delete, &[path], None))
                .is_err());
        }
        for destination in ["Bundle", "Bundle/Nested", "../outside", ""] {
            assert!(core
                .preview_file_operation(
                    &p.id,
                    &request(FileOperationKind::Move, &["Bundle"], Some(destination))
                )
                .is_err());
        }
        assert!(root.join("Bundle/Nested").is_dir());
    }

    #[test]
    fn rejects_stale_source_metadata_and_new_exclusion_decisions() {
        let (_temp, core, p, root) = fixture();
        fs::create_dir(root.join("Bundle")).unwrap();
        fs::write(root.join("Bundle/note.txt"), "old").unwrap();
        let request = request(FileOperationKind::Move, &["Bundle"], Some("Docs"));
        let plan = core.preview_file_operation(&p.id, &request).unwrap();
        fs::write(root.join("Bundle/note.txt"), "changed on disk").unwrap();
        assert!(core
            .execute_file_operation(&p.id, &request, &plan.confirmation_token)
            .unwrap_err()
            .contains("changed"));
        let plan = core.preview_file_operation(&p.id, &request).unwrap();
        let mut settings = core.settings().unwrap();
        settings
            .inspector
            .exclude_patterns
            .push("/Bundle/note.txt".into());
        core.save_settings(settings).unwrap();
        assert!(core
            .execute_file_operation(&p.id, &request, &plan.confirmation_token)
            .is_err());
        assert!(root.join("Bundle/note.txt").exists());
        assert!(!root.join("Docs/Bundle").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_nested_symlinks_without_touching_the_outside_target() {
        let (temp, core, p, root) = fixture();
        fs::create_dir(root.join("Bundle")).unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("Bundle/link")).unwrap();
        for kind in [
            FileOperationKind::Delete,
            FileOperationKind::Move,
            FileOperationKind::Copy,
        ] {
            assert!(core
                .preview_file_operation(&p.id, &request(kind, &["Bundle"], Some("Docs")))
                .is_err());
        }
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_nested_junctions_and_linked_destinations() {
        use std::os::windows::process::CommandExt;
        let (temp, core, p, root) = fixture();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("note.txt"), "outside").unwrap();
        fs::create_dir(root.join("Bundle")).unwrap();
        let linked = root.join("Bundle").join("link");
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&linked)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Could not create test junction: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        for kind in [
            FileOperationKind::Delete,
            FileOperationKind::Move,
            FileOperationKind::Copy,
        ] {
            assert!(core
                .preview_file_operation(&p.id, &request(kind, &["Bundle"], Some("Docs")))
                .is_err());
            assert!(core
                .preview_file_operation(
                    &p.id,
                    &request(kind, &["Bundle/link/note.txt"], Some("Docs"))
                )
                .is_err());
        }
        fs::write(root.join("first.txt"), "first").unwrap();
        assert!(core
            .preview_file_operation(
                &p.id,
                &request(FileOperationKind::Move, &["first.txt"], Some("Bundle/link"))
            )
            .is_err());
        assert_eq!(
            fs::read_to_string(outside.join("note.txt")).unwrap(),
            "outside"
        );
        assert!(root.join("first.txt").exists());
    }
}
