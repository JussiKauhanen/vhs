# VHS

A browser-based screen recorder and GIF editor. The app and GIF encoder run locally in your browser.

## Try it on a Mac

Double-click **Start VHS.command**. It uses Python 3 to open the app in your default browser, normally at `http://127.0.0.1:8765`. Keep the Terminal window open while recording. For the first run, try a desktop version of Chrome or Edge. Opening `index.html` directly also works, but without pointer effects.

1. Click **Choose screen or window** and select what to share in the browser picker. If macOS prompts for screen recording access, allow it for your browser.
2. Position the rectangle inside the preview. Drag a corner to resize, or focus the frame and use the arrow keys to move it. Shift and the arrow keys resize it.
3. Click **Record**, switch to the shared window, and perform the action. In Chrome and Edge a small floating window with **Pause** and **Stop** stays on top of your other windows while you record. Keep it outside the recorded frame. You can also stop in VHS or through the browser's sharing bar.
4. Edit on the timeline. The bottom track is the clip, with thumbnails of the footage. Drag its orange edges, or put the playhead somewhere and use **Cut start** / **Cut end** (`[` and `]`), to cut away the beginning or end. **Restore full clip** or Undo brings it back. **Speed** and **Hold end** change pacing. Playback loops until you turn **Loop** off.
5. Select **Arrow** or **Box** and drag on the preview to draw. For **Note**, type the text and click to place it. Each mark gets its own track with a coloured block. It starts at the playhead and runs to the end. Drag the block to move it in time, or drag its edges to change when it appears and disappears. Click a track name to select a mark, and click × to delete it. With no tool active, click a mark on the preview to select it and drag to move it. The Ink colour applies to the selected mark.
6. Click **Export GIF…** (top right). Choose the size, frame rate and number of colours. VHS shows an estimated file size before you export. To edit a screenshot or existing GIF, use **Import image** or drop the file into VHS. Still images also have a **Save PNG** option, and you can drag the image track's right edge to make it show for longer.

Shortcuts in the editor: Space play/pause, L loop on/off, ← → step 0.1 s (Shift for 1 s), `[` `]` cut at the playhead, Delete removes the selected mark, Esc deselects, ⌘Z / Ctrl+Z undo. The theme button in the header switches between Auto, Light and Dark.

### Pointer effects and follow-zoom

A web page cannot see the mouse outside its own tab, so **Start VHS.command** reads the Mac's pointer position and passes it to VHS while you record. It uses macOS's built-in CoreGraphics, so there is nothing to install. The Terminal window says `Pointer tracking: on` when it works.

Record an **entire screen** (not a single window) to use these. In the editor, the **Pointer** section offers:

- **Style:** Highlight (yellow halo), Big pointer, Dot, or Spotlight (dims everything but the area around the pointer). Your real cursor is still in the recording; these are drawn on top of it.
- **Show clicks:** a ring pulses wherever you click.
- **Follow:** zooms in 1.5×, 2× or 3× and pans smoothly to keep the pointer in view. The editor shows the size of the area being followed. Zooming in a lot on a non-Retina screen looks softer.

With several displays, VHS picks the screen whose shape matches the recording, preferring the main display.

The recorder captures silent clips of up to 30 seconds. GIFs export at 5–20 frames per second, up to 1280 pixels on the long edge. The full shared source is held temporarily in browser memory during recording. Preview and export use the selected crop. Keep the tab open until you download your work. Animated GIF import requires browser support for ImageDecoder.

## Host on GitHub Pages

Place `index.html`, `style.css`, `app.js`, and the entire `vendor` folder at the root of the publishing branch. In the repository's **Settings → Pages**, choose **Deploy from a branch** and select that branch and its root folder. Open the HTTPS site to use screen sharing. Pointer effects need Start VHS.command, so they are not available on GitHub Pages.

The bundled gifenc 1.0.3 encoder is distributed under the MIT license in `vendor/gifenc-LICENSE.md`.
