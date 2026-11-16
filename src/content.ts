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
type Slide = { stage: HTMLElement; label: string; caption: string };

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
  expand.textContent = "⤢ Full screen";
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
    slides: stages.map((stage, index) => ({ stage: stage.root, label: pairs[index].label, caption })),
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
  frame.append(after, before, diff, beforeTag, afterTag);
  const canDiff = pair.before instanceof HTMLImageElement && pair.after instanceof HTMLImageElement;

  root.append(frame);
  if (pair.label) {
    const caption = el("figcaption", `${PREFIX}-label`);
    caption.textContent = pair.label;
    root.append(caption);
  }
  setNaturalSize(frame, pair.after);

  let mode: Mode = DEFAULT_MODE;
  let showingBefore = true;

  function render() {
    // Blend modes over video need every copy in step; a still-frame diff would mislead, so videos flip instead.
    const shown = mode === "diff" && !canDiff ? "flip" : mode;
    frame.dataset.mode = shown;
    beforeTag.textContent = shown === "diff" ? "Before only" : "Before";
    afterTag.textContent = shown === "diff" ? "After only" : "After";
    // Both share one grid cell sized to the taller image, so a taller After would peek out below a flipped-in Before.
    after.style.visibility = shown === "flip" && showingBefore ? "hidden" : "visible";
    if (shown === "diff") {
      if (!diff.hasChildNodes()) diff.append(...buildDiffLayers(pair.before, pair.after));
      before.style.opacity = "0";
    } else if (shown === "flip") {
      before.style.opacity = showingBefore ? "1" : "0";
      frame.dataset.showing = showingBefore ? "before" : "after";
    }
  }

  frame.addEventListener("pointerdown", () => {
    if (frame.dataset.mode !== "flip") return;
    showingBefore = !showingBefore;
    render();
  });
  frame.addEventListener("keydown", (event) => {
    if (frame.dataset.mode !== "flip" || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    showingBefore = !showingBefore;
    render();
  });

  return {
    root,
    videos: [before, after].filter((media): media is HTMLVideoElement => media instanceof HTMLVideoElement),
    setMode(next: Mode) {
      mode = next;
      render();
    },
  };
}

// ---------- Diff ----------

// GitHub serves uploads without CORS headers, so a canvas can't read their pixels. The browser's compositor
// can still blend them: inside an isolated group, `lighten` then `difference` leaves max(0, top − base) per
// channel, i.e. only the pixels where one side is darker. An SVG filter turns that into a solid colour whose
// opacity grows with the difference, dilated 1px so hairline changes (a border, a 1px shift) stay visible.
// "Darker" means ink on light screenshots; on dark screenshots the colours swap.
function buildDiffLayers(beforeSource: HTMLImageElement | HTMLVideoElement, afterSource: HTMLImageElement | HTMLVideoElement) {
  const onlyBefore = diffLayer(beforeSource, afterSource, "removed");
  const onlyAfter = diffLayer(afterSource, beforeSource, "added");
  return [onlyBefore, onlyAfter];
}

// Pixels where `darker` is darker than `other`: max(other, darker) − darker = max(0, other − darker).
function diffLayer(darker: HTMLImageElement | HTMLVideoElement, other: HTMLImageElement | HTMLVideoElement, kind: "removed" | "added") {
  const group = el("div", `${PREFIX}-diff-layer ${PREFIX}-diff-${kind}`);
  const base = cloneMedia(darker, "diff-part");
  const lighten = cloneMedia(other, "diff-part");
  lighten.style.mixBlendMode = "lighten";
  const subtract = cloneMedia(darker, "diff-part");
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
  svg.innerHTML = Object.entries(DIFF_COLORS)
    .map(
      ([kind, [r, g, b]]) => `
    <filter id="${PREFIX}-${kind}" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  6 6 6 0 -0.06" />
      <feMorphology operator="dilate" radius="1" />
    </filter>`,
    )
    .join("");
  document.body.append(svg);
}

// Both sides scale to the same width so screenshots taken at the same viewport line up pixel for pixel.
function cloneMedia(source: HTMLImageElement | HTMLVideoElement, side: "before" | "after" | "diff-part") {
  const media = source.cloneNode(true) as HTMLImageElement | HTMLVideoElement;
  media.removeAttribute("style");
  media.removeAttribute("width");
  media.removeAttribute("height");
  media.className = `${PREFIX}-media ${PREFIX}-${side}`;
  media.draggable = false;
  if (media instanceof HTMLVideoElement) {
    media.controls = false;
    media.muted = true;
    media.loop = true;
    media.playsInline = true;
  }
  return media;
}

