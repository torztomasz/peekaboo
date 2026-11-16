// Auto-align runs here because only the extension's own worker may read GitHub's uploaded images: they are
// served without CORS headers, so page code (and the userscript) can't get at their pixels. The permission
// for the image host is optional, asked for on the options page the first time someone picks Auto.

import { IMAGE_ORIGINS } from "./origins";

type AlignRequest = { type: "align"; before: string; after: string };
type AlignResponse = { dx: number; diff: string } | { needsPermission: true } | { error: string };

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "align") {
    findOffset(message as AlignRequest).then(reply, (error) => reply({ error: String(error) }));
    return true;
  }
  if (message?.type === "open-options") chrome.runtime.openOptionsPage();
  return false;
});

// Where the narrower screenshot's left edge sits inside the wider one, in the wider one's pixels.
async function findOffset({ before, after }: AlignRequest): Promise<AlignResponse> {
  if (!(await chrome.permissions.contains({ origins: IMAGE_ORIGINS }))) return { needsPermission: true };
  const [a, b] = await Promise.all([load(before), load(after)]);
  const beforeIsWide = a.width >= b.width;
  const [wide, narrow] = beforeIsWide ? [a, b] : [b, a];
  const slack = wide.width - narrow.width;

  // Pass 1: both shrunk so the wide one is about 400px across, every offset compared.
  const scale = Math.min(1, 400 / wide.width);
  const coarse = bestOffset(gray(wide, scale), gray(narrow, scale), Math.round(slack * scale), Math.ceil(16 * scale));
  // Pass 2: full size, within the coarse step either side.
  const step = Math.ceil(1 / scale) + 1;
  const fine = bestOffset(gray(wide, 1), gray(narrow, 1), slack, 0, Math.round(coarse / scale) - step, Math.round(coarse / scale) + step);
  return { dx: fine, diff: await diffImage(a, b, beforeIsWide ? 0 : fine, beforeIsWide ? fine : 0) };
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

async function diffImage(before: ImageBitmap, after: ImageBitmap, beforeX: number, afterX: number) {
  const width = Math.max(before.width + beforeX, after.width + afterX), height = Math.max(before.height, after.height);
  const pixels = (bitmap: ImageBitmap) => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  };
  const b = pixels(before), a = pixels(after);
  const removed = new Float32Array(width * height), added = new Float32Array(width * height);
  for (let y = 0; y < Math.min(before.height, after.height); y++) {
    for (let x = Math.max(beforeX, afterX); x < Math.min(before.width + beforeX, after.width + afterX); x++) {
      const bi = (y * before.width + x - beforeX) * 4, ai = (y * after.width + x - afterX) * 4;
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
