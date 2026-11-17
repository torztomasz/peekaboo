// What changed between two screenshots, as red/green maps and the separate places that changed. Pure
// pixel code apart from the worker's canvas calls, so Node can test it.
//
// A change often pushes everything below it down: a banner above the header, a new item in a menu. Compared
// pixel for pixel, every shifted row reads as changed, and the reviewer sees a third of the screen in colour
// for one banner. So same-width pairs are lined up like a text diff, one row of pixels for one line: the
// rows that only After has are what was added, and the rows after them are compared with the rows they
// moved down from. Only the columns that changed take part, since a menu grows without moving the page
// beside it.

export type Pixels = { data: Uint8ClampedArray; width: number; height: number };
export type Placement = { beforeX: number; beforeY: number; afterX: number; afterY: number };
// `changed` of `compared` pixels differ visibly. `moved` says rows were lined up after content moved.
// `regions` are the separate places that changed, as fractions of the shared canvas, top to bottom.
export type Stats = { changed: number; compared: number; moved: boolean; regions: Region[] };
export type Region = { x: number; y: number; w: number; h: number };
export type ChangeMaps = { removed: Float32Array; added: Float32Array; width: number; height: number; stats: Stats };

export const AS_IS: Placement = { beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 };

// Same-width pairs: each band of changed columns is lined up row by row where that leaves fewer changed
// pixels than comparing as placed.
// The canvas is After's coordinates (both top-aligned), so the maps sit over After in Diff.
export function lineUpChanges(before: Pixels, after: Pixels): ChangeMaps {
  const asPlaced = changeMaps(before, after, AS_IS);
  if (before.width !== after.width || asPlaced.stats.changed === 0) return asPlaced;
  const { width, height } = asPlaced;
  const removed = new Float32Array(width * height), added = new Float32Array(width * height);
  let changed = 0, moved = false;
  for (const [x0, x1] of columnBands(asPlaced)) {
    const placedCount = countBand(asPlaced, x0, x1);
    const lined = lineUpBand(before, after, x0, x1);
    const better = lined && lined.changed < placedCount ? lined : null;
    const source = better ?? asPlaced;
    for (let y = 0; y < height; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * width + x;
        removed[i] = source.removed[i]; added[i] = source.added[i];
      }
    }
    changed += better ? better.changed : placedCount;
    moved ||= Boolean(better);
  }
  if (!moved) return asPlaced;
  const stats: Stats = { changed, compared: asPlaced.stats.compared, moved, regions: visibleRegions(removed, added, width, height) };
  return { removed, added, width, height, stats };
}

// Alpha = 6 x summed channel difference - 0.06, as the compositor filter in the page: ignores anti-aliasing
// noise, saturates by ~6% change. Red where Before was darker, green where After is.
const strength = (difference: number) => Math.min(1, Math.max(0, 6 * difference - 0.06));

// Pixels only one screenshot covers stay clear, since there is nothing to compare them with.
export function changeMaps(before: Pixels, after: Pixels, { beforeX, beforeY, afterX, afterY }: Placement): ChangeMaps {
  const width = Math.max(before.width + beforeX, after.width + afterX), height = Math.max(before.height + beforeY, after.height + afterY);
  const b = before.data, a = after.data;
  const removed = new Float32Array(width * height), added = new Float32Array(width * height);
  const stats: Stats = { changed: 0, compared: 0, moved: false, regions: [] };
  for (let y = Math.max(beforeY, afterY); y < Math.min(before.height + beforeY, after.height + afterY); y++) {
    for (let x = Math.max(beforeX, afterX); x < Math.min(before.width + beforeX, after.width + afterX); x++) {
      const bi = ((y - beforeY) * before.width + x - beforeX) * 4, ai = ((y - afterY) * after.width + x - afterX) * 4;
      const [r, g] = comparePixel(b, bi, a, ai);
      removed[y * width + x] = r;
      added[y * width + x] = g;
      stats.compared++;
      if (r > 0 || g > 0) stats.changed++;
    }
  }
  stats.regions = visibleRegions(removed, added, width, height);
  return { removed, added, width, height, stats };
}

