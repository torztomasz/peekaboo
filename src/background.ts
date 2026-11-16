// Auto-align runs here because only the extension's own worker may read GitHub's uploaded images: they are
// served without CORS headers, so page code (and the userscript) can't get at their pixels. The permission
// for the image host is optional, asked for on the options page the first time someone picks Auto.

import { IMAGE_ORIGINS } from "./origins";

type AlignRequest = { type: "align"; before: string; after: string };
type Placement = { beforeX: number; beforeY: number; afterX: number; afterY: number };
type AlignResponse = { placement: Placement; diff: string } | { needsPermission: true } | { error: string };

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "align") {
    findOffset(message as AlignRequest).then(reply, (error) => reply({ error: String(error) }));
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

async function findOffset({ before, after }: AlignRequest): Promise<AlignResponse> {
  if (!(await chrome.permissions.contains({ origins: IMAGE_ORIGINS }))) return { needsPermission: true };
  const [b, a] = await Promise.all([load(before), load(after)]);
  const fits = (outer: ImageBitmap, inner: ImageBitmap) => outer.width >= inner.width && outer.height >= inner.height;
  let placement: Placement | null = null;
  if (fits(b, a) || fits(a, b)) {
    const beforeOutside = fits(b, a);
    const found = locate(beforeOutside ? b : a, beforeOutside ? a : b);
    if (found.error <= CONTAINED_MAX_ERROR) {
      placement = beforeOutside ? { beforeX: 0, beforeY: 0, afterX: found.x, afterY: found.y } : { beforeX: found.x, beforeY: found.y, afterX: 0, afterY: 0 };
    }
  }
  if (!placement) {
    const beforeIsWide = b.width >= a.width;
    const dx = slideSideways(beforeIsWide ? b : a, beforeIsWide ? a : b);
    placement = beforeIsWide ? { beforeX: 0, beforeY: 0, afterX: dx, afterY: 0 } : { beforeX: dx, beforeY: 0, afterX: 0, afterY: 0 };
  }
  return { placement, diff: await diffImage(b, a, placement) };
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

// Template match of `inner` inside `outer`: every position on a shrunk copy, then exact around the best.
function locate(outer: ImageBitmap, inner: ImageBitmap) {
  let scale = Math.min(1, 240 / Math.max(outer.width, outer.height));
  scale = Math.min(1, Math.max(scale, 24 / Math.min(inner.width, inner.height)));
  const coarse = match(gray(outer, scale), gray(inner, scale), 0, Math.round((outer.width - inner.width) * scale), 0, Math.round((outer.height - inner.height) * scale), 1);
  const step = Math.ceil(1 / scale) + 1;
  const cx = Math.round(coarse.x / scale), cy = Math.round(coarse.y / scale);
  const o = gray(outer, 1), i = gray(inner, 1);
  return match(o, i, Math.max(0, cx - step), Math.min(outer.width - inner.width, cx + step), Math.max(0, cy - step), Math.min(outer.height - inner.height, cy + step), 1);
}

// Smallest mean absolute difference over positions [x0..x1] x [y0..y1]; abandons a position once it can't win.
function match(outer: Gray, inner: Gray, x0: number, x1: number, y0: number, y1: number, stride: number) {
  const rowStep = Math.max(stride, Math.floor(inner.height / 200)), colStep = Math.max(stride, Math.floor(inner.width / 300));
  let samples = 0;
  for (let y = 0; y < inner.height; y += rowStep) for (let x = 0; x < inner.width; x += colStep) samples++;
  let best = { x: x0, y: y0, error: Infinity };
  for (let oy = y0; oy <= y1; oy++) {
    for (let ox = x0; ox <= x1; ox++) {
      let sum = 0;
      const limit = best.error * samples;
      for (let y = 0; y < inner.height && sum < limit; y += rowStep) {
        const orow = (oy + y) * outer.width + ox, irow = y * inner.width;
        for (let x = 0; x < inner.width; x += colStep) sum += Math.abs(outer.data[orow + x] - inner.data[irow + x]);
      }
      if (sum < limit) best = { x: ox, y: oy, error: sum / samples };
    }
  }
  return best;
}

async function load(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  return createImageBitmap(await response.blob());
}

type Gray = { data: Float32Array; width: number; height: number };

function gray(bitmap: ImageBitmap, scale: number): Gray {
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(Math.min(bitmap.height, 4000) * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0, bitmap.width, Math.min(bitmap.height, 4000), 0, 0, width, height);
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

async function diffImage(before: ImageBitmap, after: ImageBitmap, { beforeX, beforeY, afterX, afterY }: Placement) {
  const width = Math.max(before.width + beforeX, after.width + afterX), height = Math.max(before.height + beforeY, after.height + afterY);
  const pixels = (bitmap: ImageBitmap) => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  };
  const b = pixels(before), a = pixels(after);
  const removed = new Float32Array(width * height), added = new Float32Array(width * height);
  for (let y = Math.max(beforeY, afterY); y < Math.min(before.height + beforeY, after.height + afterY); y++) {
    for (let x = Math.max(beforeX, afterX); x < Math.min(before.width + beforeX, after.width + afterX); x++) {
      const bi = ((y - beforeY) * before.width + x - beforeX) * 4, ai = ((y - afterY) * after.width + x - afterX) * 4;
      let lighterAfter = 0, lighterBefore = 0;
      for (let c = 0; c < 3; c++) {
        const d = (a[ai + c] - b[bi + c]) / 255;
        if (d > 0) lighterAfter += d; else lighterBefore -= d;
      }
      removed[y * width + x] = Math.min(1, Math.max(0, 6 * lighterAfter - 0.06));
      added[y * width + x] = Math.min(1, Math.max(0, 6 * lighterBefore - 0.06));
    }
  }
  const out = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= height || xx >= width) continue;
        r = Math.max(r, removed[yy * width + xx]); g = Math.max(g, added[yy * width + xx]);
      }
      const [color, alpha] = r >= g ? [REMOVED, r] : [ADDED, g];
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
