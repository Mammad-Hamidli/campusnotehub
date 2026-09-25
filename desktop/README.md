# campusnotehub for Windows

A native Windows app (Tauri 2, WebView2) that opens https://www.campusnotehub.com in
its own window, shipped as a standard `campusnotehub_<version>_x64-setup.exe` installer
(Welcome → Destination → Start menu → Install → Finish).

It is a thin shell. The web app is not bundled or changed: every page, API call and cookie
comes from the live site, so a Vercel deploy updates the desktop app instantly and the
installer only needs rebuilding when something in `desktop/` changes.

```
desktop/
  package.json              Tauri CLI + scripts; "version" is the app/installer version
  src-tauri/
    tauri.conf.json         window, remote URL, NSIS installer settings
    src/main.rs             link / popup handling, single instance
    icons/                  generated from public/brand/campus-hub-app-icon.svg (npm run icons)
```

## Behaviour inside the app

| | |
|---|---|
| Sign-in and cookies | Unchanged. The page is loaded top-level from its real origin, so `CH_AT` / `CH_RT` are first-party cookies exactly as in Edge. They are session cookies by design (`src/lib/auth/session.ts`), so **closing the app signs the user out**, like closing a browser. |
| Google sign-in | Runs inside the window (top-level redirect to accounts.google.com and back). Google serves its normal sign-in page, not the embedded-webview block: WebView2 presents itself as Chrome on accounts.google.com. |
| Links with `target="_blank"`, `window.open`, Ctrl/middle-click | Open in the default browser. Only `http`, `https`, `mailto`, `tel` are passed on. |
| `mailto:` / `tel:` links | Open the default mail / phone app. |
| Downloads (notes, exports, recovery codes) | WebView2's own download flyout, saved to the user's Downloads folder. |
| Camera (document capture) | WebView2 asks for permission the first time. |
| File drag-and-drop | Delivered to the page (Tauri's native drop handling is off). |
| Zoom | Ctrl + / Ctrl − / Ctrl + wheel / pinch. Alt+← goes back. |
| Second launch | Focuses the running window instead of opening another. |
| Tauri APIs | None exposed to the site: there is no capabilities file, so the remote page cannot call into the shell. |
| Offline | WebView2's "can't reach this page" screen; reload with F5. |

The installer is per-user (no admin prompt): it installs to
`%LOCALAPPDATA%\campusnotehub`, adds a Start menu entry and an entry under
Settings → Apps. The WebView2 profile lives in `%LOCALAPPDATA%\com.campusnotehub.desktop`;
the uninstaller offers to delete it. If WebView2 is missing (rare outside old Windows 10
installs) the installer downloads it silently.

## Build the installer locally (PowerShell)

One-time prerequisites (Rust needs the MSVC linker from the C++ build tools):

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install --id Rustlang.Rustup
# open a NEW terminal so cargo is on PATH, then:
rustup default stable-msvc
```

Build:

```powershell
cd desktop
npm ci
# Keep Cargo's multi-GB build output out of OneDrive (and under Windows' 260-char path limit):
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\campusnotehub-desktop-target"
npm run build
```

The installer is written to
`$env:CARGO_TARGET_DIR\release\bundle\nsis\campusnotehub_<version>_x64-setup.exe`
(`desktop\src-tauri\target\release\bundle\nsis\` if `CARGO_TARGET_DIR` is not set).
The first build compiles ~480 crates and takes several minutes; later builds are incremental.

## Run against the local dev server

```powershell
npm run dev              # in the repo root: Next.js on http://localhost:3000
cd desktop; npm run dev  # second terminal: the desktop window loads localhost:3000, DevTools enabled (F12)
```

Debug builds (`npm run dev`, `cargo build`, `target\debug\*.exe`) are console programs on
purpose, so panics and `eprintln!` output reach the terminal. Started from Explorer, a debug
exe opens a console window next to the app. The installer's exe is a release build, which
opens no console (`windows_subsystem` in `src/main.rs`; `tauri.conf.json` has no such setting).

## Build in GitHub Actions

`.github/workflows/desktop-windows.yml` builds on `windows-latest`:

- **Actions → "Desktop - Windows installer" → Run workflow**, or any PR touching `desktop/`:
  the setup `.exe` is uploaded as the `campusnotehub-windows-installer` artifact.
- **Release:** bump `"version"` in `desktop/package.json`, commit, then
  ```powershell
  git tag desktop-v1.0.1
  git push origin desktop-v1.0.1
  ```
  The workflow checks that the tag matches the version and attaches the installer to a
  GitHub Release named after the tag.

The site's "Download for Windows" button (landing page, header, footer, and the stable link
`https://www.campusnotehub.com/download/windows`) picks up the newest `desktop-v*` release
with a `*-setup.exe` asset within 10 minutes, with no redeploy. Until the first release exists
it shows "coming soon". Drafts and pre-releases are ignored, so publishing a release as a
pre-release is a way to test it before the site links to it. It is hidden inside the desktop
app itself.

## Before public distribution: code signing

The installer is unsigned, so Windows SmartScreen shows "Windows protected your PC"
(users click *More info → Run anyway*). To remove that, sign with an EV/OV code-signing
certificate or Azure Trusted Signing and configure `bundle.windows.certificateThumbprint`
or `bundle.windows.signCommand` in `tauri.conf.json`.

## Changing things

- **Site URL:** `build.frontendDist` in `tauri.conf.json`.
- **Icon:** replace `public/brand/campus-hub-app-icon.svg`, run `npm run icons`, then delete
  the non-Windows outputs (`android/`, `ios/`, `icon.icns`, `Square*Logo.png`, `StoreLogo.png`).
- **Version:** `desktop/package.json` only (the installer and the .exe's file version read it).
  The version in `Cargo.toml` is the Rust crate's and is not shown anywhere.
