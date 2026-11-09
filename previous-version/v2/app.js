"use strict";
const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timecode = (t) =>
  new Date(Math.round(Math.max(0, t) * 1000)).toISOString().slice(14, 21);
const seconds = (t) => (t < 10 ? t.toFixed(1) : String(Math.round(t))) + " s";
const statusText = (text) => {
  $("status").textContent = text;
};
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const live = $("live"),
  display = $("display"),
  context = display.getContext("2d", { willReadFrequently: true });
const MAX_RECORD = 30,
  MIN_RUN = 0.1;
const KINDS = { arrow: ["↗", "Arrow"], box: ["□", "Box"], note: ["T", "Note"] };

let stream,
  recorder,
  rec = null,
  clockTimer,
  mini = null,
  session = 0;
let region = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  cropDrag,
  asset,
  tool,
  draft,
  playing = false,
  exporting = false,
  busy = false;
// Annotation times (from/until) are stored in source seconds so marks stay
// attached to the footage when the clip is cut or its speed changes.
// null means "from the beginning" / "to the end of the GIF".
let annotations = [],
  selected = null,
  history = [],
  playhead = 0,
  playOrigin = 0,
  animation;
let edit = { start: 0, end: 1, speed: 1, hold: 0 },
  axisLen = 1,
  tlDrag = null,
  canvasDrag = null,
  inkBefore = null;

/* ---------- Capture ---------- */

function releaseStream() {
  const old = stream;
  stream = null;
  if (old) old.getTracks().forEach((track) => track.stop());
  live.srcObject = null;
  $("record").disabled = true;
  $("surface").hidden = true;
  $("pattern").hidden = false;
  $("signal").textContent = "●   STANDBY";
  $("format").textContent = "NO INPUT";
}
function fitDisplay() {
  if (display.hidden) return;
  const glass = $("glass");
  const scale = Math.min(
    glass.clientWidth / display.width,
    glass.clientHeight / display.height,
  );
  if (!(scale > 0)) return;
  display.style.width = display.width * scale + "px";
  display.style.height = display.height * scale + "px";
}
function fit() {
  fitDisplay();
  if (!live.videoWidth) return;
  const glass = $("glass");
  const scale = Math.min(
    glass.clientWidth / live.videoWidth,
    glass.clientHeight / live.videoHeight,
  );
  Object.assign($("surface").style, {
    width: live.videoWidth * scale + "px",
    height: live.videoHeight * scale + "px",
  });
  paintCrop();
}
new ResizeObserver(fit).observe($("glass"));
function paintCrop() {
  const { x, y, w, h } = region;
  Object.assign($("crop").style, {
    left: x * 100 + "%",
    top: y * 100 + "%",
    width: w * 100 + "%",
    height: h * 100 + "%",
  });
  $("format").textContent =
    Math.round(w * live.videoWidth) + " × " + Math.round(h * live.videoHeight);
}
function ratio() {
  const selectedAspect = $("aspect").value;
  return selectedAspect === "free" || selectedAspect === "full"
    ? null
    : (Number(selectedAspect) * live.videoHeight) / live.videoWidth;
}
function setAspect() {
  if (!stream) return;
  const r = ratio();
  const w = r ? Math.min(0.8, 0.8 * r) : 0.8,
    h = r ? w / r : 0.8;
  region =
    $("aspect").value === "full"
      ? { x: 0, y: 0, w: 1, h: 1 }
      : { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  paintCrop();
}
$("aspect").onchange = setAspect;
function cropChange(initial, dx, dy, corner) {
  if (corner < 0) {
    region = {
      ...initial,
      x: clamp(initial.x + dx, 0, 1 - initial.w),
      y: clamp(initial.y + dy, 0, 1 - initial.h),
    };
  } else {
    const left = corner % 2 === 0,
      top = corner < 2;
    const ax = left ? initial.x + initial.w : initial.x,
      ay = top ? initial.y + initial.h : initial.y;
    const maxW = left ? ax : 1 - ax,
      maxH = top ? ay : 1 - ay;
    let w = clamp(initial.w + (left ? -dx : dx), Math.min(0.04, maxW), maxW);
    let h = clamp(initial.h + (top ? -dy : dy), Math.min(0.04, maxH), maxH);
    const r = ratio();
    if (r) {
      w = Math.min(maxW, maxH * r, Math.abs(dx) > Math.abs(dy) ? w : h * r);
      h = w / r;
    }
    region = { x: left ? ax - w : ax, y: top ? ay - h : ay, w, h };
  }
  paintCrop();
}
$("crop").onpointerdown = (e) => {
  if (recorder || $("aspect").value === "full") return;
  cropDrag = {
    x: e.clientX,
    y: e.clientY,
    initial: { ...region },
    corner: [...$("crop").children].indexOf(e.target),
  };
  $("crop").setPointerCapture(e.pointerId);
};
$("crop").onpointermove = (e) => {
  if (!cropDrag) return;
  cropChange(
    cropDrag.initial,
    (e.clientX - cropDrag.x) / $("surface").clientWidth,
    (e.clientY - cropDrag.y) / $("surface").clientHeight,
    cropDrag.corner,
  );
};
$("crop").onlostpointercapture = () => {
  cropDrag = null;
};
$("crop").onkeydown = (e) => {
  if (recorder || $("aspect").value === "full" || !e.key.startsWith("Arrow"))
    return;
  e.preventDefault();
  cropChange(
    region,
    { ArrowLeft: -0.01, ArrowRight: 0.01 }[e.key] || 0,
    { ArrowUp: -0.01, ArrowDown: 0.01 }[e.key] || 0,
    e.shiftKey ? 3 : -1,
  );
};
function busyControls(value) {
  busy = value;
  $("import").disabled = $("share").disabled = value;
}
$("share").onclick = async () => {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    statusText(
      "Screen capture needs a supported desktop browser. Open VHS in Chrome or Edge on localhost or HTTPS, or import an image.",
    );
    return;
  }
  busyControls(true);
  try {
    const picked = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    releaseStream();
    stream = picked;
    picked.getVideoTracks()[0].onended = () => {
      if (picked !== stream) return;
      if (recorder) stopRecording();
      else {
        releaseStream();
        statusText("Screen sharing ended. Choose a source to reconnect.");
      }
    };
    live.srcObject = picked;
    await live.play();
    if (picked !== stream) return;
    $("pattern").hidden = true;
    $("surface").hidden = false;
    $("record").disabled = false;
    $("signal").textContent = "●   LIVE INPUT";
    fit();
    setAspect();
    statusText("Position the viewfinder, then press Record.");
  } catch (err) {
    statusText(
      err.name === "NotAllowedError"
        ? "Screen sharing was canceled or blocked. You can choose a source again."
        : "Could not open this source. " + err.message,
    );
  } finally {
    busyControls(false);
  }
};

