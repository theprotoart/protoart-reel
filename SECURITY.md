# Security

## How Reel is built to be safe

- **Sandboxed editor:** the window runs in Chromium's OS sandbox with context isolation, served from
  `app://reel/` (never `file://`), with a strict Content-Security-Policy, no navigation, no new windows
  and no network: every request that isn't the app's own files is blocked.
- **Narrow bridge:** the editor talks to the main process only through the functions in `preload.js`.
  Every message is checked to come from the editor page and validated. The editor never sees folder
  paths: projects are opened by random tokens, and media is served only from the open project's
  `media` folder, by plain file names.
- **Permissions:** camera, microphone and screen capture are allowed only for the editor page, and
  screen capture only for the source picked in Reel's own recording dialog.
- **Files:** projects and exports are written to a temporary file and renamed into place. Recordings are
  written only inside the project.
- **AI helpers:** ERNIE and the prompt writer run as separate Python processes from Protoart Studio's
  existing environments, running only this app's two fixed scripts with `-I` (isolated), a minimal
  environment and Hugging Face offline mode. Inputs are validated (prompt length, image size and type,
  dimensions, steps).
- **Hardened Electron:** fuses disable Node mode, `NODE_OPTIONS`, inspector flags and extra `file://`
  privileges; the app is signed ad hoc.
- **Audio helper:** `reel-audio` is compiled from `native/reel-audio.swift` and signed with the app. It
  only taps the apps you pick, writes only the WAV paths the main process creates inside the project,
  and its private audio routes are removed when it exits. App keys and mixer settings are validated.

## Audit, 14 November 2026

**What Reel is:** a desktop app for macOS (Electron), used by one person on their own Mac. It has **no logins or
accounts, no payments, no database, no server, and no website**. It has no connection to the internet, with three
exceptions: downloading AI models from a fixed list, downloading the voice and sound-separation packages, and
whatever you upload yourself. It reads and writes your project files, imports media you drop in, runs its own
helper programs (screen audio, speech, voice), and runs AI models on your Mac (FLUX/ERNIE pictures, Qwen writer,
Kitten voices, SAM-Audio).

Because there is no server, website or account, the web risks in the list below **can't happen to it**: there is
nothing on the internet to attack, no sign-in to break, and no other user whose data could be seen.

Checked in the code, with the tests in `tests/security.test.mjs` (9 tests) guarding each finding.

### The list you asked about

