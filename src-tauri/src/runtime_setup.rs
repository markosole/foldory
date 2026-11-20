//! Native Windows first-run setup, including for a copied standalone executable.
//! No Tauri windows, database access or WebView2 instances are created here.

use std::{
    io::Write,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver, Sender, TryRecvError},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::HWND,
    UI::{
        Controls::{
            TaskDialogIndirect, TASKDIALOGCONFIG, TDCBF_CLOSE_BUTTON, TDE_CONTENT,
            TDF_CALLBACK_TIMER, TDF_SHOW_MARQUEE_PROGRESS_BAR, TDM_CLICK_BUTTON, TDM_ENABLE_BUTTON,
            TDM_SET_ELEMENT_TEXT, TDM_SET_PROGRESS_BAR_MARQUEE, TDN_BUTTON_CLICKED, TDN_CREATED,
            TDN_TIMER,
        },
        WindowsAndMessaging::{PostMessageW, SendMessageW, IDCLOSE},
    },
};

const BOOTSTRAPPER_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const MAX_BOOTSTRAPPER_BYTES: usize = 10 * 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x08000000;
const VERIFY_SIGNATURE: &str = r#"
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:FOLDORY_WEBVIEW2_INSTALLER
if ($signature.Status -ne 'Valid' -or
    $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
    exit 1
}
exit 0
"#;

pub fn ensure_runtime() -> bool {
    // Windows Sandbox can inherit runtime files and stale registration from
    // different host versions. Resolve an existing signed runtime before trying
    // to reinstall it through a potentially restricted machine updater.
    if !runtime_available() && recover_installed_runtime() {
        return true;
    }
    ensure_with(runtime_available, prompt, install_with_progress)
}

fn version_numbers(value: &str) -> Option<[u32; 4]> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 4
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
        parts[3].parse().ok()?,
    ])
}

fn runtime_candidates(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let Some(version) = entry.file_name().to_str().and_then(version_numbers) else {
                continue;
            };
            if entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.path().join("msedgewebview2.exe").is_file()
            {
                candidates.push((version, entry.path()));
            }
        }
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    candidates.into_iter().map(|(_, path)| path).collect()
}

fn select_runtime(
    candidates: &[PathBuf],
    mut trusted: impl FnMut(&Path) -> bool,
    mut activate: impl FnMut(&Path) -> bool,
) -> bool {
    candidates
        .iter()
        .any(|path| trusted(&path.join("msedgewebview2.exe")) && activate(path))
}

fn recover_installed_runtime() -> bool {
    // An explicit deployment override belongs to the user/administrator.
    let previous = std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
    if previous.as_ref().is_some_and(|value| !value.is_empty()) {
        return false;
    }
    let roots: Vec<_> = ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|root| PathBuf::from(root).join("Microsoft/EdgeWebView/Application"))
        .filter(|root| root.is_absolute())
        .collect();
    select_runtime(
        &runtime_candidates(&roots),
        |executable| verify_microsoft_signature(executable).is_ok(),
        |folder| {
            // This runs synchronously before the setup worker, Tauri, Tokio or
            // application threads start. The override affects this process only.
            std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", folder);
            if runtime_available() {
                true
            } else {
                match &previous {
                    Some(value) => std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", value),
                    None => std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"),
                }
                false
            }
        },
    )
}

// Keep startup policy independently testable without changing the host runtime.
fn ensure_with(
    mut available: impl FnMut() -> bool,
    mut ask: impl FnMut(Option<&str>) -> bool,
    mut install: impl FnMut() -> Result<(), String>,
) -> bool {
    if available() {
        return true;
    }
    let mut failure = None;
    loop {
        if !ask(failure.as_deref()) {
            return false;
        }
        // Another application may have installed the shared runtime meanwhile.
        if available() {
            return true;
        }
        failure = Some(match install() {
            Ok(()) if available() => return true,
            Ok(()) => "Setup finished, but WebView2 is still unavailable for this Windows account. Restart Windows if requested, or ask your administrator whether runtime installation is blocked.".into(),
            Err(error) => error,
        });
    }
}

fn runtime_available() -> bool {
    // Uses the same WebView2 loader as Tauri, including per-user installations.
    tauri::webview_version().is_ok_and(|version| !version.trim().is_empty())
}

