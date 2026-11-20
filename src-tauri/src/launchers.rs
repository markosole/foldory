use crate::{ai::Provider, ai_cli, integrations};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
pub struct InstalledModes {
    desktop: bool,
    cli: bool,
}
pub type Detection = BTreeMap<&'static str, InstalledModes>;

pub fn parse_launcher_id(id: &str) -> Option<(&str, &str)> {
    // Retain the old Cursor action ID for callers upgrading from the built-in launcher.
    if id == "cursor" {
        return Some(("cursor", "desktop"));
    }
    let (provider, mode) = id.split_once('-')?;
    (["cursor", "claude", "codex"].contains(&provider) && ["desktop", "cli"].contains(&mode))
        .then_some((provider, mode))
}

fn provider(id: &str) -> Provider {
    match id {
        "cursor" => Provider::Cursor,
        "claude" => Provider::Claude,
        _ => Provider::Codex,
    }
}

fn cursor_desktop() -> Option<PathBuf> {
    let known = integrations::find_cursor();
    if known.is_file() {
        return Some(known);
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .filter(|path| path.is_absolute())
        .flat_map(|dir| [dir.join("Cursor.exe"), dir.join("../../../Cursor.exe")])
        .find(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok())
}

#[cfg(windows)]
fn protocol_installed(scheme: &str) -> bool {
    // Association lookup includes both traditional installers and MSIX / Store apps.
    #[link(name = "shlwapi")]
    unsafe extern "system" {
        fn AssocQueryStringW(
            flags: u32,
            kind: u32,
            association: *const u16,
            extra: *const u16,
            output: *mut u16,
            length: *mut u32,
        ) -> i32;
    }
    let scheme: Vec<u16> = scheme.encode_utf16().chain(Some(0)).collect();
    let mut output = vec![0u16; 32768];
    let mut length = output.len() as u32;
    // ASSOCF_IS_PROTOCOL and ASSOCSTR_PROGID. Packaged apps may have no
    // ASSOCSTR_EXECUTABLE, but still have a valid protocol registration.
    // All buffers are live for the call.
    let result = unsafe {
        AssocQueryStringW(
            0x1000,
            20,
            scheme.as_ptr(),
            std::ptr::null(),
            output.as_mut_ptr(),
            &mut length,
        )
    };
    result == 0 && length > 1
}

#[cfg(not(windows))]
fn protocol_installed(_scheme: &str) -> bool {
    false
}

pub fn detect() -> Detection {
    ["cursor", "claude", "codex"]
        .into_iter()
        .map(|id| {
            (
                id,
                InstalledModes {
                    desktop: if id == "cursor" {
                        cursor_desktop().is_some()
                    } else {
                        protocol_installed(id)
                    },
                    cli: ai_cli::launcher_command(provider(id)).is_some(),
                },
            )
        })
        .collect()
}

fn desktop_url(id: &str, root: &Path) -> Result<url::Url, String> {
    // Official formats: learn.chatgpt.com/docs/reference/commands and
    // support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link.
    let (base, parameter) = match id {
        "codex" => ("codex://new", "path"),
        "claude" => ("claude://code/new", "folder"),
        _ => return Err("Unknown desktop launcher.".into()),
    };
    let mut url = url::Url::parse(base).map_err(|error| error.to_string())?;
    // Windows canonicalization uses extended paths. Apps expect ordinary drive / UNC paths.
    let path = root.to_string_lossy();
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
    };
    url.query_pairs_mut().append_pair(parameter, &path);
    Ok(url)
}

pub fn launch(id: &str, mode: &str, root: &Path) -> Result<(), String> {
    let label = match id {
        "cursor" => "Cursor",
        "claude" => "Claude",
        "codex" => "Codex",
        _ => return Err("Unknown supported tool.".into()),
    };
    if mode == "cli" {
        let mut command = ai_cli::launcher_command(provider(id))
            .ok_or_else(|| format!("{label} CLI was not found. Install it, then use Detect installed in Settings → Tools & launchers."))?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x00000010); // CREATE_NEW_CONSOLE: an interactive user-requested CLI.
        }
        return integrations::spawn_console(command, root, &format!("{label} CLI"));
    }
    if mode != "desktop" {
        return Err("Unknown launcher mode.".into());
    }
    if id == "cursor" {
        let executable = cursor_desktop().ok_or(
            "Cursor Desktop was not found. Install Cursor and detect installed tools again.",
        )?;
        let mut command = integrations::hidden_command(executable);
        command.arg(root);
        return integrations::spawn_tool(command, root, "Cursor Desktop");
    }
    if !protocol_installed(id) {
        return Err(format!("{label} Desktop was not found. Install or repair the desktop app, then detect installed tools again."));
    }
    let url = desktop_url(id, root)?;
    #[cfg(windows)]
    {
        integrations::shell_open(std::ffi::OsStr::new(url.as_str()), Some(root))
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("Desktop launchers currently require Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_links_preserve_paths_without_turning_them_into_parameters() {
        for (id, key) in [("claude", "folder"), ("codex", "path")] {
            let path = r"C:\Projects\A & B #1\Ž demo";
            let url = desktop_url(id, Path::new(path)).unwrap();
            assert_eq!(
                url.query_pairs().collect::<Vec<_>>(),
                vec![(key.into(), path.into())]
            );
            assert!(url.fragment().is_none());
            let extended = desktop_url(id, Path::new(r"\\?\C:\Projects\Alpha")).unwrap();
            assert_eq!(
                extended.query_pairs().next().unwrap().1,
                r"C:\Projects\Alpha"
            );
            let unc = desktop_url(id, Path::new(r"\\?\UNC\server\share\Alpha")).unwrap();
            assert_eq!(unc.query_pairs().next().unwrap().1, r"\\server\share\Alpha");
        }
    }

    #[test]
    fn supported_ids_do_not_capture_custom_tools() {
        assert_eq!(parse_launcher_id("cursor"), Some(("cursor", "desktop")));
        assert_eq!(parse_launcher_id("claude-cli"), Some(("claude", "cli")));
        assert!(parse_launcher_id("codex-desktop-extra").is_none());
        assert!(parse_launcher_id("my-editor").is_none());
    }

    #[test]
    fn installed_tools_can_be_detected_without_launching_them() {
        let detected = detect();
        assert_eq!(detected.len(), 3);
        eprintln!("Detected launchers: {detected:?}");
    }
}
