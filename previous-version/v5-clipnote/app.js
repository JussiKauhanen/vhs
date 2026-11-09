"use strict";
/* Clipnote: record a screen clip, add animated stickers, export GIF / MP4 / PNG.
   Everything runs in the page. Sticker positions and times are stored in source
   pixels and source seconds, so cropping and trimming never move them. */

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60),
    s = t - m * 60;
  return m + ":" + (s < 10 ? "0" : "") + (Math.floor(s * 10) / 10).toFixed(1);
};
const fmtClock = (t) => {
  const s = Math.floor(Math.max(0, t));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};
const fmtBytes = (n) =>
  n < 1e6 ? Math.max(1, Math.round(n / 1e3)) + " KB" : (n / 1e6).toFixed(1) + " MB";
const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
let toastTimer;
function toast(text, ms = 3200) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- Theme ---------- */

let theme = store.get("clipnote-theme");
function isDark() {
  return theme
    ? theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
}
function paintThemeButton() {
  $("theme").querySelector("use").setAttribute("href", isDark() ? "#i-sun" : "#i-moon");
}
$("theme").onclick = () => {
  theme = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  store.set("clipnote-theme", theme);
  paintThemeButton();
};
paintThemeButton();

/* ---------- Screens ---------- */

function showScreen(name) {
  for (const id of ["home", "capture", "editor"]) $(id).hidden = id !== name;
  const editing = name === "editor";
  $("tabs").hidden = !editing;
  $("editTools").hidden = !editing;
  $("newBtn").hidden = !editing;
  $("exportBtn").hidden = !editing;
  if (editing) requestAnimationFrame(fitView);
}

$("homeNote").textContent = !navigator.mediaDevices?.getDisplayMedia
  ? "Screen recording needs a desktop browser such as Chrome or Edge. You can still open an image or video."
  : !window.documentPictureInPicture
    ? "Tip: the floating controls need Chrome or Edge."
    : "";

/* ======================================================================
   Capture session: floating controls, recording, screenshots
   ====================================================================== */

const MAX_RECORD = 60;
const live = $("live");
let stream = null,
  recorder = null,
  rec = null,
  clockTimer = null,
  floater = null,
  session = null;

function capState() {
  if (!stream) return "pick";
  if (!recorder) return "ready";
  return recorder.state === "paused" ? "paused" : "recording";
}
function recordedTime() {
  if (!rec) return 0;
  const now = rec.pausedAt ?? performance.now();
  return (now - rec.startedAt - rec.pausedMs) / 1000;
}

async function startSession() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("Screen recording needs a desktop browser such as Chrome or Edge.");
    return;
  }
  if (session) return;
  session = { shots: [], clip: null };
  // The floating window must open first: it needs this click.
  await openFloater();
  await pickScreen();
}
$("startBtn").onclick = startSession;
$("newBtn").onclick = startSession;

async function pickScreen() {
  try {
    const picked = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
    if (!session) {
      picked.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = picked;
    picked.getVideoTracks()[0].onended = () => {
      if (stream === picked) finishSession();
    };
    live.srcObject = picked;
    await live.play().catch(() => {});
    showScreen("capture");
    updateCapture();
  } catch (err) {
    // Some browsers want a fresh click before showing the screen picker.
    if (floater && (err.name === "InvalidStateError" || /activation|gesture/i.test(err.message))) {
      updateCapture();
      return;
    }
    cancelSession();
    if (err.name !== "NotAllowedError") toast("Could not start screen sharing. " + err.message);
  }
}
function cancelSession() {
  closeFloater();
  releaseStream();
  session = null;
  showScreen(projects.length ? "editor" : "home");
}
function releaseStream() {
  const s = stream;
  stream = null;
  s?.getTracks().forEach((t) => t.stop());
  live.srcObject = null;
}

function startRecording() {
  if (!stream || recorder) return;
  const chunks = [];
  try {
    const r = new MediaRecorder(stream);
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      const length = recordedTime();
      clearInterval(clockTimer);
      recorder = null;
      rec = null;
      if (session && length > 0.2)
        session.clip = { url: URL.createObjectURL(new Blob(chunks, { type: r.mimeType })), length };
      finishSession();
    };
    r.start(250);
    recorder = r;
    rec = { startedAt: performance.now(), pausedAt: null, pausedMs: 0 };
    clockTimer = setInterval(() => {
      updateClock();
      if (recordedTime() >= MAX_RECORD) stopRecording();
    }, 200);
  } catch (err) {
    toast("Could not start recording. " + err.message);
  }
  updateCapture();
}
function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}
function togglePause() {
  if (!recorder) return;
  if (recorder.state === "recording") {
    recorder.pause();
    rec.pausedAt = performance.now();
  } else {
    rec.pausedMs += performance.now() - rec.pausedAt;
    rec.pausedAt = null;
    recorder.resume();
  }
  updateCapture();
}
async function takeShot() {
  if (!stream || !session) return;
  const track = stream.getVideoTracks()[0];
  let source = null;
  try {
    if (window.ImageCapture) source = await new ImageCapture(track).grabFrame();
  } catch {}
  if (!source && live.videoWidth) source = live;
  if (!source) return;
  const c = el("canvas");
  c.width = source.width || source.videoWidth;
  c.height = source.height || source.videoHeight;
  c.getContext("2d").drawImage(source, 0, 0);
  source.close?.();
  session.shots.push(c);
  flash();
  const thumb = el("img");
  thumb.src = scaledCopy(c, 160).toDataURL("image/jpeg", 0.7);
  thumb.alt = "Screenshot " + session.shots.length;
  $("shotStrip").append(thumb);
  $("shotStrip").hidden = false;
  updateCapture();
}
function scaledCopy(src, width) {
  const c = el("canvas");
  c.width = width;
  c.height = Math.max(1, Math.round((width * src.height) / src.width));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function flash() {
  for (const f of [$("flash"), floater?.doc.querySelector(".flash")]) {
    if (!f) continue;
    f.classList.remove("go");
    void f.offsetWidth;
    f.classList.add("go");
  }
}
function captureAction(act) {
  if (act === "pick") pickScreen();
  else if (act === "record") startRecording();
  else if (act === "pause" || act === "resume") togglePause();
  else if (act === "stop") stopRecording();
  else if (act === "shot") takeShot();
  else if (act === "done") {
    if (recorder) stopRecording();
    else if (stream || session?.shots.length) finishSession();
    else cancelSession();
  }
}
$("cRecord").onclick = () => captureAction(recorder ? "stop" : "record");
$("cPause").onclick = () => captureAction("pause");
$("cShot").onclick = () => captureAction("shot");
$("cDone").onclick = () => captureAction("done");

function updateClock() {
  const t = fmtClock(recordedTime());
  $("capTime").textContent = t;
  if (floater) floater.doc.querySelector(".time").textContent = t;
}
function updateCapture() {
  const state = capState(),
    shots = session?.shots.length || 0;
  const label = { pick: "Choose a screen", ready: "Ready to record", recording: "Recording", paused: "Paused" }[state];
  $("capLabel").textContent = label;
  $("capDot").classList.toggle("on", state === "recording");
  $("cRecord").querySelector("span").textContent = recorder ? "Stop" : "Record";
  $("cRecord").querySelector("use").setAttribute("href", recorder ? "#i-stop" : "#i-rec");
  $("cPause").hidden = !recorder;
  $("cPause").querySelector("span").textContent = state === "paused" ? "Resume" : "Pause";
  $("cDone").hidden = !!recorder;
  $("cShotCount").hidden = !shots;
  $("cShotCount").textContent = shots;
  $("capHint").textContent = floater
    ? "Your controls float on top of every window. Tip: share a single window so they stay out of the video."
    : "Come back to this tab to stop. Tip: share a single window rather than the entire screen.";
  updateClock();
  if (!floater) return;
  const d = floater.doc;
  d.body.dataset.state = state;
  d.querySelector(".shot em").textContent = shots || "";
  d.querySelector(".label").textContent = label;
}

/* The floating control window (Document Picture-in-Picture, Chrome / Edge). */
const FLOATER_CSS = `
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:600 13px system-ui,-apple-system,sans-serif;background:#fff;color:#050038;display:flex;align-items:center;overflow:hidden}
@media (prefers-color-scheme:dark){body{background:#20202a;color:#f1f0ff}button{background:#2a2a36!important;color:#f1f0ff}}
.bar{display:flex;align-items:center;gap:6px;padding:0 10px;width:100%}
.status{display:flex;flex-direction:column;flex:1;min-width:0;line-height:1.15}
.label{font-size:11px;color:#8a89a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.time{font:600 16px ui-monospace,Menlo,monospace}
.dot{width:10px;height:10px;border-radius:50%;background:#c9c8da;flex:none;margin-right:2px}
body[data-state=recording] .dot{background:#ff4d4d;animation:b 1s infinite}
@keyframes b{50%{opacity:.3}}
button{display:none;align-items:center;gap:5px;border:0;border-radius:10px;padding:9px 11px;font:inherit;cursor:pointer;background:#f0f1f6;color:#050038}
button:hover{filter:brightness(.95)}
button:active{transform:scale(.96)}
button svg{width:16px;height:16px}
.primary{background:#4262ff!important;color:#fff!important}
.rec svg{color:#ff9a9a}
.shot em{font-style:normal;font-size:11px;background:#4262ff;color:#fff;border-radius:9px;padding:0 5px}
.shot em:empty{display:none}
body[data-state=pick] [data-act=pick],body[data-state=pick] [data-act=done],
body[data-state=ready] [data-act=record],body[data-state=ready] [data-act=shot],body[data-state=ready] [data-act=done],
body[data-state=recording] [data-act=pause],body[data-state=recording] [data-act=stop],body[data-state=recording] [data-act=shot],
body[data-state=paused] [data-act=resume],body[data-state=paused] [data-act=stop],body[data-state=paused] [data-act=shot]{display:inline-flex}
.flash{position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none}
.flash.go{animation:f .35s ease-out}@keyframes f{from{opacity:.9}}
`;
const ICON = {
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.5" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.5" fill="currentColor"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.4-2h5l1.4 2h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
async function openFloater() {
  if (!window.documentPictureInPicture || floater) return;
  try {
    const win = await documentPictureInPicture.requestWindow({ width: 380, height: 66 });
    const doc = win.document;
    doc.title = "Clipnote";
    const style = doc.createElement("style");
    style.textContent = FLOATER_CSS;
    doc.head.append(style);
    doc.body.innerHTML =
      '<div class="bar"><span class="dot"></span><span class="status"><span class="label">Choose a screen</span><span class="time">00:00</span></span>' +
      '<button data-act="pick" class="primary">Choose screen</button>' +
      `<button data-act="record" class="primary rec">${ICON.rec}Record</button>` +
      `<button data-act="pause">${ICON.pause}Pause</button>` +
      `<button data-act="resume" class="primary rec">${ICON.rec}Resume</button>` +
      `<button data-act="stop" class="primary">${ICON.stop}Stop</button>` +
      `<button data-act="shot" class="shot" title="Take a screenshot">${ICON.camera}<em></em></button>` +
      `<button data-act="done">${ICON.check}Done</button></div><div class="flash"></div>`;
    doc.body.dataset.state = "pick";
    doc.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) captureAction(b.dataset.act);
    });
    win.addEventListener("pagehide", () => {
      if (floater?.win === win) {
        floater = null;
        updateCapture();
      }
    });
    floater = { win, doc };
  } catch {
    floater = null;
  }
}
function closeFloater() {
  const f = floater;
  floater = null;
  try {
    f?.win.close();
  } catch {}
}

