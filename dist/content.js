(() => {
  // src/content.ts
  var MODES = [
    { mode: "table", label: "Side by side", hint: "GitHub's own table" },
    { mode: "flip", label: "Flip", hint: "Click or press Space to blink between before and after" },
    { mode: "diff", label: "Diff", hint: "Unchanged pixels fade out; red was darker before, green is darker after" }
  ];
  var DEFAULT_MODE = "flip";
  var MODE_KEY = "peekaboo-mode";
  var PROCESSED = "peekaboo";
  var PREFIX = "peekaboo";
  var widgets = /* @__PURE__ */ new Set();
  main();
  function main() {
    injectStyles();
    let scheduled = false;
    const scheduleSync = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        sync();
      });
    };
    new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", handleViewerKeys, true);
    document.addEventListener("keydown", (event) => event.key === "Shift" && !event.repeat && startPeek(event), true);
    document.addEventListener("keyup", (event) => event.key === "Shift" && endPeek(), true);
    window.addEventListener("blur", endPeek);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") eachAlignBar((bar) => bar.retryAuto());
    });
    scheduleSync();
  }
  function sync() {
    ensureDiffFilters();
    removeOrphanWidgets();
    for (const table of document.querySelectorAll(".markdown-body table")) {
      if (table.dataset[PROCESSED]) continue;
      table.dataset[PROCESSED] = "1";
      const pairs = readPairs(table);
      if (pairs.length > 0) table.before(buildWidget(table, pairs));
    }
  }
  function removeOrphanWidgets() {
    for (const widget of document.querySelectorAll(`.${PREFIX}`)) {
      if (!(widget.nextElementSibling instanceof HTMLTableElement)) widget.remove();
    }
  }
  function readPairs(table) {
    const headers = Array.from(table.tHead?.rows[0]?.cells ?? []).map((cell) => cell.textContent?.trim() ?? "");
    const beforeIndex = headers.findIndex((text) => /^before\b/i.test(text));
    const afterIndex = headers.findIndex((text) => /^after\b/i.test(text));
    if (beforeIndex < 0 || afterIndex < 0) return [];
    const pairs = [];
    for (const row of Array.from(table.tBodies[0]?.rows ?? [])) {
      const before = row.cells[beforeIndex]?.querySelector("img, video");
      const after = row.cells[afterIndex]?.querySelector("img, video");
      if (!before || !after) continue;
      const label = Array.from(row.cells).filter((_, index) => index !== beforeIndex && index !== afterIndex).map((cell) => cell.textContent?.trim()).filter(Boolean).join(" \xB7 ");
      pairs.push({ label, before, after });
    }
    return pairs;
  }
  function buildWidget(table, pairs) {
    const widget = el("div", PREFIX);
    const toolbar = el("div", `${PREFIX}-toolbar`);
    const view = el("div", `${PREFIX}-view`);
    const stages = pairs.map((pair) => buildStage(pair));
    view.append(...stages.map((stage) => stage.root));
    const modeButtons = MODES.map(({ mode, label, hint }) => {
      const button = el("button", `${PREFIX}-mode`);
      button.type = "button";
      button.textContent = label;
      button.title = hint;
      button.addEventListener("click", () => setModeEverywhere(mode, toolbar));
      return { mode, button };
    });
    const expand = el("button", `${PREFIX}-expand`);
    expand.type = "button";
    expand.append(icon("screen-full"), "Full screen");
    expand.title = "Full screen: \u2190 \u2192 step through every pair on the page, Esc closes";
    const segmented = el("div", `${PREFIX}-segmented`);
    segmented.append(...modeButtons.map(({ button }) => button));
    toolbar.append(segmented, expand);
    if (pairs.some((pair) => pair.before instanceof HTMLVideoElement || pair.after instanceof HTMLVideoElement)) {
      toolbar.append(buildPlayButton(stages));
    }
    widget.append(toolbar, view);
    function applyMode(mode) {
      widget.dataset.mode = mode;
      table.hidden = mode !== "table";
      view.hidden = mode === "table";
      expand.hidden = mode === "table";
      for (const { mode: buttonMode, button } of modeButtons) button.setAttribute("aria-pressed", String(buttonMode === mode));
      for (const stage of stages) stage.setMode(mode);
    }
    applyMode(loadMode());
    const caption = captionBelow(table);
    const entry = {
      root: widget,
      applyMode,
      slides: stages.map((stage, index) => ({ stage: stage.root, label: pairs[index].label, caption, flip: stage.flip, peek: stage.peek }))
    };
    widgets.add(entry);
    expand.addEventListener("click", () => openViewer(entry.slides[0]));
    return widget;
  }
  function buildStage(pair) {
    const root = el("figure", `${PREFIX}-stage`);
    const frame = el("div", `${PREFIX}-frame`);
    frame.tabIndex = 0;
    const after = cloneMedia(pair.after, "after");
    const before = cloneMedia(pair.before, "before");
    const beforeTag = tag("Before", "before");
    const afterTag = tag("After", "after");
    const diff = el("div", `${PREFIX}-diff`);
    const canvas = el("div", `${PREFIX}-canvas`);
    canvas.append(after, before, diff);
    frame.append(canvas);
    const legend = el("div", `${PREFIX}-legend`);
    const flipHint = el("span", `${PREFIX}-flip-hint`);
    flipHint.textContent = "Click to flip";
    const notCompared = el("span", `${PREFIX}-not-compared`);
    notCompared.textContent = "Not compared";
    const middle = el("span", `${PREFIX}-legend-middle`);
    middle.append(flipHint, notCompared);
    legend.append(beforeTag, middle, afterTag);
    const canDiff = pair.before instanceof HTMLImageElement && pair.after instanceof HTMLImageElement;
    const same = el("p", `${PREFIX}-same`);
    same.hidden = true;
    same.textContent = "No visible difference. The same screenshot twice?";
    root.append(legend, frame, same);
    if (pair.label) {
      const caption = el("figcaption", `${PREFIX}-label`);
      caption.textContent = pair.label;
      root.append(caption);
    }
    let mode = DEFAULT_MODE;
    let showingBefore = true;
    let peeking = false;
    function render() {
      let shown = mode === "diff" && !canDiff ? "flip" : mode;
      const beforeShown = shownSide();
      if (peeking && shown === "diff") shown = "flip";
      frame.dataset.mode = shown;
      legend.dataset.mode = shown;
      beforeTag.textContent = shown === "diff" ? "Darker before" : "Before";
      afterTag.textContent = shown === "diff" ? "Darker after" : "After";
      after.style.visibility = shown === "flip" && beforeShown ? "hidden" : "visible";
      if (shown === "diff") {
        if (!diff.hasChildNodes()) diff.append(...buildDiffLayers(pair.before, pair.after));
        before.style.opacity = "0";
      } else if (shown === "flip") {
        before.style.opacity = beforeShown ? "1" : "0";
        frame.dataset.showing = beforeShown ? "before" : "after";
        legend.dataset.showing = frame.dataset.showing;
      }
    }
    function shownSide() {
      if (!peeking) return showingBefore;
      return mode === "diff" ? false : !showingBefore;
    }
    frame.addEventListener("peekaboo:diff", (event) => {
      const url = event.detail;
      diff.replaceChildren();
      if (url) {
        const img = el("img", `${PREFIX}-diff-image`);
        img.src = url;
        img.alt = "";
        diff.append(img);
      }
      render();
    });
    function flip() {
      if (frame.dataset.mode !== "flip") return;
      showingBefore = !showingBefore;
      render();
    }
    frame.addEventListener("pointerdown", flip);
    frame.addEventListener("pointerenter", () => hovered = stage);
    frame.addEventListener("pointerleave", () => {
      if (hovered === stage) hovered = null;
    });
    frame.addEventListener("keydown", (event) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      flip();
    });
    const stage = {
      root,
      peek(on) {
        if (peeking === on) return;
        peeking = on;
        render();
      },
      flip,
      videos: [before, after].filter((media) => media instanceof HTMLVideoElement),
      setMode(next) {
        mode = next;
        render();
      }
    };
    fitPair(root, pair, (isSame) => same.hidden = !isSame);
    return stage;
  }
  var hovered = null;
  var peekingAt = null;
  function startPeek(event) {
    const typing = event.target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
    const peek = viewer ? viewer.slides[viewer.index].peek : hovered?.peek;
    if (typing || !peek) return;
    peekingAt = peek;
    peek(true);
  }
  function endPeek() {
    peekingAt?.(false);
    peekingAt = null;
  }
  function buildDiffLayers(beforeSource, afterSource) {
    const onlyBefore = diffLayer([beforeSource, "before"], [afterSource, "after"], "removed");
    const onlyAfter = diffLayer([afterSource, "after"], [beforeSource, "before"], "added");
    return [onlyBefore, onlyAfter];
  }
  function diffLayer([darker, darkerSide], [other, otherSide], kind) {
    const group = el("div", `${PREFIX}-diff-layer ${PREFIX}-diff-${kind}`);
    const base = cloneMedia(darker, "diff-part", darkerSide);
    const lighten = cloneMedia(other, "diff-part", otherSide);
    lighten.style.mixBlendMode = "lighten";
    const subtract = cloneMedia(darker, "diff-part", darkerSide);
    subtract.style.mixBlendMode = "difference";
    group.append(base, lighten, subtract);
    return group;
  }
  var DIFF_COLORS = { removed: [0.86, 0.14, 0.18], added: [0.1, 0.72, 0.3] };
  function ensureDiffFilters() {
    if (document.getElementById(`${PREFIX}-filters`)) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = `${PREFIX}-filters`;
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
    const morphs = { "": `<feMorphology operator="dilate" radius="1" />`, "-resampled": `<feMorphology operator="erode" radius="1" /><feMorphology operator="dilate" radius="2" />` };
    svg.innerHTML = Object.entries(DIFF_COLORS).flatMap(([kind, [r, g, b]]) => Object.entries(morphs).map(([suffix, steps]) => `
    <filter id="${PREFIX}-${kind}${suffix}" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  6 6 6 0 -0.06" />
      ${steps}
    </filter>`)).join("");
    document.body.append(svg);
  }
  function cloneMedia(source, side, from = side) {
    const media = source.cloneNode(true);
    media.removeAttribute("style");
    media.removeAttribute("width");
    media.removeAttribute("height");
    media.className = `${PREFIX}-media ${PREFIX}-${side}`;
    media.dataset.from = from;
    media.draggable = false;
    if (media instanceof HTMLVideoElement) {
      media.controls = false;
      media.muted = true;
      media.loop = true;
      media.playsInline = true;
    }
    return media;
  }
  var DENSITIES = [1.25, 1.5, 2, 3];
  var ALIGN_KEY = "peekaboo-align";
  var CAN_AUTO = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  var ALIGNS = [
    ...CAN_AUTO ? [{ align: "auto", label: "Auto" }] : [],
    { align: "left", label: "Left" },
    { align: "center", label: "Center" },
    { align: "right", label: "Right" }
  ];
  var alignBars = /* @__PURE__ */ new Map();
  function eachAlignBar(action) {
    for (const [frame, bar] of alignBars) {
      if (frame.isConnected) action(bar);
      else alignBars.delete(frame);
    }
  }
  function fitPair(root, pair, showSame) {
    const frame = frameOf(root);
    let done = false;
    const apply = () => {
      const [bw, bh] = naturalSize(pair.before), [aw, ah] = naturalSize(pair.after);
      if (done || !bw || !aw) return;
      done = true;
      const ratio = aw / bw;
      const near = (a, b) => Math.abs(a / b - 1) < 0.02;
      const sameSize = bw === aw && bh === ah;
      const density = DENSITIES.some((d) => near(ratio, d) || near(1 / ratio, d));
      if (sameSize || density) {
        root.style.setProperty("--natural-width", `${aw}px`);
        root.style.setProperty("--aspect", String(aw / ah));
        if (!sameSize) frame.dataset.resampled = "";
        const width = Math.min(bw, aw);
        const sameShape = Math.abs(bh * width / bw - ah * width / aw) <= 1;
        if (canAutoAlign(pair) && sameShape) askBackground("compare", pair, (response) => {
          if (response?.diff) frame.dispatchEvent(new CustomEvent("peekaboo:diff", { detail: response.diff }));
          showSame(response?.same ?? null);
        });
        return;
      }
      if (bw === aw) {
        root.dataset.partial = "1";
        root.style.setProperty("--natural-width", `${aw}px`);
        root.style.setProperty("--aspect", String(aw / Math.max(bh, ah)));
        if (!canAutoAlign(pair) || loadAlign() !== "auto") return;
        askBackground("align", pair, (response) => {
          const p = response?.placement;
          if (!p || !p.beforeY && !p.afterY) return;
          root.insertBefore(buildAlignBar(root, pair, [bw, bh], [aw, ah], showSame, { placement: p, diff: response.diff, same: response.same }), frame.nextSibling);
        });
        return;
      }
      root.insertBefore(buildAlignBar(root, pair, [bw, bh], [aw, ah], showSame), frame.nextSibling);
    };
    for (const media of [pair.before, pair.after]) {
      media.addEventListener(media instanceof HTMLImageElement ? "load" : "loadedmetadata", apply, { once: true });
    }
    apply();
  }
  var canAutoAlign = (pair) => CAN_AUTO && pair.before instanceof HTMLImageElement && pair.after instanceof HTMLImageElement;
  function askBackground(type, pair, done) {
    const message = { type, before: pair.before.currentSrc, after: pair.after.currentSrc };
    try {
      chrome.runtime.sendMessage(message, (response) => done(chrome.runtime.lastError ? null : response));
    } catch {
      done(null);
    }
  }
  function naturalSize(media) {
    return media instanceof HTMLImageElement ? [media.naturalWidth, media.naturalHeight] : [media.videoWidth, media.videoHeight];
  }
  var frameOf = (stage) => stage.querySelector(`.${PREFIX}-frame`);
  function placeOnCanvas(stage, [bw, bh], [aw, ah], p) {
    const width = Math.max(p.beforeX + bw, p.afterX + aw), height = Math.max(p.beforeY + bh, p.afterY + ah);
    const pct = (v) => `${v / width * 100}%`;
    stage.style.setProperty("--natural-width", `${width}px`);
    stage.style.setProperty("--aspect", String(width / height));
    stage.style.setProperty("--before-w", pct(bw));
    stage.style.setProperty("--after-w", pct(aw));
    stage.style.setProperty("--before-x", pct(p.beforeX));
    stage.style.setProperty("--after-x", pct(p.afterX));
    stage.style.setProperty("--before-y", pct(p.beforeY));
    stage.style.setProperty("--after-y", pct(p.afterY));
    stage.dataset.partial = "1";
    stage.style.setProperty("--after-clip", comparedPart([p.afterX, p.afterY, aw, ah], [p.beforeX, p.beforeY, bw, bh]));
  }
  function comparedPart([x, y, w, h], [ox, oy, ow, oh]) {
    const pct = (v, of) => `${Math.max(0, v) / of * 100}%`;
    return `inset(${pct(oy - y, h)} ${pct(x + w - (ox + ow), w)} ${pct(y + h - (oy + oh), h)} ${pct(ox - x, w)})`;
  }
  function buildAlignBar(stage, pair, beforeSize, afterSize, showSame, found) {
    const [bw, bh] = beforeSize, [aw, ah] = afterSize;
    const slack = Math.abs(bw - aw), beforeNarrow = bw < aw;
    const images = canAutoAlign(pair);
    const bar = el("div", `${PREFIX}-align`);
    const note = el("span", `${PREFIX}-align-note`);
    note.textContent = found ? `One screenshot is a crop of the other (before ${bw} \xD7 ${bh}, after ${aw} \xD7 ${ah}). Line them up by` : `Different sizes (before ${bw} \xD7 ${bh}, after ${aw} \xD7 ${ah}). Line them up by`;
    const segmented = el("div", `${PREFIX}-segmented`);
    const choices = found ? [{ align: "auto", label: "Auto" }, { align: "left", label: "Top" }] : ALIGNS.filter(({ align }) => align !== "auto" || images);
    const buttons = choices.map(({ align, label }) => {
      const button = el("button", `${PREFIX}-mode`);
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        try {
          localStorage.setItem(ALIGN_KEY, align);
        } catch {
        }
        eachAlignBar((bar2) => bar2.sync());
      });
      return { align, button };
    });
    segmented.append(...buttons.map(({ button }) => button));
    const status = el("span", `${PREFIX}-align-note`);
    bar.append(note, segmented, status);
    const frame = frameOf(stage);
    const placeSideways = (offset) => placeOnCanvas(
      stage,
      beforeSize,
      afterSize,
      beforeNarrow ? { beforeX: offset, beforeY: 0, afterX: 0, afterY: 0 } : { beforeX: 0, beforeY: 0, afterX: offset, afterY: 0 }
    );
    let autoPlacement = found?.placement ?? null;
    let autoDiff = found?.diff ?? null;
    let autoSame = found?.same ?? null;
    let shownDiff = null;
    const showDiff = (url) => {
      if (url === shownDiff) return;
      shownDiff = url;
      frame.dispatchEvent(new CustomEvent("peekaboo:diff", { detail: url }));
    };
    let waitingForPermission = false;
    let fellBack = false;
    const press = (align) => {
      for (const { align: buttonAlign, button } of buttons) button.setAttribute("aria-pressed", String(buttonAlign === align));
    };
    const runAuto = () => {
      status.textContent = "Lining up\u2026";
      askBackground("align", pair, (response) => {
        status.replaceChildren();
        if (response?.placement) {
          autoPlacement = response.placement;
          autoDiff = response.diff;
          autoSame = response.same;
          waitingForPermission = false;
          fellBack = false;
          sync2();
          return;
        }
        placeSideways(slack / 2);
        fellBack = true;
        press("center");
        if (response?.needsPermission) {
          waitingForPermission = true;
          const allow = el("button", `${PREFIX}-expand`);
          allow.type = "button";
          allow.textContent = "Turn on Auto-align";
          allow.title = "Opens Peekaboo's settings next to this tab; you come back here once it's on";
          allow.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-options" }));
          status.append("Centered for now. Auto-align finds where they match: ", allow);
        } else {
          status.textContent = "Couldn't line them up; centered instead.";
        }
      });
    };
    const retryAuto = () => {
      if (waitingForPermission && loadAlign() === "auto") runAuto();
    };
    const sync2 = () => {
      let current = images ? loadAlign() : loadAlign() === "auto" ? "left" : loadAlign();
      if (found && current !== "auto") current = "left";
      press(current === "auto" && fellBack ? "center" : current);
      if (current !== "auto") status.replaceChildren();
      showDiff(current === "auto" ? autoDiff : null);
      showSame(current === "auto" ? autoSame : null);
      if (current === "left") placeSideways(0);
      else if (current === "center") placeSideways(slack / 2);
      else if (current === "right") placeSideways(slack);
      else if (autoPlacement) placeOnCanvas(stage, beforeSize, afterSize, autoPlacement);
      else runAuto();
    };
    alignBars.set(frame, { sync: sync2, retryAuto });
    sync2();
    return bar;
  }
  function loadAlign() {
    try {
      const saved = localStorage.getItem(ALIGN_KEY);
      if (ALIGNS.some(({ align }) => align === saved)) return saved;
    } catch {
    }
    return CAN_AUTO ? "auto" : "left";
  }
  function buildPlayButton(stages) {
    const button = el("button", `${PREFIX}-expand`);
    button.type = "button";
    button.textContent = "\u25B6 Play";
    button.title = "Play both recordings from the start, in step";
    let playing = false;
    button.addEventListener("click", () => {
      playing = !playing;
      button.textContent = playing ? "\u275A\u275A Pause" : "\u25B6 Play";
      for (const { videos } of stages) {
        for (const video of videos) {
          if (playing) {
            video.currentTime = 0;
            void video.play();
          } else {
            video.pause();
          }
        }
      }
    });
    return button;
  }
  var VIEWER_MODES = MODES.filter(({ mode }) => mode !== "table");
  var viewer = null;
  function openViewer(start) {
    closeViewer();
    const slides = allSlides();
    const overlay = el("div", `${PREFIX}-viewer`);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const bar = el("div", `${PREFIX}-viewer-bar`);
    const previous = navButton("chevron-left", "Previous pair (\u2190)", () => stepViewer(-1));
    const counter = el("span", `${PREFIX}-viewer-counter`);
    const next = navButton("chevron-right", "Next pair (\u2192)", () => stepViewer(1));
    const segmented = el("div", `${PREFIX}-segmented`);
    const modeButtons = VIEWER_MODES.map(({ mode, label, hint }, index) => {
      const button = el("button", `${PREFIX}-mode`);
      button.type = "button";
      button.textContent = label;
      button.title = `${hint} (${index + 1})`;
      button.addEventListener("click", () => setModeEverywhere(mode));
      return { mode, button };
    });
    segmented.append(...modeButtons.map(({ button }) => button));
    const close = navButton("x", "Close (Esc)", closeViewer);
    close.classList.add(`${PREFIX}-viewer-close`);
    bar.append(previous, counter, next, segmented, close);
    const title = el("div", `${PREFIX}-viewer-title`);
    const body = el("div", `${PREFIX}-viewer-body`);
    const column = el("div", `${PREFIX}-viewer-column`);
    const caption = el("p", `${PREFIX}-viewer-caption`);
    column.append(caption);
    body.append(column);
    const keys = buildKeyHints();
    overlay.append(bar, title, body, keys.row);
    document.body.append(overlay);
    document.documentElement.classList.add(`${PREFIX}-locked`);
    viewer = { overlay, body, counter, title, caption, modeButtons, keys, slides, index: -1, placeholder: document.createComment("peekaboo") };
    overlay.addEventListener("mousedown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    overlay.addEventListener("keydown", keepFocusInside);
    if (loadMode() === "table") setModeEverywhere(DEFAULT_MODE);
    syncViewerModes();
    showSlide(Math.max(0, slides.indexOf(start)));
  }
  function showSlide(index) {
    if (!viewer) return;
    returnStage();
    const slide = viewer.slides[index];
    viewer.index = index;
    slide.stage.before(viewer.placeholder);
    viewer.caption.before(slide.stage);
    viewer.counter.textContent = `${index + 1} / ${viewer.slides.length}`;
    viewer.title.textContent = slide.label;
    viewer.title.hidden = !slide.label;
    viewer.caption.textContent = slide.caption;
    viewer.caption.hidden = !slide.caption;
    viewer.body.classList.toggle(`${PREFIX}-has-caption`, Boolean(slide.caption));
    syncKeyHints();
    frameOf(slide.stage).focus({ preventScroll: true });
  }
  function stepViewer(delta) {
    if (!viewer) return;
    const count = viewer.slides.length;
    showSlide((viewer.index + delta + count) % count);
  }
  function returnStage() {
    if (!viewer || viewer.index < 0) return;
    viewer.placeholder.replaceWith(viewer.slides[viewer.index].stage);
  }
  function closeViewer() {
    if (!viewer) return;
    returnStage();
    const lastStage = viewer.index >= 0 ? viewer.slides[viewer.index].stage : null;
    viewer.overlay.remove();
    document.documentElement.classList.remove(`${PREFIX}-locked`);
    viewer = null;
    lastStage?.scrollIntoView({ block: "center" });
    lastStage?.closest(`.${PREFIX}`)?.querySelector(`.${PREFIX}-toolbar > .${PREFIX}-expand:not([hidden])`)?.focus({ preventScroll: true });
  }
  function keepFocusInside(event) {
    if (event.key !== "Tab" || !viewer) return;
    const stops = Array.from(viewer.overlay.querySelectorAll(`button, .${PREFIX}-frame`)).filter((node) => node.getClientRects().length > 0);
    const first = stops[0], last = stops[stops.length - 1];
    const leaving = event.shiftKey ? document.activeElement === first : document.activeElement === last;
    if (!leaving && viewer.overlay.contains(document.activeElement)) return;
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
  function syncViewerModes() {
    if (!viewer) return;
    const current = loadMode();
    for (const { mode, button } of viewer.modeButtons) button.setAttribute("aria-pressed", String(mode === current));
    syncKeyHints();
  }
  function syncKeyHints() {
    if (!viewer || viewer.index < 0) return;
    const diff = frameOf(viewer.slides[viewer.index].stage).dataset.mode === "diff";
    viewer.keys.flip.hidden = diff;
    viewer.keys.peekAction.textContent = diff ? " hold for After" : " hold to peek";
  }
  function handleViewerKeys(event) {
    if (!viewer) return;
    const modeIndex = Number(event.key) - 1;
    if (event.key === "Escape") closeViewer();
    else if (event.key === "ArrowLeft") stepViewer(-1);
    else if (event.key === "ArrowRight") stepViewer(1);
    else if (VIEWER_MODES[modeIndex]) setModeEverywhere(VIEWER_MODES[modeIndex].mode);
    else if ((event.key === " " || event.key === "Enter") && !(event.target instanceof HTMLButtonElement)) viewer.slides[viewer.index].flip();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
  function allSlides() {
    return Array.from(widgets).filter((widget) => widget.root.isConnected).sort((a, b) => a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1).flatMap((widget) => widget.slides);
  }
  function captionBelow(table) {
    const next = outermostWrapper(table).nextElementSibling;
    const onlyChild = next?.children.length === 1 ? next.firstElementChild : null;
    const isCaption = next?.tagName === "P" && onlyChild?.tagName === "EM" && next.textContent?.trim() === onlyChild.textContent?.trim();
    return isCaption ? next.textContent.trim() : "";
  }
  function outermostWrapper(table) {
    let node = table;
    while (!node.nextElementSibling && node.parentElement?.tagName.includes("-")) node = node.parentElement;
    return node;
  }
  function buildKeyHints() {
    const row = el("div", `${PREFIX}-viewer-keys`);
    const hint = (keys, action) => {
      const item = el("span", `${PREFIX}-viewer-key`);
      for (const key of keys) item.append(Object.assign(el("kbd", /^[←→↑↓]$/.test(key) ? `${PREFIX}-arrow` : ""), { textContent: key }));
      const text = document.createTextNode(` ${action}`);
      item.append(text);
      row.append(item);
      return { item, text };
    };
    hint(["\u2190", "\u2192"], "pair");
    const flip = hint(["Space"], "flip").item;
    const peekAction = hint(["Shift"], "hold to peek").text;
    hint(VIEWER_MODES.map((_, index) => String(index + 1)), VIEWER_MODES.map(({ label }) => label).join(" / "));
    hint(["Esc"], "close");
    return { row, flip, peekAction };
  }
  function navButton(name, title, onClick) {
    const button = el("button", `${PREFIX}-nav`);
    button.type = "button";
    button.append(icon(name));
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", onClick);
    return button;
  }
  function loadMode() {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (MODES.some(({ mode }) => mode === saved)) return saved;
    } catch {
    }
    return DEFAULT_MODE;
  }
  function setModeEverywhere(mode, anchor) {
    const topBefore = anchor?.getBoundingClientRect().top;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
    }
    for (const widget of widgets) {
      if (widget.root.isConnected) widget.applyMode(mode);
      else widgets.delete(widget);
    }
    syncViewerModes();
    if (anchor && topBefore !== void 0) window.scrollBy(0, anchor.getBoundingClientRect().top - topBefore);
  }
  var ICONS = {
    "chevron-left": "M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z",
    "chevron-right": "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
    "arrow-up": "M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018L9 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z",
    "arrow-down": "M13.03 8.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.47 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l2.97 2.97V3.75a.75.75 0 0 1 1.5 0v7.44l2.97-2.97a.75.75 0 0 1 1.06 0Z",
    x: "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z",
    "screen-full": "M1.75 10a.75.75 0 0 1 .75.75v2.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 1 13.25v-2.5a.75.75 0 0 1 .75-.75Zm12.5 0a.75.75 0 0 1 .75.75v2.5A1.75 1.75 0 0 1 13.25 15h-2.5a.75.75 0 0 1 0-1.5h2.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 .75-.75ZM2.75 2.5a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0v-2.5C1 1.784 1.784 1 2.75 1h2.5a.75.75 0 0 1 0 1.5ZM10.75 1h2.5c.966 0 1.75.784 1.75 1.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.25.25 0 0 0-.25-.25h-2.5a.75.75 0 0 1 0-1.5Z"
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add(`${PREFIX}-icon`);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }
  function tag(text, side) {
    const node = el("span", `${PREFIX}-tag ${PREFIX}-tag-${side}`);
    node.textContent = text;
    return node;
  }
  function el(name, className) {
    const node = document.createElement(name);
    node.className = className;
    return node;
  }
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
/* GitHub's markdown gives the table it stands in for a 16px bottom margin. */
.${PREFIX} { margin-bottom: 16px; }
/* In Side by side the widget is only the toolbar, whose own 8px is the gap to GitHub's table. */
.${PREFIX}[data-mode="table"] { margin-bottom: 0; }
/* Our display rules would otherwise beat the hidden attribute on pages without a global [hidden] reset. */
.${PREFIX} [hidden], .${PREFIX}-viewer [hidden] { display: none !important; }
.${PREFIX}-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.${PREFIX}-segmented { display: inline-flex; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; overflow: hidden; }
.${PREFIX}-mode, .${PREFIX}-expand {
  font: inherit; font-size: 12px; line-height: 20px; padding: 3px 10px; cursor: pointer;
  color: var(--fgColor-default, #1f2328); background: var(--bgColor-default, #fff); border: 0;
}
.${PREFIX}-mode + .${PREFIX}-mode { border-left: 1px solid var(--borderColor-default, #d1d9e0); }
.${PREFIX}-mode[aria-pressed="true"] { background: var(--bgColor-accent-emphasis, #0969da); color: var(--fgColor-onEmphasis, #fff); }
.${PREFIX}-expand { border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; }
/* GitHub's own button states: --bgColor-muted is nearly the page colour, so a hover on it is invisible in dark. */
.${PREFIX}-mode:hover:not([aria-pressed="true"]), .${PREFIX}-expand:hover, .${PREFIX}-nav:hover { background: var(--button-default-bgColor-hover, #eff2f5); }
.${PREFIX}-mode:active:not([aria-pressed="true"]), .${PREFIX}-expand:active, .${PREFIX}-nav:active { background: var(--button-default-bgColor-active, #e6eaef); }
.${PREFIX}-mode:focus-visible, .${PREFIX}-expand:focus-visible, .${PREFIX}-nav:focus-visible { outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: -2px; }
/* The pressed fill is the focus colour, so a ring in it would vanish. */
.${PREFIX}-mode[aria-pressed="true"]:focus-visible { outline-color: var(--fgColor-onEmphasis, #fff); }
.${PREFIX}-expand { display: inline-flex; align-items: center; gap: 6px; }
.${PREFIX}-icon { width: 16px; height: 16px; fill: currentColor; flex-shrink: 0; }
.${PREFIX}-view { display: flex; flex-direction: column; gap: 16px; }
.${PREFIX}-stage { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.${PREFIX}-frame, .${PREFIX}-legend { width: 100%; max-width: var(--natural-width, 100%); }
.${PREFIX}-frame {
  position: relative; display: grid;
  border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; overflow: hidden;
  background: var(--bgColor-muted, #f6f8fa); touch-action: none; user-select: none; outline-offset: 2px;
}
.${PREFIX}-frame[data-mode="flip"] { cursor: pointer; }
.${PREFIX}-canvas { grid-area: 1 / 1; display: grid; position: relative; }
.${PREFIX}-frame .${PREFIX}-media { grid-area: 1 / 1; display: block; width: 100%; max-width: none; height: auto; align-self: start; }
.${PREFIX}-frame .${PREFIX}-media[data-from="before"] { width: var(--before-w, 100%); justify-self: start; margin: var(--before-y, 0%) 0 0 var(--before-x, 0%); }
.${PREFIX}-frame .${PREFIX}-media[data-from="after"] { width: var(--after-w, 100%); justify-self: start; margin: var(--after-y, 0%) 0 0 var(--after-x, 0%); }
.${PREFIX}-align { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--fgColor-muted, #59636e); }
/* Before on the left, After on the right, like GitHub's own 2-up. In Flip the side on screen is underlined. */
.${PREFIX}-legend { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; line-height: 20px; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-legend[data-mode="flip"][data-showing="before"] .${PREFIX}-tag-before,
.${PREFIX}-legend[data-mode="flip"][data-showing="after"] .${PREFIX}-tag-after { color: var(--fgColor-default, #1f2328); box-shadow: inset 0 -2px var(--borderColor-accent-emphasis, #0969da); }
.${PREFIX}-legend[data-mode="diff"] .${PREFIX}-tag-before { color: var(--fgColor-danger, #d1242f); }
.${PREFIX}-legend[data-mode="diff"] .${PREFIX}-tag-after { color: var(--fgColor-success, #1a7f37); }
.${PREFIX}-legend-middle { display: grid; font-weight: 400; }
.${PREFIX}-flip-hint, .${PREFIX}-not-compared { grid-area: 1 / 1; justify-self: center; visibility: hidden; }
.${PREFIX}-legend[data-mode="flip"] .${PREFIX}-flip-hint { visibility: visible; }
/* Full screen has its own key row. */
.${PREFIX}-viewer-body .${PREFIX}-legend .${PREFIX}-flip-hint { visibility: hidden; }
.${PREFIX}-not-compared { display: inline-flex; align-items: center; gap: 6px; }
/* A patch of the frame's own hatch; a bordered square would read as a checkbox. */
.${PREFIX}-not-compared::before { content: ""; width: 16px; height: 10px; box-shadow: inset 0 0 0 1px var(--borderColor-muted, #d1d9e0b3); background: var(--${PREFIX}-hatch); }
.${PREFIX}-stage[data-partial] .${PREFIX}-legend[data-mode="diff"] .${PREFIX}-not-compared { visibility: visible; }
.${PREFIX}-diff, .${PREFIX}-diff-layer { grid-area: 1 / 1; display: grid; pointer-events: none; }
.${PREFIX}-diff-layer { isolation: isolate; opacity: 0.8; }
.${PREFIX}-diff-removed { filter: url(#${PREFIX}-removed); }
.${PREFIX}-diff-added { filter: url(#${PREFIX}-added); }
.${PREFIX}-frame[data-resampled] .${PREFIX}-diff-removed { filter: url(#${PREFIX}-removed-resampled); }
.${PREFIX}-frame[data-resampled] .${PREFIX}-diff-added { filter: url(#${PREFIX}-added-resampled); }
.${PREFIX}-frame:not([data-mode="diff"]) .${PREFIX}-diff { display: none; }
.${PREFIX}-diff-image { grid-area: 1 / 1; display: block; width: 100%; max-width: none; height: auto; align-self: start; }
/* Opaque, so the hatch below shows only where After doesn't cover (not compared); same look as 25% over white. */
.${PREFIX}-frame[data-mode="diff"] .${PREFIX}-after { filter: grayscale(1) contrast(0.143) brightness(1.75); clip-path: var(--after-clip, none); }
/* The filter above makes the ghost a stacking context, which paints over plain siblings: lift the colours over it. */
.${PREFIX}-diff { z-index: 1; }
/* The ghost fades toward white in both themes: over a dark page it turned into a grey slab the red and green lost contrast on. */
.${PREFIX}, .${PREFIX}-viewer { --${PREFIX}-hatch: repeating-linear-gradient(-45deg, #fff 0 5px, #d8dee4 5px 6px); }
.${PREFIX}-frame[data-mode="diff"] { background: var(--${PREFIX}-hatch); }
/* Scaled to a fractional device pixel ratio, an image's edge pixels are partly transparent, and the blend turns
   that into a false "changed" outline. Clipping the blended group (not each copy, which moves
   the edge inward instead) trims it. 2px, because the filter's 1px dilate runs before the clip. A real change only in
   the outermost 2px no longer shows. */
.${PREFIX}-diff-layer { clip-path: inset(2px); }
.${PREFIX}-label { font-size: 12px; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-same { margin: 0; font-size: 12px; color: var(--fgColor-attention, #9a6700); font-weight: 600; }

.${PREFIX}-locked { overflow: hidden; }
.${PREFIX}-viewer {
  position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column; gap: 10px;
  padding: 12px 24px 16px; background: var(--bgColor-default, #fff); color: var(--fgColor-default, #1f2328);
  font-size: 14px;
}
.${PREFIX}-viewer-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${PREFIX}-viewer-bar > * { flex-shrink: 0; }
.${PREFIX}-viewer-counter { min-width: 56px; text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-nav {
  font: inherit; line-height: 1; width: 32px; height: 28px; cursor: pointer; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  color: var(--fgColor-default, #1f2328); background: var(--bgColor-default, #fff); border: 1px solid var(--borderColor-default, #d1d9e0);
}
.${PREFIX}-viewer-bar .${PREFIX}-segmented { margin-left: 8px; }
.${PREFIX}-viewer-keys { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 18px; font-size: 12px; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-viewer-key { display: inline-flex; align-items: baseline; gap: 3px; white-space: nowrap; }
.${PREFIX}-viewer-key kbd {
  font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 18px; padding: 0 4px; text-align: center;
  border: 1px solid var(--borderColor-default, #d1d9e0); border-bottom-width: 2px; border-radius: 4px;
  background: var(--bgColor-muted, #f6f8fa); color: var(--fgColor-default, #1f2328);
}
.${PREFIX}-viewer-key kbd.${PREFIX}-arrow { font-family: inherit; font-size: 12px; }
.${PREFIX}-viewer-close { margin-left: auto; }
.${PREFIX}-viewer-title { font-weight: 600; text-align: center; }
.${PREFIX}-viewer-column { display: flex; flex-direction: column; align-items: center; gap: 12px; width: 100%; }
.${PREFIX}-viewer-caption {
  margin: 0; max-width: min(900px, 100%); text-align: center; font-size: 15px; line-height: 1.5; text-wrap: balance;
  color: var(--fgColor-default, #1f2328); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.${PREFIX}-viewer-body { flex: 1; min-height: 0; display: flex; justify-content: center; align-items: safe center; overflow: auto; container-type: size; }
.${PREFIX}-viewer-body .${PREFIX}-frame:focus { outline: none; }
.${PREFIX}-viewer-body .${PREFIX}-stage { align-items: center; width: 100%; }
.${PREFIX}-viewer-body .${PREFIX}-label { display: none; }
/* Full screen fills the space, upscaling small crops: sized from the viewer's own box, not vh, so page zoom can't overflow it. */
.${PREFIX}-viewer-body .${PREFIX}-frame, .${PREFIX}-viewer-body .${PREFIX}-legend { max-width: none; width: min(100cqw, calc((100cqh - var(--legend-room) - var(--caption-room, 0px) - var(--same-room, 0px)) * var(--aspect, 1.6))); }
/* The legend's 20px line plus the stage's 6px gap. */
.${PREFIX}-viewer-body { --legend-room: 26px; }
.${PREFIX}-viewer-body:has(.${PREFIX}-same:not([hidden])) { --same-room: 24px; }
/* Room for up to three caption lines, so the image shrinks instead of pushing the caption off screen. */
.${PREFIX}-has-caption { --caption-room: 92px; }
`;
    document.head.append(style);
  }
})();
