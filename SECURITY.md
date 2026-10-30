# Security

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