const differs = (b: ArrayLike<number>, bi: number, a: ArrayLike<number>, ai: number) => {
  const [r, g] = comparePixel(b, bi, a, ai);
  return r > 0 || g > 0;
};

function comparePixel(b: ArrayLike<number>, bi: number, a: ArrayLike<number>, ai: number) {
  let lighterAfter = 0, lighterBefore = 0;
  for (let c = 0; c < 3; c++) {
    const d = (a[ai + c] - b[bi + c]) / 255;
    if (d > 0) lighterAfter += d; else lighterBefore -= d;
  }
  return [strength(lighterAfter), strength(lighterBefore)];
}

// ---------- Column bands ----------

// The x-ranges the changes span, overlapping ones merged: each is lined up on its own, so a menu that grew
// moves only its own columns. Changes too scattered to list are one full-width band.
function columnBands({ removed, added, width, height }: ChangeMaps): [number, number][] {
  const boxes = findRegions(removed, added, width, height);
  if (boxes.length >= MAX_REGIONS) return [[0, width]];
  const spans = boxes.map(({ x0, x1 }) => [x0, x1] as [number, number]).sort((p, q) => p[0] - q[0]);
  const bands: [number, number][] = [];
  for (const [x0, x1] of spans) {
    const last = bands[bands.length - 1];
    if (last && x0 <= last[1]) last[1] = Math.max(last[1], x1);
    else bands.push([x0, x1]);
  }
  return bands;
}

function countBand({ removed, added, width, height }: ChangeMaps, x0: number, x1: number) {
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = x0; x < x1; x++) if (removed[y * width + x] > 0 || added[y * width + x] > 0) count++;
  return count;
}

// ---------- Lining up rows ----------

// Past this many inserted or deleted rows the two aren't one layout with something moved; compare as placed.
const MAX_ROW_EDITS = 1200;
// Rows match when they are equal inside this margin: a band's edges often hold a sliver of what sits
// beside the moving content, a shadow or the page showing through, which doesn't move with it. Inside
// they must be exact, or the tip of an icon would pass for a blank row and pair rows a few apart.
const EDGE_MARGIN = 24, EDGE_SHARE = 0.05;

type Band = { removed: Float32Array; added: Float32Array; changed: number };

// Rows of columns [x0, x1) matched like lines of text. Between matched rows, an edit replaces some rows of
// Before with some of After: they are compared in order, and what's left over on one side is an insertion,
// compared with the After row it grows from (so a new item shows, but not the panel edges it stretches),
// or a deletion, a red rule where the rows used to be, since After has no room to show them.
// A pixel counts only if it also differs from the same spot in Before: what stayed put while the rest
// moved (the page beside a menu that grew) isn't a change, and Flip shows it isn't.
function lineUpBand(before: Pixels, after: Pixels, x0: number, x1: number): Band | null {
  const pairs = matchRows(before.height, after.height, rowsMatch(before, after, x0, x1));
  if (!pairs) return null;
  const width = Math.max(before.width, after.width), height = Math.max(before.height, after.height);
  const removed = new Float32Array(width * height), added = new Float32Array(width * height);
  let changed = 0;
  // After's pixel at (x, y) against `other`, unless it matches Before at (x, y). The colour stays the one
  // against `other`: a pixel unlike either would otherwise take its colour from whatever used to sit there.
  const mark = (x: number, y: number, other: Uint8ClampedArray, oi: number) => {
    const ai = (y * after.width + x) * 4;
    const [r, g] = comparePixel(other, oi, after.data, ai);
    if ((r > 0 || g > 0) && y < before.height && !differs(before.data, (y * before.width + x) * 4, after.data, ai)) return;
    paint(y * width + x, r, g);
  };
  const paint = (i: number, r: number, g: number) => {
    if (r <= 0 && g <= 0) return;
    if (removed[i] === 0 && added[i] === 0) changed++;
    removed[i] = Math.max(removed[i], r); added[i] = Math.max(added[i], g);
  };
  const edit = (b0: number, b1: number, a0: number, a1: number) => {
    const common = Math.min(b1 - b0, a1 - a0);
    for (let k = 0; k < common; k++) for (let x = x0; x < x1; x++) mark(x, a0 + k, before.data, ((b0 + k) * before.width + x) * 4);
    // A viewport capture ends at the window's edge, not the page's: rows pushed past it aren't removed.
    if (b1 === before.height && a1 === after.height && before.height === after.height) return;
    const grownFrom = a0 > 0 ? a0 - 1 : a1 < after.height ? a1 : -1;
    const background = grownFrom < 0 && a1 > a0 + common ? commonColour(before, x0, x1) : null;
    for (let y = a0 + common; y < a1; y++) {
      for (let x = x0; x < x1; x++) {
        if (background) mark(x, y, background, 0);
        else mark(x, y, after.data, (grownFrom * after.width + x) * 4);
      }
    }
    if (b1 - b0 > common) markDeletion(before, after, b0 + common, b1, x0, x1, a1, width, (i) => paint(i, 1, 0));
  };
  let bi = 0, ai = 0;
  for (const [b, a] of [...pairs, [before.height, after.height]]) {
    if (b > bi || a > ai) edit(bi, b, ai, a);
    bi = b + 1; ai = a + 1;
  }
  return { removed, added, changed };
}

