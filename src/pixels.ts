// The pixel work behind Auto-align and "how much changed", on decoded RGBA so it runs (and is tested) the
// same in the extension's worker and in Node. The worker only fetches, decodes and encodes.
//
// Screenshots are big (a 2560 × 1600 retina capture is 4M pixels; a full page can be 10× that), and this
// runs once per pair as a PR opens, so every pass avoids per-pixel allocation, works on bytes, and stops
// as soon as a candidate can't win.

export type Image = { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
export type Placement = { beforeX: number; beforeY: number; afterX: number; afterY: number };
// The diff covers the whole shared canvas (`width` × `height`) but only `box` holds anything: `data` is that
// box's RGBA. Everything outside it is transparent, so it isn't computed, encoded or decoded.
export type Box = { x: number; y: number; width: number; height: number };
// `changed` counts the pixels that differ visibly (by the rule that colours the diff).
export type Overlay = { width: number; height: number; box: Box; data: Uint8ClampedArray<ArrayBuffer>; changed: number };

// Where each screenshot sits on a shared canvas, in their own (equal) pixel scale.
// First: is one a crop of the other (a viewport inside a full page, a detail inside a screen)? Then it is
// placed where it matches, in both directions, but only on a near-perfect match: a loose fit would line up
// the wrong part of a page whose layout really shifted, and hide that shift. Otherwise the screenshots are
// two window widths of one page: top-aligned, the narrower slid sideways to where the two match best.
// Only a crop is `exact`: two window widths reflow (columns move, rows end at another edge), so what a
// count would report as changes there is partly layout.
const CONTAINED_MAX_ERROR = 6;

export function findPlacement(before: Image, after: Image): { placement: Placement; exact: boolean } {
  const fits = (outer: Image, inner: Image) => outer.width >= inner.width && outer.height >= inner.height;
  if (fits(before, after) || fits(after, before)) {
    const beforeOutside = fits(before, after);
    const found = locate(beforeOutside ? before : after, beforeOutside ? after : before);
    if (found.error <= CONTAINED_MAX_ERROR) {
      const placement = beforeOutside ? { beforeX: 0, beforeY: 0, afterX: found.x, afterY: found.y } : { beforeX: found.x, beforeY: found.y, afterX: 0, afterY: 0 };
      return { placement, exact: true };
    }
  }
  const beforeIsWide = before.width >= after.width;
  const dx = slideSideways(beforeIsWide ? before : after, beforeIsWide ? after : before);
  const placement = beforeIsWide ? { beforeX: 0, beforeY: 0, afterX: dx, afterY: 0 } : { beforeX: dx, beforeY: 0, afterX: 0, afterY: 0 };
  return { placement, exact: false };
}

// ---------- Matching ----------

// Grey levels, one byte per pixel. Full-size copies stop at FULL_SIZE_ROWS, for speed and memory; a
// taller template still matches on those rows.
type Gray = { data: Uint8Array; width: number; height: number };
type Shrunk = Gray & { stepX: number; stepY: number };
const FULL_SIZE_ROWS = 4000;

const lumaAt = (d: Uint8ClampedArray, p: number) => d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29;

function grayRows({ data, width }: Image, top: number, bottom: number): Gray {
  const out = new Uint8Array(width * (bottom - top));
  for (let i = 0, p = top * width * 4; i < out.length; i++, p += 4) out[i] = lumaAt(data, p) >> 8;
  return { data: out, width, height: bottom - top };
}

// Rows [top, bottom) area-averaged down by `scale`. Unlike a canvas's bilinear drawImage every source
// pixel counts, so text at a tenth of its size is still a grey smear in the right place rather than an
// aliased pattern that matches anywhere. `step` is how many source pixels one output pixel covers.
function shrink(image: Image, scale: number, top: number, bottom: number): Shrunk {
  if (scale >= 1) return { ...grayRows(image, top, bottom), stepX: 1, stepY: 1 };
  const { data, width: sourceWidth } = image, sourceHeight = bottom - top;
  const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
  const stepX = sourceWidth / width, stepY = sourceHeight / height;
  const column = new Int32Array(sourceWidth), columnCount = new Float64Array(width);
  for (let x = 0; x < sourceWidth; x++) columnCount[(column[x] = Math.min(width - 1, Math.floor(x / stepX)))]++;
  const out = new Uint8Array(width * height), sums = new Float64Array(width);
  for (let oy = 0, y = 0; oy < height; oy++) {
    const end = oy === height - 1 ? sourceHeight : Math.floor((oy + 1) * stepY);
    const rows = end - y;
    sums.fill(0);
    for (; y < end; y++) {
      for (let x = 0, p = (top + y) * sourceWidth * 4; x < sourceWidth; x++, p += 4) sums[column[x]] += lumaAt(data, p);
    }
    for (let ox = 0; ox < width; ox++) out[oy * width + ox] = Math.round(sums[ox] / (256 * rows * columnCount[ox]));
  }
  return { data: out, width, height, stepX, stepY };
}

// A [1 2 1] × [1 2 1] blur, edges clamped.
function blur(g: Shrunk): Shrunk {
  const { width: w, height: h, data } = g, rows = new Uint16Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) rows[r + x] = data[r + Math.max(0, x - 1)] + 2 * data[r + x] + data[r + Math.min(w - 1, x + 1)];
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w, here = y * w, down = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) out[here + x] = (rows[up + x] + 2 * rows[here + x] + rows[down + x] + 8) >> 4;
  }
  return { ...g, data: out };
}

