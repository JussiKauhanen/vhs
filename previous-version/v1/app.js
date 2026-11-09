"use strict";
const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timecode = (t) =>
  new Date(Math.round(t * 1000)).toISOString().slice(14, 21);
const statusText = (text) => {
  $("status").textContent = text;
};
const live = $("live"),
  display = $("display"),
  context = display.getContext("2d", { willReadFrequently: true });
let stream,
  recorder,
  session = 0,
  recordingStart = 0,
  stopTimer,
  clockTimer;
let region = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  cropDrag,
  asset,
  tool,
  draft,
  playing = false,
  exporting = false;
let annotations = [],
  playhead = 0,
  playOrigin = 0,
  animation,
  busy = false;
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
function fit() {
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
  const selected = $("aspect").value;
  return selected === "free" || selected === "full"
    ? null
    : (Number(selected) * live.videoHeight) / live.videoWidth;
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
    const selected = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    releaseStream();
    stream = selected;
    selected.getVideoTracks()[0].onended = () => {
      if (selected !== stream) return;
      if (recorder) stopRecording();
      else {
        releaseStream();
        statusText("Screen sharing ended. Choose a source to reconnect.");
      }
    };
    live.srcObject = selected;
    await live.play();
    if (selected !== stream) return;
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
function stopRecording() {
  if (recorder?.state === "recording") recorder.stop();
  clearTimeout(stopTimer);
  clearInterval(clockTimer);
  $("record").disabled = true;
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
$("record").onclick = () => {
  if (recorder) {
    stopRecording();
    return;
  }
  if (!stream || busy) return;
  const parts = [],
    bounds = { ...region };
  try {
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    rec.onstop = async () => {
      const elapsed = (performance.now() - recordingStart) / 1000;
      clearTimeout(stopTimer);
      clearInterval(clockTimer);
      recorder = null;
      releaseStream();
      $("record").innerHTML = "<span>●</span> Record";
      $("aspect").disabled = false;
      const url = URL.createObjectURL(new Blob(parts, { type: rec.mimeType }));
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
    rec.onerror = (e) => {
      statusText(e.error?.message || "Recording interrupted.");
    };
    rec.start(250);
    recorder = rec;
    recordingStart = performance.now();
    busyControls(true);
    $("aspect").disabled = true;
    $("signal").textContent = "●   RECORDING";
    $("record").textContent = "■  Stop recording";
    clockTimer = setInterval(() => {
      $("clock").textContent = timecode(
        (performance.now() - recordingStart) / 1000,
      );
    }, 100);
    stopTimer = setTimeout(stopRecording, 30000);
    statusText(
      "Recording the selected region. Stop here or use the browser’s sharing control. Clips stop at 30 seconds.",
    );
  } catch (err) {
    statusText("Could not start recording. " + err.message);
  }
};
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
  draft = null;
  tool = null;
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
function openAsset(item) {
  dispose();
  asset = item;
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
  $("png").hidden = asset.kind !== "image";
  $("start").value = 0;
  $("end").value = item.length.toFixed(3);
  $("start").max = $("end").max = item.length;
  $("speed").value = 1;
  $("hold").value = 0;
  $("title").textContent = "Edit studio";
  $("signal").textContent = "●   PLAYBACK";
  $("format").textContent = display.width + " × " + display.height;
  $("markFrom").value = 0;
  $("markUntil").value = "";
  $("note").value = "";
  setTool(null);
  updateUndo();
  setPosition(0);
  statusText(
    "Trim, adjust timing, or add annotations. Export when you’re ready.",
  );
  if (asset.kind !== "image") play();
}
$("new").onclick = () => {
  dispose();
  $("editPanel").hidden = display.hidden = $("timeline").hidden = true;
  $("capturePanel").hidden = false;
  releaseStream();
  $("clock").textContent = "00:00.0";
  $("title").textContent = "Capture studio";
  statusText("Choose a source or import an image.");
};
function timing() {
  const start = Number($("start").value),
    end = Number($("end").value),
    speed = Number($("speed").value);
  const run = (end - start) / speed;
  return { start, end, speed, run, total: run + Number($("hold").value) };
}
function sourceTime(t) {
  const { start, speed, end } = timing();
  return clamp(start + t * speed, start, Math.max(start, end - 0.001));
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
    const size = Math.max(12, display.width / 26),
      pad = size * 0.3;
    context.font = "bold " + size + "px sans-serif";
    context.textBaseline = "top";
    const width = Math.min(
      display.width,
      context.measureText(text).width + 2 * pad,
    );
    const nx = clamp(x, 0, display.width - width),
      ny = clamp(y, 0, Math.max(0, display.height - size - 2 * pad));
    context.fillStyle = "#161912";
    context.fillRect(nx, ny, width, size + 2 * pad);
    context.fillStyle = color;
    context.fillText(text, nx + pad, ny + pad, Math.max(1, width - 2 * pad));
  }
  context.restore();
}
function draw(t = playhead) {
  if (!asset) return;
  let source = asset.source;
  if (asset.frames)
    source = (
      asset.frames.findLast((f) => f.start <= sourceTime(t)) || asset.frames[0]
    ).image;
  context.clearRect(0, 0, display.width, display.height);
  context.drawImage(source, ...asset.rect, 0, 0, display.width, display.height);
  annotations
    .filter((mark) => t >= mark.from && (mark.until === null || t < mark.until))
    .forEach(drawMark);
  if (draft) drawMark(draft);
}
function syncUI(t) {
  playhead = t;
  $("seek").max = timing().total;
  $("seek").value = t;
  $("clock").textContent = timecode(t);
}
function setPosition(t) {
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
$("seek").oninput = () => {
  stopPlay();
  setPosition(Number($("seek").value));
};
for (const id of ["start", "end", "speed", "hold"])
  $(id).onchange = () => {
    stopPlay();
    const minLen = Math.min(0.01, asset.length);
    const end = clamp(Number($("end").value) || minLen, minLen, asset.length);
    $("end").value = end;
    $("start").value = clamp(Number($("start").value), 0, end - minLen);
    $("hold").value = clamp(Number($("hold").value), 0, 30);
    setPosition(0);
  };
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
      ? "Write a note, then click to place it."
      : kind
        ? "Drag on the preview to draw."
        : "Choose a tool, then draw on the preview.";
}
$("tools").onclick = (e) => {
  if (e.target.dataset.tool) {
    stopPlay();
    setTool(e.target.dataset.tool);
    if (tool === "note") $("note").focus();
  }
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
function updateUndo() {
  $("undo").disabled = !annotations.length;
}
display.onpointerdown = (e) => {
  if (!tool || exporting) return;
  stopPlay();
  const { x, y } = point(e);
  display.setPointerCapture(e.pointerId);
  const text = $("note").value.trim();
  if (tool === "note" && !text) {
    $("note").focus();
    return;
  }
  const from = Number($("markFrom").value),
    until = $("markUntil").value === "" ? null : Number($("markUntil").value);
  if (from < 0 || from >= timing().total || (until !== null && until <= from)) {
    statusText(
      "Choose annotation times within the clip, with Until later than From.",
    );
    return;
  }
  draft = {
    kind: tool,
    x,
    y,
    ex: x,
    ey: y,
    color: $("ink").value,
    text,
    from,
    until,
  };
  draw();
};
display.onpointermove = (e) => {
  if (draft) {
    const p = point(e);
    draft.ex = p.x;
    draft.ey = p.y;
    draw();
  }
};
display.onpointerup = () => {
  if (draft) {
    if (
      draft.kind === "note" ||
      Math.hypot(draft.x - draft.ex, draft.y - draft.ey) > 1
    )
      annotations.push(draft);
    draft = null;
    updateUndo();
    draw();
  }
};
display.onpointercancel = () => {
  draft = null;
  draw();
};
$("undo").onclick = () => {
  annotations.pop();
  updateUndo();
  draw();
};
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
  draw();
  display.toBlob((blob) => {
    if (blob) download(blob, "VHS-image.png");
  });
};
async function seekVideo(video, t) {
  if (!video.seeking && Math.abs(video.currentTime - t) < 0.0001) return;
  await waitEvent(video, "seeked", () => {
    video.currentTime = t;
  });
}
$("gif").onclick = async () => {
  if (exporting || busy) return;
  stopPlay();
  exporting = true;
  const original = playhead;
  $("editPanel").inert = $("timeline").inert = true;
  $("import").disabled = true;
  try {
    const { total, run } = timing(),
      staticImage = asset.kind === "image";
    const boundaries = new Set([0, total]);
    if (!staticImage) {
      for (let i = 1; i / 10 < run; i++) boundaries.add(i / 10);
      if (total > run) boundaries.add(run);
    }
    for (const mark of annotations) {
      if (mark.from > 0 && mark.from < total) boundaries.add(mark.from);
      if (mark.until !== null && mark.until > 0 && mark.until < total)
        boundaries.add(mark.until);
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
      draw(t);
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
    $("editPanel").inert = $("timeline").inert = false;
    $("import").disabled = false;
    setPosition(original);
  }
};