// Caps the comparison at the screenshot's real width, so a 400px crop isn't blown up to the column width.
function setNaturalSize(frame: HTMLElement, source: HTMLImageElement | HTMLVideoElement) {
  const apply = () => {
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.videoWidth;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.videoHeight;
    if (!width || !height) return;
    frame.style.setProperty("--natural-width", `${width}px`);
    frame.style.setProperty("--aspect", String(width / height));
  };
  apply();
  source.addEventListener(source instanceof HTMLImageElement ? "load" : "loadedmetadata", apply, { once: true });
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
  const previous = navButton("‹", "Previous pair (←)", () => stepViewer(-1));
  const counter = el("span", `${PREFIX}-viewer-counter`);
  const next = navButton("›", "Next pair (→)", () => stepViewer(1));
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
  const close = navButton("✕", "Close (Esc)", closeViewer);
  close.classList.add(`${PREFIX}-viewer-close`);
  bar.append(previous, counter, next, segmented, close);

  const title = el("div", `${PREFIX}-viewer-title`);
  // The caption sits right under the image, not at the screen's bottom edge, so it reads as the pair's caption.
  const body = el("div", `${PREFIX}-viewer-body`);
  const column = el("div", `${PREFIX}-viewer-column`);
  const caption = el("p", `${PREFIX}-viewer-caption`);
  column.append(caption);
  body.append(column);
  overlay.append(bar, title, body);
  document.body.append(overlay);
  document.documentElement.classList.add(`${PREFIX}-locked`);

  viewer = { overlay, body, counter, title, caption, modeButtons, slides, index: -1, placeholder: document.createComment("peekaboo") };
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
  slide.stage.querySelector<HTMLElement>(`.${PREFIX}-frame`)?.focus({ preventScroll: true });
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
}

function syncViewerModes() {
  if (!viewer) return;
  const current = loadMode();
  for (const { mode, button } of viewer.modeButtons) button.setAttribute("aria-pressed", String(mode === current));
}

function handleViewerKeys(event: KeyboardEvent) {
  if (!viewer) return;
  const modeIndex = Number(event.key) - 1;
  if (event.key === "Escape") closeViewer();
  else if (event.key === "ArrowLeft") stepViewer(-1);
  else if (event.key === "ArrowRight") stepViewer(1);
  else if (VIEWER_MODES[modeIndex]) setModeEverywhere(VIEWER_MODES[modeIndex].mode);
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

function navButton(text: string, title: string, onClick: () => void) {
  const button = el("button", `${PREFIX}-nav`);
  button.type = "button";
  button.textContent = text;
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
.${PREFIX} { margin-bottom: 8px; }
/* Our display rules would otherwise beat the hidden attribute on pages without a global [hidden] reset. */
.${PREFIX} [hidden] { display: none !important; }
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
.${PREFIX}-frame .${PREFIX}-media { grid-area: 1 / 1; display: block; width: 100%; max-width: none; height: auto; }
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
.${PREFIX}-frame[data-mode="diff"] .${PREFIX}-after { filter: grayscale(1); opacity: 0.25; }
.${PREFIX}-frame[data-mode="diff"] .${PREFIX}-tag-before { background: rgb(219 36 46); }
.${PREFIX}-frame[data-mode="diff"] .${PREFIX}-tag-after { background: rgb(26 160 77); }
.${PREFIX}-label { font-size: 12px; color: var(--fgColor-muted, #59636e); }

.${PREFIX}-locked { overflow: hidden; }
.${PREFIX}-viewer {
  position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column; gap: 10px;
  padding: 12px 24px 16px; background: var(--bgColor-default, #fff); color: var(--fgColor-default, #1f2328);
  font-size: 14px;
}
.${PREFIX}-viewer-bar { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-viewer-counter { min-width: 56px; text-align: center; font-variant-numeric: tabular-nums; color: var(--fgColor-muted, #59636e); }
.${PREFIX}-nav {
  font: inherit; font-size: 18px; line-height: 1; width: 32px; height: 28px; cursor: pointer; border-radius: 6px;
  color: var(--fgColor-default, #1f2328); background: var(--bgColor-default, #fff); border: 1px solid var(--borderColor-default, #d1d9e0);
}
.${PREFIX}-nav:hover { background: var(--bgColor-muted, #f6f8fa); }
.${PREFIX}-viewer-bar .${PREFIX}-segmented { margin-left: 8px; }
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
.${PREFIX}-viewer-body .${PREFIX}-frame { max-width: none; width: min(100cqw, calc((100cqh - var(--caption-room, 0px)) * var(--aspect, 1.6))); }
/* Room for up to three caption lines, so the image shrinks instead of pushing the caption off screen. */
.${PREFIX}-has-caption { --caption-room: 92px; }
`;
  document.head.append(style);
}