// All but the 1px border, so a match at (x, y) puts the image's own corner at (x − 1, y − 1).
function interior(g: Shrunk): Shrunk {
  const width = g.width - 2, height = g.height - 2, out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(g.data.subarray((y + 1) * g.width + 1, (y + 1) * g.width + 1 + width), y * width);
  return { ...g, data: out, width, height };
}

// Template match of `inner` inside `outer`: every position on shrunk copies of the whole images, so a
// crop from anywhere down a tall capture can be found; then full size, but only the bands of rows the
// coarse hits could be off by. Search ranges come from the grey copies' own sizes, so nothing reads past them.
//
// Shrinking averages a crop's pixels on a grid offset from the full image's by a fraction of a cell, and
// on text that fraction alone can decide which spot scores best. A light blur of both shrunk copies makes
// that fraction matter little; only the crop's interior is compared, since its blurred border mixed in
// pixels the outer image has but the crop doesn't. Then the right spot ranks among the best few:
// COARSE_CANDIDATES of them are checked at full size, each starting from the best error so far.
// (Measured on 41 text crops: 33 in the top 8 at every scale from 0.09 to 0.2, against 23 to 31 unblurred.)
// The blur also erases fine patterns (1px stripes, hairline grids) that only the plain copies tell apart,
// so unless the blurred search finds the crop exactly, the plain copies are searched too and the closer
// match wins (the blurred one on a tie); a crop too small to lose a border is searched plain only.
const COARSE_CANDIDATES = 8;

function locate(outer: Image, inner: Image) {
  const scale = Math.min(1, Math.max(240 / Math.max(outer.width, outer.height), 24 / Math.min(inner.width, inner.height)));
  const o = shrink(outer, scale, 0, outer.height), i = shrink(inner, scale, 0, inner.height);
  const blurred = i.width >= 3 && i.height >= 3 ? search(outer, inner, blur(o), interior(blur(i)), 1) : null;
  if (blurred?.error === 0) return blurred;
  const plain = search(outer, inner, o, i, 0);
  return blurred && blurred.error <= plain.error ? blurred : plain;
}