// Columns where the deleted rows held anything neither After row they closed up between has get a 2px
// rule there; deleted blank space draws nothing.
function markDeletion(before: Pixels, after: Pixels, b0: number, b1: number, x0: number, x1: number, at: number, width: number, paint: (i: number) => void) {
  const below = Math.min(at, after.height - 1), above = Math.max(0, at - 1), top = Math.min(above, after.height - 2);
  for (let x = x0; x < x1; x++) {
    let content = false;
    for (let y = b0; y < b1 && !content; y++) {
      const bi = (y * before.width + x) * 4;
      content = differs(after.data, (below * after.width + x) * 4, before.data, bi) && differs(after.data, (above * after.width + x) * 4, before.data, bi);
    }
    if (content) for (let y = top; y < top + 2; y++) paint(y * width + x);
  }
}

// Whether Before's row b and After's row a hold the same pixels in [x0, x1), short of the edge margins.
function rowsMatch(before: Pixels, after: Pixels, x0: number, x1: number) {
  const margin = Math.min(EDGE_MARGIN, Math.floor((x1 - x0) * EDGE_SHARE));
  const hb = rowHashes(before, x0 + margin, x1 - margin), ha = rowHashes(after, x0 + margin, x1 - margin);
  return (b: number, a: number) => hb[b] === ha[a];
}

// FNV-1a of each row's RGB in [x0, x1): equal rows, equal hashes.
function rowHashes({ data, width, height }: Pixels, x0: number, x1: number) {
  const hashes = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let h = 0x811c9dc5;
    for (let i = (y * width + x0) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
      h = Math.imul(h ^ data[i], 16777619); h = Math.imul(h ^ data[i + 1], 16777619); h = Math.imul(h ^ data[i + 2], 16777619);
    }
    hashes[y] = h;
  }
  return hashes;
}

// The band's most frequent colour, sampled: the page behind rows inserted into an otherwise empty band.
function commonColour({ data, width, height }: Pixels, x0: number, x1: number) {
  const counts = new Map<number, number>();
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * height) / 20000)));
  let best = 0, bestCount = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4, key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > bestCount) { bestCount = count; best = key; }
    }
  }
  return new Uint8ClampedArray([best >> 16, (best >> 8) & 255, best & 255, 255]);
}

// The longest run of rows both share, in order, as [beforeRow, afterRow] pairs; null past `maxEdits`.
// Rows that end both images alike are matched first, as text diffs do: replacing ten rows in place and
// deleting ten then adding ten at the bottom cost the same, and only the first is what happened when
// the rows below are the same blank page.
export function matchRows(n: number, m: number, same: (b: number, a: number) => boolean, maxEdits = MAX_ROW_EDITS): [number, number][] | null {
  let tail = 0;
  while (tail < n && tail < m && same(n - 1 - tail, m - 1 - tail)) tail++;
  const pairs = myers(n - tail, m - tail, same, maxEdits);
  if (!pairs) return null;
  for (let i = tail; i > 0; i--) pairs.push([n - i, m - i]);
  return pairs;
}

