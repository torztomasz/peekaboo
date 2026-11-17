// Reviewing a side-by-side table means eyeballing two shrunken images across a gap; small shifts (padding,
// colour, a 1px border) disappear. Overlaying the two at the same scale and blinking between them makes the
// difference jump, which the eye catches, so Flip is the default. The original table stays in the DOM (hidden), so
// "Side by side" is always the untouched GitHub rendering.
//
// Tables are found by header text:
// | Before | After | (optionally with a label column such as | Viewport | Before | After |).

type Mode = "table" | "flip" | "diff";

type Pair = { label: string; before: HTMLImageElement | HTMLVideoElement; after: HTMLImageElement | HTMLVideoElement };

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: "table", label: "Side by side", hint: "GitHub's own table" },
  { mode: "flip", label: "Flip", hint: "Click or press Space to blink between before and after" },
  { mode: "diff", label: "Diff", hint: "Unchanged pixels fade out; red was darker before, green is darker after" },
];
const DEFAULT_MODE: Mode = "flip";
const MODE_KEY = "peekaboo-mode";
const PROCESSED = "peekaboo";
const PREFIX = "peekaboo";
// Every widget on the page, so a mode picked on one table applies to all of them, and the full-screen
// viewer can step through every pair on the page, not just one table's.
const widgets = new Set<Widget>();

type Widget = { root: HTMLElement; applyMode: (mode: Mode) => void; slides: Slide[] };

// One pair as the full-screen viewer shows it: the stage element plus the text that explains it.
type Slide = { stage: HTMLElement; label: string; caption: string; flip: () => void; peek: Peek };
type Stage = ReturnType<typeof buildStage>;
type Peek = (on: boolean) => void;

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
  // GitHub re-renders comment bodies on navigation, edits and previews, so we re-scan on DOM changes.
  new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
  // Capture phase, so full-screen keys win over anything focused on the page.
  document.addEventListener("keydown", handleViewerKeys, true);
  document.addEventListener("keydown", (event) => event.key === "Shift" && !event.repeat && startPeek(event), true);
  document.addEventListener("keyup", (event) => event.key === "Shift" && endPeek(), true);
  window.addEventListener("blur", endPeek);
  // Back from the options page with the permission granted: bars waiting for it try again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") eachAlignBar((bar) => bar.retryAuto());
  });
  scheduleSync();
}

function sync() {
  ensureDiffFilters();
  removeOrphanWidgets();
  for (const table of document.querySelectorAll<HTMLTableElement>(".markdown-body table")) {
    if (table.dataset[PROCESSED]) continue;
    table.dataset[PROCESSED] = "1";
    const pairs = readPairs(table);
    if (pairs.length > 0) table.before(buildWidget(table, pairs));
  }
}

function removeOrphanWidgets() {
  for (const widget of document.querySelectorAll<HTMLElement>(`.${PREFIX}`)) {
    if (!(widget.nextElementSibling instanceof HTMLTableElement)) widget.remove();
  }
}

// ---------- Reading the table ----------

function readPairs(table: HTMLTableElement): Pair[] {
  const headers = Array.from(table.tHead?.rows[0]?.cells ?? []).map((cell) => cell.textContent?.trim() ?? "");
  const beforeIndex = headers.findIndex((text) => /^before\b/i.test(text));
  const afterIndex = headers.findIndex((text) => /^after\b/i.test(text));
  if (beforeIndex < 0 || afterIndex < 0) return [];

  const pairs: Pair[] = [];
  for (const row of Array.from(table.tBodies[0]?.rows ?? [])) {
    const before = row.cells[beforeIndex]?.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
    const after = row.cells[afterIndex]?.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
    if (!before || !after) continue;
    const label = Array.from(row.cells)
      .filter((_, index) => index !== beforeIndex && index !== afterIndex)
      .map((cell) => cell.textContent?.trim())
      .filter(Boolean)
      .join(" · ");
    pairs.push({ label, before, after });
  }
  return pairs;
}

// ---------- Widget ----------

