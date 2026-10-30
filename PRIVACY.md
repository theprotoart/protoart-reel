# Privacy

ProtoArt Reel works entirely on your Mac. It has no accounts and no analytics, and makes no network
connections, with one exception you start yourself: GET FLUX downloads the FLUX.2 [klein] model
once from Hugging Face (the same copy Protoart Studio uses), on a Mac where Studio hasn't already. Nothing about you or your projects is sent. Recordings, projects, thumbnails and exports stay where you save them.

- The screen, camera, microphone and computer audio are recorded only while a recording is running,
  and only the sources you turn on. macOS asks for permission the first time.
- The pointer position is saved with screen recordings (for pointer effects and Auto zoom). Clicks and
  key presses are recorded only when you turn on "Record clicks" or "Record keystrokes" for a
  recording (for click effects and the keystroke display), and stay in the project.
- ERNIE and FLUX pictures and prompt suggestions are made on your Mac by Protoart Studio's engines; prompts and
  frames are not sent anywhere.
- Per-app sound is captured only from the apps you tick while a recording is running. The Sound mixer
  processes app audio live and never saves it. Mixer settings (per app: volume, mute, EQ, output) are
  stored in Reel's settings folder.
