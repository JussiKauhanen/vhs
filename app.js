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
function toast(text, ms = 3200, action) {
  const t = $("toast");
  t.textContent = text;
  if (action) {
    const b = el("button", "toastbtn", action.label);
    b.onclick = () => {
      t.hidden = true;
      action.run();
    };
    t.append(b);
  }
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
  themeFloater();
};
paintThemeButton();

/* ---------- Screens ---------- */

let screenName = "home";
function showScreen(name) {
  screenName = name;
  for (const id of ["home", "capture", "editor"]) $(id).hidden = id !== name;
  const editing = name === "editor";
  // Open clips stay as tabs on the home page too, so you can jump back into one.
  $("tabs").hidden = !(editing || (name === "home" && projects.length));
  $("homeBtn").hidden = !editing;
  $("editTools").hidden = !editing;
  $("newBtn").hidden = !editing;
  $("exportBtn").hidden = !editing;
  $("saveState").hidden = !editing;
  if (editing) requestAnimationFrame(fitView);
  if (name === "home") renderLibrary();
  if (projects.length) renderTabs();
}
function goHome() {
  if (session || exporting) return;
  stopPlay();
  if (cropping) toggleCrop();
  if (cur) {
    cur.playhead = playhead;
    flushSave(cur);
  }
  showScreen("home");
}
$("homeLogo").onclick = goHome;
$("homeBtn").onclick = goHome;

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
    const options = { video: { frameRate: 30 }, audio: false };
    // Bring the window you picked to the front (like Teams), instead of jumping back here.
    if (window.CaptureController) {
      const controller = new CaptureController();
      try {
        controller.setFocusBehavior("focus-captured-surface");
        options.controller = controller;
      } catch {}
    }
    const picked = await navigator.mediaDevices.getDisplayMedia(options);
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
    showInFloater(picked);
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
  document.title = "Clipnote";
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
        session.clip = { blob: new Blob(chunks, { type: r.mimeType }), length };
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
  if (recorder?.state === "recording") document.title = "● REC " + t + " · Clipnote";
  if (floater) {
    floater.doc.querySelector(".time").textContent = t;
    floater.doc.querySelector(".pilltext").textContent = (recorder?.state === "paused" ? "PAUSED " : "REC ") + t;
  }
}
function updateCapture() {
  const state = capState(),
    shots = session?.shots.length || 0;
  const label = { pick: "Choose a screen", ready: "Ready to record", recording: "Recording", paused: "Paused" }[state];
  $("capLabel").textContent = label;
  $("capDot").classList.toggle("on", state === "recording");
  $("cRecord").querySelector("span").textContent = recorder ? "Stop" : "Record";
  $("cRecord").classList.toggle("stopping", !!recorder);
  $("cRecord").querySelector("use").setAttribute("href", recorder ? "#i-stop" : "#i-rec");
  $("cPause").hidden = !recorder;
  $("cPause").querySelector("span").textContent = state === "paused" ? "Resume" : "Pause";
  $("cDone").hidden = !!recorder;
  $("cShotCount").hidden = !shots;
  $("cShotCount").textContent = shots;
  const screen = $("capture"),
    mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  screen.classList.toggle("floating", !!floater);
  screen.classList.toggle("recording", state === "recording");
  $("capTitle").textContent =
    state === "recording" ? "Recording…" : state === "paused" ? "Paused" : state === "pick" ? "Pick a window to share" : "You’re sharing a window";
  $("capHint").textContent = floater
    ? "Go ahead and use the window you picked. Your controls and a live preview float on top of everything, so you never need to come back here."
    : "Use the window you picked, then come back to this tab to stop. Tip: share a single window rather than the entire screen.";
  $("capTip").innerHTML = floater
    ? (mac ? "Tip: press <kbd>⌘</kbd> <kbd>M</kbd>" : "Tip: press <kbd>Win</kbd> <kbd>↓</kbd>") +
      " to tuck this browser window away. The floating controls stay put."
    : "";
  $("capTip").hidden = !floater;
  document.title = state === "recording" ? "● REC " + fmtClock(recordedTime()) + " · Clipnote" : state === "paused" ? "Ⅱ Paused · Clipnote" : "Clipnote";
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
body{font:600 13px system-ui,-apple-system,sans-serif;background:#16161f;color:#f1f0ff;overflow:hidden}
.wrap{height:100%;display:flex;flex-direction:column;gap:8px;padding:8px}
.screen{position:relative;flex:1;min-height:0;border-radius:12px;background:#000;overflow:hidden;box-shadow:inset 0 0 0 3px #4262ff}
.screen video{position:absolute;inset:3px;width:calc(100% - 6px);height:calc(100% - 6px);object-fit:contain;border-radius:9px}
.empty{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:12px;color:#b1b0c9;font-size:13px}
body:not([data-state=pick]) .empty{display:none}
body[data-state=recording] .screen{box-shadow:inset 0 0 0 3px #ff4d4d,0 0 0 1px #ff4d4d55}
body[data-state=paused] .screen{box-shadow:inset 0 0 0 3px #ffb020}
.pill{position:absolute;left:10px;top:10px;display:none;align-items:center;gap:6px;background:#ff4d4d;color:#fff;font:700 11px ui-monospace,Menlo,monospace;letter-spacing:.06em;padding:3px 8px;border-radius:7px}
.pill i{width:7px;height:7px;border-radius:50%;background:#fff;animation:b 1s infinite}
body[data-state=recording] .pill{display:inline-flex}
body[data-state=paused] .pill{display:inline-flex;background:#ffb020;color:#16161f}
body[data-state=paused] .pill i{animation:none;background:#16161f}
@keyframes b{50%{opacity:.25}}
.bar{display:flex;align-items:center;gap:6px}
.status{display:flex;flex-direction:column;flex:1;min-width:0;line-height:1.15;padding-left:2px}
.label{font-size:11px;color:#9a99b6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.time{font:600 15px ui-monospace,Menlo,monospace}
button{display:none;align-items:center;gap:5px;border:0;border-radius:10px;padding:8px 10px;font:inherit;cursor:pointer;background:#2a2a38;color:#f1f0ff}
button:hover{background:#353547}
button:active{transform:scale(.96)}
button svg{width:16px;height:16px}
.primary{background:#4262ff}.primary:hover{background:#3150f0}
.rec svg{color:#ff9a9a}
.stop{background:#ff4d4d}.stop:hover{background:#ff3333}
.shot em{font-style:normal;font-size:11px;background:#4262ff;color:#fff;border-radius:9px;padding:0 5px}
.shot em:empty{display:none}
body[data-state=pick] [data-act=pick],body[data-state=pick] [data-act=done],
body[data-state=ready] [data-act=record],body[data-state=ready] [data-act=shot],body[data-state=ready] [data-act=done],
body[data-state=recording] [data-act=pause],body[data-state=recording] [data-act=stop],body[data-state=recording] [data-act=shot],
body[data-state=paused] [data-act=resume],body[data-state=paused] [data-act=stop],body[data-state=paused] [data-act=shot]{display:inline-flex}
.flash{position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none}
.flash.go{animation:f .35s ease-out}@keyframes f{from{opacity:.9}}
body.light{background:#fff;color:#050038}
.light button{background:#f0f1f6;color:#050038}.light button:hover{background:#e4e6f0}
.light .primary{background:#4262ff;color:#fff}.light .primary:hover{background:#3150f0}
.light .stop{background:#ff4d4d;color:#fff}.light .stop:hover{background:#ff3333}
.light .label{color:#8a89a6}
.light .screen{background:#eef0f7}.light .empty{color:#6b6a8a}
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
    const win = await documentPictureInPicture.requestWindow({ width: 380, height: 280 });
    const doc = win.document;
    doc.title = "Clipnote";
    const style = doc.createElement("style");
    style.textContent = FLOATER_CSS;
    doc.head.append(style);
    // A live mini view of what is being recorded, with the controls underneath.
    doc.body.innerHTML =
      '<div class="wrap"><div class="screen"><video muted autoplay playsinline></video>' +
      '<div class="empty">Pick the window you want to record in the browser’s share dialog.</div>' +
      '<span class="pill"><i></i><span class="pilltext">REC</span></span></div>' +
      '<div class="bar"><span class="status"><span class="label">Choose a screen</span><span class="time">00:00</span></span>' +
      '<button data-act="pick" class="primary">Choose screen</button>' +
      `<button data-act="record" class="primary rec">${ICON.rec}Record</button>` +
      `<button data-act="pause">${ICON.pause}Pause</button>` +
      `<button data-act="resume" class="primary rec">${ICON.rec}Resume</button>` +
      `<button data-act="stop" class="stop">${ICON.stop}Stop</button>` +
      `<button data-act="shot" class="shot" title="Take a screenshot">${ICON.camera}<em></em></button>` +
      `<button data-act="done">${ICON.check}Done</button></div></div><div class="flash"></div>`;
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
    themeFloater();
    if (stream) showInFloater(stream);
  } catch {
    floater = null;
  }
}
// The floating controls follow light / dark mode too.
function themeFloater() {
  floater?.doc.body.classList.toggle("light", !isDark());
}
function showInFloater(s) {
  const v = floater?.doc.querySelector("video");
  if (!v) return;
  v.srcObject = s;
  v.play().catch(() => {});
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
  document.title = "Clipnote";
  closeFloater();
  releaseStream();
  $("shotStrip").textContent = "";
  $("shotStrip").hidden = true;
  if (!s) return;
  const added = [];
  try {
    if (s.clip) {
      const p = await videoProject(URL.createObjectURL(s.clip.blob), s.clip.length, "Recording " + shortDate());
      p.media = s.clip.blob;
      added.push(p);
    }
  } catch (err) {
    toast("Could not read the recording. " + err.message);
  }
  s.shots.forEach((c, i) => added.push(imageProject(c, "Screenshot " + (i + 1) + " · " + shortDate())));
  try {
    window.focus();
  } catch {}
  if (!added.length) {
    showScreen(projects.length ? "editor" : "home");
    return;
  }
  projects.push(...added);
  openProject(added[0]);
  // Everything is saved in this browser right away.
  for (const p of added) saveProject(p);
  if (added.length > 1) toast(added.length + " captures are ready and saved. Switch between them at the top.");
}

/* ======================================================================
   Library: every capture is saved in this browser (IndexedDB), with its
   stickers and edits, so it can be reopened from the home page later.
   ====================================================================== */

const Library = (() => {
  let dbp = null;
  const open = () =>
    (dbp ??= new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("This browser cannot keep clips."));
      const q = indexedDB.open("clipnote", 1);
      q.onupgradeneeded = () => {
        q.result.createObjectStore("clips", { keyPath: "id" });
        q.result.createObjectStore("media");
      };
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error || new Error("Could not open storage."));
    }));
  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(t.error || new Error("Could not save."));
      const r = fn(t);
      if (r) r.onsuccess = () => (result = r.result);
    });
  }
  return {
    list: () => run(["clips"], "readonly", (t) => t.objectStore("clips").getAll()),
    media: (id) => run(["media"], "readonly", (t) => t.objectStore("media").get(id)),
    save: (meta, media) =>
      run(["clips", "media"], "readwrite", (t) => {
        t.objectStore("clips").put(meta);
        if (media) t.objectStore("media").put(media, meta.id);
      }),
    remove: (id) =>
      run(["clips", "media"], "readwrite", (t) => {
        t.objectStore("clips").delete(id);
        t.objectStore("media").delete(id);
      }),
  };
})();

const saveTimers = new Map();
let saveWarned = false,
  persistAsked = false;
function scheduleSave(p = cur) {
  if (!p) return;
  clearTimeout(saveTimers.get(p));
  saveTimers.set(p, setTimeout(() => saveProject(p), 700));
  setSaveState("saving");
}
function flushSave(p) {
  if (saveTimers.has(p)) saveProject(p);
}
function cancelSave(p) {
  clearTimeout(saveTimers.get(p));
  saveTimers.delete(p);
}
async function saveProject(p) {
  cancelSave(p);
  try {
    const media = p.mediaSaved ? null : p.media || (await toBlob(p.source, "image/png"));
    const thumb = (await makeThumb(p)) || p.thumb || null;
    const meta = {
      id: p.dbId,
      name: p.name,
      kind: p.kind,
      created: p.created,
      updated: Date.now(),
      width: p.width,
      height: p.height,
      length: p.length,
      edit: p.edit,
      stickers: p.stickers,
      thumb,
      size: media?.size ?? p.size ?? 0,
    };
    await Library.save(meta, media);
    p.thumb = thumb;
    if (media) {
      p.mediaSaved = true;
      p.size = media.size;
      p.media = null;
    }
    if (!persistAsked) {
      persistAsked = true;
      navigator.storage?.persist?.().catch(() => {});
    }
    if (!saveTimers.size) setSaveState("saved");
  } catch (err) {
    setSaveState("error", err);
    if (!saveWarned) {
      saveWarned = true;
      toast("Couldn’t save to this browser, so export your work before closing. " + (err?.message || ""), 7000);
    }
  }
}
function toBlob(source, type = "image/jpeg", quality = 0.82) {
  let c = source;
  if (!(source instanceof HTMLCanvasElement)) {
    c = el("canvas");
    c.width = source.width || source.naturalWidth;
    c.height = source.height || source.naturalHeight;
    c.getContext("2d").drawImage(source, 0, 0);
  }
  return new Promise((r) => c.toBlob(r, type, quality));
}
// A small picture for the home page: the current frame with its stickers.
async function makeThumb(p) {
  const W = 400;
  const c = el("canvas");
  if (p === cur && !$("editor").hidden) {
    const [, , cw, ch] = p.edit.crop;
    c.width = W;
    c.height = Math.max(1, Math.round((W * ch) / cw));
    renderFrame(c.getContext("2d"), c.width, c.height, playhead);
  } else if (p.kind === "image" && !p.thumb) {
    c.width = W;
    c.height = Math.max(1, Math.round((W * p.height) / p.width));
    c.getContext("2d").drawImage(p.source, 0, 0, c.width, c.height);
  } else return null;
  return toBlob(c, "image/jpeg", 0.8);
}
function setSaveState(state, err) {
  const b = $("saveState");
  b.dataset.state = state;
  b.textContent = state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Not saved";
  b.title =
    state === "error"
      ? "Couldn’t save in this browser: " + (err?.message || "unknown error")
      : "Your clips are saved automatically in this browser.";
}
addEventListener("pagehide", () => [...saveTimers.keys()].forEach(saveProject));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) [...saveTimers.keys()].forEach(saveProject);
});

function shortDate(d = new Date()) {
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "Just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 172800) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: s > 300 * 86400 ? "numeric" : undefined });
}
function clipLength(c) {
  const e = c.edit;
  return (e.end - e.start) / e.speed + (e.hold || 0);
}

/* The home page gallery */
let libraryToken = 0;
async function renderLibrary() {
  const token = ++libraryToken;
  let clips = [],
    failed = null;
  try {
    clips = await Library.list();
  } catch (err) {
    failed = err;
  }
  if (token !== libraryToken) return;
  clips.sort((a, b) => b.created - a.created);
  const grid = $("libGrid");
  grid.textContent = "";
  for (const c of clips) grid.append(libraryCard(c));
  $("library").classList.toggle("empty", !clips.length);
  $("libEmpty").hidden = clips.length > 0;
  $("libEmpty").textContent = failed
    ? "This browser can’t keep clips here. Your work still exports as usual. Tip: Chrome or Edge can keep them."
    : "Your recordings and screenshots will show up here. They’re saved in this browser, nothing is uploaded.";
  let note = clips.length ? clips.length + (clips.length === 1 ? " clip" : " clips") + " saved in this browser" : "";
  if (clips.length && navigator.storage?.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      if (usage && token === libraryToken) note += " · " + fmtBytes(usage);
    } catch {}
  }
  if (token === libraryToken) $("libCount").textContent = note;
}
function libraryCard(c) {
  const card = el("article", "clipcard");
  const tile = el("button", "cliptile");
  tile.setAttribute("aria-label", "Open " + c.name);
  if (c.thumb) {
    const img = el("img");
    img.alt = "";
    img.src = URL.createObjectURL(c.thumb);
    img.onload = () => URL.revokeObjectURL(img.src);
    tile.append(img);
  }
  tile.append(el("span", "kindbadge", c.kind === "video" ? "▶ " + fmt(clipLength(c)).replace(/\.\d$/, "") : "Screenshot"));
  if (projects.some((p) => p.dbId === c.id)) tile.append(el("span", "openbadge", "Open"));
  tile.onclick = () => openSaved(c);
  const name = el("input", "clipname");
  name.value = c.name;
  name.setAttribute("aria-label", "Clip name");
  name.title = "Click to rename";
  name.onkeydown = (e) => e.key === "Enter" && name.blur();
  name.onchange = () => renameClip(c, name.value.trim() || c.name);
  const stickers = c.stickers?.length || 0;
  const meta = el("p", "clipmeta", relTime(c.updated) + (stickers ? " · " + stickers + (stickers === 1 ? " sticker" : " stickers") : ""));
  const del = el("button", "icon clipdel");
  del.title = "Delete";
  del.setAttribute("aria-label", "Delete " + c.name);
  del.innerHTML = '<svg><use href="#i-trash"/></svg>';
  del.onclick = () => deleteClip(c);
  card.append(tile, name, meta, del);
  return card;
}
async function renameClip(c, name) {
  const open = projects.find((p) => p.dbId === c.id);
  if (open) {
    open.name = name;
    await saveProject(open);
  } else await Library.save({ ...c, name, updated: Date.now() }).catch(() => {});
  renderLibrary();
}
async function deleteClip(c) {
  const media = await Library.media(c.id).catch(() => null);
  try {
    await Library.remove(c.id);
  } catch (err) {
    toast("Could not delete it. " + err.message);
    return;
  }
  const open = projects.find((p) => p.dbId === c.id);
  if (open) closeProject(open, true);
  else renderLibrary();
  toast("Deleted “" + c.name + "”.", 7000, {
    label: "Undo",
    run: async () => {
      await Library.save(c, media).catch(() => {});
      renderLibrary();
    },
  });
}
async function openSaved(c) {
  const open = projects.find((p) => p.dbId === c.id);
  if (open) return openProject(open);
  try {
    const media = await Library.media(c.id);
    if (!media) throw new Error("Its file is missing.");
    const p =
      c.kind === "video"
        ? await videoProject(URL.createObjectURL(media), c.length, c.name)
        : imageProject(await createImageBitmap(media), c.name);
    Object.assign(p, { dbId: c.id, created: c.created, mediaSaved: true, size: c.size, thumb: c.thumb });
    p.edit = c.edit;
    p.stickers = c.stickers || [];
    nextId = Math.max(nextId, ...p.stickers.map((s) => (s.id || 0) + 1));
    projects.push(p);
    openProject(p);
  } catch (err) {
    toast("Could not open that clip. " + (err.message || ""));
  }
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
    dbId: crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2),
    created: Date.now(),
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
    p.media = file;
    projects.push(p);
    openProject(p);
    saveProject(p);
  } catch (err) {
    URL.revokeObjectURL(url);
    toast("Could not open that file. " + (err.message || ""));
  }
}

function renderTabs() {
  const nav = $("tabs");
  nav.textContent = "";
  for (const p of projects) {
    const b = el("button", p === cur && screenName === "editor" ? "on" : "");
    b.title = "Double-click to rename";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", p.kind === "video" ? "#i-play" : "#i-camera");
    icon.append(use);
    const label = el("span", "tabname", p.name);
    b.append(icon, label);
    b.ondblclick = () => renameInTab(p, label);
    if (projects.length > 1) {
      const x = el("span", "tabx", "×");
      x.title = "Close";
      x.onclick = (e) => {
        e.stopPropagation();
        closeProject(p);
      };
      b.append(x);
    }
    b.onclick = () => (p !== cur || screenName !== "editor") && openProject(p);
    nav.append(b);
  }
}
function renameInTab(p, label) {
  const input = el("input", "tabedit");
  input.value = p.name;
  input.setAttribute("aria-label", "Clip name");
  label.replaceWith(input);
  input.select();
  const done = (save) => {
    if (!input.isConnected) return;
    const name = input.value.trim();
    if (save && name && name !== p.name) {
      p.name = name;
      scheduleSave(p);
    }
    renderTabs();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  };
  input.onblur = () => done(true);
  input.onclick = (e) => e.stopPropagation();
}
function closeProject(p, deleted = false) {
  if (exporting) return;
  if (deleted) cancelSave(p);
  else flushSave(p);
  const i = projects.indexOf(p);
  if (i < 0) return;
  projects.splice(i, 1);
  if (p.url) setTimeout(() => URL.revokeObjectURL(p.url), 2000);
  if (p === cur) {
    stopPlay();
    cur = null;
    if (projects.length && screenName === "editor") openProject(projects[Math.max(0, i - 1)]);
    else showScreen("home");
  } else showScreen(screenName === "editor" ? "editor" : "home");
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
  box: { name: "Box", color: "#4262FF", dur: 3 },
  ring: { name: "Circle", color: "#E5547A", dur: 3 },
  marker: { name: "Highlighter", color: "#FFE14D", dur: 3 },
  tag: { name: "Tag", text: "NEW", color: "#E5547A", dur: 3 },
};
// The sticker panel: sections of ready-made variants, Canva style.
const TRAY = [
  { title: "Notes & tags", items: [
    { type: "note", label: "Yellow note", props: { color: "#FFD02F" } },
    { type: "note", label: "Pink note", props: { color: "#FF9EC4" } },
    { type: "note", label: "Green note", props: { color: "#A6E3A1" } },
    { type: "note", label: "Blue note", props: { color: "#9FC5FF" } },
    { type: "tag", label: "New tag", props: { text: "NEW", color: "#E5547A" } },
    { type: "tag", label: "Tip tag", props: { text: "TIP", color: "#4262FF" } },
  ] },
  { title: "Speech bubbles", items: [
    { type: "bubble", label: "Speech bubble", props: { shape: "round", color: "#FFFFFF", text: "Click here" } },
    { type: "bubble", label: "Oval bubble", props: { shape: "oval", color: "#FFD02F", text: "Hello!" } },
    { type: "bubble", label: "Thought bubble", props: { shape: "thought", color: "#FFFFFF", text: "Hmm…" } },
    { type: "bubble", label: "Burst", props: { shape: "burst", color: "#FF8A00", text: "WOW!" } },
    { type: "bubble", label: "Pink bubble", props: { shape: "round", color: "#E5547A", text: "Tip!" } },
    { type: "bubble", label: "Dark box", props: { shape: "rect", color: "#050038", text: "Step 1" } },
  ] },
  { title: "Arrows", items: [
    { type: "arrow", label: "Curved arrow", props: { color: "#E5547A", bend: 0.22 } },
    { type: "arrow", label: "Straight arrow", props: { color: "#4262FF", bend: 0 } },
    { type: "arrow", label: "Swoosh arrow", props: { color: "#23A26D", bend: -0.42 } },
  ] },
  { title: "Highlight", items: [
    { type: "ring", label: "Circle", props: { color: "#E5547A" } },
    { type: "box", label: "Box", props: { color: "#4262FF" } },
    { type: "marker", label: "Highlighter", props: { color: "#FFE14D" } },
    { type: "spotlight", label: "Spotlight" },
  ] },
  { title: "Mouse", items: [
    { type: "click", label: "Click" },
    { type: "dblclick", label: "Double-click" },
    { type: "rightclick", label: "Right-click" },
  ] },
  { title: "Keys", items: [
    { type: "keys", label: "Copy ⌘ C", props: { text: "⌘ + C" } },
    { type: "keys", label: "Paste ⌘ V", props: { text: "⌘ + V" } },
    { type: "keys", label: "Enter key", props: { text: "Enter ↵" } },
  ] },
];
const PALETTES = {
  note: ["#FFD02F", "#FF9EC4", "#A6E3A1", "#9FC5FF", "#FFB46B"],
  bubble: ["#FFFFFF", "#FFD02F", "#4262FF", "#E5547A", "#050038"],
  marker: ["#FFE14D", "#7CF5B0", "#FF9EC4", "#8FD3FF", "#FFB46B"],
  other: ["#E5547A", "#4262FF", "#23A26D", "#FF8A00", "#050038"],
};
const TEXT_TYPES = ["note", "bubble", "keys", "tag"];
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
      shape = s.shape || "round",
      tipX = x + w * 0.16,
      tipY = y + h * 1.45,
      cx = x + w / 2,
      cy = y + h / 2;
    // Pops out from its tail (a burst from its middle).
    const ax = shape === "burst" ? cx : tipX,
      ay = shape === "burst" ? cy : tipY,
      k = 0.5 + 0.5 * a.pop;
    ctx.translate(ax, ay);
    ctx.scale(k, k);
    ctx.translate(-ax, -ay);
    let tw = w * 0.86,
      th = h * 0.8;
    // Every part of the outline runs clockwise, so the body and tail merge into one shape.
    const tail = (x0, y0, x1, y1) => {
      ctx.moveTo(x1, y1);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(x0, y0);
      ctx.closePath();
    };
    const circle = (bx, by, r) => {
      ctx.moveTo(bx + r, by);
      ctx.arc(bx, by, r, 0, Math.PI * 2);
    };
    const path = () => {
      ctx.beginPath();
      if (shape === "oval") {
        ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
        tail(x + w * 0.12, y + h * 0.62, x + w * 0.36, y + h * 0.93);
      } else if (shape === "thought") {
        for (let i = 0; i < 10; i++) {
          const t = (i / 10) * Math.PI * 2;
          circle(cx + Math.cos(t) * w * 0.38, cy + Math.sin(t) * h * 0.32, h * 0.3);
        }
        ctx.moveTo(cx + w * 0.4, cy);
        ctx.ellipse(cx, cy, w * 0.4, h * 0.36, 0, 0, Math.PI * 2);
        circle(x + w * 0.2, y + h * 1.1, h * 0.13);
        circle(tipX - w * 0.03, tipY - h * 0.06, h * 0.075);
      } else if (shape === "burst") {
        const n = 12;
        for (let i = 0; i < n * 2; i++) {
          const t = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2,
            f = i % 2 ? 0.7 : 1;
          const px = cx + Math.cos(t) * (w / 2) * f,
            py = cy + Math.sin(t) * (h / 2) * f;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath();
      } else {
        ctx.roundRect(x, y, w, h, shape === "rect" ? h * 0.12 : h * 0.32);
        tail(x + w * 0.1, y + h - 1, x + w * 0.32, y + h - 1);
      }
    };
    if (shape === "oval") (tw = w * 0.72), (th = h * 0.64);
    else if (shape === "thought") (tw = w * 0.7), (th = h * 0.62);
    else if (shape === "burst") (tw = w * 0.6), (th = h * 0.5);
    ctx.fillStyle = s.color;
    ctx.shadowColor = "rgba(5,0,56,.25)";
    ctx.shadowBlur = h * 0.35;
    ctx.shadowOffsetY = h * 0.08;
    path();
    ctx.fill();
    ctx.shadowColor = "transparent";
    if (s.color.toUpperCase() === "#FFFFFF") {
      // A fine outline around the whole shape, tail included: stroke, then fill over the inner half.
      ctx.strokeStyle = "rgba(5,0,56,.16)";
      ctx.lineWidth = h * 0.06;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.fill();
    }
    fitText(ctx, s.text, cx, cy, tw, th, shape === "burst" ? h * 0.3 : h * 0.4, lightColor(s.color) ? "#050038" : "#FFFFFF");
  },
  box(ctx, s, a) {
    const p = easeOutCubic(clamp(a.age / 0.5, 0, 1)),
      per = 2 * (s.w + s.h);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.lw;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.setLineDash([per * p, per]);
    ctx.beginPath();
    ctx.roundRect(s.x, s.y, s.w, s.h, Math.min(s.w, s.h) * 0.14);
    ctx.stroke();
  },
  ring(ctx, s, a) {
    // A hand-drawn circle that draws itself and overshoots a little.
    const p = easeOutCubic(clamp(a.age / 0.55, 0, 1)),
      cx = s.x + s.w / 2,
      cy = s.y + s.h / 2,
      n = 72,
      start = -2.4,
      sweep = Math.PI * 2 * 1.1 * p;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.lw;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const t = start + (sweep * i) / n,
        wob = 1 + 0.035 * Math.sin(t * 3) + 0.03 * (i / n);
      const px = cx + Math.cos(t) * (s.w / 2) * wob,
        py = cy + Math.sin(t) * (s.h / 2) * wob;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
  },
  marker(ctx, s, a) {
    // Highlighter pen: wipes in from the left and tints what is underneath.
    const p = easeOutCubic(clamp(a.age / 0.4, 0, 1));
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = s.color;
    ctx.globalAlpha *= 0.85;
    ctx.beginPath();
    ctx.roundRect(s.x, s.y, s.w * p, s.h, s.h * 0.25);
    ctx.fill();
  },
  tag(ctx, s, a) {
    const h = s.h;
    ctx.font = `800 ${h * 0.5}px ${FONT}`;
    s.w = ctx.measureText(s.text || "").width + h * 1.1;
    const k = 0.5 + 0.5 * a.pop;
    ctx.translate(s.x + s.w / 2, s.y + h / 2);
    ctx.rotate(-0.05);
    ctx.scale(k, k);
    ctx.shadowColor = "rgba(5,0,56,.25)";
    ctx.shadowBlur = h * 0.3;
    ctx.shadowOffsetY = h * 0.08;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.roundRect(-s.w / 2, -h / 2, s.w, h, h / 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = lightColor(s.color) ? "#050038" : "#FFFFFF";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.text || "", 0, h * 0.03);
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
        // A small round "+" badge between keys, readable on light and dark screens.
        const px = key.x + key.w + h * 0.275,
          py = h * 0.47,
          r = h * 0.2,
          arm = r * 0.5;
        ctx.shadowColor = "rgba(5,0,56,.25)";
        ctx.shadowBlur = h * 0.12;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = "#050038";
        ctx.lineWidth = h * 0.055;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(px - arm, py);
        ctx.lineTo(px + arm, py);
        ctx.moveTo(px, py - arm);
        ctx.lineTo(px, py + arm);
        ctx.stroke();
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
  if (s.type === "keys" || s.type === "tag") return { x: s.x, y: s.y, w: s.w || s.h * 3, h: s.h };
  if (s.type === "bubble" && s.shape === "thought") return { x: s.x - s.w * 0.06, y: s.y - s.h * 0.14, w: s.w * 1.12, h: s.h * 1.59 };
  if (s.type === "bubble" && s.shape !== "burst") return { x: s.x, y: s.y, w: s.w, h: s.h * 1.45 };
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}
function handles(s) {
  if (s.type === "arrow") return { p0: [s.x, s.y], p2: [s.x2, s.y2] };
  if (s.r) return { se: [s.x + s.r, s.y + s.r] };
  if (s.type === "keys" || s.type === "tag") return { se: [s.x + (s.w || s.h * 3), s.y + s.h] };
  return { se: [s.x + s.w, s.y + s.h] };
}
function newSticker(type, px, py, item = {}) {
  const def = STICKERS[type],
    [cx, cy, cw, ch] = cur.edit.crop,
    U = Math.max(cw, ch * 1.4) / 100;
  const s = { id: nextId++, type, color: def.color, text: def.text, name: item.label || def.name, ...item.props };
  const shape = s.shape;
  if (type === "note") Object.assign(s, { w: 17 * U, h: 17 * U, x: px - 8.5 * U, y: py - 8.5 * U });
  else if (type === "tag") Object.assign(s, { h: 4.6 * U, x: px - 5 * U, y: py - 2.3 * U });
  else if (type === "bubble" && shape === "burst") Object.assign(s, { w: 20 * U, h: 14 * U, x: px - 10 * U, y: py - 7 * U });
  else if (type === "bubble" && shape === "oval") Object.assign(s, { w: 24 * U, h: 11 * U, x: px - 3.8 * U, y: py - 16 * U });
  else if (type === "bubble" && shape === "thought") Object.assign(s, { w: 26 * U, h: 12 * U, x: px - 4 * U, y: py - 17.4 * U });
  else if (type === "bubble") Object.assign(s, { w: 24 * U, h: 8 * U, x: px - 4 * U, y: py - 11.6 * U });
  else if (type === "ring") Object.assign(s, { w: 18 * U, h: 11 * U, x: px - 9 * U, y: py - 5.5 * U, lw: 0.6 * U });
  else if (type === "box") Object.assign(s, { w: 24 * U, h: 14 * U, x: px - 12 * U, y: py - 7 * U, lw: 0.55 * U });
  else if (type === "marker") Object.assign(s, { w: 22 * U, h: 3.6 * U, x: px - 11 * U, y: py - 1.8 * U });
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
  if (s.type === "keys" || s.type === "tag") return s.text || STICKERS[s.type].name;
  return s.name || STICKERS[s.type].name;
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
  scheduleSave();
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
  scheduleSave();
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

function trayPreview(item, W = 160, H = 120) {
  const c = el("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d"),
    type = item.type;
  ctx.scale(W / 160, H / 120);
  const s = { type, color: STICKERS[type].color, text: STICKERS[type].text, ...item.props };
  const shape = s.shape;
  if (type === "note") Object.assign(s, { x: 42, y: 22, w: 76, h: 76, text: "Note" });
  else if (type === "tag") Object.assign(s, { x: 0, y: 44, h: 34 });
  else if (type === "bubble" && shape === "burst") Object.assign(s, { x: 14, y: 14, w: 132, h: 92 });
  else if (type === "bubble" && shape === "oval") Object.assign(s, { x: 16, y: 10, w: 128, h: 62 });
  else if (type === "bubble" && shape === "thought") Object.assign(s, { x: 18, y: 12, w: 124, h: 58 });
  else if (type === "bubble") Object.assign(s, { x: 12, y: 18, w: 136, h: 50 });
  else if (type === "arrow") Object.assign(s, { x: 28, y: 98, x2: 132, y2: 26, w: 7 });
  else if (type === "keys") Object.assign(s, { x: 0, y: 38, h: 44 });
  else if (type === "ring") Object.assign(s, { x: 24, y: 26, w: 112, h: 68, lw: 6 });
  else if (type === "box") Object.assign(s, { x: 22, y: 26, w: 116, h: 68, lw: 6 });
  else if (type === "marker") Object.assign(s, { x: 18, y: 48, w: 120, h: 24 });
  else if (type === "spotlight") Object.assign(s, { x: 46, y: 30, w: 70, h: 54 });
  else if (type === "rightclick") Object.assign(s, { r: 13, x: 50, y: 52 });
  else Object.assign(s, { r: 21, x: 78, y: 62 });
  if (type === "keys") keysLayout(ctx, s);
  if (type === "tag") {
    ctx.font = `800 ${s.h * 0.5}px ${FONT}`;
    s.w = ctx.measureText(s.text).width + s.h * 1.1;
  }
  if (type === "keys" || type === "tag") s.x = (160 - s.w) / 2;
  if (type === "spotlight" || type === "marker") {
    // A little pretend screen to show the effect on.
    ctx.fillStyle = "#e9ebfa";
    ctx.beginPath();
    ctx.roundRect(8, 10, 144, 100, 10);
    ctx.fill();
    ctx.fillStyle = "#b7bde8";
    for (let i = 0; i < 4; i++) ctx.fillRect(20, 24 + i * 21, i % 2 ? 80 : 116, 9);
  }
  const still = ["click", "dblclick", "rightclick"].includes(type) ? { ...STILL, age: 0.35 } : STILL;
  drawSticker(ctx, s, still, [8, 10, 144, 100]);
  return c;
}
let trayDrag = null;
function buildTray() {
  const body = $("stickerGrid");
  for (const section of TRAY) {
    const sec = el("section", "traysection");
    sec.append(el("h3", "", section.title));
    const grid = el("div", "traygrid");
    for (const item of section.items) {
      item.words = (item.label + " " + item.type + " " + section.title + " " + (item.props?.text || "")).toLowerCase();
      grid.append(trayTile(item));
    }
    sec.append(grid);
    body.append(sec);
  }
}
function trayTile(item) {
  const tile = el("button", "sticker");
  tile.dataset.type = item.type;
  tile.title = item.label + " · drag onto your clip, or click to add";
  tile.setAttribute("aria-label", "Add " + item.label);
  tile.item = item;
  tile.append(trayPreview(item));
  const center = () => {
    const [x, y, w, h] = cur.edit.crop;
    addSticker(item, x + w / 2, y + h / 2);
  };
  // Mouse presses shouldn't leave focus on the tile (Space must stay "play").
  tile.onmousedown = (e) => e.preventDefault();
  tile.onpointerdown = (e) => {
    if (e.button !== 0 || !cur || exporting || trayDrag) return;
    startTrayDrag(item, e, tile, center);
  };
  tile.onclick = (e) => {
    // Keyboard users: Enter or Space adds the sticker in the middle.
    if (e.detail === 0 && cur) center();
  };
  return tile;
}
// Dragging a sticker from the panel. Listens on the whole window, and if the
// mouse button turns out to be up already (a missed release, e.g. with trackpad
// drag gestures or letting go outside the window), the drag ends right away
// instead of the sticker following the pointer around.
function startTrayDrag(item, down, tile, center) {
  const d = (trayDrag = { ghost: null, last: down });
  try {
    tile.setPointerCapture(down.pointerId);
  } catch {}
  const same = (e) => e.pointerId === down.pointerId;
  const move = (e) => {
    if (!same(e)) return;
    if (e.buttons === 0) return finish(d.last, true);
    d.last = e;
    if (!d.ghost && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 6) {
      d.ghost = trayPreview(item, 240, 180);
      d.ghost.className = "dragghost";
      d.ghost.style.width = "130px";
      document.body.append(d.ghost);
    }
    if (d.ghost) {
      d.ghost.style.left = e.clientX + "px";
      d.ghost.style.top = e.clientY + "px";
      $("stage").classList.toggle("dropping", overView(e));
    }
  };
  const up = (e) => same(e) && finish(e, false);
  const cancel = () => finish(null, true);
  function finish(e, missed) {
    if (trayDrag !== d) return;
    trayDrag = null;
    removeEventListener("pointermove", move, true);
    removeEventListener("pointerup", up, true);
    removeEventListener("pointercancel", cancel, true);
    removeEventListener("blur", cancel);
    tile.removeEventListener("lostpointercapture", lost);
    $("stage").classList.remove("dropping");
    d.ghost?.remove();
    if (d.ghost) {
      if (e && overView(e)) {
        const p = toSource(e);
        addSticker(item, p.x, p.y);
      }
    } else if (!missed) center();
  }
  // Losing capture without a release (e.g. the window lost focus) also ends the drag.
  const lost = () => setTimeout(() => trayDrag === d && finish(d.last, true), 0);
  addEventListener("pointermove", move, true);
  addEventListener("pointerup", up, true);
  addEventListener("pointercancel", cancel, true);
  addEventListener("blur", cancel);
  tile.addEventListener("lostpointercapture", lost);
}
$("stickerSearch").oninput = () => {
  const q = $("stickerSearch").value.trim().toLowerCase();
  let shown = 0;
  for (const sec of document.querySelectorAll(".traysection")) {
    let any = 0;
    for (const tile of sec.querySelectorAll(".sticker")) {
      const hit = !q || q.split(/\s+/).every((w) => tile.item.words.includes(w));
      tile.hidden = !hit;
      any += hit;
    }
    sec.hidden = !any;
    shown += any;
  }
  $("searchClear").hidden = !q;
  $("trayEmpty").hidden = !!shown;
  $("trayEmpty").textContent = "No stickers match “" + $("stickerSearch").value.trim() + "”.";
};
$("searchClear").onclick = () => {
  $("stickerSearch").value = "";
  $("stickerSearch").oninput();
  $("stickerSearch").focus();
};
function overView(e) {
  const b = view.getBoundingClientRect();
  return e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
}
function addSticker(item, x, y) {
  if (cropping) toggleCrop();
  stopPlay();
  const before = snapshot(),
    t1 = playhead,
    type = item.type;
  const s = newSticker(type, x, y, item);
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
addEventListener("blur", () => {
  if (canvasDrag) view.onpointerup();
  if (tlDrag) endTimelineDrag();
  cropDrag = null;
});

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
  if (canvasDrag && e.buttons === 0) return view.onpointerup();
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
  else if (s.type === "keys" || s.type === "tag") s.h = Math.max(2 * U, o.h + dy);
  else {
    s.w = Math.max(4 * U, o.w + dx);
    s.h = Math.max(s.type === "marker" ? U : 3 * U, o.h + dy);
  }
  draw();
};
view.onpointerup = () => {
  if (!canvasDrag) return;
  commit(canvasDrag.before);
  canvasDrag = null;
  renderTimeline();
};
view.onpointercancel = view.onlostpointercapture = view.onpointerup;
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
  if (e.buttons === 0) return (cropDrag = null);
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
  const block = el("div", "block sblock" + (lightColor(trackColor(s)) ? " dark" : ""), s.name || STICKERS[s.type].name);
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
  if (e.buttons === 0) return endTimelineDrag();
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
