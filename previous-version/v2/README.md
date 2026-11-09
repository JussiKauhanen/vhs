# VHS

A browser-based screen recorder and GIF editor. The app and GIF encoder run locally in your browser.

## Try it on a Mac

Double-click **Start VHS.command**. It uses Python 3 to open the app in your default browser. Keep the Terminal window open while recording. For the first run, try a desktop version of Chrome or Edge. Alternatively, open a terminal in this folder and run `python3 -m http.server 8000 --bind 127.0.0.1`, then visit `http://localhost:8000`.

1. Click **Choose screen or window** and select what to share in the browser picker. If macOS prompts for screen recording access, allow it for your browser.
2. Position the rectangle inside the preview. Drag a corner to resize, or focus the frame and use the arrow keys to move it. Shift and the arrow keys resize it.
3. Click **Record**, switch to the shared window, and perform the action. In Chrome and Edge a small floating window with **Pause** and **Stop** stays on top of your other windows while you record. Keep it outside the recorded frame. You can also stop in VHS or through the browser's sharing bar.
4. Edit on the timeline. The bottom track is the clip. Drag its orange edges, or put the playhead somewhere and use **Cut start** / **Cut end** (`[` and `]`), to cut away the beginning or end. **Restore full clip** or Undo brings it back. **Speed** and **Hold end** change pacing.
5. Select **Arrow** or **Box** and drag on the preview to draw. For **Note**, type the text and click to place it. Each mark gets its own track with a coloured block. It starts at the playhead and runs to the end. Drag the block to move it in time, or drag its edges to change when it appears and disappears. Click a track name to select a mark, and click × to delete it. With no tool active, click a mark on the preview to select it and drag to move it. The Ink colour applies to the selected mark.
6. Click **Export GIF** (top right) to download the result. To edit a screenshot or existing GIF, use **Import image** or drop the file into VHS. Still images also have a **Save PNG** option, and you can drag the image track's right edge to make it show for longer.

Shortcuts in the editor: Space play/pause, ← → step 0.1 s (Shift for 1 s), `[` `]` cut at the playhead, Delete removes the selected mark, Esc deselects, ⌘Z / Ctrl+Z undo.

The first version records silent clips of up to 30 seconds. GIFs export at up to 10 frames per second, with a maximum long edge of 960 pixels. The full shared source is held temporarily in browser memory during recording. Preview and export use the selected crop. Keep the tab open until you download your work. Animated GIF import requires browser support for ImageDecoder.

## Host on GitHub Pages

Place `index.html`, `style.css`, `app.js`, and the entire `vendor` folder at the root of the publishing branch. In the repository's **Settings → Pages**, choose **Deploy from a branch** and select that branch and its root folder. Open the HTTPS site to use screen sharing.

The bundled gifenc 1.0.3 encoder is distributed under the MIT license in `vendor/gifenc-LICENSE.md`.
