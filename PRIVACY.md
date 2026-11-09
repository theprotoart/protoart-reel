# Privacy

ProtoArt Reel works entirely on your Mac. It has no accounts and no analytics, and makes no network
connections, except downloads you start yourself: GET FLUX downloads the FLUX.2 [klein] model
once from Hugging Face (the same copy Protoart Studio uses), on a Mac where Studio hasn't already; GET (in the
writer) downloads a Qwen model; and GET KITTEN VOICES downloads KittenTTS from GitHub, its Python packages from the
Python Package Index (PyPI) and its model from Hugging Face, once. Nothing about you or your projects is sent. Recordings, projects, thumbnails and exports stay where you save them.

- The screen, camera, microphone and computer audio are recorded only while a recording is running,
  and only the sources you turn on. macOS asks for permission the first time.
- The pointer position is saved with screen recordings (for pointer effects and Auto zoom). Clicks and
  key presses are recorded only when you turn on "Record clicks" or "Record keystrokes" for a
  recording (for click effects and the keystroke display), and stay in the project.
- ERNIE and FLUX pictures and prompt suggestions are made on your Mac by Protoart Studio's engines; prompts and
  frames are not sent anywhere.
- Kitten voices (speech from text) are made on your Mac. A voice you clone is saved only in Reel's settings folder
  (Kitten › My Voices: the recording and what it says) until you remove it; it is never uploaded.
- Per-app sound is captured only from the apps you tick while a recording is running. The Sound mixer
  processes app audio live and never saves it. Mixer settings (per app: volume, mute, EQ, output) are
  stored in Reel's settings folder.
