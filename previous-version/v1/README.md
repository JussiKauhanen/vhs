# VHS

A browser-based screen recorder and GIF editor. The app and GIF encoder run locally in your browser.

## Try it on a Mac

Double-click **Start VHS.command**. It uses Python 3 to open the app in your default browser. Keep the Terminal window open while recording. For the first run, try a desktop version of Chrome or Edge. Alternatively, open a terminal in this folder and run `python3 -m http.server 8000 --bind 127.0.0.1`, then visit `http://localhost:8000`.

1. Click **Choose screen or window** and select what to share in the browser picker. If macOS prompts for screen recording access, allow it for your browser.
2. Position the rectangle inside the preview. Drag a corner to resize, or focus the frame and use the arrow keys to move it. Shift and the arrow keys resize it.
3. Click **Record**, switch to the shared window, and perform the action. Click **Stop recording** in VHS or stop sharing through the browser.
4. Trim with **Start** and **End**. Use **Speed** or **Hold last frame** to extend the clip. Select **Arrow** or **Box** and drag to draw. For **Note**, type the text and click to place it. Open **Annotation timing** before placing a mark to make it appear during part of the output.
5. Click **Export GIF** to download the result. To edit a screenshot or existing GIF, use **Import image** or drop the file into VHS. Still images also have a **Save PNG** option.

The first version records silent clips of up to 30 seconds. GIFs export at up to 10 frames per second, with a maximum long edge of 960 pixels. The full shared source is held temporarily in browser memory during recording. Preview and export use the selected crop. Keep the tab open until you download your work. Animated GIF import requires browser support for ImageDecoder.

## Host on GitHub Pages

Place `index.html`, `style.css`, `app.js`, and the entire `vendor` folder at the root of the publishing branch. In the repository's **Settings → Pages**, choose **Deploy from a branch** and select that branch and its root folder. Open the HTTPS site to use screen sharing.

The bundled gifenc 1.0.3 encoder is distributed under the MIT license in `vendor/gifenc-LICENSE.md`.