fn prompt(failure: Option<&str>) -> bool {
    let description = match failure {
        None => "Foldory needs Microsoft Edge WebView2 Runtime to display its interface. This is a separate component from the Edge browser.\n\nDownload and install it automatically now? An internet connection is required. Foldory will open when setup finishes.".into(),
        Some(error) => format!("WebView2 setup could not complete.\n\n{error}\n\nCheck your internet connection and any installation restrictions, then select Yes to retry. Select No to close Foldory."),
    };
    rfd::MessageDialog::new()
        .set_title("Foldory — WebView2 setup")
        .set_description(description)
        .set_level(if failure.is_some() {
            rfd::MessageLevel::Error
        } else {
            rfd::MessageLevel::Info
        })
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        == rfd::MessageDialogResult::Yes
}

enum SetupEvent {
    Progress(&'static str),
    Finished(Result<(), String>),
}

struct ProgressDialog {
    events: Receiver<SetupEvent>,
    result: Option<Result<(), String>>,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

// The callback and its state live on the calling thread for the entire modal
// TaskDialogIndirect call. The worker communicates only through the channel.
unsafe extern "system" fn progress_callback(
    window: HWND,
    notification: u32,
    _: usize,
    _: isize,
    data: isize,
) -> i32 {
    let state = data as *mut ProgressDialog;
    match notification as i32 {
        TDN_CREATED => {
            SendMessageW(window, TDM_ENABLE_BUTTON as u32, IDCLOSE as usize, 0);
            SendMessageW(window, TDM_SET_PROGRESS_BAR_MARQUEE as u32, 1, 30);
        }
        TDN_BUTTON_CLICKED if (*state).result.is_none() => return 1,
        TDN_TIMER if (*state).result.is_none() => loop {
            match (*state).events.try_recv() {
                Ok(SetupEvent::Progress(message)) => {
                    let text = wide(message);
                    SendMessageW(
                        window,
                        TDM_SET_ELEMENT_TEXT as u32,
                        TDE_CONTENT as usize,
                        text.as_ptr() as isize,
                    );
                }
                event => {
                    let result = match event {
                        Ok(SetupEvent::Finished(result)) => result,
                        Err(TryRecvError::Disconnected) => {
                            Err("The setup worker stopped unexpectedly. Please retry.".into())
                        }
                        _ => break,
                    };
                    (*state).result = Some(result);
                    SendMessageW(window, TDM_ENABLE_BUTTON as u32, IDCLOSE as usize, 1);
                    PostMessageW(window, TDM_CLICK_BUTTON as u32, IDCLOSE as usize, 0);
                    break;
                }
            }
        },
        _ => {}
    }
    0
}

fn install_with_progress() -> Result<(), String> {
    with_progress(install_runtime)
}

fn with_progress(
    operation: impl FnOnce(&Sender<SetupEvent>) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (sender, events) = mpsc::channel();
    let title = wide("Foldory setup");
    let heading = wide("Installing Microsoft Edge WebView2 Runtime");
    let content = wide("Preparing setup…");
    let footer = wide("Setup can take a few minutes. Foldory will open automatically.");
    let mut state = ProgressDialog {
        events,
        result: None,
    };
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        dwFlags: TDF_CALLBACK_TIMER | TDF_SHOW_MARQUEE_PROGRESS_BAR,
        dwCommonButtons: TDCBF_CLOSE_BUTTON,
        pszWindowTitle: title.as_ptr(),
        pszMainInstruction: heading.as_ptr(),
        pszContent: content.as_ptr(),
        pszFooter: footer.as_ptr(),
        pfCallback: Some(progress_callback),
        lpCallbackData: &mut state as *mut ProgressDialog as isize,
        ..Default::default()
    };
    let worker = std::thread::Builder::new()
        .name("webview2-setup".into())
        .spawn(move || {
            let result = operation(&sender);
            let _ = sender.send(SetupEvent::Finished(result));
        })
        .map_err(|error| format!("Could not start setup: {error}"))?;
    // Tauri's executable manifest enables Common Controls v6. All UTF-16
    // strings and callback state remain valid until this modal call returns.
    let status = unsafe {
        TaskDialogIndirect(
            &config,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    // Always join: the temporary installer must outlive the child process, and
    // a failed progress dialog must not leave an unobserved installation.
    worker
        .join()
        .map_err(|_| "The setup worker stopped unexpectedly.".to_string())?;
    if status < 0 {
        return Err(format!(
            "Windows could not display setup progress (0x{:08X}). Please retry.",
            status as u32
        ));
    }
    state
        .result
        .unwrap_or_else(|| Err("Setup closed before it completed. Please retry.".into()))
}

fn progress(sender: &Sender<SetupEvent>, message: &'static str) {
    let _ = sender.send(SetupEvent::Progress(message));
}

fn install_runtime(sender: &Sender<SetupEvent>) -> Result<(), String> {
    let directory = tempfile::Builder::new()
        .prefix("project-manager-webview2-")
        .tempdir()
        .map_err(|error| format!("Could not create a temporary setup folder: {error}"))?;
    let installer = directory.path().join("MicrosoftEdgeWebview2Setup.exe");
    progress(sender, "Downloading the WebView2 installer from Microsoft…");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Could not prepare the download: {error}"))?;
    runtime.block_on(download_bootstrapper(&installer))?;

    progress(sender, "Verifying Microsoft's digital signature…");
    verify_microsoft_signature(&installer)?;

    progress(
        sender,
        "Downloading and installing WebView2 Runtime. This can take a few minutes…",
    );
    let status = wait_for_command(
        Command::new(&installer).args(["/silent", "/install"]),
        Duration::from_secs(600),
        "WebView2 installation",
    )?;

    progress(
        sender,
        "Checking that WebView2 is available for your Windows account…",
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        // Availability is authoritative even if the bootstrapper reported an
        // already-installed result or another app completed setup concurrently.
        if runtime_available() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let code = status.code().map_or("unknown".into(), |code| {
        format!("{code} (0x{:08X})", code as u32)
    });
    Err(format!("Microsoft's installer exited with code {code}, but WebView2 is still unavailable. Restart Windows if requested. Your administrator may need to allow WebView2 installation for this account."))
}

async fn download_bootstrapper(path: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .user_agent(concat!("ProjectManager/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not prepare Microsoft's download: {error}"))?;
    let mut response = client
        .get(BOOTSTRAPPER_URL)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| {
            format!("Could not download WebView2. Check your internet connection. {error}")
        })?;
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The WebView2 download was interrupted: {error}"))?
    {
        if data.len().saturating_add(chunk.len()) > MAX_BOOTSTRAPPER_BYTES {
            return Err(
                "Microsoft's installer download exceeded the expected size. Please retry.".into(),
            );
        }
        data.extend_from_slice(&chunk);
    }
    if !data.starts_with(b"MZ") {
        return Err("The download did not contain a Windows installer. Check whether your network blocks Microsoft's download servers.".into());
    }
    let mut file = std::fs::File::create(path)
        .map_err(|error| format!("Could not save the WebView2 installer: {error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("Could not save the WebView2 installer: {error}"))
}

fn verify_microsoft_signature(path: &Path) -> Result<(), String> {
    // Pass the path as process data, never as PowerShell source. Use Windows'
    // built-in Authenticode trust validation before executing downloaded code.
    let system_root = std::env::var_os("SystemRoot")
        .ok_or("Windows could not locate its signature verification tools.")?;
    let powershell = Path::new(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    // A parent using PowerShell 7 (including developer tools) may export an
    // incompatible PSModulePath. Verification must use Windows' own modules.
    let modules = powershell.parent().unwrap().join("Modules");
    let status = wait_for_command(
        Command::new(powershell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                VERIFY_SIGNATURE,
            ])
            .env("FOLDORY_WEBVIEW2_INSTALLER", path)
            .env("PSModulePath", modules),
        Duration::from_secs(60),
        "Microsoft installer signature verification",
    )?;
    if !status.success() {
        return Err("Windows could not verify a valid Microsoft signature on the WebView2 installer. The installer was not run. Check your connection, system clock and administrator restrictions, then retry.".into());
    }
    Ok(())
}

fn wait_for_command(
    command: &mut Command,
    timeout: Duration,
    operation: &str,
) -> Result<ExitStatus, String> {
    let mut child = command
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start {operation}: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("Could not check {operation}: {error}"),
                    _ => format!("{operation} took too long. Check your connection and installation restrictions, then retry."),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, collections::VecDeque};

    #[test]
    fn candidate_versions_are_numeric_and_incomplete_folders_are_ignored() {
        let root = tempfile::tempdir().unwrap();
        for version in [
            "9.0.1.1",
            "10.0.1.1",
            "157.0.4341.60",
            "SetupMetrics",
            "158.0.0",
            "158.0.0.1-beta",
        ] {
            let folder = root.path().join(version);
            std::fs::create_dir(&folder).unwrap();
            std::fs::write(folder.join("msedgewebview2.exe"), b"fixture").unwrap();
        }
        std::fs::create_dir(root.path().join("159.0.0.1")).unwrap();
        let names: Vec<_> =
            runtime_candidates(&[root.path().to_path_buf(), root.path().join("missing")])
                .into_iter()
                .map(|path| path.file_name().unwrap().to_str().unwrap().to_string())
                .collect();
        assert_eq!(names, ["157.0.4341.60", "10.0.1.1", "9.0.1.1"]);
    }

    #[test]
    fn untrusted_runtime_is_never_activated() {
        assert!(!select_runtime(
            &[PathBuf::from("untrusted")],
            |_| false,
            |_| panic!("untrusted runtime activated")
        ));
    }

    #[test]
    fn selects_first_trusted_runtime_the_loader_can_use() {
        let candidates = ["newest", "compatible", "oldest"].map(PathBuf::from);
        let mut attempted = Vec::new();
        assert!(select_runtime(
            &candidates,
            |_| true,
            |path| {
                attempted.push(path.to_path_buf());
                path == Path::new("compatible")
            }
        ));
        assert_eq!(attempted, candidates[..2]);
    }

    #[test]
    fn unusable_existing_runtimes_still_allow_normal_setup() {
        assert!(!select_runtime(
            &[PathBuf::from("unusable")],
            |_| true,
            |_| false
        ));
    }

    #[test]
    fn existing_runtime_never_prompts_or_installs() {
        assert!(ensure_with(
            || true,
            |_| panic!("unexpected prompt"),
            || panic!("unexpected install")
        ));
    }

    #[test]
    fn declining_setup_does_not_install_or_start_the_app() {
        assert!(!ensure_with(
            || false,
            |error| {
                assert!(error.is_none());
                false
            },
            || panic!("unexpected install")
        ));
    }

    #[test]
    fn installed_runtime_is_checked_before_starting_the_app() {
        let installed = Cell::new(false);
        assert!(ensure_with(
            || installed.get(),
            |_| true,
            || {
                installed.set(true);
                Ok(())
            }
        ));
    }

    #[test]
    fn failed_download_can_be_retried_in_the_same_launch() {
        let installed = Cell::new(false);
        let attempts = Cell::new(0);
        assert!(ensure_with(
            || installed.get(),
            |error| {
                if attempts.get() == 1 {
                    assert_eq!(error, Some("offline"));
                }
                true
            },
            || {
                attempts.set(attempts.get() + 1);
                if attempts.get() == 1 {
                    Err("offline".into())
                } else {
                    installed.set(true);
                    Ok(())
                }
            }
        ));
        assert_eq!(attempts.get(), 2);
    }

    #[test]
    fn success_exit_without_runtime_does_not_start_the_app() {
        let mut answers = VecDeque::from([true, false]);
        assert!(!ensure_with(
            || false,
            |error| {
                let answer = answers.pop_front().expect("unexpected extra prompt");
                if !answer {
                    assert!(error.unwrap().contains("still unavailable"));
                }
                answer
            },
            || Ok(())
        ));
    }

    #[test]
    fn runtime_installed_by_another_process_skips_our_installer() {
        let mut checks = VecDeque::from([false, true]);
        assert!(ensure_with(
            || checks.pop_front().unwrap(),
            |_| true,
            || panic!("unexpected install")
        ));
    }

    #[test]
    fn signature_verification_rejects_unsigned_executable() {
        let directory = tempfile::tempdir().unwrap();
        let installer = directory.path().join("installer '$; test.exe");
        std::fs::write(&installer, b"MZ - not a signed executable").unwrap();
        assert!(verify_microsoft_signature(&installer)
            .unwrap_err()
            .contains("signature"));
    }

    #[test]
    #[ignore = "Downloads Microsoft's real bootstrapper; verifies it without installing"]
    fn microsoft_bootstrapper_download_and_signature() {
        let directory = tempfile::tempdir().unwrap();
        let installer = directory.path().join("MicrosoftEdgeWebview2Setup.exe");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(download_bootstrapper(&installer))
            .unwrap();
        verify_microsoft_signature(&installer).unwrap();
    }

    #[test]
    fn child_process_timeout_is_bounded() {
        let error = wait_for_command(
            Command::new("powershell.exe").args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[System.Threading.Thread]::Sleep(10000)",
            ]),
            Duration::from_millis(100),
            "test process",
        )
        .unwrap_err();
        assert!(error.contains("took too long"));
    }

    #[test]
    #[ignore = "Interactive native UI smoke test; does not download or install anything"]
    fn native_setup_prompt_smoke() {
        assert!(!prompt(None), "Choose No in the initial setup prompt");
        assert!(
            !prompt(Some(
                "Preview: simulated offline download. No software was installed."
            )),
            "Choose No in the retry prompt"
        );
    }
}
