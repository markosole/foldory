// Kept outside the application bundle so the parsed startup shell can be
// revealed without waiting for React and its dependencies.
window.__TAURI__?.window.getCurrentWindow().show();