// Myers' diff. Each step's furthest reaches are kept so the path can be walked back.
function myers(n: number, m: number, same: (b: number, a: number) => boolean, maxEdits: number): [number, number][] | null {
  if (n === 0 || m === 0) return [];
  const offset = maxEdits + 1;
  let v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxEdits; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(x, y)) { x++; y++; }
      next[offset + k] = x;
      if (x >= n && y >= m) return walkBack(trace, d, k, x);
    }
    v = next;
  }
  return null;
}

function walkBack(trace: Int32Array[], d: number, k: number, x: number) {
  const pairs: [number, number][] = [];
  let y = x - k;
  for (; d > 0; d--) {
    const v = trace[d], at = (kk: number) => v[kk + d + 1];
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1, prevX = at(prevK), prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    while (x > startX) { x--; y--; pairs.push([x, y]); }
    x = prevX; y = prevY; k = prevK;
  }
  while (x > 0 && y > 0) { x--; y--; pairs.push([x, y]); }
  return pairs.reverse();
}

// ---------- Regions ----------

// What a reviewer calls one change (a reworded label, a moved button) is often several blobs of pixels a
// few apart, so changed pixels are pooled into 8px cells and cells up to 2 apart join one region.
const CELL = 8, REACH = 2, MAX_REGIONS = 99;

type Box = { x0: number; y0: number; x1: number; y1: number };

// A place whose strongest pixel is this faint is anti-aliasing that came out a shade different (an icon
// redrawn a fraction of a pixel lower); Diff barely tints it, so it isn't a change to step to.
const FAINT = 0.25;

function visibleRegions(removed: Float32Array, added: Float32Array, width: number, height: number): Region[] {
  const peak = ({ x0, y0, x1, y1 }: Box) => {
    let max = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) max = Math.max(max, removed[y * width + x], added[y * width + x]);
    return max;
  };
  return findRegions(removed, added, width, height).filter((box) => peak(box) >= FAINT).map((box) => toRegion(box, width, height));
}

const toRegion = ({ x0, y0, x1, y1 }: Box, width: number, height: number): Region => ({ x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height });

function findRegions(removed: Float32Array, added: Float32Array, width: number, height: number): Box[] {
  const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
  const hit = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (removed[i] > 0 || added[i] > 0) hit[((y / CELL) | 0) * cols + ((x / CELL) | 0)] = 1;
    }
  }
  // Cells only decide what belongs together; the box is drawn round the changed pixels themselves, or its
  // edges would stick out by however far the change sits from the 8px grid (up to 28px on screen at 4x).
  const tighten = (bx0: number, by0: number, bx1: number, by1: number): Box => {
    let x0 = bx1, y0 = by1, x1 = bx0, y1 = by0;
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const i = y * width + x;
        if (removed[i] > 0 || added[i] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
      }
    }
    return { x0, y0, x1, y1 };
  };
  const seen = new Uint8Array(cols * rows);
  const boxes: Box[] = [];
  // Row-major scan, so each region is found from its top edge and the list comes out top to bottom.
  for (let start = 0; start < hit.length && boxes.length < MAX_REGIONS; start++) {
    if (!hit[start] || seen[start]) continue;
    let left = cols, right = 0, top = rows, bottom = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const cell = stack.pop()!, col = cell % cols, row = (cell / cols) | 0;
      left = Math.min(left, col); right = Math.max(right, col); top = Math.min(top, row); bottom = Math.max(bottom, row);
      for (let r = Math.max(0, row - REACH); r <= Math.min(rows - 1, row + REACH); r++) {
        for (let c = Math.max(0, col - REACH); c <= Math.min(cols - 1, col + REACH); c++) {
          const next = r * cols + c;
          if (hit[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
        }
      }
    }
    boxes.push(tighten(left * CELL, top * CELL, Math.min(width, (right + 1) * CELL), Math.min(height, (bottom + 1) * CELL)));
  }
  return boxes;
}