function buildWidget(table: HTMLTableElement, pairs: Pair[]) {
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
  expand.title = "Full screen: ← → step through every pair on the page, Esc closes";

  const segmented = el("div", `${PREFIX}-segmented`);
  segmented.append(...modeButtons.map(({ button }) => button));
  toolbar.append(segmented, expand);

  if (pairs.some((pair) => pair.before instanceof HTMLVideoElement || pair.after instanceof HTMLVideoElement)) {
    toolbar.append(buildPlayButton(stages));
  }
  widget.append(toolbar, view);

  function applyMode(mode: Mode) {
    widget.dataset.mode = mode;
    table.hidden = mode !== "table";
    view.hidden = mode === "table";
    expand.hidden = mode === "table";
    for (const { mode: buttonMode, button } of modeButtons) button.setAttribute("aria-pressed", String(buttonMode === mode));
    for (const stage of stages) stage.setMode(mode);
  }
  applyMode(loadMode());
  const caption = captionBelow(table);
  const entry: Widget = {
    root: widget,
    applyMode,
    slides: stages.map((stage, index) => ({ stage: stage.root, label: pairs[index].label, caption, flip: stage.flip, peek: stage.peek })),
  };
  widgets.add(entry);
  expand.addEventListener("click", () => openViewer(entry.slides[0]));
  return widget;
}

function buildStage(pair: Pair) {
  const root = el("figure", `${PREFIX}-stage`);
  const frame = el("div", `${PREFIX}-frame`);
  frame.tabIndex = 0;
  const after = cloneMedia(pair.after, "after");
  const before = cloneMedia(pair.before, "before");
  const beforeTag = tag("Before", "before");
  const afterTag = tag("After", "after");
  const diff = el("div", `${PREFIX}-diff`);
  // The screenshots and the diff share one grid cell; the tags sit on the frame above them.
  const canvas = el("div", `${PREFIX}-canvas`);
  canvas.append(after, before, diff);
  frame.append(canvas);
  // Above the image, not on it: a tag on the image covers the pixels under review (often the changed title).
  const legend = el("div", `${PREFIX}-legend`);
  // The frame looks like a plain image; nothing else says it reacts to a click until you hover it.
  const flipHint = el("span", `${PREFIX}-flip-hint`);
  flipHint.textContent = "Click to flip";
  // The hatch Diff shows where only one screenshot exists needs a key next to red and green.
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

  let mode: Mode = DEFAULT_MODE;
  let showingBefore = true;
  // While Shift is held: Flip shows the other side, Diff shows the plain After under its colours.
  let peeking = false;

  function render() {
    // Blend modes over video need every copy in step; a still-frame diff would mislead, so videos flip instead.
    let shown = mode === "diff" && !canDiff ? "flip" : mode;
    const beforeShown = shownSide();
    if (peeking && shown === "diff") shown = "flip";
    frame.dataset.mode = shown;
    legend.dataset.mode = shown;
    // Red and green mark where each side is darker: ink on light screenshots, but on dark ones a removed white
    // heading shows green, so "only in Before/After" would be wrong half the time.
    beforeTag.textContent = shown === "diff" ? "Darker before" : "Before";
    afterTag.textContent = shown === "diff" ? "Darker after" : "After";
    // Both share one grid cell sized to the taller image, so a taller After would peek out below a flipped-in Before.
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
    const url = (event as CustomEvent<string | null>).detail;
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
  frame.addEventListener("pointerenter", () => (hovered = stage));
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
    peek(on: boolean) {
      if (peeking === on) return;
      peeking = on;
      render();
    },
    flip,
    videos: [before, after].filter((media): media is HTMLVideoElement => media instanceof HTMLVideoElement),
    setMode(next: Mode) {
      mode = next;
      render();
    },
  };  // Last, because with cached images (GitHub re-rendering a comment) it runs at once and calls back into
  // the state above.
  fitPair(root, pair, (isSame) => (same.hidden = !isSame));
  return stage;
}

// ---------- Hold to peek ----------

// The pair under the mouse, so Shift on the page knows which one to peek at.
let hovered: Stage | null = null;
let peekingAt: Peek | null = null;