/* ---------- Recording, pause and the floating mini controls ---------- */

$("miniHint").textContent = window.documentPictureInPicture
  ? "While recording, a small floating window with Pause and Stop stays on top. Keep it outside the frame."
  : "Tip: in Chrome or Edge, Pause and Stop also appear in a small floating window while you record.";

function recordedTime() {
  if (!rec) return 0;
  const now = rec.pausedAt ?? performance.now();
  return (now - rec.startedAt - rec.pausedMs) / 1000;
}
function setRecordUI() {
  const state = recorder ? recorder.state : "inactive",
    paused = state === "paused";
  $("record").innerHTML = recorder ? "■ Stop recording" : "<span>●</span> Record";
  $("pause").hidden = !recorder;
  $("pause").textContent = paused ? "● Resume" : "Ⅱ Pause";
  if (recorder)
    $("signal").textContent = paused ? "Ⅱ   PAUSED" : "●   RECORDING";
  if (mini) {
    mini.pause.textContent = paused ? "● Resume" : "Ⅱ Pause";
    mini.dot.classList.toggle("paused", paused);
    mini.label.textContent = paused ? "PAUSED" : "REC";
  }
}
function tickClock() {
  const t = recordedTime();
  $("clock").textContent = timecode(t);
  if (mini) mini.time.textContent = timecode(t);
  if (t >= MAX_RECORD) stopRecording();
}
function togglePause() {
  if (!recorder || !rec) return;
  if (recorder.state === "recording") {
    recorder.pause();
    rec.pausedAt = performance.now();
    statusText("Paused. Resume when you are ready, or stop to edit.");
  } else if (recorder.state === "paused") {
    rec.pausedMs += performance.now() - rec.pausedAt;
    rec.pausedAt = null;
    recorder.resume();
    statusText("Recording.");
  }
  setRecordUI();
}
function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  clearInterval(clockTimer);
  $("record").disabled = true;
  $("pause").disabled = true;
}
$("pause").onclick = togglePause;

const MINI_CSS = `
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: #22251f; color: #e9e8dc; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; }
  .mini { height: 100%; display: flex; align-items: center; gap: 8px; padding: 0 12px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #f56b47; flex: none; animation: blink 1s infinite; }
  .dot.paused { background: #8b8d83; animation: none; }
  .lab { font: 700 10px ui-monospace, monospace; letter-spacing: .1em; color: #cfd0c4; }
  .time { font: 15px ui-monospace, "SF Mono", Menlo, monospace; flex: 1; }
  button { font: 600 13px -apple-system, BlinkMacSystemFont, sans-serif; border-radius: 5px; padding: 7px 10px; cursor: pointer; border: 1px solid #55584f; background: #33372f; color: #f2f1e8; }
  button:hover { background: #3f443a; }
  .stop { background: #f56b47; border-color: #b95538; color: #1e201a; }
  .stop:hover { background: #ff805d; }
  @keyframes blink { 50% { opacity: .35; } }
`;
async function openMini() {
  if (!window.documentPictureInPicture || mini) return;
  try {
    const win = await documentPictureInPicture.requestWindow({
      width: 320,
      height: 64,
    });
    const doc = win.document;
    doc.title = "VHS · Recording";
    const style = doc.createElement("style");
    style.textContent = MINI_CSS;
    doc.head.append(style);
    doc.body.innerHTML =
      '<div class="mini"><span class="dot"></span><span class="lab">REC</span>' +
      '<span class="time">00:00.0</span><button class="pause">Ⅱ Pause</button>' +
      '<button class="stop">■ Stop</button></div>';
    const q = (sel) => doc.querySelector(sel);
    q(".pause").onclick = togglePause;
    q(".stop").onclick = () => {
      stopRecording();
      try {
        window.focus();
      } catch {}
    };
    win.addEventListener("pagehide", () => {
      if (mini?.win === win) mini = null;
    });
    mini = {
      win,
      time: q(".time"),
      pause: q(".pause"),
      dot: q(".dot"),
      label: q(".lab"),
    };
  } catch {
    mini = null;
  }
}
function closeMini() {
  const m = mini;
  mini = null;
  try {
    m?.win.close();
  } catch {}
}

