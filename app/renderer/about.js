// HELP: how Reel works, as topics you can search. Type a question or a word ("pause", "claps", "shortcut",
// "plug-in") and the topics that answer it stay, with the words lit. The window scrolls; nothing is cut off.
// Text markup: **bold** and `key`.
import { el, modal } from './ui.js';

// Each topic: [title, extra words people might search for, paragraphs, group]. Group 'how' = how to,
// 'fix' = troubleshooting (written as the problem you see, then what to do).
export const TOPICS = [
  // ------------------------------------------------------------------ how to
  ['Getting started', 'start begin new project edit record simple full guide keys panel', [
    'Press **RECORD MY SCREEN** to record, or **EDIT A VIDEO** to bring in a video you have. **SIMPLE** (top bar) shows the essentials and a 1 → 2 → 3 guide; **FULL** shows every tool.',
    'While you edit, the studio keys sit in the panel at the top right: the big **REC** key, ✂ TAKES, ADD MEDIA, ⚡ AUTO EDIT, ⚖ AUTO MIX, MIXER, SPECTRAL, AI IMAGE, THUMBNAIL and the big **EXPORT** key.',
    'Turn on **EXPLAIN** (top right, `⌘/`) and rest the pointer on anything to see what it does. Type a problem in the **Search help** box in the top bar any time.'], 'how'],
  ['Recording', 'record rec screen window camera microphone mic computer audio countdown stop pause resume menu bar icon', [
    'Press the big **REC** key (`⌘R`), pick a screen or a window, and choose camera, microphone and computer audio. After the countdown Reel hides. The REC key stays down with its lamp blinking while you record.',
    'While recording, the panel at the bottom of the screen has **MARK**, **PAUSE** and **STOP** (`⌥⇧⌘M`, `⌥⇧⌘2`, `⇧⌘2`). Clicking the red icon in the menu bar opens its menu (Resume, Stop…). A pause is simply left out of the recording, however long it is.',
    'Each source is saved as its own file (screen and camera as MP4, sound as lossless WAV). A recording’s clips come in **grouped**: move or trim one and the others follow. **UNGROUP** splits them.',
    'New recordings appear at the **top of the Media list** with a **NEW** tag for 10 minutes.'], 'how'],
  ['Takes: clap when a line goes wrong', 'takes take clap claps mistake retake bad keep drop mark marker fluff redo', [
    'Messed up a line? **Clap three times** (or press `⌥⇧⌘M` / **MARK**), pause, and say it again. When you stop, Reel listens to the microphone and splits the recording into takes at each clap.',
    '**✂ TAKES** lists them. The take before each clap is marked **DROP**; the last one is kept. Play any take with ▶, switch **KEEP / DROP**, then **REMOVE DROPPED TAKES** cuts them, claps and all, and closes the gaps (`⌘Z` brings them back).',
    'For other footage: select a clip and press **LISTEN FOR CLAPS** in TAKES (or Edit › Find Clap Markers…). **Auto Edit** can find and cut claps too (its **Claps** setting).'], 'how'],
  ['Editing on the timeline', 'edit cut split splice blade trim delete move snap group ungroup select forward toolbar tool bar', [
    'Drag media from the left onto the timeline. Upper tracks draw on top. `S` splices at the playhead, `T` is the blade, `⌫` deletes, `⇧⌫` deletes and closes the gap, `M` adds a marker, `Space` plays.',
    'Drag a clip’s edges to trim it; a group (screen + its sound) trims together. `⌥` while trimming moves only that clip, or rolls a cut between two touching clips. **SNAP** makes clips land flush against each other, markers and the playhead.',
    '**Hold SELECT** for two tools: **→ SELECT** (one item at a time) and **⇉ SELECT FORWARD**: click anywhere and everything to the right of it, on every track, is selected, ready to drag. `A` is the normal select tool, `⇧A` select forward. The other selections (all video, all audio…) are under MORE SELECTIONS.',
    'The tool bar: SELECT ▾ · BLADE · SPLICE · DELETE · **GAPS ▾** · + INSERT ▾ · EFFECTS ▾ · AUDIO ▾ · TEXT ▾ · PARTS ▾ · SNAP · ⚙ ▾.'], 'how'],
  ['Gaps, ripple and closing empty space', 'gap gaps ripple close empty space auto delete hole silence black', [
    '**GAPS ▾ › CLOSE GAPS** (`⌥⌫`) removes every empty stretch of the edit (where nothing plays on any track) and slides everything after it up, so all the tracks stay in sync. Markers, captions and parts move with it; locked tracks are never moved.',
    'Turn on **AUTO** in GAPS ▾ and Delete closes the gap it leaves, like RIPPLE.'], 'how'],
  ['Smooth cuts, fades and crossfades', 'smooth cut cuts fade fades crossfade cross fade overlap click pop jump', [
    'Where two clips meet after a cut (a delete, ripple, Close Gaps or Auto Edit joined them), Reel adds a short **crossfade** so the sound doesn’t click and the picture doesn’t jar; next to a gap the sound fades out and in. A plain split of continuous footage needs nothing.',
    'Change it in **Settings › Timeline › Smooth every cut**: Off, Short (0.1 s), Medium, Long.',
    '**Drag one clip over another** on the same track and Reel crossfades them across the overlap. A cut set to **NONE** in Transitions stays a hard cut.'], 'how'],
  ['Transitions', 'transition transitions dissolve wipe none cut every all one this apply', [
    'Click the **⧓** on any cut, or EFFECTS ▾ › Transitions & fades. The **APPLY TO** switch at the top says where a click goes: **THIS CUT** or **EVERY CUT**.',
    '**NONE (Cut)** with EVERY CUT takes every transition off.'], 'how'],
  ['Undo and redo', 'undo redo history back mistake', [
    '`⌘Z` undoes and `⇧⌘Z` redoes, with no limit to how far back. Each time, a note says exactly what changed (“↶ Undo: Move 2 clips”).'], 'how'],
  ['Markers', 'marker markers flag chapter remove delete rename jump', [
    '`M` adds a marker at the playhead. Each marker has a **flag** on the timeline: click it to jump there, right-click to rename or delete it (or delete them all), `⌥`-click deletes it.',
    'The project panel on the right lists every marker with a **×** to remove it. Markers become YouTube chapters in the export notes.'], 'how'],
  ['Speed', 'speed fast slow faster time-lapse timelapse 100x 64x 16x', [
    'Click a clip’s speed badge (or Clip › Speed) to change it: slow motion down to a few percent, fast up to **100×** (buttons for 16×, 32× and 64×).',
    'The preview plays up to 16× and keeps up beyond that, without sound; the export uses the exact speed.'], 'how'],
  ['Parts (keep only some of a long video)', 'part parts section sections keep region in out snap', [
    '**PARTS ▾ › Keep a part** and drag across each part you want. Part edges snap to other parts, clips, markers and the playhead, and two parts can meet exactly end to end. Auto Edit then blends the parts into one edit.'], 'how'],
  ['Call-outs, titles and the end screen', 'callout callouts call-out title text arrow end screen card picture image box watch next subscribe', [
    'Text, call-outs (spotlight, blur, magnify), arrows and end screens are in **+ INSERT ▾** and **EFFECTS ▾ › CALL-OUTS**. They always draw above the video, whatever track they are on, and their words update as you type.',
    '**Double-click** any clip to edit it: its settings open with the cursor in its text.',
    '**End screen pictures:** select the end screen and, in the panel on the right, drop an image from Media onto a box, or press **CHOOSE…** next to it (or *Add a picture from this Mac…*). The picture fills the box, with your caption over it. **CLEAR** takes it out.'], 'how'],
  ['Auto Edit', 'auto edit automatic tiktok shorts youtube podcast tutorial best moments cut ums pauses clean claps voice one clip', [
    '**⚡ AUTO EDIT** (`⌥⌘E`) edits a video for TikTok / Reels, Shorts, several Shorts, a podcast clip, a **Tutorial** or a YouTube video. You preview it and choose **KEEP IT**, **DISCARD** or **TRY ANOTHER**.',
    '**Tutorial:** finds your clap signals and cuts them out (each leaves a take marker for ✂ TAKES), puts the **Tutorial voice** chain on your voice (De-click → De-ess → Auto Level), evens the volume, cuts ums and long pauses, adds gentle zooms and chapters.',
    'Every recipe has settings you can change: Zooms, **Motion** (Punchy: quick push-ins and push-outs for Shorts and TikTok; Ken Burns: slow drifts for tutorials; Follow the action), Transitions, Sound effects, Captions, Clean up, **Claps** (Leave / Mark / Cut them out), **Voice** (any effects preset, including your own saved ones), Volume and Call-outs.',
    '**Keep sped-up clips whole** (on by default): cutting dead air never cuts into clips with a speed change, like time-lapses. To use only some parts of a long video, choose **PARTS ▾ › Keep a part** and drag across each part first. **One clip only:** right-click a clip › **⚡ Auto Edit this clip…**.'], 'how'],
  ['AUTO MIX: levels for dialogue, music and sound effects', 'auto mix automix level levels balance dialogue music sound effects sfx duck dip colour color blue orange green tidy remove quieter louder clean declick', [
    'Give each sound track its colour with the tag on its header: **blue DIALOGUE**, **orange MUSIC**, **green SOUND FX** (several tracks can share one). Then **⚖ AUTO MIX** (`⌥⌘M`, or the key in the panel) sets each to its level: voices clear, music under them, effects heard without jumping out.',
    'Pick a style (Podcast, YouTube, Cinematic). The **Music** and **Sound FX** sliders go from **−30 dB** to +12 dB, with quick buttons (−30, −20, −12, −6, −3, 0, +3, +6).',
    '**Clean the dialogue:** tick **De-click** (on by default), **De-ess** or **Noise gate**; they go on the dialogue tracks before Auto Level, where you can adjust them.',
    'Other options: dip the music while someone talks, even out the dialogue, and **Tidy tracks** (same-colour tracks share one track). **▶ HEAR AUTO MIX** plays the result; nothing is kept until **KEEP IT**. **REMOVE AUTO MIX** (open AUTO MIX again, or right-click a track) puts everything back.'], 'how'],
  ['Sound, mixer and plug-ins', 'sound audio mixer level volume pan eq plug-in plugin waves izotope fabfilter cedar live spectral denoise loudness auto level duck vst au audio unit', [
    '**MIXER** (`⇧⌘M`) has a strip for every track: level, pan, mute, solo, effects. Each track also has an **ƒx rack** (the fx button on its header): built-in effects (EQ, Compressor, De-esser, **De-click**, Noise gate, Reverb, Delay, Limiter, Auto Level, Gain) and **★ Your plug-ins** (Audio Units: Waves, iZotope, FabFilter, CEDAR…).',
    '**Hear a plug-in live:** open its window, then press `Space`. The LISTEN LIVE bar can **RENDER INTO TRACK** (applied for good) or leave it to render at export.',
    '**SPECTRAL** (`⌥⌘S`) repairs sound: de-noise, de-click, de-ess, de-bark. Music marked to dip under the voice gets quieter while you talk.'], 'how'],
  ['De-click (mouth clicks and pops)', 'declick de-click click clicks mouth lip smack pop pops crackle', [
    'On a track: **ƒx rack › + add effect › De-click**. Presets: *Mouth clicks (voice)*, *Pops & crackle*, *Gentle*. **Sensitivity** finds more clicks when higher; **Longest click** is how long a click can be.',
    'It also comes in the **Tutorial voice**, **Podcast voice** and **Clean dialogue** presets, in AUTO MIX (Clean the dialogue) and in Auto Edit (Voice). The track plays about 1 ms late, far less than a video frame.'], 'how'],
  ['Effects presets (save a chain of plug-ins)', 'preset presets chain save rack configuration plug-in plugin settings voice tutorial podcast noisy room reuse', [
    'Each track’s ƒx rack has **PRESETS ▾**. Built in: **Tutorial voice** (De-click → De-ess → Auto Level), **Clean dialogue (light)**, **Podcast voice** (De-click → EQ → Compressor → De-ess → Auto Level) and **Noisy room**.',
    '**Save this rack as a preset…** keeps everything on the track, including your own plug-ins with their settings (set CEDAR up once, save it). Your presets are on every track’s PRESETS ▾ (★) and in **Auto Edit › Voice**. *Delete a preset…* removes one.'], 'how'],
  ['Bounce to a new track (render effects in place)', 'bounce render in place freeze flatten commit print apply permanently destructive new track effects plug-ins hear while editing audiosuite original mute grey', [
    'To hear and mix with the fully processed sound while you edit (like Bounce in Place or Freeze in a DAW): select sound clips and choose **AUDIO ▾ › ⤓ Bounce to new track**, or right-click a clip › **⤓ Bounce to new track**, or right-click a track’s name › **⤓ Bounce track to a new track**.',
    'Reel renders everything that shapes the sound before the fader: each clip’s volume, fades, crossfades, pan, speed and its own effects, then the track’s effects and plug-ins. The result is a new WAV on a new **“· rendered”** track right under the original, cut into clips at exactly the same times and lengths. The plug-ins no longer need to run for it.',
    'The originals stay where they were, **muted and greyed out** with a **RENDERED ↓** tag; the new clips are tagged **BOUNCED**. The new track keeps the original’s fader, pan and automation, so the mix sounds the same.',
    'To go back: right-click either clip (or the track) › **↩ Back to the original sound**, or `⌘Z`. The rendered WAV stays in the project folder.'], 'how'],
  ['Retake: throw a take away while recording', 'retake discard redo again restart delete take recording start over mistake new take', [
    'On the recording panel, press **↺ RETAKE**, then press it again (it asks **SURE?** for 3 seconds, so one slip can’t lose a take). That take’s files are deleted and a fresh take starts after a 3-second count on the panel, with the same screen, camera and microphone. You don’t go back to the editor.',
    'The menu-bar icon has **Discard This Take and Start Again** too. To keep a take and redo just a line, clap three times instead (see Takes).'], 'how'],
  ['Speech from text and Kitten voices (clone your own voice)', 'speech text to speech tts voice voices kitten natural narrator read aloud clone cloning my voice own voice fix line word emotion laugh sigh emphasis language german spanish french', [
    '**🗣 VOICES** (the violet key in the panel on the right, or TEXT ▾ › 🗣 Speech from text, or Insert › Kitten Voices…). To clone your voice: press **🎙 CLONE MY VOICE** beside it and read the passage into your microphone (or select a clip of you talking first, to use that). Type the words, choose an engine, then **ADD AT PLAYHEAD**: the speech lands on a free sound track, marked as voice so music ducks under it.',
    '**Mac voices** are the ones built into macOS: instant, nothing to install. **Kitten voices (natural)** are KittenTTS 2, made on this Mac’s graphics chip: 115 voices (characters such as Victor, Maeve or Marcus, and voices that speak 20 languages). The first time, press **GET KITTEN VOICES** (one download of about 3 GB; it then works offline and nothing is uploaded).',
    'Choose an **Emotion** (joyful, sad, stern, excited…) and **Delivery** (Steady, or Expressive for livelier reads). The **Add** buttons put a beat where the cursor is: <laugh>, <sigh>, <pause>, <um>… Select a word and press **(((stress)))** to stress it.',
    '**Clone a voice** (your own, to fix a line without re-recording): select a clip of one person talking with no music, put the playhead where they start, then **＋ Clone a voice from the selected clip**. Reel uses 15 seconds from there and hears what’s said (on this Mac); name it and it’s first in the voice list. Only clone voices you have permission to use. **Remove** moves a saved voice’s recording to the Trash.'], 'how'],
  ['Green screen, background removal and picture in picture', 'green screen chroma key blue screen keying background remove cut out person pip picture in picture corner camera overlay inset', [
    '**EFFECTS ▾ › 🟩 Green screen** (or right-click a clip) keys out a green or blue screen: pick its colour (or **Pick** it from the screen) and adjust Tolerance and Softness. Put the new background on the track below.',
    '**EFFECTS ▾ › ✂ Remove background** cuts a person out without any green screen (made on this Mac). **▣ Picture in picture** puts the selected clip small in a corner with rounded corners and a shadow; choose it again to move it round the corners, or drag it in the preview.'], 'how'],
  ['Stabilize a shaky video', 'stabilize stabilise stabilization shaky shake wobble handheld steady smooth camera jitter tripod gimbal warp', [
    'Select a video clip › **EFFECTS ▾ › 🎥 Stabilize** (or right-click the clip). Reel follows the camera’s shake once (on small frames, on this Mac), keeps slow intended moves such as a pan, takes out the jitter, and zooms in a little so the moving edges stay hidden. The original file isn’t changed.',
    'In the clip’s **Stabilize** section: **Smoothness** (higher is steadier, like a tripod), **Strength**, **Zoom** (Automatic, or less to crop less), on/off, **Measure again** and **Remove**. It plays in the preview and exports the same.'], 'how'],
  ['Copy and paste effects', 'copy paste effects zooms actions filters sound effects plug-ins pointer reuse apply same', [
    'Right-click a clip › **Copy effects** copies its zoom and pan actions, picture filters, sound effects (built-in and your plug-ins) and pointer effects. Select other clips › right-click › **Paste effects**. Right-click one action on a clip › **Copy this action**, then **Paste action at playhead** on any clip. Pasted sound effects show **FX !** until you press RENDER EFFECTS.'], 'how'],
  ['Cinematic transitions and filters', 'cinematic film transitions fade lens defocus exposure burn flare letterbox grain halation chromatic aberration split dreamy dip punch zoom movie look', [
    'Transitions: **Cinematic fade**, **Dip to film**, **Dreamy glow**, **Letterbox close**, and on cuts **Lens defocus**, **Exposure burn**, **Lens flare sweep**, **Punch zoom** and **Chromatic split**, beside the light leaks and film burns. Auto Edit’s packs include **Filmic** and **Social (fast)**.',
    'Filters (clip settings › Filters › Add): **Film grain**, **Letterbox bars** (2.39, 2, 1.85, 2.76 : 1), **Halation glow** and **Chromatic aberration**.'], 'how'],
  ['Device frames, motion backgrounds and audio visualizers', 'device frame browser window mac window phone laptop mockup motion background animated background gradient bokeh grid waves audio visualizer bars wave ring spectrum', [
    '**Frame** (clip settings › Position) puts a picture inside a **Browser window** (with an address), a **Mac window** (with a title), a **Phone** or a **Laptop**, dark or light.',
    '**★ Presets › Backgrounds**: Gradient flow, Bokeh lights, Tech grid, Soft waves: animated, on their own track under everything; scale your video down (or use Picture in picture) to see them. **Audio visualizers** (bars, wave, ring) follow the sound under the playhead when you add them.'], 'how'],
  ['Pointer spotlight and magnifier', 'pointer cursor spotlight dim magnifier magnify lens zoom follow mouse highlight', [
    'Select a screen recording › **Pointer effects**: besides the highlight and click rings, **Spotlight** dims everything except a circle round the pointer, and **Magnifier** shows a round lens that follows the pointer, larger (choose its size and zoom).'], 'how'],
  ['Rendering a plug-in onto a clip (like AudioSuite)', 'render rendered rendering effects clip apply permanent audiosuite progress meter badge a/b compare processed cedar', [
    'Select a sound clip; in its **Effects** section add a built-in tool or **+ PLUG-IN**, set it, then press **RENDER EFFECTS**. A meter shows the percentage, and the clip on the timeline says **RENDERING 42%**.',
    'When it’s done the clip plays a **new processed file**: it gets a green **FX ✓** badge and its waveform is redrawn from the processed sound. **A: ORIGINAL / B: EFFECTS** switches between the two to compare. An amber **FX !** means the effects aren’t rendered yet; **FX ○** means they’re bypassed.',
    'If the plug-in’s window is still open, Reel uses the settings in that window.'], 'how'],
  ['Plug-ins on the master bus', 'master bus plug-in plugin mastering limiter loudness whole mix export ozone tg mastering', [
    'Your own plug-ins on the **whole mix**: in **EXPORT**, the Master row has **+ PLUG-IN**. Also **MASTER…** there, **★ MASTER PLUG-INS** in the MIXER, and **File › Master Bus & Plug-ins…**. They are applied when you export.',
    'Reel loads **Audio Unit** plug-ins. Most VST3 plug-ins install an Audio Unit version too, and that one shows up. Plug-ins that are only VST3 are listed under the plug-in list but can’t load yet. Pro Tools AudioSuite / AAX plug-ins only run in apps Avid licenses.'], 'how'],
  ['Voice over and ADR', 'voice over voiceover narration record mic punch adr dialogue align guide vocalign lip sync mute', [
    '**AUDIO ▾ › Voice over** (`⇧⌘R`) records your mic while the edit plays, from the playhead. **PUNCH IN** re-records just between In (`I`) and Out (`O`).',
    '**ADR:** tick “ADR: align each take to the original dialogue” and pick the **Guide** track that holds the original line, or leave it automatic. To align two clips you already have, select both and use AUDIO ▾ › ADR (`⌥⌘A`).'], 'how'],
  ['Captions and editing by text', 'captions subtitles srt vtt transcript text edit words ums delete all', [
    '**TEXT ▾ › Auto captions** listens to the speech and writes timed captions. Import or export SRT / WebVTT from the File menu. **🗑 DELETE ALL CAPTIONS** is in the Captions section on the right (also File › Delete All Captions…; ⌘Z brings them back).',
    '**TEXT ▾ › Edit by text** shows a transcript: delete words to cut them, and remove ums and long pauses.'], 'how'],
  ['Titles, description and chapters (Qwen writer)', 'qwen ai writer title titles description chapters chapter names youtube seo write language model llm local', [
    '**TEXT ▾ › ✍ Title, description & chapters** (also in Export, beside the chapters): Qwen, a small language model on this Mac, writes 5 title ideas, a description and a name for each chapter from what’s said in your video. Nothing is uploaded. Copy them, name the project with a title, or put the chapters on the timeline as markers.',
    'Three sizes: **1.5B** (any Mac), **3B** (16 GB of memory or more) and **7B** (32 GB or more); press **GET** to download one. A size your Mac can’t run is greyed out with the reason. With a model, **Auto Edit** names its chapters the same way. It runs in Protoart Studio’s Python, so Protoart Studio needs to be installed.'], 'how'],
  ['Keyboard shortcuts', 'keyboard shortcut shortcuts keys hotkey custom change assign', [
    '**Settings › Keyboard Shortcuts** lists every command. Click one and press the keys you want; Reel warns if they’re taken. Clear or reset any of them.',
    'Common ones: `Space` play, `J` `K` `L` shuttle, `←` `→` one frame, `I` / `O` In and Out, `[` `]` trim to the playhead, `⌘Z` undo, `⌘S` save, `⌘E` export.'], 'how'],
  ['Thumbnails and pictures', 'thumbnail image ernie flux ai picture title youtube', [
    '**THUMBNAIL** (`⌘T`) opens the Thumbnail Studio: start from any frame, paint new art with ERNIE and add a big title. **AI IMAGE** makes a picture for the edit. They run on this Mac through ProtoArt Studio; nothing is uploaded.'], 'how'],
  ['Export presets (HandBrake-style) and file size limits', 'preset presets handbrake general web devices hardware production social email discord apple android chromecast roku xbox playstation fire videotoolbox fast hq super file size limit 25 mb 25mb 10mb 8mb fit import json quality', [
    'The **Preset** menu in Export has Reel’s own presets and HandBrake’s collection: **General** (Very Fast, Fast, HQ, Super HQ at 4K, 1080p, 720p, 576p, 480p), **Web** (Creator, YouTube HQ, Social 25 MB, Discord, Email 25 MiB), **Devices** (Apple, Android, Chromecast, Amazon Fire, PlayStation, Roku, Xbox), **Hardware** (VideoToolbox) and **Production**.',
    '**Quality** picks a level (Very fast to Production) or a fixed bitrate. **File size limit** makes the whole export fit (Social 25 MB, Email 25 MiB, Discord 10 MB…): Reel works out the bitrate, and warns if that’s too little for the size. A preset’s frame rate is a peak, never more than your project’s.',
    '**Import HandBrake…** brings in your own HandBrake presets: in HandBrake’s Presets window choose a preset (or a folder) › **Export…**, then pick that .json file. **Save as preset…** keeps your current settings. Reel makes MP4 (H.264 or HEVC) with stereo AAC, so AV1, MKV or surround presets are made as the nearest of those, and Reel says so.'], 'how'],
  ['Exporting', 'export render save video mp4 hevc h264 audio sound only aac m4a wav wave chapters loudness gif', [
    '**EXPORT** (`⌘E`, the big green key) renders exactly what the preview shows: **H.264** plays everywhere, **HEVC** is smaller, **Sound only · AAC (.m4a)**, **Sound only · WAV** (uncompressed 24-bit, 48 kHz, for mastering or editing elsewhere), Animated GIF or PNG.',
    'The progress line shows frames for video, and “Sound 1:23 of 10:11” for sound only; **Cancel** stops it. Markers become YouTube chapter text. Plug-ins on tracks and on the master are applied at the end.'], 'how'],
  ['Colour schemes, light and dark', 'colour color colours colors change make mode scheme schemes theme themes skin skins look appearance light dark night powder amber cream slate ember dandelion blue orange red', [
    '**Settings › Appearance** has the faceplate, **Dark**, **Light** or **Match macOS** (switch quickly with `⇧⌘L`), and the **Colour scheme**: the same five as ProtoArt Dandelion.',
    '**Amber** (Reel’s original: charcoal and amber), **Powder** (blue powder coat on Light, burnt orange on Dark, white printing, yellow lamps), **Cream** (warm cream, yellow lamps, deep red), **Slate** (blue-grey steel, ivory lamps) and **Ember** (black and red-orange). Keys and lamps light up in the scheme’s colour; knobs, meters, the tape reels and the LED displays keep their own.'], 'how'],
  ['Saving, settings and where things are', 'save saved autosave settings preferences storage folder where projects movies proxy remember', [
    '**SAVE** (`⌘S`) saves now; the SAVED lamp lights when everything is saved. Reel also saves automatically (Settings › General).',
    'Projects live in Movies › ProtoArt Reel (change it in Settings › Media & Storage), one .reel folder per project with its media inside. **⚙ ▾ › Proxy** plays smaller copies of big videos so editing stays smooth; export always uses the originals.'], 'how'],
  ['Delete several projects at once', 'delete remove trash several many multiple projects select drag box marquee lasso home clean up', [
    'On the home screen, **drag a box across the projects** (start on a project or the empty space beside them): every project it touches is picked. Hold **⇧** or **⌘** while dragging to add to what’s picked; **⌘-click** picks one, **⇧-click** picks a run, **⌘A** picks them all.',
    'Then press **⌫** (or **MOVE TO TRASH…**, or right-click a picked project). Reel asks first, and the projects go to the Trash with their recordings, so you can put them back until you empty it. **Esc** or a click on empty space clears the picks.'], 'how'],

  ['Show notes on screen with a clap (ingredients, steps, tips)', 'clap claps note notes on screen instructions ingredients recipe cooking steps list callout card tip text', [
    'Clap three times, then say what should appear on screen: “Ingredients: two eggs, a cup of flour and a pinch of salt.” **AUTO EDIT › Claps › Show as notes** turns each clap into a **note card** (a title and a list, one item at a time) with what you said, and cuts the claps out. Words like Ingredients, You’ll need, Step 2, Tip or Oven become the card’s title.',
    '**Notes: Keep what I say** leaves your voice in; **Cut what I say (text only)** removes it, so the note only shows as text. Without Auto Edit: AUDIO ▾ › Find clap markers… › **📝 Make on-screen notes**. Click a card to edit its title and list (one item per line) in the inspector; drag it anywhere.'], 'how'],
  ['Picture in picture', 'pip picture in picture corner small overlay webcam inset facecam', [
    'Select a video or picture and press **▣ PiP** on the tool strip (press again for the next corner), or use the **PICTURE IN PICTURE** corners at the top of the inspector (**FULL** puts it back). It gets rounded corners and a shadow.',
    'If a full-frame video on a track above would hide it, Reel moves it to a track of its own on top. Right-click the preview for it too.'], 'how'],
  ['Text reveal transition (video through text)', 'text reveal transition through words letters zoom fill screen title cut', [
    'Click a cut’s **⧓** and choose **Text reveal**: the next clip shows through big bold words over the one before, then the words zoom into a letter until the new clip fills the screen.',
    'Type the words in the inspector › Transitions › **Reveal text** (one or two short words work best). It uses the clip before as a crossfade, so both keep playing during it.'], 'how'],
  ['Thumbnail from a frame of the video', 'thumbnail frame still youtube cover pick best frame screenshot pop', [
    'Right-click the preview › **Use this frame for the thumbnail…**, or THUMBNAIL › Background › Video frame. Reel shows the best-looking frames to click (★ is the sharpest and most colourful), and ◀ ▶ steps a frame or a second at a time.',
    '**Pop** adds contrast and colour, the way thumbnails usually look. No ERNIE art is needed; add a title, a badge and save as JPG for YouTube.'], 'how'],
  ['Match colour and colour wheels', 'colour color match grade grading wheels lift gamma gain shadows midtones highlights look like same reference correction', [
    '**EFFECTS ▾ › 🎨 Match colour…**: pick the shot the others should look like; Reel measures the colours of each clip and shifts them to the same warmth, brightness and contrast. Match the selected clips or every clip; Filters › Match colour has the Amount and Match again.',
    '**◐ Colour wheels** (EFFECTS ▾, or Filters › Add): Shadows, Midtones and Highlights. Drag a dot toward a colour, use the slider under a wheel for darker or brighter, double-click to reset. They run on the graphics chip in the preview and the export.'], 'how'],
  ['Move, resize and rotate on the preview', 'handles transform rotate rotation resize scale move centre center davinci box drag corner', [
    'Select a clip and drag it on the preview. The **corner and edge handles** resize it (from the centre), the handle on the stem above it **rotates** it (hold ⇧ for 15° steps; straight and square are sticky), and the dot in the middle moves it.',
    'Double-click the rotation handle to straighten it, or the centre dot to centre it in the frame. Hold ⌥ Option and drag a handle to crop. Right-click for Fit, Fill and resets.'], 'how'],

  ['Make music fit the video (extend or shorten a song)', 'music extend lengthen shorten fit song length loop remix seamless ending background track end of video', [
    'Select the music clip, then the **MUSIC** tab in the panel on the right › **🎵 FIT TO THE VIDEO** (one click), or **Other length…**; the same is in **AUDIO ▾ › 🎵 Fit music to a length…** and on the right-click menu. Choose **the end of the video**, the In–Out, or a length you type. Reel finds the beat and the places where the song repeats itself, then plays a section again (or skips one) right there, with short crossfades, so the joins can’t be heard. The intro and the real ending stay.',
    '**🎵 REMIX** (the switch next to SNAP) turns this on and off for dragging: on, the right end of any music or sound clip is a ♪, so dragging it re-fits the song; off, the end trims the clip as normal (turn it off when you just want to crop).',
    '**Or just drag the ♪ on the end of the music** to where it should stop (it snaps to the end of the video): when you let go, the song is re-fitted to that length the same way, longer or shorter, as often as you like. The result is ordinary clips, grouped: move or trim any join if you want it elsewhere, and ⌘Z undoes it. If a fit is a fraction of a second off, Reel speeds the music up or slows it down by at most 3%, with the pitch kept.'], 'how'],
  ['Elastic Wave: stretch part of a sound without changing its pitch', 'elastic wave stretch warp marker audio timing pitch fairlight davinci retime sync word beat', [
    'Right-click an audio clip › **〰 Elastic Wave**. Then **press on the waveform and drag**: the moment you grabbed (a word, a beat) moves, and the sound before and after it stretches or squeezes to meet it, with the pitch kept. Each grab leaves a marker you can drag again; double-click to add one without moving anything. The clip’s start and end stay put; drag its name strip to move the whole clip.',
    'Each part shows its speed (73%, 133%…). Double-click a marker to remove it; right-click › Remove Elastic Wave / retime for an even speed again.'], 'how'],
  ['Retime curve: speed ramps and precise timing', 'retime curve speed ramp ease slow motion timing keyframe time remap curve', [
    'Select a clip and open **Retime curve** in the inspector (or right-click › ⤳ Retime curve…). Clip time runs across and source time up: steeper plays faster, flatter slower; the dashed line is normal speed. Drag a point, or press anywhere on the line and drag it into a new point; double-click a point to remove it.',
    'Presets: **Ease in**, **Ease out**, **Speed ramp** (fast through the middle), **Slow-mo middle**, **Straight**. The clip keeps its length; picture and sound follow the curve, and the sound keeps its pitch (turn Keep pitch off in Speed for a tape effect).'], 'how'],

  // ------------------------------------------------------------------ troubleshooting
  ['A menu does nothing when I click it', 'menu menus unresponsive nothing happens dead broken click settings file edit not working stuck', [
    'Fixed in 1.5.5: after a recording, the floating recording panel left Reel’s menu bar (starting with the **ProtoArt Reel** menu) unresponsive until you clicked another app and back. Reel also used to rebuild the menu bar after each edit, which could swallow a click.',
    'If a menu still won’t open: click another app (or the desktop), then click Reel’s window again. If Reel isn’t answering at all, it may be busy with a big task (an export or a render): wait for its progress bar to finish.'], 'fix'],
  ['Export seems frozen or stuck on “Starting…”', 'export frozen freeze freezes stuck hang hangs starting slow not exporting by itself alone sound only audio wav aac progress', [
    'Sound-only exports now show progress (“Sound 1:23 of 10:11…”). If the line says it is **waiting for a plug-in render**, a track plug-in is still rendering; it continues on its own.',
    'If an AAC export stops with “The AAC sound encoder stopped responding”, choose **Sound only · WAV** instead. **Cancel** always stops an export.',
    'Very long edits with plug-ins on tracks take longer the first time; each recording is rendered once per plug-in setting and reused after that.'], 'fix'],
  ['Export failed: “Video decoding failed”', 'video decoding failed decoding error export failed decoder', [
    'Fixed in 1.5.3: clips now release their video decoder as soon as they’re off screen. If it still happens, close other apps that play or edit video, turn on **⚙ ▾ › Proxy** while editing, and export again.'], 'fix'],
  ['I rendered a plug-in but it sounds the same', 'no difference same nothing happened render plug-in plugin cedar effect not working not applied audiosuite', [
    'Look at the clip: a green **FX ✓** means it now plays the processed file; amber **FX !** means it isn’t rendered yet (press **RENDER EFFECTS**); grey **FX ○** means it’s bypassed: press **A: ORIGINAL** to switch back to **B: EFFECTS**.',
    'Before 1.5.5 a plug-in’s settings were only saved when its window closed, so rendering with the window open used its default settings. Now the open window’s settings are used. Use **A / B** to compare, and check the plug-in itself is set to do something (some start at zero).',
    'Some plug-ins need their licence app running (iLok License Manager, Waves Central).'], 'fix'],
  ['“The plug-in host stopped (a plug-in may have crashed)”', 'plug-in host stopped crashed crash fx:edit error invoking remote method render into track mono stereo waves', [
    'Fixed in 1.5.7: a plug-in that only takes stereo (like the stereo half of a Waves shell) crashed Reel’s plug-in helper when given a mono microphone recording, again for every clip. Reel now checks first and feeds such plug-ins the recording as stereo; if a plug-in can’t take the sound at all, it says which one, and it stops instead of retrying every clip.'], 'fix'],
  ['My plug-in isn’t in the list', 'plug-in plugin missing not listed vst vst3 only aax audiosuite au audio unit find load install', [
    'Reel lists **Audio Unit** plug-ins. If yours is only installed as VST3, it’s named at the bottom of the plug-in list; install the maker’s Audio Unit version (most offer one) and it appears. AudioSuite / AAX (Pro Tools only) can’t be loaded.'], 'fix'],
  ['My recording stopped or was lost during a pause', 'recording lost stopped pause paused long cancelled locked sleep', [
    'Since 1.5.4 a recording that has started is never thrown away: if macOS stops the screen capture while you’re paused (the Mac locked), everything recorded is kept and saved when you resume or stop.'], 'fix'],
  ['Clicks or pops at cuts, or mouth clicks', 'click clicks pop pops cut cuts noise mouth', [
    'At cuts: turn on **Settings › Timeline › Smooth every cut** (adds short crossfades). Mouth clicks: put **De-click** on the voice track, or use the **Tutorial voice** preset.'], 'fix'],
  ['Music too loud or too quiet after AUTO MIX', 'music too loud quiet sound effects balance auto mix level', [
    'Open **⚖ AUTO MIX** again and move **Music** (or **Sound FX**) down, as far as −30 dB, or use the quick buttons, then **▶ HEAR AUTO MIX**. Check every music track is tagged **orange MUSIC**.'], 'fix'],
  ['Titles or call-outs don’t show', 'callout call-out title text not showing invisible hidden missing behind video', [
    'Since 1.5.4 they always draw above the video, whatever track they are on. If one is still missing, check its track isn’t hidden (the H button) and that the playhead is over the clip.'], 'fix'],
  ['A transition keeps coming back', 'transition comes back dissolve none every cut reappears', [
    'In Transitions, choose **APPLY TO: EVERY CUT** and then **NONE (Cut)** to take every transition off; **THIS CUT** changes only the selected cut.'], 'fix'],
  ['Clips or parts don’t line up', 'snap snapping gap align misaligned not lining up parts overlap', [
    'Turn on **SNAP**. Drag a clip into its neighbour and it lands flush. Parts snap to each other end to end. **GAPS ▾ › CLOSE GAPS** removes empty space between them.'], 'fix'],
  ['Buttons overlap when the window is small', 'small window narrow shrink overlap overlapping timecode transport keys zoom hidden cut off resize', [
    'Fixed in 1.5.6: in a narrow window the deck gives way step by step (meters, tape counter, tape speed, reels, then the frame keys; `←` `→` still step a frame) instead of the time sliding over the transport keys, and the zoom bar stays visible under the tools.'], 'fix'],
  ['I can’t find my new recording', 'recording find missing where new media list', [
    'New recordings are at the **top of the Media list** with a NEW tag. Use the Media search box or the VIDEO / AUDIO filters.'], 'fix'],
  ['No sound when a clip is sped up a lot', 'speed fast no sound silent muted 16x 32x 64x 100x', [
    'Above 16× the preview plays without sound, to keep up. The export uses the exact speed.'], 'fix'],
  ['Speech and waveform are out of sync', 'waveform sync latency delay out of sync early late audio buffer interface hear', [
    'Reel plays sound early by your sound card’s delay so the sound, playhead and waveform line up. If speech still looks early or late, set **Settings › Playback & Recording › Sound sync** by hand.'], 'fix'],
];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** **bold** and `key` → elements, with matches of `words` lit. */
function rich(text, words) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0, m;
  const lit = s => {
    if (!words.length) return [s];
    const parts = s.split(new RegExp(`(${words.map(esc).join('|')})`, 'gi'));
    return parts.map((p, i) => (i % 2 ? el('mark', { text: p }) : p));
  };
  while ((m = re.exec(text))) {
    out.push(...lit(text.slice(last, m.index)));
    out.push(m[1] ? el('b', {}, ...lit(m[1])) : el('kbd', { text: m[2] }));
    last = re.lastIndex;
  }
  out.push(...lit(text.slice(last)));
  return out;
}