| Item | Applies? | What I found | Result |
|---|---|---|---|
| Next.js header bypass | No | Not a Next.js or web app; there is no server. | Not applicable |
| Exposed `.git` folder | Partly | No website to expose it on. The built app and DMG contain no `.git`, and the public GitHub repo is meant to be public. | OK |
| Open Supabase storage | No | Reel uses no Supabase or cloud storage. | Not applicable |
| Prices set by the browser | No | Nothing is sold in the app. | Not applicable |
| Credential stuffing | No | No logins. | Not applicable |
| Open database | No | No database. Projects are files on your Mac. | Not applicable |
| Polyfill.io / third-party scripts | Yes | Every script, style and font is inside the app. The page's Content-Security-Policy allows only its own scripts, and the main process cancels every request that isn't to the app itself. | OK |
| SMS pumping | No | Reel sends no texts or emails. | Not applicable |
| Prompt injection | Partly | The Qwen writer and the prompt helper read your own transcript or frame and only suggest text for you to read. They can't run commands, open files or reach the internet. | OK |
| Weak JWT secret | No | No tokens or sessions. Projects are opened with random tokens that exist only in memory while the app is open. | Not applicable |
| Race conditions | Yes | Saves and exports go to a temporary file that is then renamed into place. Recording chunks are written in order through a queue. Media names are reserved before copying, and copies refuse to overwrite (`COPYFILE_EXCL`). | OK |
| Account pre-hijacking | No | No accounts. | Not applicable |
| Subdomain takeover | No | No website or domain. Downloads are on GitHub Releases and Hugging Face. | Not applicable |
| SSRF | No | No server. The only downloads go to a fixed list of model repos, and the editor page can't make network requests at all. | Not applicable |
| Path traversal | Yes | Every file name from the editor is checked (`validate.mediaName`: no `/`, `\`, `..`, leading dot or control characters). The `app://` server serves only the app's own files, through a strict pattern, and refuses links and folders. Projects are found through a list of known projects, never through a path the page sends. | OK (tested) |
| Password-reset poisoning | No | No passwords. | Not applicable |
| Source maps | Partly | No `.map` files in the repo or in the built app. | OK |
| Clickjacking | No | Not a web page. The window can't be framed, navigate, or open new windows (`frame-src 'none'`). | Not applicable |
| Open redirect | Partly | The window can't navigate or open links. The only thing opened outside the app is a fixed System Settings privacy pane. | OK (tested) |
| User enumeration | No | No users. | Not applicable |

### Risks that fit a desktop AI app

| Item | Applies? | What I found | Result |
|---|---|---|---|
| Secrets in the code | Yes | Searched every tracked file for API keys, tokens (OpenAI, Anthropic, Hugging Face, GitHub, AWS, Google, Slack), private keys, JWTs, passwords, personal emails and home-folder paths. None found. `.gitignore` already keeps `.env`, keys and tokens out. | OK (tested) |
| Secrets in the git history | Yes | Searched all 52 commits on every branch the same way. None found. | OK |
| Secrets in the built app | Yes | The 1.7.0 build was checked before upload: no keys, tokens, email or home paths. The upload script uses your own saved Hugging Face login and stores no token in the repo. | OK |
| Private data / one user seeing another's | No | Single-user app with no sharing service. Recordings, projects and cloned voices stay on your Mac (see PRIVACY.md). | Not applicable |
| Logins and permission checks | Partly | No sign-in. In its place, every message from the window to the main process is checked to come from the editor page (`fromEditor`) or the recording panel (`fromHud`). Camera, microphone and screen capture are granted only to the editor page, and screen capture only for the source you picked. | OK (tested) |
| HTML or code injection | Yes | Only the app's own scripts can run (CSP `script-src 'self'`, no `eval`). The few places that build HTML use only numbers or escaped text; everything else uses `textContent`. Imported SVGs are shown as images, which can't run scripts. | OK (tested) |
| Unsafe database queries | No | No database. | Not applicable |
| Command injection | Yes | Every helper (speech, audio, voice, Python AI scripts, `say`) is started with a fixed list of arguments and no shell. Text for speech goes through a file. Python runs with `-I` (isolated) and a minimal environment. | OK (tested) |
| File uploads / imports | Yes | Dropped files are copied into the project only if they are pictures, video or sound; anything else (keys, documents) is refused. A shared project or ScreenFlow package therefore can't pull private files into itself. Every write has a size limit (project 32 MB, images 32–64 MB, captions 16 MB). | OK |
| Downloads | Yes | Started only by your GET buttons, from a fixed list. The FLUX model is pinned to one exact revision. The voice and sound-separation packages are pinned to reviewed commits. | OK |
| Model files that can hide code | Yes | Only weight files (`.safetensors`, JSON, tokenizers) are downloaded: no pickles (`.bin`, `.pt`, `.ckpt`). Models load with `local_files_only` and offline mode, and remote code is never trusted (`trust_remote_code` is off). | OK (tested) |
| What the AI is allowed to do | Yes | It only returns text or pictures to you. It has no tools, no file access beyond its own input and output, and no internet while it runs. | OK |
| Electron settings | Yes | Sandbox on, context isolation on, Node off in the page and its workers, web security on, no webviews, no navigation, no new windows, devtools off in the shipped app (unless you start it with `REEL_DEVTOOLS` set). Fuses turn off Node mode, `NODE_OPTIONS`, inspector flags and extra `file://` rights. | OK (tested) |
| Electron version | Yes | Reel ships Electron **44.7.0**. Electron 44 is still supported, but its latest patch is **44.11.2** (12 Nov 2026), and Electron patch releases bring Chromium security fixes. | **Needs your OK** (update and rebuild) |
| Dependencies pinned | Yes | Electron and @electron/fuses are pinned to exact versions. There is **no `package-lock.json`**, so the helper packages Electron's installer uses aren't locked. This only affects building, not the app. | Recommend: commit a lockfile |
| AI model versions pinned | Partly | FLUX is pinned. The Qwen writer, Kitten and SAM-Audio models download the latest version from their official repos. They are weights only, so they can't run code, but a changed model could behave differently. | Recommend: pin revisions (OK, low) |
| App files sealed | Partly | The app's JavaScript is a plain folder, not a sealed `asar` archive with integrity checking. Changing it would already need write access to the app on your Mac. | Low; optional later |
| Rate limits (signups, logins, paid calls) | No | Nothing costs money per use and there are no signups or logins. | Not applicable |
| Old downloads on Hugging Face | Partly | The repo's history still holds the 1.5.0 and 1.5.1 DMGs from before these checks were done. | Recommend: check or squash history |

**Nothing needed fixing in the code.** The open items are the Electron update, the lockfile and the model pins.
They change what gets downloaded and built, so they're waiting for your OK.