function waitEvent(target, success, action, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      target.removeEventListener(success, ok);
      target.removeEventListener("error", fail);
    };
    const ok = () => {
      clean();
      resolve();
    };
    const fail = () => {
      clean();
      reject(new Error("The browser could not read this recording."));
    };
    const timer = setTimeout(fail, timeout);
    target.addEventListener(success, ok, { once: true });
    target.addEventListener("error", fail, { once: true });
    try {
      action();
    } catch (err) {
      clean();
      reject(err);
    }
  });
}
$("record").onclick = async () => {
  if (recorder) {
    stopRecording();
    return;
  }
  if (!stream || busy) return;
  busyControls(true);
  // Must be the first await: the floating window needs the click's user activation.
  await openMini();
  if (!stream) {
    closeMini();
    busyControls(false);
    return;
  }
  const parts = [],
    bounds = { ...region };
  try {
    const r = new MediaRecorder(stream);
    r.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    r.onstop = async () => {
      const elapsed = recordedTime();
      clearInterval(clockTimer);
      recorder = null;
      rec = null;
      closeMini();
      releaseStream();
      setRecordUI();
      $("pause").disabled = false;
      $("aspect").disabled = false;
      const url = URL.createObjectURL(new Blob(parts, { type: r.mimeType }));
      try {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        await waitEvent(video, "loadeddata", () => {
          video.src = url;
        });
        const length = Number.isFinite(video.duration)
          ? Math.min(elapsed, video.duration)
          : elapsed;
        if (!(length > 0.01))
          throw new Error("The clip was too short. Try recording again.");
        openAsset({
          kind: "video",
          source: video,
          url,
          length,
          bounds,
          width: video.videoWidth,
          height: video.videoHeight,
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        statusText(err.message);
      } finally {
        busyControls(false);
      }
    };
    r.onerror = (e) => {
      statusText(e.error?.message || "Recording interrupted.");
    };
    r.start(250);
    recorder = r;
    rec = { startedAt: performance.now(), pausedAt: null, pausedMs: 0 };
    $("aspect").disabled = true;
    $("pause").disabled = false;
    setRecordUI();
    clockTimer = setInterval(tickClock, 100);
    statusText(
      "Recording. The frame is applied when you edit. Pause or stop here, in the floating controls, or with the browser’s sharing bar. Clips stop at 30 seconds.",
    );
  } catch (err) {
    closeMini();
    busyControls(false);
    statusText("Could not start recording. " + err.message);
  }
};

/* ---------- Importing ---------- */

function stopPlay() {
  playing = false;
  cancelAnimationFrame(animation);
  if (asset?.kind === "video") asset.source.pause();
  $("play").textContent = "▶ Play";
}
function dispose() {
  stopPlay();
  session++;
  if (asset?.url) URL.revokeObjectURL(asset.url);
  asset?.frames?.forEach((f) => f.image.close());
  asset = null;
  annotations = [];
  selected = null;
  history = [];
  draft = null;
  tool = null;
  tlDrag = canvasDrag = inkBefore = null;
}
$("import").onclick = () => {
  if (!busy && !exporting) $("file").click();
};
async function decodeImage(file) {
  if (file.type === "image/gif") {
    if (!window.ImageDecoder)
      throw new Error(
        "GIF import needs a browser with ImageDecoder support, such as Chrome. PNG and JPEG images also work.",
      );
    const decoder = new ImageDecoder({
      data: await file.arrayBuffer(),
      type: file.type,
    });
    const frames = [];
    try {
      await decoder.tracks.ready;
      let length = 0,
        pixels = 0;
      for (let i = 0; i < decoder.tracks.selectedTrack.frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        pixels += image.displayWidth * image.displayHeight;
        if (pixels > 48e6) {
          image.close();
          throw new Error(
            "This GIF is too large to edit. Try a shorter or smaller GIF.",
          );
        }
        frames.push({ image, start: length });
        length += Math.max(0.02, (image.duration || 100000) / 1e6);
      }
      const first = frames[0].image;
      return {
        kind: frames.length === 1 ? "image" : "animation",
        frames,
        width: first.displayWidth,
        height: first.displayHeight,
        length: frames.length === 1 ? 2 : length,
      };
    } catch (err) {
      frames.forEach((f) => f.image.close());
      throw err;
    } finally {
      decoder.close();
    }
  }
  const url = URL.createObjectURL(file),
    img = new Image();
  try {
    img.src = url;
    await img.decode();
    return {
      kind: "image",
      source: img,
      url,
      width: img.naturalWidth,
      height: img.naturalHeight,
      length: 2,
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}
$("file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  await importFile(file);
};
async function importFile(file) {
  if (!file || exporting || busy) return;
  busyControls(true);
  try {
    const item = await decodeImage(file);
    releaseStream();
    openAsset(item);
  } catch (err) {
    statusText("Could not import image. " + err.message);
  } finally {
    busyControls(false);
  }
}
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  void importFile(e.dataTransfer.files[0]);
});

/* ---------- Editor ---------- */

function openAsset(item) {
  dispose();
  asset = item;
  // A still image has no real length, so its duration can be stretched.
  asset.maxEnd = item.kind === "image" ? 60 : item.length;
  const b = asset.bounds || { x: 0, y: 0, w: 1, h: 1 };
  asset.rect = [
    asset.width * b.x,
    asset.height * b.y,
    asset.width * b.w,
    asset.height * b.h,
  ];
  const scale = Math.min(1, 960 / Math.max(asset.rect[2], asset.rect[3]));
  display.width = Math.max(1, Math.round(asset.rect[2] * scale));
  display.height = Math.max(1, Math.round(asset.rect[3] * scale));
  $("pattern").hidden = $("surface").hidden = $("capturePanel").hidden = true;
  $("editPanel").hidden = display.hidden = $("timeline").hidden = false;
  $("editActions").hidden = false;
  $("png").hidden = asset.kind !== "image";
  $("speedWrap").hidden = asset.kind === "image";
  edit = { start: 0, end: item.length, speed: 1, hold: 0 };
  $("speed").value = "1";
  $("hold").value = 0;
  $("title").textContent = "Edit studio";
  $("signal").textContent = "●   PLAYBACK";
  $("format").textContent = display.width + " × " + display.height;
  $("note").value = "";
  setTool(null);
  updateUndo();
  renderTimeline();
  fitDisplay();
  setPosition(0);
  statusText(
    "Cut the clip on the timeline, add annotations, then export the GIF.",
  );
  if (asset.kind !== "image") play();
}
$("new").onclick = () => {
  dispose();
  $("editPanel").hidden = display.hidden = $("timeline").hidden = true;
  $("editActions").hidden = true;
  $("capturePanel").hidden = false;
  releaseStream();
  $("clock").textContent = "00:00.0";
  $("title").textContent = "Capture studio";
  statusText("Choose a source or import an image.");
};

function timing() {
  const { start, end, speed, hold } = edit;
  const run = (end - start) / speed;
  return { start, end, speed, hold, run, total: run + hold };
}
// Output time (what the GIF shows) <-> source time (position in the footage).
const toOut = (s) => (s - edit.start) / edit.speed;
const toSrc = (t) => edit.start + t * edit.speed;
function sourceTime(t) {
  const { start, end } = timing();
  return clamp(toSrc(t), start, Math.max(start, end - 0.001));
}
function markSpan(mark) {
  const { total } = timing();
  const a = mark.from === null ? 0 : toOut(mark.from),
    b = mark.until === null ? total : toOut(mark.until);
  return [clamp(a, 0, total), clamp(b, 0, total)];
}
function visible(mark, t) {
  const e = 0.005;
  return (
    (mark.from === null || toOut(mark.from) <= t + e) &&
    (mark.until === null || t + e < toOut(mark.until))
  );
}

/* History: every edit pushes a snapshot of the timing and marks. */
const snapshot = () => JSON.stringify({ edit, annotations });
function commit(before) {
  if (before !== snapshot()) {
    history.push(before);
    if (history.length > 200) history.shift();
  }
  updateUndo();
}
function updateUndo() {
  $("undo").disabled = !history.length;
}
function undo() {
  if (!history.length || exporting || !asset) return;
  stopPlay();
  const state = JSON.parse(history.pop());
  edit = state.edit;
  annotations = state.annotations;
  selected = null;
  $("speed").value = String(edit.speed);
  $("hold").value = edit.hold;
  updateUndo();
  afterTimingChange();
}
$("undo").onclick = undo;

/* ---------- Drawing ---------- */

function noteBox(mark) {
  const size = Math.max(12, display.width / 26),
    pad = size * 0.3,
    h = size + 2 * pad;
  context.save();
  context.font = "bold " + size + "px sans-serif";
  const w = Math.min(
    display.width,
    context.measureText(mark.text).width + 2 * pad,
  );
  context.restore();
  return {
    x: clamp(mark.x, 0, display.width - w),
    y: clamp(mark.y, 0, Math.max(0, display.height - h)),
    w,
    h,
    size,
    pad,
  };
}
function bounds(mark) {
  if (mark.kind === "note") {
    const b = noteBox(mark);
    return [b.x, b.y, b.x + b.w, b.y + b.h];
  }
  return [
    Math.min(mark.x, mark.ex),
    Math.min(mark.y, mark.ey),
    Math.max(mark.x, mark.ex),
    Math.max(mark.y, mark.ey),
  ];
}
function drawMark(mark) {
  const { kind, x, y, ex, ey, color, text } = mark;
  const line = Math.max(2, display.width / 220);
  context.save();
  context.strokeStyle = context.fillStyle = color;
  context.lineWidth = line;
  context.lineJoin = context.lineCap = "round";
  if (kind === "box") context.strokeRect(x, y, ex - x, ey - y);
  if (kind === "arrow") {
    const angle = Math.atan2(ey - y, ex - x),
      head = Math.min(Math.hypot(ex - x, ey - y) * 0.45, line * 4);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(ex, ey);
    context.stroke();
    context.beginPath();
    context.moveTo(ex, ey);
    context.lineTo(
      ex - head * Math.cos(angle - 0.5),
      ey - head * Math.sin(angle - 0.5),
    );
    context.lineTo(
      ex - head * Math.cos(angle + 0.5),
      ey - head * Math.sin(angle + 0.5),
    );
    context.closePath();
    context.fill();
  }
  if (kind === "note") {
    const b = noteBox(mark);
    context.font = "bold " + b.size + "px sans-serif";
    context.textBaseline = "top";
    context.fillStyle = "#161912";
    context.fillRect(b.x, b.y, b.w, b.h);
    context.fillStyle = color;
    context.fillText(
      text,
      b.x + b.pad,
      b.y + b.pad,
      Math.max(1, b.w - 2 * b.pad),
    );
  }
  context.restore();
}
function drawSelection(mark) {
  const [x0, y0, x1, y1] = bounds(mark),
    pad = Math.max(4, display.width / 160);
  context.save();
  context.lineWidth = Math.max(1, display.width / 600);
  context.setLineDash([6, 4]);
  context.strokeStyle = "#fff";
  context.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
  context.lineDashOffset = 5;
  context.strokeStyle = "#111";
  context.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
  context.restore();
}
// clean = true draws exactly what goes into the GIF (no selection outline).
function draw(t = playhead, clean = false) {
  if (!asset) return;
  let source = asset.source;
  if (asset.frames)
    source = (
      asset.frames.findLast((f) => f.start <= sourceTime(t)) || asset.frames[0]
    ).image;
  context.clearRect(0, 0, display.width, display.height);
  context.drawImage(source, ...asset.rect, 0, 0, display.width, display.height);
  for (const mark of annotations) if (visible(mark, t)) drawMark(mark);
  if (!clean && selected && visible(selected, t)) drawSelection(selected);
  if (draft) drawMark(draft);
}

/* ---------- Playback ---------- */

function syncUI(t) {
  playhead = t;
  $("clock").textContent = $("tcNow").textContent = timecode(t);
  updatePlayhead();
}
function setPosition(t) {
  if (!asset) return;
  const pos = clamp(t, 0, timing().total);
  syncUI(pos);
  if (asset.kind === "video") {
    asset.source.onseeked = () => {
      if (!exporting) draw();
    };
    asset.source.currentTime = sourceTime(pos);
  }
  draw();
}
function play() {
  if (playing) {
    stopPlay();
    return;
  }
  if (!asset) return;
  if (playhead >= timing().total - 0.01) setPosition(0);
  playing = true;
  $("play").textContent = "Ⅱ Pause";
  playOrigin = performance.now() - playhead * 1000;
  const id = session;
  function tick(now) {
    if (!playing || id !== session) return;
    const { total, run, speed } = timing();
    let t = (now - playOrigin) / 1000;
    if (t >= total) {
      t = 0;
      playOrigin = now;
      setPosition(0);
    }
    if (asset.kind === "video") {
      const video = asset.source;
      if (t >= run) {
        if (!video.paused) {
          video.pause();
          video.currentTime = sourceTime(t);
        }
      } else if (video.paused && !video.seeking) {
        video.playbackRate = speed;
        video.play().catch(() => {});
      }
    }
    syncUI(t);
    draw();
    animation = requestAnimationFrame(tick);
  }
  animation = requestAnimationFrame(tick);
}
$("play").onclick = play;

/* ---------- Timeline ---------- */

const across = (f) => `calc(var(--lab) + (100% - var(--lab)) * ${f})`;
const frac = (t) => clamp(t / axisLen, 0, 1);
function place(node, a, b) {
  node.style.left = (100 * a) / axisLen + "%";
  node.style.width = (100 * Math.max(0, b - a)) / axisLen + "%";
}
function updatePlayhead() {
  $("playhead").style.left = across(frac(playhead));
}
function renderTimeline() {
  if (!asset) return;
  const { total, run, hold, speed } = timing();
  // Keep the scale still while something is being dragged.
  if (!tlDrag) axisLen = total + Math.max(0.3, total * 0.1);
  $("tcTotal").textContent = timecode(total);
  $("restore").hidden = !(
    edit.start > 0.0005 || Math.abs(edit.end - asset.length) > 0.0005
  );

  const ruler = $("ruler");
  ruler.textContent = "";
  const step =
    [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => axisLen / s <= 10) ||
    60;
  for (let i = 0; i * step <= axisLen + 1e-9; i++) {
    const t = i * step;
    const label =
      t <= axisLen - step * 0.5
        ? (step < 1 ? t.toFixed(1) : String(Math.round(t))) + "s"
        : "";
    const tick = el("span", "tick", label);
    tick.style.left = (100 * t) / axisLen + "%";
    ruler.append(tick);
  }

  const rows = $("rows");
  rows.textContent = "";
  // Newest mark on top, like stacked video tracks; the clip sits at the bottom.
  for (let i = annotations.length - 1; i >= 0; i--)
    rows.append(markRow(annotations[i]));
  rows.append(clipRow(run, hold, speed));
  $("tlAfter").style.left = across(frac(total));
  updatePlayhead();
}
function markRow(mark) {
  const [icon, name] = KINDS[mark.kind];
  const row = el("div", "trow" + (mark === selected ? " selected" : ""));
  const lab = el("div", "tlab");
  const ic = el("span", "ic", icon);
  ic.style.color = mark.color;
  const del = el("button", "del", "×");
  del.title = "Delete";
  del.setAttribute("aria-label", "Delete " + name.toLowerCase());
  del.onclick = (e) => {
    e.stopPropagation();
    deleteMark(mark);
  };
  lab.append(
    ic,
    el("span", "name", mark.kind === "note" ? "“" + mark.text + "”" : name),
    del,
  );
  lab.title = "Select";
  lab.onclick = () => selectMark(mark, true);
  const lane = el("div", "lane");
  const [a, b] = markSpan(mark);
  if (b - a > 0.001) {
    const block = el("div", "block mark-block");
    block.dataset.drag = "move";
    block.mark = mark;
    block.title = "Drag to move · drag an edge to change when it shows";
    block.style.setProperty("--c", mark.color);
    place(block, a, b);
    const l = el("i", "h l"),
      r = el("i", "h r");
    l.dataset.drag = "mark-l";
    r.dataset.drag = "mark-r";
    block.append(l, r);
    lane.append(block);
  } else lane.append(el("span", "outside", "Outside the cut clip"));
  row.append(lab, lane);
  return row;
}
function clipRow(run, hold, speed) {
  const still = asset.kind === "image";
  const row = el("div", "trow cliprow");
  const lab = el(
    "div",
    "tlab",
    still ? "▣ Image" : asset.kind === "animation" ? "▶ GIF" : "▶ Clip",
  );
  lab.style.cursor = "default";
  const lane = el("div", "lane");
  const block = el(
    "div",
    "block clip-block",
    seconds(run) + (speed !== 1 ? " · " + speed + "×" : ""),
  );
  place(block, 0, run);
  const l = el("i", "h l"),
    r = el("i", "h r");
  l.dataset.drag = "trim-l";
  r.dataset.drag = "trim-r";
  l.title = "Drag to cut the start";
  r.title = still ? "Drag to change how long it shows" : "Drag to cut the end";
  block.prepend(l);
  block.append(r);
  lane.append(block);
  if (hold > 0) {
    const h = el("div", "block hold-block", "Hold");
    place(h, run, run + hold);
    lane.append(h);
  }
  row.append(lab, lane);
  return row;
}
function afterTimingChange(pos) {
  renderTimeline();
  setPosition(pos ?? Math.min(playhead, timing().total));
}
function selectMark(mark, reveal) {
  selected = mark || null;
  if (mark) {
    $("ink").value = mark.color;
    if (reveal && !visible(mark, playhead)) {
      stopPlay();
      renderTimeline();
      setPosition(markSpan(mark)[0]);
      return;
    }
  }
  renderTimeline();
  draw();
}
function deleteMark(mark) {
  if (exporting) return;
  const before = snapshot();
  annotations = annotations.filter((m) => m !== mark);
  if (selected === mark) selected = null;
  commit(before);
  renderTimeline();
  draw();
}

/* Cutting */
function cut(which) {
  if (!asset || exporting) return;
  stopPlay();
  const { run } = timing();
  if (which === "start") {
    if (playhead < 0.01 || playhead > run - MIN_RUN) {
      statusText(
        "Move the playhead to where the GIF should begin, then cut the start.",
      );
      return;
    }
    const before = snapshot(),
      removed = playhead;
    edit.start = toSrc(playhead);
    commit(before);
    afterTimingChange(0);
    statusText("Cut " + seconds(removed) + " from the start. Undo brings it back.");
  } else {
    if (playhead < MIN_RUN || playhead > run - 0.01) {
      statusText(
        "Move the playhead to where the GIF should end, then cut the end.",
      );
      return;
    }
    const before = snapshot(),
      removed = run - playhead;
    edit.end = toSrc(playhead);
    commit(before);
    afterTimingChange(timing().run);
    statusText("Cut " + seconds(removed) + " from the end. Undo brings it back.");
  }
}
$("cutStart").onclick = () => cut("start");
$("cutEnd").onclick = () => cut("end");
$("restore").onclick = () => {
  stopPlay();
  const before = snapshot();
  edit.start = 0;
  edit.end = asset.length;
  commit(before);
  afterTimingChange();
  statusText("The full clip is back.");
};
$("speed").onchange = () => {
  stopPlay();
  const before = snapshot();
  edit.speed = Number($("speed").value);
  commit(before);
  afterTimingChange();
};
$("hold").onchange = () => {
  stopPlay();
  const before = snapshot();
  edit.hold = clamp(Number($("hold").value) || 0, 0, 30);
  $("hold").value = edit.hold;
  commit(before);
  afterTimingChange();
};

/* Timeline dragging: seek, move/resize marks, trim the clip. */
const tracks = $("tracks");
function tlTime(e) {
  const r = $("ruler").getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * axisLen;
}
function showCut(f) {
  const shade = $("cutshade");
  shade.hidden = false;
  shade.style.left = across(0);
  shade.style.width = `calc((100% - var(--lab)) * ${f})`;
}
tracks.onpointerdown = (e) => {
  if (!asset || exporting || e.button !== 0 || e.target.closest(".tlab"))
    return;
  stopPlay();
  e.preventDefault();
  tracks.setPointerCapture(e.pointerId);
  const t = tlTime(e),
    handle = e.target.closest("[data-drag]"),
    type = handle?.dataset.drag;
  if (!type) {
    tlDrag = { type: "seek" };
    setPosition(t);
    return;
  }
  const mark = handle.closest(".block")?.mark;
  tlDrag = { type, t0: t, before: snapshot(), mark };
  if (mark) {
    const [a, b] = markSpan(mark);
    Object.assign(tlDrag, { a, b, total: timing().total });
    selected = mark;
    $("ink").value = mark.color;
    renderTimeline();
    draw();
  }
};
tracks.onpointermove = (e) => {
  const d = tlDrag;
  if (!d) return;
  const t = tlTime(e);
  if (d.type === "seek") {
    setPosition(t);
  } else if (d.mark) {
    const dt = t - d.t0,
      total = d.total;
    let { a, b } = d;
    if (d.type === "move") {
      const shift = clamp(dt, -a, total - b);
      a += shift;
      b += shift;
    } else if (d.type === "mark-l") a = clamp(a + dt, 0, Math.max(0, b - MIN_RUN));
    else b = clamp(b + dt, Math.min(total, a + MIN_RUN), total);
    d.mark.from = a < 0.005 ? null : toSrc(a);
    d.mark.until = b > total - 0.005 ? null : toSrc(b);
    renderTimeline();
    setPosition(d.type === "mark-r" ? Math.max(a, b - 0.02) : a);
  } else if (d.type === "trim-l") {
    d.cut = clamp(t, 0, timing().run - MIN_RUN);
    showCut(frac(d.cut));
    setPosition(d.cut);
  } else if (d.type === "trim-r") {
    edit.end = clamp(
      toSrc(t),
      edit.start + MIN_RUN * edit.speed,
      asset.maxEnd,
    );
    renderTimeline();
    setPosition(timing().run);
  }
};
function endTimelineDrag() {
  const d = tlDrag;
  if (!d) return;
  tlDrag = null;
  $("cutshade").hidden = true;
  if (d.type === "trim-l" && d.cut > 0.005) {
    edit.start = toSrc(d.cut);
    playhead = 0;
    statusText("Cut " + seconds(d.cut) + " from the start. Undo brings it back.");
  }
  if (d.type !== "seek") commit(d.before);
  renderTimeline();
  setPosition(playhead);
}
tracks.onpointerup = endTimelineDrag;
tracks.onpointercancel = endTimelineDrag;
tracks.onlostpointercapture = endTimelineDrag;

/* ---------- Annotation tools on the preview ---------- */

function setTool(kind) {
  tool = kind;
  draft = null;
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === kind);
    b.setAttribute("aria-pressed", String(b.dataset.tool === kind));
  });
  $("note").hidden = kind !== "note";
  display.style.cursor = kind ? "crosshair" : "default";
  $("toolHint").textContent =
    kind === "note"
      ? "Write a note, then click the preview to place it. It starts at the playhead."
      : kind
        ? "Drag on the preview to draw. It starts at the playhead and gets its own track."
        : "Pick a tool to draw. Without a tool, click a mark to select it and drag to move it.";
}
$("tools").onclick = (e) => {
  const button = e.target.closest("[data-tool]");
  if (!button) return;
  stopPlay();
  setTool(tool === button.dataset.tool ? null : button.dataset.tool);
  if (tool === "note") $("note").focus();
};
function point(e) {
  const r = display.getBoundingClientRect();
  return {
    x: clamp(
      ((e.clientX - r.left) * display.width) / r.width,
      0,
      display.width,
    ),
    y: clamp(
      ((e.clientY - r.top) * display.height) / r.height,
      0,
      display.height,
    ),
  };
}
function hitTest(p) {
  const r = display.getBoundingClientRect(),
    pad = (8 * display.width) / Math.max(1, r.width);
  for (let i = annotations.length - 1; i >= 0; i--) {
    const m = annotations[i];
    if (!visible(m, playhead)) continue;
    const [x0, y0, x1, y1] = bounds(m);
    if (p.x >= x0 - pad && p.x <= x1 + pad && p.y >= y0 - pad && p.y <= y1 + pad)
      return m;
  }
  return null;
}
display.onpointerdown = (e) => {
  if (!asset || exporting || e.button !== 0) return;
  stopPlay();
  const p = point(e);
  display.setPointerCapture(e.pointerId);
  if (!tool) {
    const hit = hitTest(p);
    selectMark(hit);
    if (hit)
      canvasDrag = {
        mark: hit,
        p,
        orig: { x: hit.x, y: hit.y, ex: hit.ex, ey: hit.ey },
        before: snapshot(),
      };
    return;
  }
  const text = $("note").value.trim();
  if (tool === "note" && !text) {
    $("note").focus();
    statusText("Write the note text first, then click to place it.");
    return;
  }
  draft = {
    kind: tool,
    x: p.x,
    y: p.y,
    ex: p.x,
    ey: p.y,
    color: $("ink").value,
    text,
    from: playhead > 0.005 ? toSrc(playhead) : null,
    until: null,
  };
  draw();
};
display.onpointermove = (e) => {
  const p = point(e);
  if (canvasDrag) {
    const { mark, orig } = canvasDrag,
      dx = p.x - canvasDrag.p.x,
      dy = p.y - canvasDrag.p.y;
    Object.assign(mark, {
      x: orig.x + dx,
      y: orig.y + dy,
      ex: orig.ex + dx,
      ey: orig.ey + dy,
    });
    draw();
  } else if (draft) {
    draft.ex = p.x;
    draft.ey = p.y;
    draw();
  } else if (!tool && asset) {
    display.style.cursor = hitTest(p) ? "move" : "default";
  }
};
display.onpointerup = () => {
  if (canvasDrag) {
    commit(canvasDrag.before);
    canvasDrag = null;
    return;
  }
  if (draft) {
    const before = snapshot();
    if (
      draft.kind === "note" ||
      Math.hypot(draft.x - draft.ex, draft.y - draft.ey) > 1
    ) {
      annotations.push(draft);
      selected = draft;
      commit(before);
    }
    draft = null;
    renderTimeline();
    draw();
  }
};
display.onpointercancel = () => {
  if (canvasDrag) Object.assign(canvasDrag.mark, canvasDrag.orig);
  canvasDrag = null;
  draft = null;
  draw();
};
$("ink").oninput = () => {
  if (!selected) return;
  if (inkBefore === null) inkBefore = snapshot();
  selected.color = $("ink").value;
  renderTimeline();
  draw();
};
$("ink").onchange = () => {
  if (inkBefore !== null) commit(inkBefore);
  inkBefore = null;
};

