// What the diff reports when content moves, in Node. Methodology: small synthetic screenshots drawn as
// coloured rectangles stand in for the layouts that broke the old pixel-for-pixel diff (a banner above a
// viewport capture, an item added to a dropdown, a block removed from a full-page capture). Each test
// draws Before, derives After by the edit a real page would make, and checks the places reported against
// the rectangle that was really added or removed: nothing that merely moved may show up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lineUpChanges, matchRows, type Pixels, type Region } from "../src/changes.ts";

type Rect = [x: number, y: number, w: number, h: number, colour: number];

const PAGE = 0xf4f4f4, WHITE = 0xffffff, INK = 0x202020, BORDER = 0xd0d0d0, ORANGE = 0xffe0a0;

test("a banner above a viewport capture is the only change, not everything it pushed down", () => {
  const content: Rect[] = [[10, 10, 60, 8, INK], [120, 12, 40, 6, INK], [10, 40, 180, 50, WHITE], [20, 50, 90, 10, INK], [20, 70, 50, 10, INK]];
  const before = draw(200, 120, PAGE, content);
  const after = draw(200, 120, PAGE, [[0, 0, 200, 20, ORANGE], [80, 6, 30, 8, INK], ...shift(content, 20)]);
  const { stats } = lineUpChanges(before, after);
  assert.equal(stats.moved, true);
  assert.deepEqual(pixelBoxes(stats.regions, 200, 120), [[0, 0, 200, 20]]);
  assert.equal(stats.changed, 200 * 20, "rows pushed past the window's bottom edge aren't counted as removed");
});

test("an item added to a menu is the only change, not the items below it or the page beside it", () => {
  const page: Rect[] = [[10, 10, 100, 10, INK], [10, 40, 120, 30, 0x5060e0], [10, 100, 80, 10, INK], [10, 150, 110, 20, 0x8080f0]];
  const menu = (items: Rect[], height: number): Rect[] => [[180, 20, 100, height, BORDER], [181, 21, 98, height - 2, WHITE], ...items];
  const items: Rect[] = [[190, 30, 60, 8, INK], [190, 50, 80, 8, INK], [190, 70, 40, 8, INK]];
  const before = draw(300, 200, PAGE, [...page, ...menu(items, 70)]);
  const added: Rect = [190, 50, 70, 8, 0x2a2a90];
  const after = draw(300, 200, PAGE, [...page, ...menu([items[0], added, ...shift(items.slice(1), 20)], 90)]);
  const { stats } = lineUpChanges(before, after);
  assert.equal(stats.moved, true);
  assert.deepEqual(pixelBoxes(stats.regions, 300, 200), [[190, 50, 70, 8]]);
});

test("a block removed from a full-page capture is a rule in the middle of the gap it left, and the rest closes up unmarked", () => {
  const above: Rect[] = [[10, 10, 80, 10, INK], [10, 40, 60, 10, INK]];
  const below: Rect[] = [[10, 120, 70, 10, INK], [10, 160, 90, 10, INK]];
  const before = draw(120, 200, PAGE, [...above, [20, 80, 50, 20, 0x3050d0], ...below]);
  const after = draw(120, 170, PAGE, [...above, ...shift(below, -30)]);
  const { stats } = lineUpChanges(before, after);
  assert.equal(stats.moved, true);
  assert.deepEqual(pixelBoxes(stats.regions, 120, 200), [[20, 74, 50, 2]]);
});

test("a change at the edge of a row that otherwise matches still shows", () => {
  const content: Rect[] = [[10, 10, 60, 8, INK], [10, 40, 180, 50, WHITE], [20, 50, 90, 10, INK], [20, 70, 50, 10, INK]];
  const before = draw(200, 120, PAGE, [...content, [192, 52, 6, 8, INK]]);
  const after = draw(200, 120, PAGE, [[0, 0, 200, 20, ORANGE], ...shift(content, 20), [192, 72, 6, 8, 0xd02020]]);
  const { stats } = lineUpChanges(before, after);
  assert.deepEqual(pixelBoxes(stats.regions, 200, 120), [[0, 0, 200, 20], [192, 72, 6, 8]]);
});

test("an edit in place is compared as placed", () => {
  const before = draw(100, 60, PAGE, [[10, 10, 50, 10, INK]]);
  const after = draw(100, 60, PAGE, [[10, 10, 30, 10, INK]]);
  const { stats } = lineUpChanges(before, after);
  assert.equal(stats.moved, false);
  assert.deepEqual(pixelBoxes(stats.regions, 100, 60), [[40, 10, 20, 10]]);
});

test("a shade of difference is counted but isn't a place to step to", () => {
  const before = draw(100, 60, PAGE, [[10, 10, 50, 10, INK], [70, 40, 20, 10, 0x808080]]);
  const after = draw(100, 60, PAGE, [[10, 10, 30, 10, INK], [70, 40, 20, 10, 0x828282]]);
  const { stats } = lineUpChanges(before, after);
  assert.equal(stats.changed, 20 * 10 + 20 * 10);
  assert.deepEqual(pixelBoxes(stats.regions, 100, 60), [[40, 10, 20, 10]]);
});

test("matchRows pairs the rows both share, in order", () => {
  const a = [1, 2, 3, 4, 5], b = [9, 1, 2, 4, 5, 6];
  assert.deepEqual(matchRows(a.length, b.length, (i, j) => a[i] === b[j]), [[0, 1], [1, 2], [3, 3], [4, 4]]);
  assert.equal(matchRows(a.length, b.length, () => false, 3), null, "gives up past the edit limit");
});

function draw(width: number, height: number, background: number, rects: Rect[]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  const fill = (x0: number, y0: number, w: number, h: number, colour: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) data.set([colour >> 16, (colour >> 8) & 255, colour & 255, 255], (y * width + x) * 4);
    }
  };
  fill(0, 0, width, height, background);
  for (const [x, y, w, h, colour] of rects) fill(x, y, w, h, colour);
  return { data, width, height };
}

const shift = (rects: Rect[], dy: number): Rect[] => rects.map(([x, y, w, h, c]) => [x, y + dy, w, h, c]);

// Regions come back as fractions of the canvas; back to pixels, as [x, y, w, h].
const pixelBoxes = (regions: Region[], width: number, height: number) =>
  regions.map(({ x, y, w, h }) => [Math.round(x * width), Math.round(y * height), Math.round(w * width), Math.round(h * height)]);