// words that mean the same thing when you're describing a problem
const SAME = [
  ['freeze', 'frozen', 'freezes', 'freezing', 'stuck', 'hang', 'hangs', 'hung', 'stall', 'stalls', 'stalled', 'slow', 'forever', 'waiting'],
  ['unresponsive', 'dead', 'nothing', 'broken', 'working', 'respond', 'responding', 'answer', 'ignored'],
  ['missing', 'gone', 'lost', 'disappeared', 'vanished', 'invisible', 'hidden', 'showing', 'show', 'find'],
  ['plugin', 'plug-in', 'plugins', 'plug-ins', 'vst', 'vst3', 'au', 'audiosuite', 'aax', 'effect', 'effects', 'fx'],
  ['sound', 'audio', 'voice', 'dialogue', 'dialog', 'speech'],
  ['loud', 'louder', 'quiet', 'quieter', 'volume', 'level', 'levels', 'db', 'balance', 'gain'],
  ['click', 'clicks', 'declick', 'de-click', 'pop', 'pops', 'crackle', 'smack'],
  ['export', 'exporting', 'mp4', 'm4a', 'aac'],
  ['callout', 'callouts', 'call-out', 'call-outs', 'title', 'titles', 'text'],
  ['preset', 'presets', 'chain', 'configuration', 'config', 'setup', 'template'],
  ['automix', 'auto-mix', 'mix'],
  ['crossfade', 'fade', 'fades', 'crossfades', 'smooth', 'transition'],
  ['clap', 'claps', 'clapping', 'take', 'takes'],
];
const STOP = new Set(['how', 'do', 'i', 'the', 'a', 'an', 'to', 'can', 'is', 'my', 'in', 'of', 'what', 'where', 'and', 'or', 'it', 'on', 'for', 'with', 'why', 'does', 'when', 'this', 'that', 'there', 'be', 'are', 'was', 'not', 'no', "doesn't", 'dont', "don't", 'cant', "can't", 'won’t', "won't", 'get', 'got', 'keeps', 'keep', 'im', "i'm", 'me', 'you', 'reel', 'app']);
/** "freezes" → "freez": enough to match freeze / frozen / freezing in the text. */
const stem = w => (w.length > 4 ? w.replace(/(ing|ies|ied|es|ed|s)$/, '').replace(/e$/, '') : w);
const alts = w => { const g = SAME.find(list => list.includes(w)); return [...new Set([w, stem(w), ...(g || []).map(stem)])].filter(x => x.length > 1); };