// `border`: how many shrunk pixels the crop's copy `i` lost on each side.
function search(outer: Image, inner: Image, o: Shrunk, i: Shrunk, border: number) {
  const candidates = bestMatches(o, i, 0, o.width - i.width, 0, o.height - i.height, COARSE_CANDIDATES);
  const xMax = outer.width - inner.width, yMax = outer.height - inner.height;
  // A blurred pick can be a shrunk pixel off, so the full-size search spans two cells either way.
  const sx = 2 * Math.ceil(o.stepX) + 1, sy = 2 * Math.ceil(o.stepY) + 1;
  const template = grayRows(inner, 0, Math.min(inner.height, FULL_SIZE_ROWS));
  let best = { x: 0, y: 0, error: Infinity }, bestBand: Gray | null = null, bestTop = 0;
  for (const coarse of candidates) {
    const cx = Math.min(xMax, Math.max(0, Math.round((coarse.x - border) * o.stepX))), cy = Math.min(yMax, Math.max(0, Math.round((coarse.y - border) * o.stepY)));
    const top = Math.max(0, cy - sy), last = Math.min(yMax, cy + sy);
    const band = grayRows(outer, top, last + template.height);
    const exact = bestMatches(band, template, Math.max(0, cx - sx), Math.min(band.width - template.width, cx + sx), 0, band.height - template.height, 1, { x: cx, y: cy - top }, best.error)[0];
    if (exact && exact.error < best.error) { best = exact; bestBand = band; bestTop = top; }
  }
  if (!bestBand) return best;
  // The passes above compare a grid of every few rows and columns, which can't tell apart positions less
  // than a grid step apart when edges fall on even rows, as they all do in a 2x retina capture. Every
  // pixel decides between those, or the diff shows a 1px shift that isn't there, and its error decides
  // whether this is a crop at all: the grid can miss every row that differs.
  const [rowStep, colStep] = sampleSteps(template);
  const dense = bestMatches(bestBand, template, Math.max(0, best.x - colStep + 1), Math.min(bestBand.width - template.width, best.x + colStep - 1),
    Math.max(0, best.y - rowStep + 1), Math.min(bestBand.height - template.height, best.y + rowStep - 1), 1, best, Infinity, true)[0];
  return { x: dense.x, y: dense.y + bestTop, error: dense.error };
}

// The `count` smallest mean absolute differences over positions [x0..x1] × [y0..y1], on a sample grid of
// `inner`, best first; positions next to a better one are dropped, so the picks are separate places.
// A position is abandoned once it can't make the list (or beat `beat`), so `seed`, scored first, makes
// nearly every other position stop after a row or two. `everyPixel` compares the whole of `inner`.
type Hit = { x: number; y: number; error: number };

const sampleSteps = (inner: Gray) => [Math.max(1, Math.floor(inner.height / 200)), Math.max(1, Math.floor(inner.width / 300))];

function bestMatches(outer: Gray, inner: Gray, x0: number, x1: number, y0: number, y1: number, count: number, seed?: { x: number; y: number }, beat = Infinity, everyPixel = false): Hit[] {
  const [rowStep, colStep] = everyPixel ? [1, 1] : sampleSteps(inner);
  const samples = Math.ceil(inner.height / rowStep) * Math.ceil(inner.width / colStep);
  const od = outer.data, id = inner.data, ow = outer.width, iw = inner.width, ih = inner.height;
  const sumAt = (ox: number, oy: number, limit: number) => {
    let sum = 0;
    for (let y = 0; y < ih && sum < limit; y += rowStep) {
      const orow = (oy + y) * ow + ox, irow = y * iw;
      for (let x = 0; x < iw; x += colStep) sum += Math.abs(od[orow + x] - id[irow + x]);
    }
    return sum;
  };
  const hits: Hit[] = [];
  const worst = () => (hits.length < count ? beat : hits[hits.length - 1].error);
  const consider = (x: number, y: number) => {
    const limit = worst() * samples;
    const sum = sumAt(x, y, limit);
    if (!(sum < limit)) return;
    const hit = { x, y, error: sum / samples };
    const near = hits.findIndex((h) => Math.abs(h.x - x) <= 1 && Math.abs(h.y - y) <= 1);
    if (near >= 0) {
      if (hits[near].error <= hit.error) return;
      hits.splice(near, 1);
    }
    let at = hits.length;
    while (at > 0 && hits[at - 1].error > hit.error) at--;
    hits.splice(at, 0, hit);
    if (hits.length > count) hits.pop();
  };
  const seeded = seed !== undefined && seed.x >= x0 && seed.x <= x1 && seed.y >= y0 && seed.y <= y1;
  if (seeded) consider(seed.x, seed.y);
  for (let oy = y0; oy <= y1; oy++) {
    for (let ox = x0; ox <= x1; ox++) if (!(seeded && ox === seed.x && oy === seed.y)) consider(ox, oy);
  }
  return hits;
}