async function finishSession() {
  if (recorder) {
    stopRecording();
    return;
  }
  const s = session;
  session = null;
  closeFloater();
  releaseStream();
  $("shotStrip").textContent = "";
  $("shotStrip").hidden = true;
  if (!s) return;
  const added = [];
  try {
    if (s.clip) added.push(await videoProject(s.clip.url, s.clip.length, "Recording"));
  } catch (err) {
    toast("Could not read the recording. " + err.message);
  }
  s.shots.forEach((c, i) => added.push(imageProject(c, "Shot " + (i + 1))));
  try {
    window.focus();
  } catch {}
  if (!added.length) {
    showScreen(projects.length ? "editor" : "home");
    return;
  }
  projects.push(...added);
  openProject(added[0]);
  if (added.length > 1) toast(added.length + " captures are ready. Switch between them at the top.");
}

/* ======================================================================
   Projects (one per recording, screenshot or opened file)
   ====================================================================== */

let projects = [],
  cur = null,
  nextId = 1;

function baseProject(kind, name, source, width, height, length) {
  return {
    id: nextId++,
    kind,
    name,
    source,
    width,
    height,
    length,
    edit: {
      start: 0,
      end: length,
      speed: 1,
      hold: kind === "video" ? 1 : 0,
      crop: [0, 0, width, height],
    },
    stickers: [],
    history: [],
    future: [],
    playhead: 0,
    thumbs: null,
  };
}
function imageProject(canvasOrImage, name) {
  const w = canvasOrImage.width || canvasOrImage.naturalWidth,
    h = canvasOrImage.height || canvasOrImage.naturalHeight;
  const p = baseProject("image", name, canvasOrImage, w, h, 3);
  p.maxEnd = 60;
  return p;
}
function waitEvent(target, ok, action, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener(ok, good);
      target.removeEventListener("error", bad);
    };
    const good = () => {
      done();
      resolve();
    };
    const bad = () => {
      done();
      reject(new Error("The browser could not read this video."));
    };
    const timer = setTimeout(bad, timeout);
    target.addEventListener(ok, good, { once: true });
    target.addEventListener("error", bad, { once: true });
    try {
      action();
    } catch (e) {
      done();
      reject(e);
    }
  });
}
async function videoProject(url, length, name) {
  const v = el("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  await waitEvent(v, "loadeddata", () => (v.src = url));
  if (!length) length = v.duration;
  if (!Number.isFinite(length) || length <= 0) throw new Error("Unknown video length.");
  if (Number.isFinite(v.duration)) length = Math.min(length, v.duration);
  const p = baseProject("video", name, v, v.videoWidth, v.videoHeight, length);
  p.url = url;
  p.maxEnd = length;
  return p;
}
async function seekVideo(v, t) {
  if (!v.seeking && Math.abs(v.currentTime - t) < 0.0005) return;
  await waitEvent(v, "seeked", () => (v.currentTime = t));
}

/* Open files */
$("openBtn").onclick = () => $("file").click();
$("file").onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) openFile(f);
};
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  e.preventDefault();
  openFile(f);
});
async function openFile(file) {
  if (exporting) return;
  const url = URL.createObjectURL(file);
  try {
    let p;
    if (file.type.startsWith("video/")) p = await videoProject(url, 0, file.name.replace(/\.[^.]+$/, ""));
    else {
      const img = new Image();
      img.src = url;
      await img.decode();
      p = imageProject(img, file.name.replace(/\.[^.]+$/, ""));
    }
    projects.push(p);
    openProject(p);
  } catch (err) {
    URL.revokeObjectURL(url);
    toast("Could not open that file. " + (err.message || ""));
  }
}

function renderTabs() {
  const nav = $("tabs");
  nav.textContent = "";
  for (const p of projects) {
    const b = el("button", p === cur ? "on" : "");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", p.kind === "video" ? "#i-play" : "#i-camera");
    icon.append(use);
    b.append(icon, el("span", "", p.name));
    if (projects.length > 1) {
      const x = el("span", "tabx", "×");
      x.title = "Close";
      x.onclick = (e) => {
        e.stopPropagation();
        closeProject(p);
      };
      b.append(x);
    }
    b.onclick = () => p !== cur && openProject(p);
    nav.append(b);
  }
}
function closeProject(p) {
  if (exporting) return;
  const i = projects.indexOf(p);
  projects.splice(i, 1);
  if (p.url) URL.revokeObjectURL(p.url);
  if (p === cur) {
    cur = null;
    if (projects.length) openProject(projects[Math.max(0, i - 1)]);
    else showScreen("home");
  } else renderTabs();
}

function openProject(p) {
  stopPlay();
  if (cur) cur.playhead = playhead;
  cur = p;
  selected = null;
  cropping = false;
  session_id++;
  showScreen("editor");
  renderTabs();
  $("speedWrap").hidden = p.kind !== "video";
  $("trimTools").hidden = p.kind !== "video";
  $("speed").value = String(p.edit.speed);
  setTool();
  updateUndo();
  fitView();
  renderTimeline();
  setPosition(p.playhead);
  if (!p.thumbs) buildThumbs(p);
  if (p.kind === "video") play();
}

/* ======================================================================
   Timing: output time t (what the export shows) <-> source time s
   ====================================================================== */

let playhead = 0,
  playing = false,
  playOrigin = 0,
  frameReq = 0,
  session_id = 0,
  exporting = false;

function timing() {
  const { start, end, speed, hold } = cur.edit;
  const run = (end - start) / speed;
  return { start, end, speed, hold, run, total: run + hold };
}
const toOut = (s) => (s - cur.edit.start) / cur.edit.speed;
const toSrc = (t) => cur.edit.start + t * cur.edit.speed;
function sourceTime(t) {
  const { start, end } = timing();
  return clamp(toSrc(t), start, Math.max(start, end - 0.001));
}
// When a sticker is on screen, plus how long it has been there.
function life(s, t) {
  const { total } = timing();
  const a = s.from == null ? 0 : toOut(s.from),
    b = s.until == null ? total : toOut(s.until);
  if (t < a - 0.0005 || t >= b - 0.0005) return null;
  return { age: t - a, left: s.until == null ? Infinity : b - t };
}

/* ======================================================================
   Stickers
   ====================================================================== */

const STICKERS = {
  note: { name: "Post-it", text: "Your note", color: "#FFD02F", dur: 3 },
  arrow: { name: "Arrow", color: "#E5547A", dur: 3 },
  bubble: { name: "Text bubble", text: "Click here", color: "#FFFFFF", dur: 3 },
  click: { name: "Click", color: "#4262FF", dur: 1.6 },
  dblclick: { name: "Double-click", color: "#4262FF", dur: 1.8 },
  rightclick: { name: "Right-click", color: "#4262FF", dur: 2 },
  keys: { name: "Keys", text: "⌘ + C", dur: 2.5 },
  spotlight: { name: "Spotlight", dur: 3 },
};
const PALETTES = {
  note: ["#FFD02F", "#FF9EC4", "#A6E3A1", "#9FC5FF", "#FFB46B"],
  bubble: ["#FFFFFF", "#FFD02F", "#4262FF", "#E5547A", "#050038"],
  other: ["#E5547A", "#4262FF", "#23A26D", "#FF8A00", "#050038"],
};
const TEXT_TYPES = ["note", "bubble", "keys"];
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const lightColor = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160;
};
function anim(l) {
  const fadeOut = l.left === Infinity ? 1 : clamp(l.left / 0.2, 0, 1);
  return {
    age: l.age,
    pop: easeOutBack(clamp(l.age / 0.35, 0, 1)),
    alpha: clamp(l.age / 0.12, 0, 1) * fadeOut,
  };
}
const STILL = { age: 30, pop: 1, alpha: 1 };

