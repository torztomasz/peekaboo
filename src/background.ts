// Auto-align runs here because only the extension's own worker may read GitHub's uploaded images: they are
// served without CORS headers, so page code (and the userscript) can't get at their pixels. The permission
// for the image host is optional, asked for on the options page the first time someone picks Auto.

import { IMAGE_ORIGINS } from "./origins";
import { FULL_SIZE_ROWS, type Gray, locate } from "./match";

type PairRequest = { type: "align" | "compare"; before: string; after: string };
type Placement = { beforeX: number; beforeY: number; afterX: number; afterY: number };
// `same`: no pixel differs visibly (by the rule that colours the diff), so the same screenshot was likely
// uploaded twice. Null where the two don't line up pixel for pixel, so it can't be told.
// `dark`: the screenshots are mostly dark (a dark theme), where content is the light part. The diff's colours
// are swapped for them, so red always marks what was removed and green what was added.
type AlignResponse = { placement: Placement; diff: string; same: boolean | null; dark: boolean } | { needsPermission: true } | { error: string };
type CompareResponse = { same: boolean; dark: boolean; diff?: string } | { needsPermission: true } | { error: string };

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "align" || message?.type === "compare") {
    const work = message.type === "align" ? findOffset(message as PairRequest) : compare(message as PairRequest);
    work.then(reply, (error) => reply({ error: String(error) }));
    return true;
  }
  if (message?.type === "open-options") openSettings(_sender.tab);
  return false;
});