// Rows are top-aligned, so only the first FULL_SIZE_ROWS of each are compared.
function slideSideways(wideImage: Image, narrowImage: Image) {
  const wideRows = Math.min(wideImage.height, FULL_SIZE_ROWS), narrowRows = Math.min(narrowImage.height, FULL_SIZE_ROWS);
  const wide = grayRows(wideImage, 0, wideRows), narrow = grayRows(narrowImage, 0, narrowRows);
  // Pass 1: both shrunk so the wide one is about 400px across, every offset compared.
  const scale = Math.min(1, 400 / wide.width);
  const w = shrink(wideImage, scale, 0, wideRows), n = shrink(narrowImage, scale, 0, narrowRows);
  const overhang = Math.ceil(16 / w.stepX);
  const coarse = Math.round(bestOffset(w, n, -overhang, w.width - n.width + overhang) * w.stepX);
  // Pass 2: full size, within the coarse step either side.
  const step = Math.ceil(w.stepX) + 1;
  return bestOffset(wide, narrow, coarse - step, coarse + step, coarse);
}

// Mean absolute difference of the overlap at each horizontal offset; rows are top-aligned. Offsets where
// under 60% of the narrow one overlaps are skipped; each offset stops once it can't beat the best.
function bestOffset(wide: Gray, narrow: Gray, from: number, to: number, seed?: number) {
  const rows = Math.min(wide.height, narrow.height);
  const rowStep = Math.max(1, Math.floor(rows / 300));
  const rowCount = Math.ceil(rows / rowStep);
  const wd = wide.data, nd = narrow.data, ww = wide.width, nw = narrow.width;
  const errorAt = (dx: number, beat: number) => {
    const x0 = Math.max(0, -dx), x1 = Math.min(nw, ww - dx);
    if (x1 - x0 < nw * 0.6) return Infinity;
    const count = rowCount * (x1 - x0), limit = beat * count;
    let sum = 0;
    for (let y = 0; y < rows && sum < limit; y += rowStep) {
      const wRow = y * ww + dx, nRow = y * nw;
      for (let x = x0; x < x1; x++) sum += Math.abs(wd[wRow + x] - nd[nRow + x]);
    }
    return sum < limit ? sum / count : Infinity;
  };
  const seeded = seed !== undefined && seed >= from && seed <= to;
  let best = seeded ? seed : 0, bestError = seeded ? errorAt(seed, Infinity) : Infinity;
  for (let dx = from; dx <= to; dx++) {
    if (seeded && dx === seed) continue;
    const error = errorAt(dx, bestError);
    if (error < bestError) { bestError = error; best = dx; }
  }
  return best;
}

// ---------- Changes ----------

// A pixel's change is the summed channel difference (0–765) in each direction. The diff's opacity is
// clamp(6 × difference / 255 − 0.06): nothing up to 2 (anti-aliasing noise), full from 46. Storing the
// difference clamped to that range as a byte keeps the exact opacity and ordering at a quarter of the memory.
const NOISE = 2, SATURATED = 46;
const level = (difference: number) => (difference <= NOISE ? 0 : difference >= SATURATED ? SATURATED : difference);

// Same-size pairs only need to know whether any pixel changed, to warn when the same screenshot was
// uploaded twice: no maps, identical pixels skipped a word at a time, done at the first visible change.
const AS_IS: Placement = { beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 };

export function anyChange(before: Image, after: Image): boolean {
  return compareOverlap(before, after, AS_IS, null) > 0;
}