function fitText(ctx, text, cx, cy, maxW, maxH, size, color) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  let lines = [];
  for (let f = size; f > 4; f *= 0.9) {
    ctx.font = `700 ${f}px ${FONT}`;
    lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    if (line) lines.push(line);
    const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    if (lines.length * f * 1.2 <= maxH && widest <= maxW) {
      size = f;
      break;
    }
    size = f;
  }
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lh = size * 1.2,
    top = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lh, maxW));
}
const POINTER = [[0, 0], [0, 16], [4, 12.2], [6.8, 18.4], [9.4, 17.3], [6.7, 11.3], [12, 11.3]];
function drawCursor(ctx, x, y, size) {
  const k = size / 18;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.beginPath();
  POINTER.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#050038";
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
function arrowGeom(s) {
  const dx = s.x2 - s.x,
    dy = s.y2 - s.y,
    len = Math.hypot(dx, dy) || 1;
  const bend = s.bend ?? 0.22;
  return {
    len,
    cx: (s.x + s.x2) / 2 - (dy / len) * len * bend,
    cy: (s.y + s.y2) / 2 + (dx / len) * len * bend,
  };
}
const qpt = (s, g, u) => [
  (1 - u) ** 2 * s.x + 2 * (1 - u) * u * g.cx + u * u * s.x2,
  (1 - u) ** 2 * s.y + 2 * (1 - u) * u * g.cy + u * u * s.y2,
];
function keysLayout(ctx, s) {
  const h = s.h,
    parts = String(s.text || "").split("+").map((p) => p.trim()).filter(Boolean);
  ctx.font = `700 ${h * 0.42}px ${FONT}`;
  let x = 0;
  const keys = parts.map((label, i) => {
    const w = Math.max(h * 1.05, ctx.measureText(label).width + h * 0.6);
    const k = { label, x, w };
    x += w + (i < parts.length - 1 ? h * 0.55 : 0);
    return k;
  });
  s.w = Math.max(h, x);
  return keys;
}

const DRAW = {
  note(ctx, s, a) {
    const { x, y, w, h } = s;
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(-0.035);
    const k = 0.55 + 0.45 * a.pop;
    ctx.scale(k, k);
    ctx.shadowColor = "rgba(5,0,56,.28)";
    ctx.shadowBlur = w * 0.08;
    ctx.shadowOffsetY = w * 0.035;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, w * 0.025);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.fillRect(-w * 0.16, -h / 2 - h * 0.045, w * 0.32, h * 0.1);
    fitText(ctx, s.text, 0, 0, w * 0.82, h * 0.8, w * 0.13, "#050038");
  },
  bubble(ctx, s, a) {
    const { x, y, w, h } = s,
      tipX = x + w * 0.16,
      tipY = y + h * 1.45;
    ctx.translate(tipX, tipY);
    const k = 0.5 + 0.5 * a.pop;
    ctx.scale(k, k);
    ctx.translate(-tipX, -tipY);
    ctx.shadowColor = "rgba(5,0,56,.25)";
    ctx.shadowBlur = h * 0.35;
    ctx.shadowOffsetY = h * 0.08;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h * 0.32);
    ctx.moveTo(x + w * 0.1, y + h - 1);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(x + w * 0.32, y + h - 1);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = "transparent";
    if (s.color.toUpperCase() === "#FFFFFF") {
      ctx.strokeStyle = "rgba(5,0,56,.12)";
      ctx.lineWidth = h * 0.03;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h * 0.32);
      ctx.stroke();
    }
    fitText(ctx, s.text, x + w / 2, y + h / 2, w * 0.86, h * 0.8, h * 0.4, lightColor(s.color) ? "#050038" : "#FFFFFF");
  },
  arrow(ctx, s, a) {
    const g = arrowGeom(s),
      p = easeOutCubic(clamp(a.age / 0.5, 0, 1)),
      n = 40;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.w;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const [px, py] = qpt(s, g, (i / n) * p);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    if (p > 0.8) {
      const u = p,
        tx = 2 * (1 - u) * (g.cx - s.x) + 2 * u * (s.x2 - g.cx),
        ty = 2 * (1 - u) * (g.cy - s.y) + 2 * u * (s.y2 - g.cy),
        ang = Math.atan2(ty, tx),
        [ex, ey] = qpt(s, g, u),
        head = s.w * 4 * clamp((p - 0.8) / 0.2, 0, 1);
      ctx.beginPath();
      ctx.moveTo(ex - head * Math.cos(ang - 0.55), ey - head * Math.sin(ang - 0.55));
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex - head * Math.cos(ang + 0.55), ey - head * Math.sin(ang + 0.55));
      ctx.stroke();
    }
  },
  click(ctx, s, a) {
    pulse(ctx, s, a, [0]);
  },
  dblclick(ctx, s, a) {
    pulse(ctx, s, a, [0, 0.17]);
    const r = s.r,
      k = a.pop;
    ctx.save();
    ctx.translate(s.x + r * 1.3, s.y - r * 1.4);
    ctx.scale(k, k);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.roundRect(-r * 0.75, -r * 0.5, r * 1.5, r, r * 0.5);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${r * 0.62}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("2×", 0, r * 0.03);
    ctx.restore();
  },
  rightclick(ctx, s, a) {
    const r = s.r,
      menu = easeOutBack(clamp((a.age - 0.25) / 0.35, 0, 1));
    if (menu > 0) {
      const mx = s.x + r * 0.6,
        my = s.y + r * 0.6,
        mw = r * 5.4,
        mh = r * 4.4;
      ctx.save();
      ctx.translate(mx, my);
      ctx.scale(menu, menu);
      ctx.shadowColor = "rgba(5,0,56,.3)";
      ctx.shadowBlur = r * 1.2;
      ctx.shadowOffsetY = r * 0.3;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.roundRect(0, 0, mw, mh, r * 0.5);
      ctx.fill();
      ctx.shadowColor = "transparent";
      for (let i = 0; i < 4; i++) {
        const ry = r * 0.45 + i * r * 0.95;
        if (i === 0) {
          ctx.fillStyle = s.color + "26";
          ctx.beginPath();
          ctx.roundRect(r * 0.25, ry - r * 0.12, mw - r * 0.5, r * 0.8, r * 0.25);
          ctx.fill();
        }
        ctx.fillStyle = i === 0 ? s.color : "#c9c8da";
        ctx.beginPath();
        ctx.roundRect(r * 0.55, ry + r * 0.15, (i === 0 ? 0.62 : [0, 0.5, 0.7, 0.42][i]) * mw, r * 0.24, r * 0.12);
        ctx.fill();
      }
      ctx.restore();
    }
    pulse(ctx, s, a, [0]);
    // A little mouse with its right button lit.
    const k = a.pop,
      bx = s.x - r * 2.3,
      by = s.y - r * 2.4;
    ctx.save();
    ctx.translate(bx, by);
    ctx.scale(k, k);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#050038";
    ctx.lineWidth = r * 0.14;
    ctx.beginPath();
    ctx.roundRect(-r * 0.65, -r * 0.95, r * 1.3, r * 1.9, r * 0.65);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = s.color;
    ctx.fillRect(0, -r * 0.95, r * 0.65, r * 0.85);
    ctx.restore();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.95);
    ctx.lineTo(0, -r * 0.1);
    ctx.moveTo(-r * 0.65, -r * 0.1);
    ctx.lineTo(r * 0.65, -r * 0.1);
    ctx.stroke();
    ctx.restore();
  },
  keys(ctx, s, a) {
    const keys = keysLayout(ctx, s),
      h = s.h,
      cycle = a.age % 2;
    ctx.translate(s.x + s.w / 2, s.y + h / 2);
    const k = 0.55 + 0.45 * a.pop;
    ctx.scale(k, k);
    ctx.translate(-s.w / 2, -h / 2);
    keys.forEach((key, i) => {
      const t0 = 0.25 + i * 0.16,
        down = cycle > t0 && cycle < t0 + 0.55 ? 1 : 0,
        lip = h * (down ? 0.05 : 0.12),
        dy = h * 0.12 - lip;
      ctx.shadowColor = "rgba(5,0,56,.25)";
      ctx.shadowBlur = h * 0.2;
      ctx.shadowOffsetY = h * 0.06;
      ctx.fillStyle = "#c9cade";
      ctx.beginPath();
      ctx.roundRect(key.x, dy, key.w, h - dy, h * 0.2);
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = down ? "#eef0ff" : "#fff";
      ctx.beginPath();
      ctx.roundRect(key.x, dy, key.w, h - h * 0.12, h * 0.2);
      ctx.fill();
      ctx.fillStyle = "#050038";
      ctx.font = `700 ${h * 0.42}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(key.label, key.x + key.w / 2, dy + (h - h * 0.12) / 2);
      if (i < keys.length - 1) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "rgba(5,0,56,.6)";
        ctx.lineWidth = h * 0.05;
        ctx.font = `800 ${h * 0.4}px ${FONT}`;
        ctx.strokeText("+", key.x + key.w + h * 0.275, h / 2);
        ctx.fillText("+", key.x + key.w + h * 0.275, h / 2);
      }
    });
  },
  spotlight(ctx, s, a, view) {
    ctx.fillStyle = `rgba(5,0,56,${0.55 * a.alpha})`;
    ctx.beginPath();
    ctx.rect(view[0] - 1, view[1] - 1, view[2] + 2, view[3] + 2);
    ctx.roundRect(s.x, s.y, s.w, s.h, Math.min(s.w, s.h) * 0.12);
    ctx.fill("evenodd");
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * a.alpha})`;
    ctx.lineWidth = view[2] / 400;
    ctx.beginPath();
    ctx.roundRect(s.x, s.y, s.w, s.h, Math.min(s.w, s.h) * 0.12);
    ctx.stroke();
  },
};
function pulse(ctx, s, a, offsets) {
  const r = s.r,
    period = 1.3;
  for (const off of offsets) {
    const ph = (((a.age - off) % period) + period) % period / period;
    if (a.age < off) continue;
    ctx.strokeStyle = s.color;
    ctx.globalAlpha = a.alpha * (1 - ph);
    ctx.lineWidth = r * 0.18;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * (0.5 + 1.2 * easeOutCubic(ph)), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = a.alpha;
  const ph = (a.age % period) / period,
    press = ph < 0.12 ? 0.82 : 1;
  ctx.fillStyle = s.color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = r * 0.14;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r * 0.42 * press * (0.5 + 0.5 * a.pop), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  drawCursor(ctx, s.x + r * 0.1, s.y + r * 0.1, r * 1.25);
}
function drawSticker(ctx, s, a, view) {
  ctx.save();
  ctx.globalAlpha = a.alpha;
  DRAW[s.type](ctx, s, a, view);
  ctx.restore();
}
function bounds(s) {
  if (s.type === "arrow") {
    const g = arrowGeom(s),
      xs = [s.x, s.x2, (s.x + 2 * g.cx + s.x2) / 4],
      ys = [s.y, s.y2, (s.y + 2 * g.cy + s.y2) / 4];
    const x0 = Math.min(...xs),
      y0 = Math.min(...ys);
    return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
  }
  if (s.r) {
    const r = s.r;
    if (s.type === "rightclick") return { x: s.x - r * 3, y: s.y - r * 3.4, w: r * 9, h: r * 8.4 };
    return { x: s.x - r * 1.7, y: s.y - r * 1.9, w: r * 3.6, h: r * 3.6 };
  }
  if (s.type === "keys") return { x: s.x, y: s.y, w: s.w || s.h * 3, h: s.h };
  if (s.type === "bubble") return { x: s.x, y: s.y, w: s.w, h: s.h * 1.45 };
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}
function handles(s) {
  if (s.type === "arrow") return { p0: [s.x, s.y], p2: [s.x2, s.y2] };
  if (s.r) return { se: [s.x + s.r, s.y + s.r] };
  if (s.type === "keys") return { se: [s.x + (s.w || s.h * 3), s.y + s.h] };
  return { se: [s.x + s.w, s.y + s.h] };
}
function newSticker(type, px, py) {
  const def = STICKERS[type],
    [cx, cy, cw, ch] = cur.edit.crop,
    U = Math.max(cw, ch * 1.4) / 100;
  const s = { id: nextId++, type, color: def.color, text: def.text };
  if (type === "note") Object.assign(s, { w: 17 * U, h: 17 * U, x: px - 8.5 * U, y: py - 8.5 * U });
  else if (type === "bubble") Object.assign(s, { w: 24 * U, h: 8 * U, x: px - 4 * U, y: py - 11.6 * U });
  else if (type === "arrow") Object.assign(s, { x: px - 13 * U, y: py - 9 * U, x2: px, y2: py, w: 0.75 * U });
  else if (type === "keys") Object.assign(s, { h: 5.5 * U, x: px - 8 * U, y: py - 2.75 * U });
  else if (type === "spotlight") Object.assign(s, { w: 30 * U, h: 19 * U, x: px - 15 * U, y: py - 9.5 * U });
  else Object.assign(s, { r: 2.6 * U, x: px, y: py });
  if (type !== "arrow" && !s.r) {
    const b = bounds(s);
    s.x += clamp(b.x, cx, cx + cw - b.w) - b.x;
    s.y += clamp(b.y, cy, cy + ch - b.h) - b.y;
  }
  // Starts at the playhead and lasts a few seconds (a still image: always).
  s.from = s.until = null;
  if (cur.kind === "video") {
    // Begins a moment before the playhead, so it is fully visible right where you dropped it.
    const { start, end, speed } = timing(),
      s0 = clamp(toSrc(playhead), start, end) - 0.4 * speed;
    if (s0 > start + 0.05) s.from = Math.min(s0, end - 0.6 * speed);
    const until = (s.from ?? start) + def.dur * speed;
    if (until < end - 0.05) s.until = until;
  }
  return s;
}
function stickerLabel(s) {
  if (s.type === "note" || s.type === "bubble") return "“" + (s.text || "") + "”";
  if (s.type === "keys") return s.text || "Keys";
  return STICKERS[s.type].name;
}
function trackColor(s) {
  if (s.type === "spotlight") return "#6b6a8a";
  if (s.type === "keys") return "#050038";
  if (s.color?.toUpperCase() === "#FFFFFF") return "#c9cade";
  return s.color;
}

/* ======================================================================
   Rendering
   ====================================================================== */

const view = $("view"),
  vctx = view.getContext("2d");
let cropping = false,
  cropRegion = null;
let selected = null;

function frameSource(t) {
  return cur.source;
}
function viewRect() {
  return cropping ? [0, 0, cur.width, cur.height] : cur.edit.crop;
}
// Draws the frame at output time t into ctx (W × H), with stickers.
function renderFrame(ctx, W, H, t, opts = {}) {
  const r = opts.rect || cur.edit.crop,
    k = W / r[2];
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(frameSource(t), r[0], r[1], r[2], r[3], 0, 0, W, H);
  ctx.save();
  ctx.scale(k, H / r[3]);
  ctx.translate(-r[0], -r[1]);
  const shown = [];
  for (const s of cur.stickers) {
    const l = life(s, t);
    if (l) shown.push([s, anim(l)]);
  }
  for (const [s, a] of shown) if (s.type === "spotlight") drawSticker(ctx, s, a, r);
  for (const [s, a] of shown) if (s.type !== "spotlight") drawSticker(ctx, s, a, r);
  if (opts.ui && selected && shown.some(([s]) => s === selected)) drawSelection(ctx, selected, k);
  ctx.restore();
}
function drawSelection(ctx, s, k) {
  const b = bounds(s),
    px = 1 / k,
    pad = 6 * px * dpr();
  ctx.save();
  ctx.setLineDash([6 * px * dpr(), 4 * px * dpr()]);
  ctx.lineWidth = 1.5 * px * dpr();
  ctx.strokeStyle = "#4262FF";
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
  ctx.setLineDash([]);
  for (const [hx, hy] of Object.values(handles(s))) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#4262FF";
    ctx.lineWidth = 2.5 * px * dpr();
    ctx.beginPath();
    ctx.arc(hx, hy, 6.5 * px * dpr(), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
const dpr = () => window.devicePixelRatio || 1;

function fitView() {
  if (!cur || $("editor").hidden) return;
  const stage = $("stage"),
    r = viewRect(),
    availW = stage.clientWidth - 40,
    availH = stage.clientHeight - 40;
  const scale = Math.max(0.01, Math.min(availW / r[2], availH / r[3]));
  const cssW = Math.max(40, Math.round(r[2] * scale)),
    cssH = Math.max(30, Math.round(r[3] * scale));
  view.style.width = cssW + "px";
  view.style.height = cssH + "px";
  view.width = Math.round(cssW * dpr());
  view.height = Math.round(cssH * dpr());
  if (cropping) paintCropFrame();
  draw();
}
new ResizeObserver(() => fitView()).observe($("stage"));

function draw() {
  if (!cur) return;
  renderFrame(vctx, view.width, view.height, playhead, { ui: !exporting, rect: viewRect() });
  placeSelbar();
  $("emptyHint").hidden = cur.stickers.length > 0 || cropping;
}
// Source pixel coordinates under the pointer.
function toSource(e) {
  const b = view.getBoundingClientRect(),
    r = viewRect();
  return {
    x: r[0] + ((e.clientX - b.left) / b.width) * r[2],
    y: r[1] + ((e.clientY - b.top) / b.height) * r[3],
    k: b.width / r[2],
  };
}

/* ---------- Playback ---------- */

function syncUI(t) {
  playhead = t;
  $("tNow").textContent = fmt(t);
  updatePlayhead();
}
function setPosition(t) {
  if (!cur) return;
  const pos = clamp(t, 0, timing().total);
  syncUI(pos);
  if (cur.kind === "video") {
    const v = cur.source;
    v.onseeked = () => !exporting && draw();
    v.currentTime = sourceTime(pos);
  }
  draw();
}
function stopPlay() {
  playing = false;
  cancelAnimationFrame(frameReq);
  if (cur?.kind === "video") cur.source.pause();
  $("play").querySelector("use").setAttribute("href", "#i-play");
  $("play").setAttribute("aria-label", "Play");
}
function play() {
  if (playing) {
    stopPlay();
    return;
  }
  if (!cur || exporting) return;
  if (playhead >= timing().total - 0.02) setPosition(0);
  playing = true;
  $("play").querySelector("use").setAttribute("href", "#i-pause");
  $("play").setAttribute("aria-label", "Pause");
  playOrigin = performance.now() - playhead * 1000;
  const id = session_id;
  const tick = (now) => {
    if (!playing || id !== session_id) return;
    const { total, run, speed } = timing();
    let t = (now - playOrigin) / 1000;
    if (t >= total) {
      // Loop forever.
      t = 0;
      playOrigin = now;
      setPosition(0);
    }
    if (cur.kind === "video") {
      const v = cur.source;
      if (t >= run) {
        if (!v.paused) v.pause();
      } else if (v.paused && !v.seeking) {
        v.playbackRate = speed;
        v.play().catch(() => {});
      }
    }
    syncUI(t);
    draw();
    frameReq = requestAnimationFrame(tick);
  };
  frameReq = requestAnimationFrame(tick);
}
$("play").onclick = play;

/* ---------- History ---------- */

const snapshot = () => JSON.stringify({ edit: cur.edit, stickers: cur.stickers });
function commit(before) {
  if (before === snapshot()) return;
  cur.history.push(before);
  if (cur.history.length > 200) cur.history.shift();
  cur.future = [];
  updateUndo();
}
function restore(state) {
  const v = JSON.parse(state);
  const sel = selected?.id;
  cur.edit = v.edit;
  cur.stickers = v.stickers;
  selected = cur.stickers.find((s) => s.id === sel) || null;
  $("speed").value = String(cur.edit.speed);
  fitView();
  renderTimeline();
  setPosition(Math.min(playhead, timing().total));
}
function undo() {
  if (!cur?.history.length || exporting) return;
  stopPlay();
  cur.future.push(snapshot());
  restore(cur.history.pop());
  updateUndo();
}
function redo() {
  if (!cur?.future.length || exporting) return;
  stopPlay();
  cur.history.push(snapshot());
  restore(cur.future.pop());
  updateUndo();
}
function updateUndo() {
  $("undo").disabled = !cur?.history.length;
  $("redo").disabled = !cur?.future.length;
}
$("undo").onclick = undo;
$("redo").onclick = redo;

/* ======================================================================
   Sticker tray: drag a sticker onto the clip, or click to add it
   ====================================================================== */

function trayPreview(type) {
  const c = el("canvas");
  c.width = 128;
  c.height = 88;
  const ctx = c.getContext("2d");
  const s = { type, color: STICKERS[type].color, text: STICKERS[type].text };
  if (type === "note") Object.assign(s, { x: 40, y: 12, w: 48, h: 48, text: "Note" });
  else if (type === "bubble") Object.assign(s, { x: 20, y: 18, w: 88, h: 32, text: "Hello!" });
  else if (type === "arrow") Object.assign(s, { x: 26, y: 66, x2: 100, y2: 24, w: 5 });
  else if (type === "keys") Object.assign(s, { x: 0, y: 26, h: 34 });
  else if (type === "spotlight") Object.assign(s, { x: 34, y: 20, w: 60, h: 40 });
  else Object.assign(s, { r: 12, x: type === "rightclick" ? 52 : 60, y: type === "rightclick" ? 40 : 46 });
  if (type === "keys") {
    keysLayout(ctx, s);
    s.x = (128 - s.w) / 2;
  }
  if (type === "spotlight") {
    ctx.fillStyle = "#cfd4f5";
    ctx.fillRect(0, 0, 128, 88);
    ctx.fillStyle = "#9aa4e6";
    for (let i = 0; i < 4; i++) ctx.fillRect(12 + i * 28, 14 + (i % 2) * 30, 20, 26);
  }
  const still = type === "dblclick" || type === "click" || type === "rightclick" ? { ...STILL, age: 0.35 } : STILL;
  drawSticker(ctx, s, still, [0, 0, 128, 88]);
  return c;
}
let trayDrag = null;
function buildTray() {
  const grid = $("stickerGrid");
  for (const type of Object.keys(STICKERS)) {
    const tile = el("button", "sticker");
    tile.dataset.type = type;
    tile.title = "Drag onto your clip, or click to add";
    tile.append(trayPreview(type), el("span", "", STICKERS[type].name));
    // Mouse presses shouldn't leave focus on the tile (Space must stay "play").
    tile.onmousedown = (e) => e.preventDefault();
    tile.onpointerdown = (e) => {
      if (e.button !== 0 || !cur || exporting) return;
      trayDrag = { type, x: e.clientX, y: e.clientY, ghost: null, tile };
      tile.setPointerCapture(e.pointerId);
    };
    tile.onpointermove = (e) => {
      const d = trayDrag;
      if (!d) return;
      if (!d.ghost && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
        d.ghost = trayPreview(type);
        d.ghost.className = "dragghost";
        d.ghost.style.width = "110px";
        document.body.append(d.ghost);
      }
      if (d.ghost) {
        d.ghost.style.left = e.clientX + "px";
        d.ghost.style.top = e.clientY + "px";
        $("stage").classList.toggle("dropping", overView(e));
      }
    };
    tile.onpointerup = (e) => {
      const d = trayDrag;
      trayDrag = null;
      if (!d) return;
      $("stage").classList.remove("dropping");
      if (d.ghost) {
        d.ghost.remove();
        if (overView(e)) {
          const p = toSource(e);
          addSticker(type, p.x, p.y);
        }
      } else {
        const [x, y, w, h] = cur.edit.crop;
        addSticker(type, x + w / 2, y + h / 2);
      }
    };
    tile.onclick = (e) => {
      // Keyboard users: Enter or Space adds the sticker in the middle.
      if (e.detail !== 0 || !cur) return;
      const [x, y, w, h] = cur.edit.crop;
      addSticker(type, x + w / 2, y + h / 2);
    };
    tile.onpointercancel = () => {
      trayDrag?.ghost?.remove();
      trayDrag = null;
      $("stage").classList.remove("dropping");
    };
    grid.append(tile);
  }
}
function overView(e) {
  const b = view.getBoundingClientRect();
  return e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
}
function addSticker(type, x, y) {
  if (cropping) toggleCrop();
  stopPlay();
  const before = snapshot(),
    t1 = playhead;
  const s = newSticker(type, x, y);
  cur.stickers.push(s);
  selected = s;
  commit(before);
  setTool();
  renderTimeline();
  // Replay its entrance so the animation is visible right away.
  const a = s.from == null ? 0 : toOut(s.from);
  setPosition(a);
  previewEntrance(a, Math.min(Math.max(t1, a + 0.4), timing().total));
  if (TEXT_TYPES.includes(type)) setTimeout(() => $("selText").select(), 50);
}
function previewEntrance(t0, t1) {
  const start = performance.now(),
    id = session_id;
  const step = (now) => {
    if (id !== session_id || playing || dragging()) return;
    const t = t0 + (now - start) / 1000;
    if (t >= t1) {
      setPosition(t1);
      return;
    }
    syncUI(t);
    draw();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const dragging = () => !!(canvasDrag || tlDrag || trayDrag);

/* ---------- Selecting and editing stickers on the preview ---------- */

let canvasDrag = null;
function hitSticker(p) {
  const pad = 8 / p.k;
  for (let i = cur.stickers.length - 1; i >= 0; i--) {
    const s = cur.stickers[i];
    if (!life(s, playhead)) continue;
    if (s.type === "arrow") {
      const g = arrowGeom(s);
      for (let j = 0; j <= 24; j++) {
        const [qx, qy] = qpt(s, g, j / 24);
        if (Math.hypot(p.x - qx, p.y - qy) < s.w * 2 + pad) return s;
      }
      continue;
    }
    if (s.type === "spotlight") {
      // Only the border grabs a spotlight, so things inside stay clickable.
      const edge = 14 / p.k,
        inX = p.x > s.x - edge && p.x < s.x + s.w + edge,
        inY = p.y > s.y - edge && p.y < s.y + s.h + edge,
        nearEdge = Math.min(Math.abs(p.x - s.x), Math.abs(p.x - s.x - s.w), Math.abs(p.y - s.y), Math.abs(p.y - s.y - s.h)) < edge;
      if (inX && inY && nearEdge) return s;
      continue;
    }
    const b = bounds(s);
    if (p.x > b.x - pad && p.x < b.x + b.w + pad && p.y > b.y - pad && p.y < b.y + b.h + pad) return s;
  }
  return null;
}
function hitHandle(p) {
  if (!selected || !life(selected, playhead)) return null;
  for (const [name, [hx, hy]] of Object.entries(handles(selected)))
    if (Math.hypot(p.x - hx, p.y - hy) < 12 / p.k) return name;
  return null;
}
view.onpointerdown = (e) => {
  if (!cur || exporting || cropping || e.button !== 0) return;
  stopPlay();
  const p = toSource(e),
    handle = hitHandle(p),
    hit = handle ? selected : hitSticker(p);
  select(hit);
  if (!hit) return;
  view.setPointerCapture(e.pointerId);
  canvasDrag = { s: hit, handle, p, orig: JSON.parse(JSON.stringify(hit)), before: snapshot() };
};
view.onpointermove = (e) => {
  const p = toSource(e);
  const d = canvasDrag;
  if (!d) {
    if (cur && !cropping) view.style.cursor = hitHandle(p) ? "nwse-resize" : hitSticker(p) ? "move" : "default";
    return;
  }
  const s = d.s,
    o = d.orig,
    dx = p.x - d.p.x,
    dy = p.y - d.p.y,
    U = cur.edit.crop[2] / 100;
  if (!d.handle) {
    s.x = o.x + dx;
    s.y = o.y + dy;
    if (s.type === "arrow") {
      s.x2 = o.x2 + dx;
      s.y2 = o.y2 + dy;
    }
  } else if (d.handle === "p0") {
    s.x = o.x + dx;
    s.y = o.y + dy;
  } else if (d.handle === "p2") {
    s.x2 = o.x2 + dx;
    s.y2 = o.y2 + dy;
  } else if (s.r) s.r = Math.max(U, Math.hypot(p.x - s.x, p.y - s.y) / Math.SQRT2);
  else if (s.type === "keys") s.h = Math.max(2 * U, o.h + dy);
  else {
    s.w = Math.max(4 * U, o.w + dx);
    s.h = Math.max(3 * U, o.h + dy);
  }
  draw();
};
view.onpointerup = () => {
  if (!canvasDrag) return;
  commit(canvasDrag.before);
  canvasDrag = null;
  renderTimeline();
};
view.onpointercancel = view.onpointerup;
view.ondblclick = () => {
  if (selected && TEXT_TYPES.includes(selected.type)) $("selText").select();
};

function select(s) {
  selected = s || null;
  setTool();
  renderTimeline();
  draw();
}
function setTool() {
  const s = selected;
  $("selbar").hidden = !s;
  if (!s) return;
  $("selText").hidden = !TEXT_TYPES.includes(s.type);
  $("selText").value = s.text || "";
  $("selText").placeholder = s.type === "keys" ? "⌘ + Shift + P" : "Type here";
  const colors = $("selColors");
  colors.textContent = "";
  if (s.type !== "spotlight" && s.type !== "keys")
    for (const c of PALETTES[s.type] || PALETTES.other) {
      const b = el("button", s.color.toUpperCase() === c ? "on" : "");
      b.style.background = c;
      b.title = "Colour";
      b.onclick = () => {
        const before = snapshot();
        s.color = c;
        commit(before);
        setTool();
        renderTimeline();
        draw();
      };
      colors.append(b);
    }
}
function placeSelbar() {
  const s = selected,
    bar = $("selbar");
  if (!s || cropping || exporting || !life(s, playhead)) {
    bar.style.visibility = "hidden";
    return;
  }
  bar.style.visibility = "visible";
  const r = viewRect(),
    k = view.clientWidth / r[2],
    b = bounds(s);
  let left = (b.x + b.w / 2 - r[0]) * k,
    top = (b.y - r[1]) * k - 14;
  const below = top < bar.offsetHeight + 4;
  if (below) top = (b.y + b.h - r[1]) * k + 14 + bar.offsetHeight;
  left = clamp(left, bar.offsetWidth / 2, view.clientWidth - bar.offsetWidth / 2);
  bar.style.left = left + "px";
  bar.style.top = clamp(top, bar.offsetHeight, view.clientHeight + bar.offsetHeight + 20) + "px";
}
let textBefore = null;
$("selText").oninput = () => {
  if (!selected) return;
  textBefore ??= snapshot();
  selected.text = $("selText").value;
  draw();
  renderTimeline();
};
$("selText").onchange = $("selText").onblur = () => {
  if (textBefore) commit(textBefore);
  textBefore = null;
};
$("selText").onkeydown = (e) => {
  if (e.key === "Enter" || e.key === "Escape") $("selText").blur();
};
$("selDelete").onclick = () => selected && deleteSticker(selected);
function deleteSticker(s) {
  const before = snapshot();
  cur.stickers = cur.stickers.filter((x) => x !== s);
  if (selected === s) selected = null;
  commit(before);
  setTool();
  renderTimeline();
  draw();
}

/* ---------- Crop ---------- */

function toggleCrop() {
  if (!cur) return;
  stopPlay();
  if (!cropping) {
    cropping = true;
    const [x, y, w, h] = cur.edit.crop;
    cropRegion = { x: x / cur.width, y: y / cur.height, w: w / cur.width, h: h / cur.height };
  } else {
    cropping = false;
    const before = snapshot(),
      r = cropRegion;
    cur.edit.crop = [r.x * cur.width, r.y * cur.height, r.w * cur.width, r.h * cur.height].map((v) => Math.round(v));
    commit(before);
    renderTimeline();
  }
  $("cropFrame").hidden = !cropping;
  $("cropBtn").classList.toggle("on", cropping);
  $("cropBtn").querySelector("span").textContent = cropping ? "Done" : "Crop";
  updateCropReset();
  fitView();
}
function updateCropReset() {
  const [x, y, w, h] = cur.edit.crop;
  $("cropReset").hidden = cropping || (x === 0 && y === 0 && w === cur.width && h === cur.height);
}
$("cropBtn").onclick = toggleCrop;
$("cropReset").onclick = () => {
  const before = snapshot();
  cur.edit.crop = [0, 0, cur.width, cur.height];
  commit(before);
  updateCropReset();
  fitView();
  renderTimeline();
};
function paintCropFrame() {
  const r = cropRegion,
    f = $("cropFrame");
  Object.assign(f.style, {
    left: r.x * 100 + "%",
    top: r.y * 100 + "%",
    width: r.w * 100 + "%",
    height: r.h * 100 + "%",
  });
}
let cropDrag = null;
$("cropFrame").onpointerdown = (e) => {
  cropDrag = { x: e.clientX, y: e.clientY, r: { ...cropRegion }, corner: [...$("cropFrame").children].indexOf(e.target) };
  $("cropFrame").setPointerCapture(e.pointerId);
};
$("cropFrame").onpointermove = (e) => {
  const d = cropDrag;
  if (!d) return;
  const dx = (e.clientX - d.x) / view.clientWidth,
    dy = (e.clientY - d.y) / view.clientHeight,
    i = d.r,
    min = 0.05;
  if (d.corner < 0) cropRegion = { ...i, x: clamp(i.x + dx, 0, 1 - i.w), y: clamp(i.y + dy, 0, 1 - i.h) };
  else {
    const left = d.corner % 2 === 0,
      top = d.corner < 2;
    let x0 = i.x,
      y0 = i.y,
      x1 = i.x + i.w,
      y1 = i.y + i.h;
    if (left) x0 = clamp(x0 + dx, 0, x1 - min);
    else x1 = clamp(x1 + dx, x0 + min, 1);
    if (top) y0 = clamp(y0 + dy, 0, y1 - min);
    else y1 = clamp(y1 + dy, y0 + min, 1);
    cropRegion = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  paintCropFrame();
};
$("cropFrame").onlostpointercapture = () => (cropDrag = null);

/* ======================================================================
   Timeline: the whole recording on one ruler, cut parts hatched
   ====================================================================== */

let axisLen = 1,
  tlDrag = null;
const across = (f) => `calc(var(--lab) + (100% - var(--lab)) * ${f})`;
function computeAxis() {
  if (cur.kind === "video") axisLen = cur.length;
  else axisLen = Math.max(cur.edit.end * 1.35, cur.edit.end + 1.5);
}
function pct(s) {
  return (100 * clamp(s, 0, axisLen)) / axisLen + "%";
}
function place(node, a, b) {
  node.style.left = pct(a);
  node.style.width = (100 * Math.max(0, Math.min(b, axisLen) - Math.max(a, 0))) / axisLen + "%";
}
function playheadSource() {
  const { start, end } = timing();
  return clamp(toSrc(playhead), start, end);
}
function updatePlayhead() {
  if (cur) $("playhead").style.left = across(playheadSource() / axisLen);
}
function renderTimeline() {
  if (!cur) return;
  if (!tlDrag) computeAxis();
  const { start, end, total } = timing();
  $("tTotal").textContent = fmt(total);
  $("cutReset").hidden = !(start > 0.001 || end < cur.length - 0.001) || cur.kind !== "video";
  updateCropReset();

  const ruler = $("ruler");
  ruler.textContent = "";
  const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((v) => axisLen / v <= 10) || 60;
  for (let i = 0; i * step <= axisLen + 1e-9; i++) {
    const t = i * step,
      tick = el("span", "tick", t <= axisLen - step * 0.5 ? (step < 1 ? t.toFixed(2).replace(/0$/, "") : Math.round(t)) + "s" : "");
    tick.style.left = pct(t);
    ruler.append(tick);
  }
  const rows = $("rows");
  rows.textContent = "";
  // The clip stays pinned on top; each sticker gets its own line below, newest first.
  rows.append(clipRow());
  for (let i = cur.stickers.length - 1; i >= 0; i--) rows.append(stickerRow(cur.stickers[i]));
  if (!cur.stickers.length)
    rows.append(el("p", "tlempty", "Stickers you add get their own line here. Drag them to choose when they show."));
  updatePlayhead();
}
function cutOverlays(lane) {
  const { start, end } = timing();
  if (cur.kind !== "video") return;
  for (const [a, b] of [[0, start], [end, cur.length]])
    if (b - a > 0.001) {
      const z = el("div", "lanecut");
      place(z, a, b);
      lane.append(z);
    }
}
function stickerRow(s) {
  const row = el("div", "trow" + (s === selected ? " selected" : ""));
  const lab = el("div", "tlab");
  const sw = el("span", "sw");
  sw.style.background = trackColor(s);
  const del = el("button", "del icon");
  del.title = "Delete";
  del.setAttribute("aria-label", "Delete sticker");
  del.innerHTML = '<svg><use href="#i-trash"/></svg>';
  del.onclick = (e) => {
    e.stopPropagation();
    deleteSticker(s);
  };
  lab.append(sw, el("span", "name", stickerLabel(s)), del);
  lab.onclick = () => {
    stopPlay();
    selected = s;
    setTool();
    if (!life(s, playhead)) setPosition(s.from == null ? 0 : toOut(s.from) + 0.4);
    renderTimeline();
    draw();
  };
  const lane = el("div", "lane");
  cutOverlays(lane);
  const { start, end } = timing();
  const a = s.from ?? start,
    b = s.until ?? end;
  const block = el("div", "block sblock" + (lightColor(trackColor(s)) ? " dark" : ""), STICKERS[s.type].name);
  block.dataset.drag = "move";
  block.sticker = s;
  block.style.setProperty("--c", trackColor(s));
  block.title = "Drag to move it in time. Drag an end to change how long it shows.";
  place(block, a, b);
  const l = el("i", "h l"),
    r = el("i", "h r");
  l.dataset.drag = "s-l";
  r.dataset.drag = "s-r";
  block.append(l, r);
  lane.append(block);
  row.append(lab, lane);
  return row;
}
function clipRow() {
  const { start, end, speed } = timing();
  const video = cur.kind === "video";
  const row = el("div", "trow cliprow");
  const lab = el("div", "tlab", video ? "🎬 Clip" : "🖼 Image");
  lab.style.cursor = "default";
  const lane = el("div", "lane");
  const film = el("div", "film");
  place(film, 0, video ? cur.length : end);
  const strip = filmStrip(video ? cur.length : end);
  if (strip) film.append(strip);
  lane.append(film);
  if (video)
    for (const [a, b] of [[0, start], [end, cur.length]])
      if (b - a > 0.001) {
        const z = el("div", "cutzone");
        place(z, a, b);
        if ((b - a) / axisLen > 0.08) z.append(el("span", "", "cut"));
        lane.append(z);
      }
  const block = el("div", "block clipblock");
  place(block, start, end);
  if (video) {
    const l = el("i", "h l");
    l.dataset.drag = "trim-l";
    l.title = "Drag to cut the start";
    block.append(l);
  }
  const r = el("i", "h r");
  r.dataset.drag = "trim-r";
  r.title = video ? "Drag to cut the end" : "Drag to show the image for longer";
  block.append(r);
  lane.append(block);
  const total = timing().total;
  const label = el("span", "cliplabel", (total < 60 ? total.toFixed(1) + " s" : fmt(total)) + (speed !== 1 ? " · " + speed + "×" : ""));
  label.style.left = `calc(${pct(start)} + 14px)`;
  lane.append(label);
  row.append(lab, lane);
  return row;
}
function filmStrip(len) {
  const thumbs = cur.thumbs;
  if (!thumbs?.length) return null;
  const width = ($("ruler").clientWidth * Math.min(len, axisLen)) / axisLen,
    h = 42,
    ratio = dpr();
  if (width < 4) return null;
  const c = el("canvas");
  c.width = Math.round(width * ratio);
  c.height = h * ratio;
  const ctx = c.getContext("2d"),
    [cx, cy, cw, ch] = cur.edit.crop,
    tw = clamp((h * cw) / ch, h * 0.7, h * 2.4),
    sx = thumbs[0].width / cur.width;
  ctx.scale(ratio, ratio);
  for (let x = 0; x < width; x += tw) {
    const s = ((x + tw / 2) / width) * len,
      i = clamp(Math.floor((s / cur.length) * thumbs.length), 0, thumbs.length - 1);
    ctx.drawImage(thumbs[i], cx * sx, cy * sx, cw * sx, ch * sx, x, 0, tw, h);
  }
  return c;
}
async function buildThumbs(p) {
  const h = 64,
    w = Math.round(clamp((h * p.width) / p.height, 32, 160));
  const shoot = (src) => {
    const c = el("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(src, 0, 0, w, h);
    return c;
  };
  if (p.kind !== "video") {
    p.thumbs = [shoot(p.source)];
    if (p === cur) renderTimeline();
    return;
  }
  const count = Math.min(30, Math.max(6, Math.ceil(p.length / 0.5))),
    list = [];
  p.thumbs = [];
  try {
    const v = el("video");
    v.muted = true;
    v.preload = "auto";
    await waitEvent(v, "loadeddata", () => (v.src = p.url));
    for (let i = 0; i < count; i++) {
      if (!projects.includes(p)) return;
      await seekVideo(v, Math.min(((i + 0.5) * p.length) / count, p.length - 0.02));
      list.push(shoot(v));
      if (i % 6 === 5 || i === count - 1) {
        p.thumbs = list.slice();
        if (p === cur && !tlDrag) renderTimeline();
      }
    }
    v.removeAttribute("src");
    v.load();
  } catch {}
}
let tracksWidth = 0;
new ResizeObserver(() => {
  const w = $("tracks").clientWidth;
  if (w !== tracksWidth && cur && !tlDrag) {
    tracksWidth = w;
    renderTimeline();
  }
}).observe($("tracks"));

const tracks = $("tracks");
function sourceAt(e) {
  const r = $("ruler").getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * axisLen;
}
function seekSource(s) {
  const { start, end, speed } = timing();
  setPosition((clamp(s, start, end) - start) / speed);
}
tracks.onpointerdown = (e) => {
  if (!cur || exporting || e.button !== 0 || e.target.closest(".tlab")) return;
  stopPlay();
  e.preventDefault();
  tracks.setPointerCapture(e.pointerId);
  const s = sourceAt(e),
    h = e.target.closest("[data-drag]"),
    type = h?.dataset.drag;
  if (!type) {
    tlDrag = { type: "seek" };
    seekSource(s);
    return;
  }
  const sticker = h.closest(".block")?.sticker;
  const { start, end } = timing();
  tlDrag = { type, s0: s, before: snapshot(), sticker };
  if (sticker) {
    tlDrag.a = sticker.from ?? start;
    tlDrag.b = sticker.until ?? end;
    selected = sticker;
    setTool();
    renderTimeline();
    draw();
  }
};
tracks.onpointermove = (e) => {
  const d = tlDrag;
  if (!d) return;
  const s = sourceAt(e),
    { start, end, speed } = timing(),
    MIN = 0.2 * speed;
  if (d.type === "seek") seekSource(s);
  else if (d.sticker) {
    let { a, b } = d;
    const ds = s - d.s0;
    if (d.type === "move") {
      const shift = clamp(ds, start - a, end - b);
      a += shift;
      b += shift;
    } else if (d.type === "s-l") a = clamp(a + ds, start, b - MIN);
    else b = clamp(b + ds, a + MIN, end);
    d.sticker.from = a <= start + 0.02 ? null : a;
    d.sticker.until = b >= end - 0.02 ? null : b;
    renderTimeline();
    // Show the moment being edited, entrance included.
    setPosition(toOut(d.type === "s-r" ? Math.max(a, b - 0.05) : Math.min(a + 0.45, b - 0.01)));
  } else if (d.type === "trim-l") {
    cur.edit.start = clamp(s, 0, end - MIN);
    renderTimeline();
    setPosition(0);
  } else if (d.type === "trim-r") {
    cur.edit.end = clamp(s, start + MIN, cur.maxEnd);
    renderTimeline();
    setPosition(timing().run - 0.001);
  }
};
function endTimelineDrag() {
  const d = tlDrag;
  if (!d) return;
  tlDrag = null;
  if (d.type !== "seek") commit(d.before);
  renderTimeline();
}
tracks.onpointerup = tracks.onpointercancel = tracks.onlostpointercapture = endTimelineDrag;

/* Cutting at the playhead */
function cut(which) {
  if (!cur || cur.kind !== "video" || exporting) return;
  stopPlay();
  const { start, end, speed } = timing(),
    s = playheadSource();
  if (which === "start" ? s <= start + 0.05 || s >= end - 0.2 * speed : s >= end - 0.05 || s <= start + 0.2 * speed) {
    toast(which === "start" ? "Move the playhead to where the clip should begin." : "Move the playhead to where the clip should end.");
    return;
  }
  const before = snapshot();
  if (which === "start") cur.edit.start = s;
  else cur.edit.end = s;
  commit(before);
  renderTimeline();
  setPosition(which === "start" ? 0 : timing().run - 0.001);
  toast(which === "start" ? "Trimmed the start. Undo brings it back." : "Trimmed the end. Undo brings it back.");
}
$("cutStart").onclick = () => cut("start");
$("cutEnd").onclick = () => cut("end");
$("cutReset").onclick = () => {
  stopPlay();
  const before = snapshot();
  cur.edit.start = 0;
  cur.edit.end = cur.length;
  commit(before);
  renderTimeline();
  setPosition(0);
};
$("speed").onchange = () => {
  stopPlay();
  const before = snapshot();
  cur.edit.speed = Number($("speed").value);
  commit(before);
  renderTimeline();
  setPosition(Math.min(playhead, timing().total));
};

/* ---------- Keyboard ---------- */

document.addEventListener("keydown", (e) => {
  if (!cur || $("editor").hidden || exporting || $("exportDialog").open) return;
  if (e.target.closest?.("input, select, textarea")) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
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
    setPosition(playhead + (e.shiftKey ? 1 : 0.1) * (e.key === "ArrowLeft" ? -1 : 1));
  } else if (e.key === "[") cut("start");
  else if (e.key === "]") cut("end");
  else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
    e.preventDefault();
    deleteSticker(selected);
  } else if (e.key === "Escape") {
    if (cropping) toggleCrop();
    else select(null);
  }
});

/* ======================================================================
   Export: GIF, MP4 and PNG, with visual quality previews
   ====================================================================== */

const MP4_OK = !!(window.VideoEncoder && window.Mp4Muxer && window.VideoFrame);
const PRESETS = {
  gif: [
    { id: "small", name: "Small", edge: 480, fps: 8, colors: 64, hint: "Fast to load" },
    { id: "balanced", name: "Balanced", edge: 720, fps: 12, colors: 128, hint: "Good for READMEs" },
    { id: "sharp", name: "Sharp", edge: 1080, fps: 15, colors: 256, hint: "Crisp, bigger file" },
  ],
  mp4: [
    { id: "small", name: "Small", edge: 720, fps: 30, bitrate: 1.2e6, hint: "Quick to share" },
    { id: "balanced", name: "Balanced", edge: 1280, fps: 30, bitrate: 2.5e6, hint: "Good for READMEs" },
    { id: "sharp", name: "Sharp", edge: 1920, fps: 30, bitrate: 5e6, hint: "Full detail" },
  ],
  png: [
    { id: "half", name: "Smaller", scale: 0.5, hint: "Half size" },
    { id: "full", name: "Original", scale: 1, hint: "Every pixel" },
  ],
};
const FORMAT_INFO = {
  gif: { name: "GIF", note: "Plays everywhere, including GitHub READMEs. Loops on its own." },
  mp4: { name: "MP4", note: "Much smaller and sharper. GitHub plays it inline when you drag it into a README or issue." },
  png: { name: "PNG", note: "A still picture of the current frame, stickers included." },
};
let exportPrefs = { format: "gif", gif: "balanced", mp4: "balanced", png: "full" };
try {
  Object.assign(exportPrefs, JSON.parse(store.get("clipnote-export") || "{}"));
} catch {}
if (!MP4_OK && exportPrefs.format === "mp4") exportPrefs.format = "gif";
let estToken = 0,
  estRun = Promise.resolve();

function outSize(preset) {
  const [, , cw, ch] = cur.edit.crop,
    long = Math.max(cw, ch);
  const k = preset.scale ?? Math.min(1, preset.edge / long);
  let w = Math.max(2, Math.round(cw * k)),
    h = Math.max(2, Math.round(ch * k));
  if (exportPrefs.format === "mp4") {
    w -= w % 2;
    h -= h % 2;
  }
  return { w, h };
}
function frameTimes(fps) {
  const { total } = timing(),
    n = Math.max(1, Math.ceil(total * fps - 1e-6));
  return Array.from({ length: n + 1 }, (_, i) => Math.min(total, i / fps));
}
function animated() {
  return cur.kind === "video" || cur.stickers.length > 0;
}

function openExport() {
  if (!cur || exporting) return;
  stopPlay();
  if (cropping) toggleCrop();
  $("hold").value = String(cur.edit.hold);
  $("holdWrap").hidden = cur.kind !== "video";
  renderFormats();
  $("exportDialog").returnValue = "";
  $("exportDialog").showModal();
  refreshQualities();
}
$("exportBtn").onclick = openExport;
function renderFormats() {
  const box = $("formats");
  box.textContent = "";
  for (const f of ["gif", "mp4", "png"]) {
    if (f === "mp4" && !MP4_OK) continue;
    const b = el("button", exportPrefs.format === f ? "on" : "", FORMAT_INFO[f].name);
    b.type = "button";
    b.onclick = () => {
      exportPrefs.format = f;
      savePrefs();
      renderFormats();
      refreshQualities();
    };
    box.append(b);
  }
  $("formatNote").textContent =
    FORMAT_INFO[exportPrefs.format].note +
    (!MP4_OK && exportPrefs.format === "gif" ? " MP4 export needs Chrome, Edge or Safari." : "");
  $("holdWrap").hidden = cur.kind !== "video" || exportPrefs.format === "png";
}
function savePrefs() {
  store.set("clipnote-export", JSON.stringify(exportPrefs));
}
$("hold").onchange = () => {
  const before = snapshot();
  cur.edit.hold = Number($("hold").value);
  commit(before);
  renderTimeline();
  refreshQualities();
};

// One card per quality, each with a zoomed-in sample of the real output.
function refreshQualities() {
  const f = exportPrefs.format,
    box = $("qualities");
  box.textContent = "";
  // For MP4, options that end up the same size are merged into the sharper one.
  let list = PRESETS[f];
  if (f === "mp4")
    list = list.filter((p, i) => {
      const next = list[i + 1];
      return !next || outSize(next).w !== outSize(p).w;
    });
  if (!list.some((p) => p.id === exportPrefs[f])) exportPrefs[f] = list.at(-1).id;
  const cards = list.map((p) => {
    const { w, h } = outSize(p);
    const b = el("button", "quality" + (exportPrefs[f] === p.id ? " on" : ""));
    b.type = "button";
    const c = el("canvas");
    c.width = 320;
    c.height = 200;
    const size = el("small", "size", "Estimating…");
    b.append(c, el("b", "", p.name), el("small", "", w + " × " + h + (f === "gif" ? " · " + p.fps + " fps" : "") + " · " + p.hint), size);
    b.onclick = () => {
      exportPrefs[f] = p.id;
      savePrefs();
      box.querySelectorAll(".quality").forEach((x) => x.classList.toggle("on", x === b));
    };
    box.append(b);
    return { p, c, size, w, h };
  });
  estRun = estimateAll(cards);
}
// The area the previews zoom into: the selected sticker, else the first one, else the middle.
function focusRect() {
  const [cx, cy, cw, ch] = cur.edit.crop,
    target = selected || cur.stickers.find((s) => life(s, playhead)) || null;
  const fw = cw * 0.32,
    fh = (fw * 200) / 320;
  let x = cx + cw / 2,
    y = cy + ch / 2;
  if (target) {
    const b = bounds(target);
    x = b.x + b.w / 2;
    y = b.y + b.h / 2;
  }
  return [clamp(x - fw / 2, cx, cx + cw - fw), clamp(y - fh / 2, cy, cy + ch - fh), fw, fh];
}
async function estimateAll(cards) {
  const token = ++estToken;
  await estRun.catch(() => {});
  if (token !== estToken) return;
  exporting = true;
  if (cur.kind === "video") cur.source.onseeked = null;
  const f = exportPrefs.format,
    t0 = playhead,
    zoom = focusRect(),
    [cx, cy, cw] = cur.edit.crop;
  try {
    if (cur.kind === "video") await seekVideo(cur.source, sourceTime(t0));
    for (const card of cards) {
      if (token !== estToken) return;
      const out = el("canvas");
      out.width = card.w;
      out.height = card.h;
      const octx = out.getContext("2d", { willReadFrequently: true });
      renderFrame(octx, card.w, card.h, t0);
      let bytes = 0;
      if (f === "gif") {
        const { quantize, applyPalette, GIFEncoder } = window.GifEnc;
        const img = octx.getImageData(0, 0, card.w, card.h),
          palette = quantize(img.data, card.p.colors),
          idx = applyPalette(img.data, palette);
        for (let i = 0; i < idx.length; i++) {
          const c = palette[idx[i]];
          img.data[i * 4] = c[0];
          img.data[i * 4 + 1] = c[1];
          img.data[i * 4 + 2] = c[2];
        }
        octx.putImageData(img, 0, 0);
        const enc = GIFEncoder();
        enc.writeFrame(idx, card.w, card.h, { palette });
        enc.finish();
        const frames = animated() ? frameTimes(card.p.fps).length - 1 : 1;
        // Screen recordings have many still moments that compress well.
        bytes = enc.bytesView().length * frames * (cur.kind === "video" ? 0.75 : 1);
      } else if (f === "mp4") {
        bytes = (card.p.bitrate * timing().total) / 8;
      } else {
        const blob = await new Promise((r) => out.toBlob(r, "image/png"));
        bytes = blob?.size || 0;
      }
      // Zoomed sample so the difference in quality is visible.
      const k = card.w / cw,
        cctx = card.c.getContext("2d");
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(out, (zoom[0] - cx) * k, (zoom[1] - cy) * k, zoom[2] * k, zoom[3] * k, 0, 0, 320, 200);
      card.size.textContent = (f === "mp4" ? "Up to " : f === "png" ? "" : "About ") + fmtBytes(bytes);
      await pause(0);
    }
  } catch {
    cards.forEach((c) => c.size.textContent === "Estimating…" && (c.size.textContent = ""));
  } finally {
    exporting = false;
  }
}
$("exportDialog").onclose = async () => {
  estToken++;
  await estRun.catch(() => {});
  setPosition(playhead);
  if ($("exportDialog").returnValue !== "export") return;
  const f = exportPrefs.format,
    preset = PRESETS[f].find((p) => p.id === exportPrefs[f]) || PRESETS[f].at(-1);
  await runExport(f, preset);
};

function fileName(ext) {
  const d = new Date(),
    pad = (n) => String(n).padStart(2, "0");
  return `clipnote-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function lockUI(on) {
  exporting = on;
  $("editor").inert = on;
  $("tabs").inert = on;
  $("exportBtn").disabled = $("newBtn").disabled = on;
}
async function runExport(f, preset) {
  stopPlay();
  lockUI(true);
  const original = playhead;
  if (cur.kind === "video") cur.source.onseeked = null;
  const { w, h } = outSize(preset);
  try {
    let blob;
    if (f === "png") {
      const c = el("canvas");
      c.width = w;
      c.height = h;
      if (cur.kind === "video") await seekVideo(cur.source, sourceTime(playhead));
      renderFrame(c.getContext("2d"), w, h, playhead);
      blob = await new Promise((r) => c.toBlob(r, "image/png"));
    } else if (f === "gif") blob = await exportGif(preset, w, h);
    else blob = await exportMp4(preset, w, h);
    const name = fileName(f);
    download(blob, name);
    toast("Saved " + name + " · " + fmtBytes(blob.size), 5000);
  } catch (err) {
    toast("Export did not finish. " + (err.message || err), 6000);
  } finally {
    lockUI(false);
    setPosition(original);
  }
}
const progress = (what, i, n) => toast(what + " · " + Math.round((100 * i) / n) + "%", 0);

async function exportGif(p, w, h) {
  const { GIFEncoder, quantize, applyPalette } = window.GifEnc,
    enc = GIFEncoder(),
    c = el("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const times = animated() ? frameTimes(p.fps) : [0, timing().total];
  let pending = null,
    prev = null;
  const flush = () => pending && enc.writeFrame(pending.idx, w, h, { palette: pending.palette, delay: pending.delay, repeat: 0 });
  for (let i = 0; i < times.length - 1; i++) {
    const t = times[i];
    if (cur.kind === "video") await seekVideo(cur.source, sourceTime(t));
    syncUI(t);
    renderFrame(ctx, w, h, t);
    // GIF delays are whole hundredths of a second: round the running total, not each frame.
    const data = ctx.getImageData(0, 0, w, h).data,
      delay = (Math.round(times[i + 1] * 100) - Math.round(t * 100)) * 10;
    const words = new Uint32Array(data.buffer);
    // Identical frames are merged into one longer frame.
    if (prev && pending && words.every((v, j) => v === prev[j])) pending.delay += delay;
    else {
      flush();
      const palette = quantize(data, p.colors);
      pending = { idx: applyPalette(data, palette), palette, delay };
      prev = words.slice();
    }
    progress("Making your GIF", i + 1, times.length - 1);
    if (i % 2 === 0) await pause(0);
  }
  flush();
  enc.finish();
  return new Blob([enc.bytesView()], { type: "image/gif" });
}

async function pickCodec(w, h, bitrate, fps) {
  const tries = [
    ["avc1.640033", "avc"],
    ["avc1.4d0033", "avc"],
    ["avc1.42003e", "avc"],
    ["avc1.42001f", "avc"],
    ["vp09.00.40.08", "vp9"],
    ["av01.0.08M.08", "av1"],
  ];
  for (const [codec, kind] of tries) {
    const config = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: "quality" };
    if (kind === "avc") config.avc = { format: "avc" };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, kind };
    } catch {}
  }
  throw new Error("This browser cannot make MP4 files. Try GIF instead.");
}
async function exportMp4(p, w, h) {
  const { config, kind } = await pickCodec(w, h, p.bitrate, p.fps);
  const target = new Mp4Muxer.ArrayBufferTarget(),
    muxer = new Mp4Muxer.Muxer({ target, video: { codec: kind, width: w, height: h, frameRate: p.fps }, fastStart: "in-memory" });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure(config);
  const c = el("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d"),
    { total } = timing(),
    n = Math.max(1, Math.round(total * p.fps)),
    us = 1e6 / p.fps;
  for (let i = 0; i < n; i++) {
    if (failure) throw failure;
    const t = i / p.fps;
    if (cur.kind === "video") await seekVideo(cur.source, sourceTime(t));
    syncUI(t);
    renderFrame(ctx, w, h, t);
    const frame = new VideoFrame(c, { timestamp: Math.round(i * us), duration: Math.round(us) });
    encoder.encode(frame, { keyFrame: i % (p.fps * 2) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 8) await pause(2);
    progress("Making your MP4", i + 1, n);
    if (i % 3 === 0) await pause(0);
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}

/* ---------- Start ---------- */

buildTray();
showScreen("home");
