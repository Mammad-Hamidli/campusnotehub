//! campusnotehub for Windows: a native window around https://www.campusnotehub.com.
//!
//! The site stays an ordinary server-rendered web app. This shell ships no
//! frontend code and grants the remote page no Tauri IPC (there is no
//! capabilities file), so the page runs exactly as it does in Edge.
//!
//! Auth needs nothing special: the page is loaded top-level from its real
//! origin, so CH_AT / CH_RT are first-party cookies to WebView2 exactly as they
//! are to a browser. The window opens on /api/auth/desktop (tauri.conf.json),
//! which marks this WebView2 profile as the desktop app; sessions signed in
//! here get persistent cookies and a 7-day sliding lifetime, decided by the
//! server (DESKTOP_SESSION_DAYS in src/lib/auth/session.ts). So staying signed
//! in across restarts needs nothing here either - just never clear the
//! profile on exit.

// Release builds (the installer's exe) link as a GUI program, so Windows opens no
// console window behind the app. It is a linker setting: tauri.conf.json has no
// equivalent. Debug builds keep the console on purpose: a GUI-subsystem exe's
// stdout/stderr, panic messages included, never reach the terminal it runs from.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Hands a URL to the default browser or mail client.
///
/// Scheme-filtered because the URL is page-controlled: passing it through as-is
/// would let any page launch any protocol handler registered on the machine.
fn open_externally(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("could not open {url} externally: {err}");
        }
    }
}

fn main() {
    tauri::Builder::default()
        // Must be registered first. A second launch focuses the running window
        // instead of starting another copy on the same WebView2 profile.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Used from Rust only. The plugin's default click interceptor stays off:
        // it cancels every target="_blank" click and then calls IPC, which the
        // remote page is deliberately not allowed to do, so the link goes dead.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .setup(|app| {
            // Declared in tauri.conf.json with `"create": false` and built here,
            // because the handlers below can only be attached in code.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("tauri.conf.json must declare the \"main\" window")?;

            let popups = app.handle().clone();
            let schemes = app.handle().clone();
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                // target="_blank", window.open(), Ctrl/middle-click. Without a
                // handler Tauri drops these silently, so every external link
                // (LinkedIn, mentor meeting links, links in posts) would do nothing.
                // Same-origin popups go to the browser too: loading them in this
                // window would throw away what is on screen, e.g. a half-filled
                // registration form behind its "terms" link.
                .on_new_window(move |url, _features| {
                    open_externally(&popups, &url);
                    NewWindowResponse::Deny
                })
                // Top-level navigation is deliberately NOT restricted to our own
                // host. Sign-in redirects through accounts.google.com and, for
                // university Workspace accounts, whatever identity provider the
                // school federates to; cancelling any hop breaks sign-in.
                .on_navigation(move |url| match url.scheme() {
                    "mailto" | "tel" => {
                        open_externally(&schemes, url);
                        false
                    }
                    _ => true,
                })
                // Taskbar and Alt+Tab show the page's own title.
                .on_document_title_changed(|window, title| {
                    if !title.is_empty() {
                        let _ = window.set_title(&title);
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running campusnotehub");
}