/**
 * Topics that answer a question or describe a problem. Each word (and its everyday synonyms) that appears in a
 * topic scores; a word in the title or the topic's own keywords counts more. Most of the words (60%) must match,
 * so "export stuck on starting" and "menu does nothing" both find their answer.
 */
export function searchTopics(q, group = null) {
  const pool = group ? TOPICS.filter(t => (t[3] || 'how') === group) : TOPICS;
  const words = q.toLowerCase().replace(/[’']/g, "'").split(/[^a-z0-9⌘⇧⌥⌫'.-]+/).map(w => w.replace(/^[.'-]+|[.'-]+$/g, '')).filter(w => w && !STOP.has(w));
  if (!words.length) return { words: [], hits: pool };
  const scored = pool.map(t => {
    const title = t[0].toLowerCase(), keys = t[1].toLowerCase(), hay = (title + ' ' + keys + ' ' + t[2].join(' ')).toLowerCase();
    let score = 0, matched = 0;
    for (const w of words) {
      const forms = alts(w);
      const inTitle = forms.some(f => title.includes(f)), inKeys = forms.some(f => keys.includes(f)), inText = inTitle || inKeys || forms.some(f => hay.includes(f));
      if (!inText) continue;
      matched++;
      const whole = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      score += 1 + (inKeys ? 2 : 0) + (inTitle ? 3 : 0) + (hay.includes(w) ? 1 : 0) + (whole.test(title + ' ' + keys) ? 3 : 0);
    }
    if (matched < Math.max(1, Math.ceil(words.length * 0.6))) return null;
    // "how do I…" leans to how-to
    if ((t[3] || 'how') === 'how' && /^\s*how\b/i.test(q)) score += 3;
    // a problem-sounding question leans to troubleshooting
    if ((t[3] || 'how') === 'fix' && /\b(not|doesn|won|can'?t|nothing|stuck|frozen|freez|fail|error|wrong|broken|missing|lost|same)/.test(q.toLowerCase())) score += 2;
    return [score + matched * 2, t];
  }).filter(Boolean).sort((a, b) => b[0] - a[0]);
  const lit = [...new Set(words.flatMap(w => [w, stem(w)]))].filter(w => w.length > 2);
  return { words: lit, hits: scored.map(([, t]) => t) };
}

/** HELP: How-to and Troubleshooting, searchable. Opens straight to a search when given one. */
export function showAbout(query = '', group = null) {
  const search = el('input', { type: 'search', class: 'help-search', value: query, placeholder: 'Search help or describe a problem: “export stuck”, “menu does nothing”, “de-click”, “save a preset”…' });
  const body = el('div', { class: 'help-body' });
  let tab = group; // null = all
  const tabs = el('div', { class: 'seg help-tabs' }, ...[[null, 'ALL'], ['how', 'HOW TO'], ['fix', 'TROUBLESHOOTING']].map(([g, t]) => {
    const b = el('button', { type: 'button', text: t, onclick: () => { tab = g; draw(); } }); b._g = g; return b;
  }));
  const draw = () => {
    for (const b of tabs.children) b.classList.toggle('on', b._g === tab);
    const { words, hits } = searchTopics(search.value, tab);
    if (!hits.length) {
      body.replaceChildren(el('p', { class: 'note', text: 'Nothing found. Try fewer or other words (“export”, “plug-in”, “clicks”), look under TROUBLESHOOTING, or turn on EXPLAIN and rest the pointer on a control.' }));
      return;
    }
    const q = search.value.trim();
    body.replaceChildren(...[
      q ? el('p', { class: 'note help-count', text: `${hits.length} topic${hits.length === 1 ? '' : 's'} for “${q}”` }) : null,
      ...hits.flatMap(([title, , paras, g]) => [
        el('h3', {}, g === 'fix' ? el('span', { class: 'help-tag fix', text: 'FIX' }) : null, ...rich(title, words)),
        ...paras.map(p => el('p', {}, ...rich(p, words)))])].filter(Boolean));
    body.scrollTop = 0;
  };
  search.addEventListener('input', draw);
  draw();
  modal('How ProtoArt Reel works', el('div', { class: 'about help' },
    el('p', { class: 'note', text: 'Model PR-1 · a screen recorder and editor in the spirit of ScreenFlow, with ERNIE thumbnails. Everything stays on your Mac.' }),
    search, tabs, body), [], { wide: true });
  setTimeout(() => { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }, 50);
}
