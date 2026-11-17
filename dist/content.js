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
    expand.textContent = "\u2922 Full screen";
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
      slides: stages.map((stage, index) => ({ stage: stage.root, label: pairs[index].label, caption, flip: stage.flip, regions: stage.regions, zoomTo: stage.zoomTo }))
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
    const focus = el("div", `${PREFIX}-focus`);
    focus.hidden = true;
    canvas.append(after, before, diff, focus);
    frame.append(canvas, beforeTag, afterTag);
    const canDiff = pair.before instanceof HTMLImageElement && pair.after instanceof HTMLImageElement;
    const stats = el("p", `${PREFIX}-stats`);
    stats.hidden = true;
    root.append(frame, stats);
    if (pair.label) {
      const caption = el("figcaption", `${PREFIX}-label`);
      caption.textContent = pair.label;
      root.append(caption);
    }
    let regions = [];
    fitPair(root, frame, pair, (counts) => {
      showStats(stats, counts);
      regions = counts && counts.regions.length <= MAX_STEPS ? counts.regions : [];
      zoomTo(null);
      root.dispatchEvent(new Event("peekaboo:regions", { bubbles: true }));
    });
    function zoomTo(region) {
      focus.hidden = !region;
      if (!region) {
        canvas.style.transform = "";
        return;
      }
      const fit = Math.min(1 / (region.w + 2 * ZOOM_MARGIN), 1 / (region.h + 2 * ZOOM_MARGIN));
      const zoom = Math.min(MAX_ZOOM, Math.max(1, fit));
      const shift = (start, size) => Math.min(0, Math.max(1 - zoom, 0.5 - zoom * (start + size / 2)));
      canvas.style.transform = `translate(${shift(region.x, region.w) * 100}%, ${shift(region.y, region.h) * 100}%) scale(${zoom})`;
      canvas.style.setProperty("--zoom", String(zoom));
      Object.assign(focus.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` });
    }
    let mode = DEFAULT_MODE;
    let showingBefore = true;
    function render() {
      const shown = mode === "diff" && !canDiff ? "flip" : mode;
      frame.dataset.mode = shown;
      beforeTag.textContent = shown === "diff" ? "Before only" : "Before";
      afterTag.textContent = shown === "diff" ? "After only" : "After";
      after.style.visibility = shown === "flip" && showingBefore ? "hidden" : "visible";
      if (shown === "diff") {
        if (!diff.hasChildNodes()) diff.append(...buildDiffLayers(pair.before, pair.after));
        before.style.opacity = "0";
      } else if (shown === "flip") {
        before.style.opacity = showingBefore ? "1" : "0";
        frame.dataset.showing = showingBefore ? "before" : "after";
      }
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
    frame.addEventListener("keydown", (event) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      flip();
    });
    return {
      root,
      regions: () => regions,
      flip,
      zoomTo,
      videos: [before, after].filter((media) => media instanceof HTMLVideoElement),
      setMode(next) {
        mode = next;
        render();
      }
    };
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
    svg.innerHTML = Object.entries(DIFF_COLORS).map(
      ([kind, [r, g, b]]) => `
    <filter id="${PREFIX}-${kind}" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  6 6 6 0 -0.06" />
      <feMorphology operator="dilate" radius="1" />
    </filter>`
    ).join("");
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
  var MAX_ZOOM = 4;
  var ZOOM_MARGIN = 0.02;
  var MAX_STEPS = 15;
  function fitPair(root, frame, pair, showStats2) {
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
        frame.style.setProperty("--natural-width", `${aw}px`);
        frame.style.setProperty("--aspect", String(aw / ah));
        if (sameSize && canAutoAlign(pair)) askBackground("compare", pair, (response) => showStats2(response?.stats ?? null));
        return;
      }
      if (bw === aw) {
        frame.style.setProperty("--natural-width", `${aw}px`);
        frame.style.setProperty("--aspect", String(aw / Math.max(bh, ah)));
        if (!canAutoAlign(pair) || loadAlign() !== "auto") return;
        askBackground("align", pair, (response) => {
          const p = response?.placement;
          if (!p || !p.beforeY && !p.afterY) return;
          root.insertBefore(buildAlignBar(frame, pair, [bw, bh], [aw, ah], showStats2, { placement: p, diff: response.diff, stats: response.stats }), frame.nextSibling);
        });
        return;
      }
      root.insertBefore(buildAlignBar(frame, pair, [bw, bh], [aw, ah], showStats2), frame.nextSibling);
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
  function showStats(node, stats) {
    node.hidden = !stats;
    if (!stats) return;
    const same = stats.changed === 0;
    node.dataset.kind = same ? "same" : "changed";
    const share = stats.changed / stats.compared * 100;
    const percent = share < 0.1 ? "<0.1" : share < 10 ? share.toFixed(1) : Math.round(share).toString();
    const scattered = stats.regions.length > MAX_STEPS ? `, in ${stats.regions.length >= 99 ? "99+" : stats.regions.length} places: too scattered to step through` : "";
    node.textContent = same ? "No visible difference. The same screenshot twice?" : `${percent}% of pixels changed${scattered}`;
    node.title = `${stats.changed.toLocaleString()} of ${stats.compared.toLocaleString()} compared pixels differ visibly`;
  }
  function naturalSize(media) {
    return media instanceof HTMLImageElement ? [media.naturalWidth, media.naturalHeight] : [media.videoWidth, media.videoHeight];
  }
  function placeOnCanvas(frame, [bw, bh], [aw, ah], p) {
    const width = Math.max(p.beforeX + bw, p.afterX + aw), height = Math.max(p.beforeY + bh, p.afterY + ah);
    const pct = (v) => `${v / width * 100}%`;
    frame.style.setProperty("--natural-width", `${width}px`);
    frame.style.setProperty("--aspect", String(width / height));
    frame.style.setProperty("--before-w", pct(bw));
    frame.style.setProperty("--after-w", pct(aw));
    frame.style.setProperty("--before-x", pct(p.beforeX));
    frame.style.setProperty("--after-x", pct(p.afterX));
    frame.style.setProperty("--before-y", pct(p.beforeY));
    frame.style.setProperty("--after-y", pct(p.afterY));
  }
  function buildAlignBar(frame, pair, beforeSize, afterSize, showStats2, found) {
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
    const placeSideways = (offset) => placeOnCanvas(
      frame,
      beforeSize,
      afterSize,
      beforeNarrow ? { beforeX: offset, beforeY: 0, afterX: 0, afterY: 0 } : { beforeX: 0, beforeY: 0, afterX: offset, afterY: 0 }
    );
    let autoPlacement = found?.placement ?? null;
    let autoDiff = found?.diff ?? null;
    let autoStats = found?.stats ?? null;
    let shownDiff = null;
    const showDiff = (url) => {
      if (url === shownDiff) return;
      shownDiff = url;
      frame.dispatchEvent(new CustomEvent("peekaboo:diff", { detail: url }));
    };
    let waitingForPermission = false;
    const runAuto = () => {
      status.textContent = "Lining up\u2026";
      askBackground("align", pair, (response) => {
        status.replaceChildren();
        if (response?.placement) {
          autoPlacement = response.placement;
          autoDiff = response.diff;
          autoStats = response.stats;
          waitingForPermission = false;
          sync2();
          return;
        }
        placeSideways(slack / 2);
        if (response?.needsPermission) {
          waitingForPermission = true;
          const allow = el("button", `${PREFIX}-expand`);
          allow.type = "button";
          allow.textContent = "Turn on Auto-align";
          allow.title = "Opens Peekaboo's settings next to this tab; you come back here once it's on";
          allow.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-options" }));
          status.append("Centred for now. Peekaboo can line them up exactly: ", allow);
        } else {
          status.textContent = "Couldn't line them up; centred instead.";
        }
      });
    };
    const retryAuto = () => {
      if (waitingForPermission && loadAlign() === "auto") runAuto();
    };
    const sync2 = () => {
      let current = images ? loadAlign() : loadAlign() === "auto" ? "left" : loadAlign();
      if (found && current !== "auto") current = "left";
      for (const { align, button } of buttons) button.setAttribute("aria-pressed", String(align === current));
      if (current !== "auto") status.replaceChildren();
      showDiff(current === "auto" ? autoDiff : null);
      showStats2(current === "auto" ? autoStats : null);
      if (current === "left") placeSideways(0);
      else if (current === "center") placeSideways(slack / 2);
      else if (current === "right") placeSideways(slack);
      else if (autoPlacement) placeOnCanvas(frame, beforeSize, afterSize, autoPlacement);
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
    const previous = navButton("\u2039", "Previous pair (\u2190)", () => stepViewer(-1));
    const counter = el("span", `${PREFIX}-viewer-counter`);
    const next = navButton("\u203A", "Next pair (\u2192)", () => stepViewer(1));
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
    const changes = el("div", `${PREFIX}-viewer-changes`);
    const changeLabel = el("span", `${PREFIX}-viewer-counter`);
    changes.append(navButton("\u2191", "Previous change (\u2191)", () => stepChange(-1)), changeLabel, navButton("\u2193", "Next change (\u2193)", () => stepChange(1)));
    const close = navButton("\u2715", "Close (Esc)", closeViewer);
    close.classList.add(`${PREFIX}-viewer-close`);
    bar.append(previous, counter, next, segmented, changes, close);
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
    viewer = { overlay, body, counter, title, caption, modeButtons, changes: { group: changes, label: changeLabel, key: keys.change }, slides, index: -1, change: -1, placeholder: document.createComment("peekaboo") };
    overlay.addEventListener("mousedown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    overlay.addEventListener("peekaboo:regions", (event) => {
      if (viewer && event.target === viewer.slides[viewer.index]?.stage) showChange(-1);
    });
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
    showChange(-1);
    slide.stage.querySelector(`.${PREFIX}-frame`)?.focus({ preventScroll: true });
  }
  function stepChange(delta) {
    if (!viewer) return;
    const count = viewer.slides[viewer.index].regions().length;
    if (count) showChange((viewer.change + 1 + delta + count + 1) % (count + 1) - 1);
  }
  function showChange(change) {
    if (!viewer) return;
    const slide = viewer.slides[viewer.index];
    const regions = slide.regions();
    viewer.change = change;
    slide.zoomTo(regions[change] ?? null);
    viewer.changes.group.hidden = regions.length === 0;
    viewer.changes.key.hidden = regions.length === 0;
    const many = regions.length === 1 ? "1 change" : `${regions.length} changes`;
    viewer.changes.label.textContent = change < 0 ? many : `${change + 1} of ${many}`;
  }
  function stepViewer(delta) {
    if (!viewer) return;
    const count = viewer.slides.length;
    showSlide((viewer.index + delta + count) % count);
  }
  function returnStage() {
    if (!viewer || viewer.index < 0) return;
    const slide = viewer.slides[viewer.index];
    slide.zoomTo(null);
    viewer.placeholder.replaceWith(slide.stage);
  }
  function closeViewer() {
    if (!viewer) return;
    returnStage();
    const lastStage = viewer.index >= 0 ? viewer.slides[viewer.index].stage : null;
    viewer.overlay.remove();
    document.documentElement.classList.remove(`${PREFIX}-locked`);
    viewer = null;
    lastStage?.scrollIntoView({ block: "center" });
  }
  function syncViewerModes() {
    if (!viewer) return;
    const current = loadMode();
    for (const { mode, button } of viewer.modeButtons) button.setAttribute("aria-pressed", String(mode === current));
  }
  function handleViewerKeys(event) {
    if (!viewer) return;
    const modeIndex = Number(event.key) - 1;
    if (event.key === "Escape") closeViewer();
    else if (event.key === "ArrowLeft") stepViewer(-1);
    else if (event.key === "ArrowRight") stepViewer(1);
    else if (event.key === "ArrowUp") stepChange(-1);
    else if (event.key === "ArrowDown") stepChange(1);
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
      for (const key of keys) item.append(Object.assign(el("kbd", ""), { textContent: key }));
      item.append(` ${action}`);
      row.append(item);
      return item;
    };
    hint(["\u2190", "\u2192"], "pair");
    const change = hint(["\u2191", "\u2193"], "change");
    hint(["Space"], "flip");
    hint(VIEWER_MODES.map((_, index) => String(index + 1)), VIEWER_MODES.map(({ label }) => label).join(" / "));
    hint(["Esc"], "close");
    return { row, change };
  }
  function navButton(text, title, onClick) {
    const button = el("button", `${PREFIX}-nav`);
    button.type = "button";
    button.textContent = text;
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
.${PREFIX} { margin-bottom: 8px; }
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
.${PREFIX}-mode:hover:not([aria-pressed="true"]), .${PREFIX}-expand:hover { background: var(--bgColor-muted, #f6f8fa); }
.${PREFIX}-view { display: flex; flex-direction: column; gap: 16px; }
.${PREFIX}-stage { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.${PREFIX}-frame {
  position: relative; display: grid; width: 100%; max-width: var(--natural-width, 100%);
  border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; overflow: hidden;
  background: var(--bgColor-muted, #f6f8fa); touch-action: none; user-select: none; outline-offset: 2px;
}
.${PREFIX}-frame[data-mode="flip"] { cursor: pointer; }
.${PREFIX}-canvas { grid-area: 1 / 1; display: grid; position: relative; transform-origin: 0 0; transition: transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1); }
@media (prefers-reduced-motion: reduce) { .${PREFIX}-canvas { transition: none; } }
/* Drawn inside the zoomed canvas, so line widths divide by the zoom to stay 2px on screen. */
.${PREFIX}-focus {
  position: absolute; pointer-events: none; border-radius: calc(4px / var(--zoom, 1));
  outline: calc(2px / var(--zoom, 1)) solid var(--fgColor-accent, #0969da); outline-offset: calc(4px / var(--zoom, 1));
}
.${PREFIX}-frame .${PREFIX}-media { grid-area: 1 / 1; display: block; width: 100%; max-width: none; height: auto; align-self: start; }
.${PREFIX}-frame .${PREFIX}-media[data-from="before"] { width: var(--before-w, 100%); justify-self: start; margin: var(--before-y, 0%) 0 0 var(--before-x, 0%); }
.${PREFIX}-frame .${PREFIX}-media[data-from="after"] { width: var(--after-w, 100%); justify-self: start; margin: var(--after-y, 0%) 0 0 var(--after-x, 0%); }
.${PREFIX}-align { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-tag {
  position: absolute; top: 8px; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px;
  background: rgb(0 0 0 / 0.65); color: #fff; pointer-events: none;
}
.${PREFIX}-tag-before { left: 8px; }
.${PREFIX}-tag-after { right: 8px; }
.${PREFIX}-frame[data-mode="flip"] .${PREFIX}-tag { left: 8px; right: auto; }
.${PREFIX}-frame[data-mode="flip"][data-showing="before"] .${PREFIX}-tag-after,
.${PREFIX}-frame[data-mode="flip"][data-showing="after"] .${PREFIX}-tag-before { display: none; }
.${PREFIX}-diff, .${PREFIX}-diff-layer { grid-area: 1 / 1; display: grid; pointer-events: none; }
.${PREFIX}-diff-layer { isolation: isolate; opacity: 0.8; }
.${PREFIX}-diff-removed { filter: url(#${PREFIX}-removed); }
.${PREFIX}-diff-added { filter: url(#${PREFIX}-added); }
.${PREFIX}-frame:not([data-mode="diff"]) .${PREFIX}-diff { display: none; }
.${PREFIX}-diff-image { grid-area: 1 / 1; display: block; width: 100%; max-width: none; height: auto; align-self: start; }
.${PREFIX}-frame[data-mode="diff"] .${PREFIX}-after { filter: grayscale(1); opacity: 0.25; }
.${PREFIX}-frame[data-mode="diff"] .${PREFIX}-tag-before { background: rgb(219 36 46); }
.${PREFIX}-frame[data-mode="diff"] .${PREFIX}-tag-after { background: rgb(26 160 77); }
.${PREFIX}-label { font-size: 12px; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-stats { margin: 0; font-size: 12px; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-stats[data-kind="same"] { color: var(--fgColor-attention, #9a6700); font-weight: 600; }

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
  font: inherit; font-size: 18px; line-height: 1; width: 32px; height: 28px; cursor: pointer; border-radius: 6px;
  color: var(--fgColor-default, #1f2328); background: var(--bgColor-default, #fff); border: 1px solid var(--borderColor-default, #d1d9e0);
}
.${PREFIX}-nav:hover { background: var(--bgColor-muted, #f6f8fa); }
.${PREFIX}-viewer-bar .${PREFIX}-segmented { margin-left: 8px; }
.${PREFIX}-viewer-keys { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 18px; font-size: 12px; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-viewer-key { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.${PREFIX}-viewer-key kbd {
  font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 18px; padding: 0 4px; text-align: center;
  border: 1px solid var(--borderColor-default, #d1d9e0); border-bottom-width: 2px; border-radius: 4px;
  background: var(--bgColor-muted, #f6f8fa); color: var(--fgColor-default, #1f2328);
}
.${PREFIX}-viewer-changes { display: flex; align-items: center; gap: 4px; margin-left: 8px; }
.${PREFIX}-viewer-changes .${PREFIX}-viewer-counter { min-width: 96px; }
.${PREFIX}-viewer-close { margin-left: auto; font-size: 14px; }
.${PREFIX}-viewer-title { font-weight: 600; text-align: center; }
.${PREFIX}-viewer-column { display: flex; flex-direction: column; align-items: center; gap: 12px; width: 100%; }
.${PREFIX}-viewer-caption {
  margin: 0; max-width: min(900px, 100%); text-align: center; font-size: 15px; line-height: 1.5;
  color: var(--fgColor-default, #1f2328); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.${PREFIX}-viewer-body { flex: 1; min-height: 0; display: flex; justify-content: center; align-items: safe center; overflow: auto; container-type: size; }
.${PREFIX}-viewer-body .${PREFIX}-frame:focus { outline: none; }
.${PREFIX}-viewer-body .${PREFIX}-stage { align-items: center; width: 100%; }
.${PREFIX}-viewer-body .${PREFIX}-label { display: none; }
/* Full screen fills the space, upscaling small crops: sized from the viewer's own box, not vh, so page zoom can't overflow it. */
.${PREFIX}-viewer-body .${PREFIX}-frame { max-width: none; width: min(100cqw, calc((100cqh - var(--caption-room, 0px) - var(--stats-room, 0px)) * var(--aspect, 1.6))); }
.${PREFIX}-viewer-body:has(.${PREFIX}-stats:not([hidden])) { --stats-room: 24px; }
/* Room for up to three caption lines, so the image shrinks instead of pushing the caption off screen. */
.${PREFIX}-has-caption { --caption-room: 92px; }
`;
    document.head.append(style);
  }
})();