// The diff at full resolution, from real pixels: the compositor version shows edges wherever the two
// images are resampled at different sub-pixel offsets, which is always the case once they are shifted.
// Same rule and colours as the compositor filter (dilated 1px, 80% opacity); pixels only one screenshot
// covers stay clear, since there is nothing to compare them with.
const REMOVED = [219, 36, 46], ADDED = [26, 184, 77];

// The removed/added levels say which side is darker, which is "which side has the content" only on light
// screenshots. Averaged over both, so a pair that switches theme falls on the side most of it is on; a
// grid about 200 pixels across is plenty for a mean.
export function isDark(before: Image, after: Image) {
  const mean = ({ data, width, height }: Image) => {
    const step = Math.max(1, Math.floor(width / 200));
    let sum = 0, count = 0;
    for (let y = 0; y < height; y += step) {
      for (let p = y * width * 4; p < (y + 1) * width * 4; p += step * 4, count++) sum += lumaAt(data, p) >> 8;
    }
    return sum / count;
  };
  return (mean(before) + mean(after)) / 2 < 128;
}

// `dark`: the screenshots are mostly dark (see isDark), so the colours swap and red still marks what was
// removed, green what was added.
export function diffOverlay(before: Image, after: Image, placement: Placement, dark = false): Overlay {
  const { width, height } = canvasSize(before, after, placement);
  const levels: Levels = { removed: new Uint8Array(width * height), added: new Uint8Array(width * height), bounds: { left: width, right: 0, top: height, bottom: 0 } };
  const changed = compareOverlap(before, after, placement, levels);
  return { width, height, ...dilate(levels, width, height, dark), changed };
}

const canvasSize = (before: Image, after: Image, { beforeX, beforeY, afterX, afterY }: Placement) =>
  ({ width: Math.max(before.width + beforeX, after.width + afterX), height: Math.max(before.height + beforeY, after.height + afterY) });

// Per canvas pixel, how much it changed in each direction. `bounds` grow to hold every changed pixel
// ([left, right) × [top, bottom)), so the overlay only works there.
type Levels = { removed: Uint8Array; added: Uint8Array; bounds: { left: number; right: number; top: number; bottom: number } };

// Visibly changed pixels where both screenshots reach, written into `levels`; without them, stops at the first.
function compareOverlap(before: Image, after: Image, placement: Placement, levels: Levels | null): number {
  const { beforeX, beforeY, afterX, afterY } = placement;
  const { width } = canvasSize(before, after, placement);
  const y0 = Math.max(beforeY, afterY), y1 = Math.min(before.height + beforeY, after.height + afterY);
  const x0 = Math.max(beforeX, afterX), x1 = Math.min(before.width + beforeX, after.width + afterX);
  if (y1 <= y0 || x1 <= x0) return 0;
  const b = before.data, a = after.data;
  const b32 = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2), a32 = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    const bRow = (y - beforeY) * before.width - beforeX, aRow = (y - afterY) * after.width - afterX;
    const out = y * width;
    const changedBefore = changed;
    for (let x = x0; x < x1; x++) {
      if (b32[bRow + x] === a32[aRow + x]) continue;
      const bi = (bRow + x) << 2, ai = (aRow + x) << 2;
      let lighterAfter = 0, lighterBefore = 0;
      for (let c = 0; c < 3; c++) {
        const d = a[ai + c] - b[bi + c];
        if (d > 0) lighterAfter += d; else lighterBefore -= d;
      }
      const r = level(lighterAfter), g = level(lighterBefore);
      if (r === 0 && g === 0) continue;
      changed++;
      if (!levels) return changed;
      levels.removed[out + x] = r; levels.added[out + x] = g;
      if (x < levels.bounds.left) levels.bounds.left = x;
      if (x >= levels.bounds.right) levels.bounds.right = x + 1;
    }
    if (levels && changed > changedBefore) {
      if (y < levels.bounds.top) levels.bounds.top = y;
      levels.bounds.bottom = y + 1;
    }
  }
  return changed;
}

// ---------- Two pixel densities ----------

