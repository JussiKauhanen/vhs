# Clipnote

Record a short clip of your screen, drop friendly animated stickers on it, and share it as a GIF, MP4 or PNG — made for quick how-to snippets in GitHub READMEs. Everything runs in the web page; nothing is uploaded.

## Use it

Open `index.html` in Chrome or Edge, or host the folder on any static site such as GitHub Pages. (`Start Clipnote.command` is an optional Mac shortcut that serves the folder locally and opens it.)

1. Click **Start recording** and pick a window to share. Sharing a single window, not the entire screen, keeps the floating controls out of your video.
2. A small floating window with the controls stays on top of every window: **Record**, **Pause**, **Stop**, and the **camera** button for screenshots. Screenshots are collected and open as their own tabs when you finish. Press **Done** (or Stop) to finish.
3. In the editor, drag stickers from the left onto your clip, or click one to add it in the middle:
   Post-it, Arrow, Text bubble, Click, Double-click, Right-click, Keys (type something like `⌘ + Shift + P`) and Spotlight.
   Each sticker pops in with a short animation and gets its own line in the timeline. Drag the line to choose when it shows, or drag its ends to make it shorter or longer. Click a sticker to move it, resize it from the round handle, change its text or colour, or delete it.
4. Trim the clip: drag the yellow handles, or move the playhead and press **Start here** / **End here**. Cut parts stay visible, hatched, so you can always drag them back. **Crop** trims the edges of the picture.
5. Click **Export** and choose **GIF**, **MP4** or **PNG**. Each quality option shows a zoomed-in sample of the actual result and an estimated file size. Drag the file into a GitHub README, issue or pull request.

Shortcuts in the editor: Space play/pause · ← → step (Shift: 1 s) · `[` `]` trim at the playhead · Delete removes the selected sticker · Esc deselects · ⌘Z undo · ⇧⌘Z redo.

## Good to know

- Recordings are silent and stop after 60 seconds.
- The floating controls need Chrome or Edge. In other browsers the controls stay in the Clipnote tab.
- MP4 export uses the browser's built-in video encoder (Chrome, Edge, Safari). GIF and PNG work everywhere.
- Keep the tab open until you have saved your files; nothing is stored between visits except your theme and export choices.

## Host on GitHub Pages

Put `index.html`, `style.css`, `app.js` and the `vendor` folder at the root of the publishing branch, then choose **Settings → Pages → Deploy from a branch**.

## Credits

- [gifenc](https://github.com/mattdesl/gifenc) 1.0.3 by Matt DesLauriers, MIT license (`vendor/gifenc-LICENSE.md`).
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2 by Vanilagy, MIT license (`vendor/mp4-muxer-LICENSE.md`).
