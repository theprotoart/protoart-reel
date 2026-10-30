# Third-party notices

Distributed builds of ProtoArt Reel bundle the following software. Their full license texts are
shipped inside the app at `ProtoArt Reel.app/Contents/Resources/Licenses/`.

| Component | License | Notes |
|---|---|---|
| Electron 44.7.0 | MIT | `Electron-LICENSE.txt` |
| Chromium (bundled in Electron), including its media codecs and libraries | BSD-3-Clause and various | `LICENSES.chromium.html` |
| Node.js (bundled in Electron) | MIT and various | Covered by `LICENSES.chromium.html` and the Electron license |
| RNNoise v0.1.1 (Xiph.Org, Mozilla; Jean-Marc Valin), including its trained weights | BSD-3-Clause | `RNNoise-COPYING.txt`; compiled into the `reel-voice` helper |

Build-time tools (`@electron/fuses` and its dependencies, MIT/ISC/Apache-2.0) aren't included in the
app.

## Not bundled, used when present

ProtoArt Reel does not include or download any AI model. When Protoart Studio is installed on the same
Mac, Reel uses the engines and models it already has:

| Component | License | Used for |
|---|---|---|
| ERNIE-Image Turbo (Baidu) via mflux (MLX) | Apache-2.0 / MIT | Thumbnail art and AI Image |
| ERNIE LoRA files in Protoart Studio's LoRA folder | Set by each LoRA's author | Optional styles you choose |
| FLUX.2 [klein] 4B (Black Forest Labs) via mflux (MLX) | Apache-2.0 (model) / MIT (mflux) | Second picture engine; the 4-bit MLX conversion Protoart Studio uses (ar9av/FLUX.2-klein-4B-mflux-4bit), never shipped with Reel |
| FLUX.2 klein LoRA files in Protoart Studio's “FLUX.2” LoRA folder | Set by each LoRA's author | Optional styles you choose |
| Audio Unit plug-ins installed on your Mac (e.g. CEDAR, Waves) | Their own licences | Hosted only when you add them; nothing of theirs is copied or bundled |
| Qwen2.5-0.5B/1.5B-Instruct (Alibaba) via Transformers | Apache-2.0 | Prompt suggestions |

The app uses fonts installed with macOS; no fonts are bundled. The app icon and all artwork are
original to this project. ProtoArt Reel was designed after studying how ScreenFlow is put together
(its file layout, features and settings); no ScreenFlow code, artwork or resources are included. The
per-app audio, master and voice tools were likewise designed from the public documentation and manuals
of Loopback, SoundSource, Waves Clarity Vx and the Abbey Road TG Mastering Chain; no code, neural
networks, impulse responses or other resources from those products are included.