// Onboarding: a welcome tab on first install, and the toolbar icon opens the same page, since that is
// where people look for an extension's settings.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("options.html?welcome") });
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// From a pull request: next to it, about that one step, so the page can send the reviewer back.
function openSettings(tab?: chrome.tabs.Tab) {
  if (tab?.id == null) { chrome.runtime.openOptionsPage(); return; }
  chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?from=${tab.id}`), index: tab.index + 1, openerTabId: tab.id });
}

// Where each screenshot sits on a shared canvas, in their own (equal) pixel scale.
// First: is one a crop of the other (a viewport inside a full page, a detail inside a screen)? Then it is
// placed where it matches, in both directions, but only on a near-perfect match: a loose fit would line up
// the wrong part of a page whose layout really shifted, and hide that shift. Otherwise the screenshots are
// two window widths of one page: top-aligned, the narrower slid sideways to where the two match best.
const CONTAINED_MAX_ERROR = 6;

async function findOffset({ before, after }: PairRequest): Promise<AlignResponse> {
  if (!(await chrome.permissions.contains({ origins: IMAGE_ORIGINS }))) return { needsPermission: true };
  const [b, a] = await Promise.all([load(before), load(after)]);
  const fits = (outer: ImageBitmap, inner: ImageBitmap) => outer.width >= inner.width && outer.height >= inner.height;
  let placement: Placement | null = null;
  // Only a crop lines up pixel for pixel. Two window widths of a page reflow (columns move, rows end at
  // another edge), so sliding one sideways leaves layout differences that would read as changes.
  let exact = false;
  if (fits(b, a) || fits(a, b)) {
    const beforeOutside = fits(b, a);
    const found = locate(beforeOutside ? b : a, beforeOutside ? a : b, gray);
    if (found.error <= CONTAINED_MAX_ERROR) {
      placement = beforeOutside ? { beforeX: 0, beforeY: 0, afterX: found.x, afterY: found.y } : { beforeX: found.x, beforeY: found.y, afterX: 0, afterY: 0 };
      exact = true;
    }
  }
  if (!placement) {
    const beforeIsWide = b.width >= a.width;
    const dx = slideSideways(beforeIsWide ? b : a, beforeIsWide ? a : b);
    placement = beforeIsWide ? { beforeX: 0, beforeY: 0, afterX: dx, afterY: 0 } : { beforeX: dx, beforeY: 0, afterX: 0, afterY: 0 };
  }
  const changes = changeMaps(b, a, placement);
  const dark = isDark(b, a);
  return { placement, diff: await diffImage(changes, dark), same: exact ? changes.changed === 0 : null, dark };
}

// Same-size pairs line up as they are, so the page only needs to know whether anything changed. It's the
// cheap way to catch the same screenshot uploaded twice, which Diff would show as a reassuring blank.
// Pairs at two pixel densities also get the diff itself: the page's compositor Diff can't tell resampling
// from change (see compareDensities).
const AS_IS: Placement = { beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 };

async function compare({ before, after }: PairRequest): Promise<CompareResponse> {
  if (!(await chrome.permissions.contains({ origins: IMAGE_ORIGINS }))) return { needsPermission: true };
  const [b, a] = await Promise.all([load(before), load(after)]);
  if (b.width !== a.width || b.height !== a.height) return compareDensities(b, a);
  return { same: changeMaps(b, a, AS_IS).changed === 0, dark: isDark(b, a) };
}

// The removed/added maps say which side is darker, which is "which side has the content" only on light
// screenshots. Averaged over both, so a pair that switches theme falls on the side most of it is on.
function isDark(before: ImageBitmap, after: ImageBitmap) {
  const mean = ({ data }: Gray) => data.reduce((sum, value) => sum + value, 0) / data.length;
  const small = (bitmap: ImageBitmap) => gray(bitmap, Math.min(1, 200 / bitmap.width), 0, bitmap.height);
  return (mean(small(before)) + mean(small(after))) / 2 < 128;
}

function slideSideways(wide: ImageBitmap, narrow: ImageBitmap) {
  const slack = wide.width - narrow.width;
  // Pass 1: both shrunk so the wide one is about 400px across, every offset compared.
  const scale = Math.min(1, 400 / wide.width);
  const coarse = bestOffset(gray(wide, scale), gray(narrow, scale), Math.round(slack * scale), Math.ceil(16 * scale));
  // Pass 2: full size, within the coarse step either side.
  const step = Math.ceil(1 / scale) + 1;
  return bestOffset(gray(wide, 1), gray(narrow, 1), slack, 0, Math.round(coarse / scale) - step, Math.round(coarse / scale) + step);
}

async function load(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  return createImageBitmap(await response.blob());
}

function gray(bitmap: ImageBitmap, scale: number, top = 0, bottom = Math.min(bitmap.height, FULL_SIZE_ROWS)): Gray {
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round((bottom - top) * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, top, bitmap.width, bottom - top, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
  return { data, width, height };
}

// Mean absolute difference of the overlap at each horizontal offset; rows are top-aligned.
function bestOffset(wide: Gray, narrow: Gray, slack: number, overhang: number, from = -overhang, to = slack + overhang) {
  const rows = Math.min(wide.height, narrow.height);
  const rowStep = Math.max(1, Math.floor(rows / 300));
  let best = 0, bestError = Infinity;
  for (let dx = from; dx <= to; dx++) {
    let sum = 0, count = 0;
    const x0 = Math.max(0, -dx), x1 = Math.min(narrow.width, wide.width - dx);
    if (x1 - x0 < narrow.width * 0.6) continue;
    for (let y = 0; y < rows; y += rowStep) {
      const wRow = y * wide.width + dx, nRow = y * narrow.width;
      for (let x = x0; x < x1; x++) { sum += Math.abs(wide.data[wRow + x] - narrow.data[nRow + x]); count++; }
    }
    const error = sum / count;
    if (error < bestError) { bestError = error; best = dx; }
  }
  return best;
}

// The diff at full resolution, from real pixels: the compositor version shows edges wherever the two
// images are resampled at different sub-pixel offsets, which is always the case once they are shifted.
// Same rule and colours as the compositor filter (alpha = 6 x summed channel difference - 0.06, dilated
// 1px); pixels only one screenshot covers stay clear, since there is nothing to compare them with.
const REMOVED = [219, 36, 46], ADDED = [26, 184, 77];

// `changed` counts the pixels that differ visibly.
type ChangeMaps = { removed: Float32Array; added: Float32Array; width: number; height: number; changed: number };

function changeMaps(before: ImageBitmap, after: ImageBitmap, { beforeX, beforeY, afterX, afterY }: Placement): ChangeMaps {
  const width = Math.max(before.width + beforeX, after.width + afterX), height = Math.max(before.height + beforeY, after.height + afterY);
  const pixels = (bitmap: ImageBitmap) => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  };
  const b = pixels(before), a = pixels(after);
  const removed = new Float32Array(width * height), added = new Float32Array(width * height);
  let changed = 0;
  for (let y = Math.max(beforeY, afterY); y < Math.min(before.height + beforeY, after.height + afterY); y++) {
    for (let x = Math.max(beforeX, afterX); x < Math.min(before.width + beforeX, after.width + afterX); x++) {
      const bi = ((y - beforeY) * before.width + x - beforeX) * 4, ai = ((y - afterY) * after.width + x - afterX) * 4;
      let lighterAfter = 0, lighterBefore = 0;
      for (let c = 0; c < 3; c++) {
        const d = (a[ai + c] - b[bi + c]) / 255;
        if (d > 0) lighterAfter += d; else lighterBefore -= d;
      }
      const r = Math.min(1, Math.max(0, 6 * lighterAfter - 0.06)), g = Math.min(1, Math.max(0, 6 * lighterBefore - 0.06));
      removed[y * width + x] = r;
      added[y * width + x] = g;
      if (r > 0 || g > 0) changed++;
    }
  }
  return { removed, added, width, height, changed };
}

// ---------- Two pixel densities ----------

// A 2x and a 1x capture of one screen draw every edge differently: anti-aliasing, and stems that are one
// dark pixel at 1x but two half-dark ones once 2x is scaled down. The strict rule, tuned to catch a 1px
// shift, marks them all. So a pixel counts only if the other side has nothing as dark within 1px, and a
// place counts as changed only where that gap also beats half the other side's local contrast plus a
// floor: resampling errs by up to half an edge's contrast, and by a few levels in flat areas where its
// filter rings (measured on 2x and 1.5x captures). Inside such a place the diff shows everything the 1px
// tolerance leaves, so a reworded label shows whole glyphs, not just the pixels that cleared the edge test.
const EDGE_TOLERANCE = 0.5, SEED_STRENGTH = 0.25;
// "Such a place": up to 2 cells of 8px from a pixel that cleared the edge test.
const CELL = 8, REACH = 2;

async function compareDensities(before: ImageBitmap, after: ImageBitmap): Promise<CompareResponse> {
  // The page shows both at one width, heights following, so compare them the same way.
  const width = Math.min(before.width, after.width);
  const changes = tolerantChangeMaps(resample(before, width), resample(after, width));
  const dark = isDark(before, after);
  return { same: changes.changed === 0, dark, diff: await diffImage(changes, dark) };
}

type Rgba = { data: Uint8ClampedArray; width: number; height: number };

function resample(bitmap: ImageBitmap, width: number): Rgba {
  const height = Math.round((bitmap.height * width) / bitmap.width);
  const context = new OffscreenCanvas(width, height).getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  return { data: context.getImageData(0, 0, width, height).data, width, height };
}

function tolerantChangeMaps(before: Rgba, after: Rgba): ChangeMaps {
  const width = before.width, height = Math.max(before.height, after.height), overlap = Math.min(before.height, after.height);
  // Both measures below look at the 3x3 around (x, y) and are in summed channels / 255.
  const around = (x: number, y: number, visit: (j: number) => void) => {
    for (let yy = Math.max(0, y - 1); yy <= Math.min(overlap - 1, y + 1); yy++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) visit((yy * width + xx) * 4);
    }
  };
  // How much darker `own` is than the closest match in `other`: 0 if `other` has it nearby.
  const missing = (own: Uint8ClampedArray, other: Uint8ClampedArray, i: number, x: number, y: number) => {
    let least = Infinity;
    around(x, y, (j) => { least = Math.min(least, Math.max(0, other[j] - own[i]) + Math.max(0, other[j + 1] - own[i + 1]) + Math.max(0, other[j + 2] - own[i + 2])); });
    return least / 255;
  };
  // How far the darkest and lightest pixels around are apart: where resampling errs most.
  const contrast = (image: Uint8ClampedArray, x: number, y: number) => {
    let lo = Infinity, hi = 0;
    around(x, y, (j) => { const sum = image[j] + image[j + 1] + image[j + 2]; lo = Math.min(lo, sum); hi = Math.max(hi, sum); });
    return (hi - lo) / 255;
  };
  const strength = (gap: number) => Math.min(1, Math.max(0, 6 * gap - 0.06));

  // Pass 1: the 1px-tolerant diff, and which 8px cells hold a pixel that also clears the edge test.
  const removed = new Float32Array(width * height), added = new Float32Array(width * height);
  const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
  const seeded = new Uint8Array(cols * rows);
  for (let y = 0; y < overlap; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x, i = p * 4;
      const lost = missing(before.data, after.data, i, x, y), gained = missing(after.data, before.data, i, x, y);
      removed[p] = strength(lost);
      added[p] = strength(gained);
      const seed = (removed[p] > 0 && strength(lost - EDGE_TOLERANCE * contrast(after.data, x, y)) >= SEED_STRENGTH)
        || (added[p] > 0 && strength(gained - EDGE_TOLERANCE * contrast(before.data, x, y)) >= SEED_STRENGTH);
      if (seed) seeded[((y / CELL) | 0) * cols + ((x / CELL) | 0)] = 1;
    }
  }
  // Pass 2: keep the diff only within REACH cells of a seed.
  const kept = new Uint8Array(cols * rows);
  seeded.forEach((seed, cell) => {
    if (!seed) return;
    const col = cell % cols, row = (cell / cols) | 0;
    for (let r = Math.max(0, row - REACH); r <= Math.min(rows - 1, row + REACH); r++) kept.fill(1, r * cols + Math.max(0, col - REACH), r * cols + Math.min(cols, col + REACH + 1));
  });
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!kept[((y / CELL) | 0) * cols + ((x / CELL) | 0)]) { removed[p] = 0; added[p] = 0; } else if (removed[p] > 0 || added[p] > 0) changed++;
    }
  }
  return { removed, added, width, height, changed };
}

async function diffImage({ removed, added, width, height }: ChangeMaps, dark: boolean) {
  const [darkerBefore, darkerAfter] = dark ? [ADDED, REMOVED] : [REMOVED, ADDED];
  const out = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= height || xx >= width) continue;
        r = Math.max(r, removed[yy * width + xx]); g = Math.max(g, added[yy * width + xx]);
      }
      const [color, alpha] = r >= g ? [darkerBefore, r] : [darkerAfter, g];
      const i = (y * width + x) * 4;
      out.data[i] = color[0]; out.data[i + 1] = color[1]; out.data[i + 2] = color[2]; out.data[i + 3] = Math.round(alpha * 0.8 * 255);
    }
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(out, 0, 0);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}