// A 2x and a 1x capture of one screen draw every edge differently: anti-aliasing, and stems that are one
// dark pixel at 1x but two half-dark ones once 2x is scaled down. The strict rule, tuned to catch a 1px
// shift, marks them all. So a pixel counts only if the other side has nothing as dark within 1px, and a
// place counts as changed only where that gap also beats half the other side's local contrast plus a
// floor: resampling errs by up to half an edge's contrast, and by a few levels in flat areas where its
// filter rings (measured on 2x and 1.5x captures). Inside such a place the diff shows everything the 1px
// tolerance leaves, so a reworded label shows whole glyphs, not just the pixels that cleared the edge test.
// `before` and `after` are already scaled to one width; their heights may differ by a rounded pixel.
const EDGE_TOLERANCE = 0.5, SEED_STRENGTH = 0.25;
// "Such a place": up to 2 cells of 8px from a pixel that cleared the edge test.
const CELL = 8, REACH = 2;

export function densityOverlay(before: Image, after: Image, dark = false): Overlay {
  const width = before.width, height = Math.max(before.height, after.height), overlap = Math.min(before.height, after.height);
  const levels: Levels = { removed: new Uint8Array(width * height), added: new Uint8Array(width * height), bounds: { left: width, right: 0, top: height, bottom: 0 } };
  const b = before.data, a = after.data;
  const strength = (gap: number) => Math.min(1, Math.max(0, 6 * (gap / 255) - 0.06));
  // How much darker `own` is at pixel `i` than the closest match around (x, y) in `other`, in summed
  // channels: 0 if `other` has it nearby. Usually the same pixel already matches, so that is tried first.
  const missing = (own: Uint8ClampedArray, other: Uint8ClampedArray, i: number, x: number, y: number) => {
    const darker = (j: number) => Math.max(0, other[j] - own[i]) + Math.max(0, other[j + 1] - own[i + 1]) + Math.max(0, other[j + 2] - own[i + 2]);
    let least = darker(i);
    for (let yy = Math.max(0, y - 1); yy <= Math.min(overlap - 1, y + 1) && least > 0; yy++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) least = Math.min(least, darker((yy * width + xx) * 4));
    }
    return least;
  };
  // How far the darkest and lightest pixels around (x, y) are apart: where resampling errs most.
  const contrast = (image: Uint8ClampedArray, x: number, y: number) => {
    let lo = Infinity, hi = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(overlap - 1, y + 1); yy++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
        const j = (yy * width + xx) * 4, sum = image[j] + image[j + 1] + image[j + 2];
        if (sum < lo) lo = sum;
        if (sum > hi) hi = sum;
      }
    }
    return hi - lo;
  };

  // Pass 1: the 1px-tolerant levels, and which 8px cells hold a pixel that also clears the edge test.
  const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
  const seeded = new Uint8Array(cols * rows);
  for (let y = 0; y < overlap; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x, i = p * 4;
      const lost = missing(b, a, i, x, y), gained = missing(a, b, i, x, y);
      const r = level(lost), g = level(gained);
      if (r === 0 && g === 0) continue;
      levels.removed[p] = r; levels.added[p] = g;
      const seed = (r > 0 && strength(lost - EDGE_TOLERANCE * contrast(a, x, y)) >= SEED_STRENGTH)
        || (g > 0 && strength(gained - EDGE_TOLERANCE * contrast(b, x, y)) >= SEED_STRENGTH);
      if (seed) seeded[((y / CELL) | 0) * cols + ((x / CELL) | 0)] = 1;
    }
  }
  // Pass 2: keep the levels only within REACH cells of a seed.
  const kept = new Uint8Array(cols * rows);
  seeded.forEach((seed, cell) => {
    if (!seed) return;
    const col = cell % cols, row = (cell / cols) | 0;
    for (let r = Math.max(0, row - REACH); r <= Math.min(rows - 1, row + REACH); r++) kept.fill(1, r * cols + Math.max(0, col - REACH), r * cols + Math.min(cols, col + REACH + 1));
  });
  let changed = 0;
  for (let y = 0; y < overlap; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!levels.removed[p] && !levels.added[p]) continue;
      if (!kept[((y / CELL) | 0) * cols + ((x / CELL) | 0)]) { levels.removed[p] = 0; levels.added[p] = 0; continue; }
      changed++;
      const box = levels.bounds;
      if (x < box.left) box.left = x;
      if (x >= box.right) box.right = x + 1;
      if (y < box.top) box.top = y;
      if (y >= box.bottom) box.bottom = y + 1;
    }
  }
  return { width, height, ...dilate(levels, width, height, dark), changed };
}