// Shift is also how capitals are typed, so it does nothing while a text field has focus.
function startPeek(event: KeyboardEvent) {
  const typing = (event.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
  const peek = viewer ? viewer.slides[viewer.index].peek : hovered?.peek;
  if (typing || !peek) return;
  peekingAt = peek;
  peek(true);
}

function endPeek() {
  peekingAt?.(false);
  peekingAt = null;
}

// ---------- Diff ----------

// GitHub serves uploads without CORS headers, so a canvas can't read their pixels. The browser's compositor
// can still blend them: inside an isolated group, `lighten` then `difference` leaves max(0, top − base) per
// channel, i.e. only the pixels where one side is darker. An SVG filter turns that into a solid colour whose
// opacity grows with the difference, dilated 1px so hairline changes (a border, a 1px shift) stay visible.
// "Darker" means ink on light screenshots; on dark screenshots the colours swap.
function buildDiffLayers(beforeSource: HTMLImageElement | HTMLVideoElement, afterSource: HTMLImageElement | HTMLVideoElement) {
  const onlyBefore = diffLayer([beforeSource, "before"], [afterSource, "after"], "removed");
  const onlyAfter = diffLayer([afterSource, "after"], [beforeSource, "before"], "added");
  return [onlyBefore, onlyAfter];
}

// Pixels where `darker` is darker than `other`: max(other, darker) − darker = max(0, other − darker).
type Side = "before" | "after";
type Sided = [HTMLImageElement | HTMLVideoElement, Side];

function diffLayer([darker, darkerSide]: Sided, [other, otherSide]: Sided, kind: "removed" | "added") {
  const group = el("div", `${PREFIX}-diff-layer ${PREFIX}-diff-${kind}`);
  const base = cloneMedia(darker, "diff-part", darkerSide);
  const lighten = cloneMedia(other, "diff-part", otherSide);
  lighten.style.mixBlendMode = "lighten";
  const subtract = cloneMedia(darker, "diff-part", darkerSide);
  subtract.style.mixBlendMode = "difference";
  group.append(base, lighten, subtract);
  return group;
}

const DIFF_COLORS = { removed: [0.86, 0.14, 0.18], added: [0.1, 0.72, 0.3] };

function ensureDiffFilters() {
  if (document.getElementById(`${PREFIX}-filters`)) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = `${PREFIX}-filters`;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  // Alpha = 6 × summed channel difference − 0.06: ignores anti-aliasing noise, saturates by ~6% change.
  // A pair at two pixel densities differs along every glyph stem and edge once both are scaled (one dark
  // pixel at 1x, two half-dark ones from 2x), so its filter first erodes away marks under ~2px wide.
  // That loses hairline changes too; a wider erosion would also erase reworded text.
  const morphs = { "": `<feMorphology operator="dilate" radius="1" />`, "-resampled": `<feMorphology operator="erode" radius="1" /><feMorphology operator="dilate" radius="2" />` };
  svg.innerHTML = Object.entries(DIFF_COLORS)
    .flatMap(([kind, [r, g, b]]) => Object.entries(morphs).map(([suffix, steps]) => `
    <filter id="${PREFIX}-${kind}${suffix}" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  6 6 6 0 -0.06" />
      ${steps}
    </filter>`))
    .join("");
  document.body.append(svg);
}

// Both sides scale to the same width so screenshots taken at the same viewport line up pixel for pixel.
function cloneMedia(source: HTMLImageElement | HTMLVideoElement, side: Side | "diff-part", from: Side = side as Side) {
  const media = source.cloneNode(true) as HTMLImageElement | HTMLVideoElement;
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

// Two screenshots of different widths are either the same view at another pixel density (a 2560px retina
// capture of a 1280px window), which should be scaled to match, or two different crops or window sizes,
// which must keep one pixel scale so the content lines up, with the narrower one placed inside the wider.
// Auto finds that place from the pixels; GitHub serves uploads without CORS, so only the extension's
// background worker can read them, after the reviewer grants the optional image-host permission once.
const DENSITIES = [1.25, 1.5, 2, 3];
const ALIGN_KEY = "peekaboo-align";
type Align = "auto" | "left" | "center" | "right";
const CAN_AUTO = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
const ALIGNS: { align: Align; label: string }[] = [
  ...(CAN_AUTO ? [{ align: "auto" as Align, label: "Auto" }] : []),
  { align: "left", label: "Left" },
  { align: "center", label: "Center" },
  { align: "right", label: "Right" },
];
type AlignBar = { sync: () => void; retryAuto: () => void };
// Every align bar, keyed by its frame, so an alignment picked on one applies to all. GitHub changes pages
// without reloading, so a bar whose frame has left the page is dropped instead of run.
const alignBars = new Map<HTMLElement, AlignBar>();

function eachAlignBar(action: (bar: AlignBar) => void) {
  for (const [frame, bar] of alignBars) {
    if (frame.isConnected) action(bar);
    else alignBars.delete(frame);
  }
}

type Placement = { beforeX: number; beforeY: number; afterX: number; afterY: number };
// Diff shows the same blank for "nothing changed" and "the same file uploaded twice", so the background
// says when no pixel differs and the stage says it outright. Null: not known, say nothing.
type ShowSame = (same: boolean | null) => void;

function fitPair(root: HTMLElement, pair: Pair, showSame: ShowSame) {
  const frame = frameOf(root);
  let done = false;
  const apply = () => {
    const [bw, bh] = naturalSize(pair.before), [aw, ah] = naturalSize(pair.after);
    if (done || !bw || !aw) return;
    done = true;
    const ratio = aw / bw;
    const near = (a: number, b: number) => Math.abs(a / b - 1) < 0.02;
    const sameSize = bw === aw && bh === ah;
    const density = DENSITIES.some((d) => near(ratio, d) || near(1 / ratio, d));
    if (sameSize || density) {
      root.style.setProperty("--natural-width", `${aw}px`);
      root.style.setProperty("--aspect", String(aw / ah));
      if (!sameSize) frame.dataset.resampled = "";
      // At two densities the compositor Diff marks every resampled edge, so the worker's diff replaces it.
      // The worker compares only where both reach, so a capture that also holds more of the page keeps
      // the compositor Diff rather than be called unchanged. 1px allows for rounding an odd height.
      const width = Math.min(bw, aw);
      const sameShape = Math.abs((bh * width) / bw - (ah * width) / aw) <= 1;
      if (canAutoAlign(pair) && sameShape) askBackground("compare", pair, (response) => {
        if (response?.diff) frame.dispatchEvent(new CustomEvent("peekaboo:diff", { detail: response.diff }));
        showSame(response?.same ?? null);
      });
      return;
    }
    // Same width, different heights: usually a page that got longer or shorter, so top-aligned is right
    // and edge buttons would do nothing. Only a crop of the other (found by Auto) earns the bar.
    if (bw === aw) {
      root.dataset.partial = "1";
      root.style.setProperty("--natural-width", `${aw}px`);
      root.style.setProperty("--aspect", String(aw / Math.max(bh, ah)));
      if (!canAutoAlign(pair) || loadAlign() !== "auto") return;
      askBackground("align", pair, (response) => {
        const p = response?.placement as Placement | undefined;
        if (!p || (!p.beforeY && !p.afterY)) return;
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

const canAutoAlign = (pair: Pair) => CAN_AUTO && pair.before instanceof HTMLImageElement && pair.after instanceof HTMLImageElement;

// Reading lastError keeps Chrome from logging every failure (e.g. after the extension was reloaded) as unchecked.
function askBackground(type: "align" | "compare", pair: Pair, done: (response: any) => void) {
  const message = { type, before: (pair.before as HTMLImageElement).currentSrc, after: (pair.after as HTMLImageElement).currentSrc };
  try {
    chrome.runtime.sendMessage(message, (response) => done(chrome.runtime.lastError ? null : response));
  } catch {
    done(null);
  }
}

function naturalSize(media: HTMLImageElement | HTMLVideoElement) {
  return media instanceof HTMLImageElement ? [media.naturalWidth, media.naturalHeight] : [media.videoWidth, media.videoHeight];
}

// Lays both screenshots out on a shared canvas at one pixel scale. Positions and sizes are percentages
// of the canvas width (margin-top percentages are of the width too), so the frame can scale freely.
const frameOf = (stage: HTMLElement) => stage.querySelector<HTMLElement>(`.${PREFIX}-frame`)!;

function placeOnCanvas(stage: HTMLElement, [bw, bh]: number[], [aw, ah]: number[], p: Placement) {
  const width = Math.max(p.beforeX + bw, p.afterX + aw), height = Math.max(p.beforeY + bh, p.afterY + ah);
  const pct = (v: number) => `${(v / width) * 100}%`;
  stage.style.setProperty("--natural-width", `${width}px`);
  stage.style.setProperty("--aspect", String(width / height));
  stage.style.setProperty("--before-w", pct(bw)); stage.style.setProperty("--after-w", pct(aw));
  stage.style.setProperty("--before-x", pct(p.beforeX)); stage.style.setProperty("--after-x", pct(p.afterX));
  stage.style.setProperty("--before-y", pct(p.beforeY)); stage.style.setProperty("--after-y", pct(p.afterY));
  stage.dataset.partial = "1";
  stage.style.setProperty("--after-clip", comparedPart([p.afterX, p.afterY, aw, ah], [p.beforeX, p.beforeY, bw, bh]));
}

// Diff shows the After ghost only where Before is too, so the hatch behind it marks everything not compared.
function comparedPart([x, y, w, h]: number[], [ox, oy, ow, oh]: number[]) {
  const pct = (v: number, of: number) => `${(Math.max(0, v) / of) * 100}%`;
  return `inset(${pct(oy - y, h)} ${pct(x + w - (ox + ow), w)} ${pct(y + h - (oy + oh), h)} ${pct(ox - x, w)})`;
}

// `found` is a crop placement Auto already made for a same-width pair: that bar offers only Auto and Top.
// "Same" belongs to Auto's placement, so it shows only while Auto is the chosen alignment.
function buildAlignBar(stage: HTMLElement, pair: Pair, beforeSize: number[], afterSize: number[], showSame: ShowSame, found?: { placement: Placement; diff: string; same: boolean | null }) {
  const [bw, bh] = beforeSize, [aw, ah] = afterSize;
  const slack = Math.abs(bw - aw), beforeNarrow = bw < aw;
  const images = canAutoAlign(pair);
  const bar = el("div", `${PREFIX}-align`);
  const note = el("span", `${PREFIX}-align-note`);
  note.textContent = found
    ? `One screenshot is a crop of the other (before ${bw} × ${bh}, after ${aw} × ${ah}). Line them up by`
    : `Different sizes (before ${bw} × ${bh}, after ${aw} × ${ah}). Line them up by`;
  const segmented = el("div", `${PREFIX}-segmented`);
  const choices = found ? [{ align: "auto" as Align, label: "Auto" }, { align: "left" as Align, label: "Top" }] : ALIGNS.filter(({ align }) => align !== "auto" || images);
  const buttons = choices.map(({ align, label }) => {
    const button = el("button", `${PREFIX}-mode`);
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      try { localStorage.setItem(ALIGN_KEY, align); } catch {}
      eachAlignBar((bar) => bar.sync());
    });
    return { align, button };
  });
  segmented.append(...buttons.map(({ button }) => button));
  const status = el("span", `${PREFIX}-align-note`);
  bar.append(note, segmented, status);

  const frame = frameOf(stage);
  const placeSideways = (offset: number) => placeOnCanvas(stage, beforeSize, afterSize,
    beforeNarrow ? { beforeX: offset, beforeY: 0, afterX: 0, afterY: 0 } : { beforeX: 0, beforeY: 0, afterX: offset, afterY: 0 });
  let autoPlacement: Placement | null = found?.placement ?? null;
  let autoDiff: string | null = found?.diff ?? null;
  let autoSame: boolean | null = found?.same ?? null;
  let shownDiff: string | null = null;
  const showDiff = (url: string | null) => {
    if (url === shownDiff) return;
    shownDiff = url;
    frame.dispatchEvent(new CustomEvent("peekaboo:diff", { detail: url }));
  };
  let waitingForPermission = false;
  // Auto is still the saved choice (it retries once allowed), but the pressed button says what's on screen.
  let fellBack = false;
  const press = (align: Align) => {
    for (const { align: buttonAlign, button } of buttons) button.setAttribute("aria-pressed", String(buttonAlign === align));
  };
  const runAuto = () => {
    status.textContent = "Lining up…";
    askBackground("align", pair, (response) => {
      status.replaceChildren();
      if (response?.placement) {
        autoPlacement = response.placement; autoDiff = response.diff; autoSame = response.same; waitingForPermission = false; fellBack = false;
        sync();
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
  const sync = () => {
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
  alignBars.set(frame, { sync, retryAuto });
  sync();
  return bar;
}

function loadAlign(): Align {
  try {
    const saved = localStorage.getItem(ALIGN_KEY);
    if (ALIGNS.some(({ align }) => align === saved)) return saved as Align;
  } catch {}
  return CAN_AUTO ? "auto" : "left";
}

function buildPlayButton(stages: ReturnType<typeof buildStage>[]) {
  const button = el("button", `${PREFIX}-expand`);
  button.type = "button";
  button.textContent = "▶ Play";
  button.title = "Play both recordings from the start, in step";
  let playing = false;
  button.addEventListener("click", () => {
    playing = !playing;
    button.textContent = playing ? "❚❚ Pause" : "▶ Play";
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

// ---------- Full screen ----------

// One pair at a time, across every table on the page, so reviewing a PR with many pairs is ← → instead of
// scrolling. The stage element itself moves into the overlay (keeping its Flip side) and goes back to
// a placeholder when you step away, so there's only ever one copy of each pair.
const VIEWER_MODES = MODES.filter(({ mode }) => mode !== "table");

let viewer: {
  overlay: HTMLElement;
  body: HTMLElement;
  counter: HTMLElement;
  title: HTMLElement;
  caption: HTMLElement;
  modeButtons: { mode: Mode; button: HTMLButtonElement }[];
  keys: KeyHints;
  slides: Slide[];
  index: number;
  placeholder: Comment;
} | null = null;

function openViewer(start: Slide) {
  closeViewer();
  const slides = allSlides();
  const overlay = el("div", `${PREFIX}-viewer`);
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const bar = el("div", `${PREFIX}-viewer-bar`);
  const previous = navButton("chevron-left", "Previous pair (←)", () => stepViewer(-1));
  const counter = el("span", `${PREFIX}-viewer-counter`);
  const next = navButton("chevron-right", "Next pair (→)", () => stepViewer(1));
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
  // The caption sits right under the image, not at the screen's bottom edge, so it reads as the pair's caption.
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
  // A clicked button would keep focus and swallow Space, which flips; buttons reached with Tab still take it.
  overlay.addEventListener("mousedown", (event) => {
    if ((event.target as Element).closest("button")) event.preventDefault();
  });
  overlay.addEventListener("keydown", keepFocusInside);
  if (loadMode() === "table") setModeEverywhere(DEFAULT_MODE);
  syncViewerModes();
  showSlide(Math.max(0, slides.indexOf(start)));
}

function showSlide(index: number) {
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

function stepViewer(delta: number) {
  if (!viewer) return;
  const count = viewer.slides.length;
  showSlide((viewer.index + delta + count) % count);
}

function returnStage() {
  if (!viewer || viewer.index < 0) return;
  viewer.placeholder.replaceWith(viewer.slides[viewer.index].stage);
}

// Modes changed in full screen resized the tables behind it, so land on the pair you were looking at.
function closeViewer() {
  if (!viewer) return;
  returnStage();
  const lastStage = viewer.index >= 0 ? viewer.slides[viewer.index].stage : null;
  viewer.overlay.remove();
  document.documentElement.classList.remove(`${PREFIX}-locked`);
  viewer = null;
  lastStage?.scrollIntoView({ block: "center" });
  // Back where keyboard users left off: the Full screen button of the table that pair belongs to.
  lastStage?.closest(`.${PREFIX}`)?.querySelector<HTMLElement>(`.${PREFIX}-toolbar > .${PREFIX}-expand:not([hidden])`)?.focus({ preventScroll: true });
}

// A modal dialog: Tab and Shift+Tab cycle through its own controls instead of walking into the page behind it.
function keepFocusInside(event: KeyboardEvent) {
  if (event.key !== "Tab" || !viewer) return;
  const stops = Array.from(viewer.overlay.querySelectorAll<HTMLElement>(`button, .${PREFIX}-frame`)).filter((node) => node.getClientRects().length > 0);
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

// Reads the frame, not the saved mode: a video pair in Diff still flips.
function syncKeyHints() {
  if (!viewer || viewer.index < 0) return;
  const diff = frameOf(viewer.slides[viewer.index].stage).dataset.mode === "diff";
  viewer.keys.flip.hidden = diff;
  viewer.keys.peekAction.textContent = diff ? " hold for After" : " hold to peek";
}

function handleViewerKeys(event: KeyboardEvent) {
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
  return Array.from(widgets)
    .filter((widget) => widget.root.isConnected)
    .sort((a, b) => (a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .flatMap((widget) => widget.slides);
}

// PR authors put one italic line under each table saying what the pair fixes.
function captionBelow(table: HTMLTableElement) {
  const next = outermostWrapper(table).nextElementSibling;
  const onlyChild = next?.children.length === 1 ? next.firstElementChild : null;
  const isCaption = next?.tagName === "P" && onlyChild?.tagName === "EM" && next.textContent?.trim() === onlyChild.textContent?.trim();
  return isCaption ? next.textContent!.trim() : "";
}

// GitHub wraps rendered tables in a custom element (<markdown-accessiblity-table>), so the caption is the
// wrapper's sibling, not the table's.
function outermostWrapper(table: HTMLTableElement) {
  let node: Element = table;
  while (!node.nextElementSibling && node.parentElement?.tagName.includes("-")) node = node.parentElement;
  return node;
}

// The keys are the fast way through a PR's pairs, and button tooltips only tell people who hover.
type KeyHints = ReturnType<typeof buildKeyHints>;

function buildKeyHints() {
  const row = el("div", `${PREFIX}-viewer-keys`);
  const hint = (keys: string[], action: string) => {
    const item = el("span", `${PREFIX}-viewer-key`);
    // Arrows in 11px monospace render about 6px tall; the UI font draws them at letter size.
    for (const key of keys) item.append(Object.assign(el("kbd", /^[←→↑↓]$/.test(key) ? `${PREFIX}-arrow` : ""), { textContent: key }));
    const text = document.createTextNode(` ${action}`);
    item.append(text);
    row.append(item);
    return { item, text };
  };
  hint(["←", "→"], "pair");
  const flip = hint(["Space"], "flip").item;
  const peekAction = hint(["Shift"], "hold to peek").text;
  hint(VIEWER_MODES.map((_, index) => String(index + 1)), VIEWER_MODES.map(({ label }) => label).join(" / "));
  hint(["Esc"], "close");
  return { row, flip, peekAction };
}

function navButton(name: IconName, title: string, onClick: () => void) {
  const button = el("button", `${PREFIX}-nav`);
  button.type = "button";
  button.append(icon(name));
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  return button;
}

// ---------- Helpers ----------

function loadMode(): Mode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (MODES.some(({ mode }) => mode === saved)) return saved as Mode;
  } catch {}
  return DEFAULT_MODE;
}

// One preference for every table on every page, so switching to Flip once sticks while reviewing.
// Tables above the one you clicked resize too, so `anchor` (the clicked toolbar) is held at the same
// spot on screen; otherwise the pair you were reviewing jumps away.
function setModeEverywhere(mode: Mode, anchor?: HTMLElement) {
  const topBefore = anchor?.getBoundingClientRect().top;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
  for (const widget of widgets) {
    if (widget.root.isConnected) widget.applyMode(mode);
    else widgets.delete(widget);
  }
  syncViewerModes();
  if (anchor && topBefore !== undefined) window.scrollBy(0, anchor.getBoundingClientRect().top - topBefore);
}

// Primer octicons (16px), drawn in currentColor so they follow the theme.
const ICONS = {
  "chevron-left": "M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z",
  "chevron-right": "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
  "arrow-up": "M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018L9 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z",
  "arrow-down": "M13.03 8.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.47 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l2.97 2.97V3.75a.75.75 0 0 1 1.5 0v7.44l2.97-2.97a.75.75 0 0 1 1.06 0Z",
  x: "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z",
  "screen-full": "M1.75 10a.75.75 0 0 1 .75.75v2.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 1 13.25v-2.5a.75.75 0 0 1 .75-.75Zm12.5 0a.75.75 0 0 1 .75.75v2.5A1.75 1.75 0 0 1 13.25 15h-2.5a.75.75 0 0 1 0-1.5h2.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 .75-.75ZM2.75 2.5a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0v-2.5C1 1.784 1.784 1 2.75 1h2.5a.75.75 0 0 1 0 1.5ZM10.75 1h2.5c.966 0 1.75.784 1.75 1.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.25.25 0 0 0-.25-.25h-2.5a.75.75 0 0 1 0-1.5Z",
};
type IconName = keyof typeof ICONS;

function icon(name: IconName) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(`${PREFIX}-icon`);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function tag(text: string, side: "before" | "after") {
  const node = el("span", `${PREFIX}-tag ${PREFIX}-tag-${side}`);
  node.textContent = text;
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(name: K, className: string) {
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