/* ---------- Keyboard ---------- */

document.addEventListener("keydown", (e) => {
  if (!asset || exporting || $("timeline").hidden) return;
  if (e.target.closest?.("input, select, textarea, [contenteditable]")) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === " ") {
    if (e.target.tagName === "BUTTON") return;
    e.preventDefault();
    play();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    stopPlay();
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === "ArrowLeft" ? -1 : 1);
    setPosition(Math.round((playhead + step) * 100) / 100);
  } else if (e.key === "[") cut("start");
  else if (e.key === "]") cut("end");
  else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
    e.preventDefault();
    deleteMark(selected);
  } else if (e.key === "Escape") {
    setTool(null);
    selectMark(null);
  }
});

/* ---------- Export ---------- */

function download(blob, name) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$("png").onclick = () => {
  stopPlay();
  draw(playhead, true);
  display.toBlob((blob) => {
    if (blob) download(blob, "VHS-image.png");
  });
  draw();
};
async function seekVideo(video, t) {
  if (!video.seeking && Math.abs(video.currentTime - t) < 0.0001) return;
  await waitEvent(video, "seeked", () => {
    video.currentTime = t;
  });
}
$("gif").onclick = async () => {
  if (exporting || busy || !asset) return;
  stopPlay();
  exporting = true;
  const original = playhead;
  $("editPanel").inert = $("timeline").inert = $("editActions").inert = true;
  $("import").disabled = true;
  try {
    const { total, run } = timing(),
      staticImage = asset.kind === "image";
    const boundaries = new Set([0, total]);
    if (!staticImage) {
      for (let i = 1; i / 10 < run; i++) boundaries.add(i / 10);
      if (total > run) boundaries.add(run);
    }
    for (const mark of annotations)
      for (const s of [mark.from, mark.until])
        if (s !== null) {
          const t = toOut(s);
          if (t > 0 && t < total) boundaries.add(t);
        }
    // GIF delays use hundredths of a second. Merge coincident frame boundaries.
    const times = [
      ...new Set([...boundaries].map((t) => Math.round(t * 100) / 100)),
    ].sort((a, b) => a - b);
    if (times.length < 2) times.push(0.01);
    const count = times.length - 1;
    const { GIFEncoder, quantize, applyPalette } = window.VHSGif,
      encoder = GIFEncoder();
    for (let i = 0; i < count; i++) {
      const t = times[i];
      if (asset.kind === "video") await seekVideo(asset.source, sourceTime(t));
      syncUI(t);
      draw(t, true);
      const pixels = context.getImageData(
        0,
        0,
        display.width,
        display.height,
      ).data;
      const palette = quantize(pixels, 256),
        indices = applyPalette(pixels, palette);
      const delay = (times[i + 1] - t) * 1000;
      encoder.writeFrame(indices, display.width, display.height, {
        palette,
        delay,
        repeat: 0,
      });
      statusText("Encoding GIF · " + Math.round(((i + 1) * 100) / count) + "%");
      await pause(0);
    }
    encoder.finish();
    download(
      new Blob([encoder.bytesView()], { type: "image/gif" }),
      "VHS-clip.gif",
    );
    statusText("GIF exported.");
  } catch (err) {
    statusText("Export could not finish. " + err.message);
  } finally {
    exporting = false;
    $("editPanel").inert = $("timeline").inert = $("editActions").inert = false;
    $("import").disabled = false;
    setPosition(original);
  }
};

setTool(null);