// RGBA of the overlay: each pixel takes the strongest change within 1px (a separable 3 × 3 max, rows then
// a rolling window of three), coloured by whichever direction is stronger, as one 32-bit write. Only the
// box around the changes, plus the 1px they dilate into, is computed.
function dilate({ removed, added, bounds }: Levels, width: number, height: number, dark: boolean): { box: Box; data: Uint8ClampedArray<ArrayBuffer> } {
  if (bounds.right <= bounds.left) return { box: { x: 0, y: 0, width: 0, height: 0 }, data: new Uint8ClampedArray(0) };
  const opacity = (l: number) => Math.round(Math.min(1, Math.max(0, (6 * l) / 255 - 0.06)) * 0.8 * 255);
  const rgba = (color: number[], alpha: number) => (alpha ? ((alpha << 24) | (color[2] << 16) | (color[1] << 8) | color[0]) >>> 0 : 0);
  const removedColor = new Uint32Array(SATURATED + 1), addedColor = new Uint32Array(SATURATED + 1);
  const [darkerBefore, darkerAfter] = dark ? [ADDED, REMOVED] : [REMOVED, ADDED];
  for (let l = 0; l <= SATURATED; l++) { removedColor[l] = rgba(darkerBefore, opacity(l)); addedColor[l] = rgba(darkerAfter, opacity(l)); }

  const left = Math.max(0, bounds.left - 1), right = Math.min(width, bounds.right + 1);
  const top = Math.max(0, bounds.top - 1), bottom = Math.min(height, bounds.bottom + 1);
  const boxWidth = right - left;
  const out = new Uint8ClampedArray(boxWidth * (bottom - top) * 4);
  const rowMax = (source: Uint8Array, y: number, into: Uint8Array) => {
    if (y < bounds.top || y >= bounds.bottom) { into.fill(0); return; }
    const row = y * width;
    for (let x = left; x < right; x++) {
      let m = source[row + x];
      if (x > 0 && source[row + x - 1] > m) m = source[row + x - 1];
      if (x < width - 1 && source[row + x + 1] > m) m = source[row + x + 1];
      into[x] = m;
    }
  };
  // Three rows of horizontal maxima per map: y − 1, y, y + 1, rotated as y advances.
  const rows = (source: Uint8Array) => {
    const ring = [new Uint8Array(width), new Uint8Array(width), new Uint8Array(width)];
    rowMax(source, top - 1, ring[0]);
    rowMax(source, top, ring[1]);
    rowMax(source, top + 1, ring[2]);
    return {
      ring,
      advance(y: number) {
        const oldest = ring.shift()!;
        rowMax(source, y + 2, oldest);
        ring.push(oldest);
      },
    };
  };
  const r = rows(removed), g = rows(added);
  const out32 = new Uint32Array(out.buffer);
  for (let y = top; y < bottom; y++) {
    const [rUp, rMid, rDown] = r.ring, [gUp, gMid, gDown] = g.ring;
    const row = (y - top) * boxWidth - left;
    for (let x = left; x < right; x++) {
      let rm = rMid[x], gm = gMid[x];
      if (rUp[x] > rm) rm = rUp[x];
      if (rDown[x] > rm) rm = rDown[x];
      if (gUp[x] > gm) gm = gUp[x];
      if (gDown[x] > gm) gm = gDown[x];
      out32[row + x] = rm >= gm ? removedColor[rm] : addedColor[gm];
    }
    r.advance(y);
    g.advance(y);
  }
  return { box: { x: left, y: top, width: boxWidth, height: bottom - top }, data: out };
}
