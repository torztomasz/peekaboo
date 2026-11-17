// Auto-align and the worker's diff, on synthetic screenshots, in Node. Methodology: images are built from
// rectangles of known grey levels, so where a crop sits and which pixels changed is known exactly. Tiles
// of random shades stand in for a full-page capture (distinctive everywhere, even shrunk); rows of
// word-sized bars stand in for text, which looks alike everywhere once shrunk. Expected placements,
// counts and overlay colours are worked out by hand, never by the code under test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anyChange, densityOverlay, diffOverlay, findPlacement, isDark, type Image } from "../src/pixels.ts";

const at = (x: number, y: number) => ({ beforeX: 0, beforeY: 0, afterX: x, afterY: y });
const placed = (before: Image, after: Image) => findPlacement(before, after).placement;

test("places a crop taken below row 4000 of a tall capture", () => {
  const page = tiles(1200, 7000);
  assert.deepEqual(placed(page, crop(page, 300, 5500, 600, 900)), at(300, 5500));
});

test("places a same-width viewport at the bottom of a tall capture", () => {
  const page = tiles(1200, 7000);
  assert.deepEqual(placed(page, crop(page, 0, 5600, 1200, 1400)), at(0, 5600));
});

test("places a template taller than the full-size row cap", () => {
  const page = tiles(1200, 9000);
  assert.deepEqual(placed(page, crop(page, 0, 3800, 1200, 5000)), at(0, 3800));
});

test("places a crop near the top", () => {
  const page = tiles(640, 900);
  assert.deepEqual(placed(page, crop(page, 160, 560, 480, 320)), at(160, 560));
});

// Every edge on an even row and column, as in a 2x retina capture: matching on every other pixel can't
// tell an odd offset from the one before it, which drew a 1px "change" along every edge.
test("places a crop at an odd offset when every edge falls on an even pixel", () => {
  const page = tiles(1200, 7000);
  assert.deepEqual(placed(page, crop(page, 301, 5501, 600, 900)), at(301, 5501));
});

test("places a small detail inside a text-heavy screen, either way round", () => {
  const screen = text(2560, 1600);
  const detail = crop(screen, 913, 517, 600, 400);
  assert.deepEqual(placed(screen, detail), at(913, 517));
  assert.deepEqual(placed(detail, screen), { beforeX: 913, beforeY: 517, afterX: 0, afterY: 0 });
});

// Shrunk for the coarse pass, a text crop on a grid offset from the screen's ranks low unless both
// shrunk copies are blurred.
test("places a text crop whose shrunk grid is offset from the screen's", () => {
  const screen = text(2560, 1600);
  assert.deepEqual(placed(screen, crop(screen, 443, 135, 400, 250)), at(443, 135));
});

// Too thin to blur and drop a border from once shrunk, so these take the plain search.
test("places crops one and two pixels thin", () => {
  const page = noise(640, 480);
  assert.deepEqual(placed(page, crop(page, 301, 100, 1, 200)), at(301, 100));
  assert.deepEqual(placed(page, crop(page, 100, 301, 200, 2)), at(100, 301));
});

// Blurred, every stretch of alternating rows looks alike, and the top one is close enough (error 4) to
// pass for the crop; only the plain copies tell 0/254 rows from 4/250 ones.
test("places a crop of fine stripes that the blur makes look like other stripes", () => {
  const page = blank(160, 240);
  for (let y = 0; y < 240; y++) {
    const shade = y >= 120 && y < 200 ? (y % 2 ? 254 : 0) : y % 2 ? 250 : 4;
    fill(page, 0, y, 160, 1, [shade, shade, shade]);
  }
  assert.deepEqual(findPlacement(page, crop(page, 0, 120, 160, 80)), { placement: at(0, 120), exact: true });
});

// Two places fit equally well (mean error 4): at row 900 twenty rows differ a lot, at row 100 every row
// differs a little. The blurred search picks row 900, as main did; the plain search only ties it there.
test("keeps the blurred search's placement when the plain search only ties it", () => {
  const page = solid(400, 1600, [0, 0, 0]), part = blank(400, 300);
  for (let r = 0; r < 300; r++) {
    const shade = 60 + ((r * 7) % 120), lit = r < 20 ? 60 : 0;
    fill(part, 0, r, 400, 1, [shade, shade, shade]);
    fill(page, 0, 100 + r, 400, 1, [shade + 4, shade + 4, shade + 4]);
    fill(page, 0, 900 + r, 400, 1, [shade + lit, shade + lit, shade + lit]);
  }
  assert.deepEqual(placed(page, part), at(0, 900));
});

// Every other row matches, so a sample of every other row would call it a perfect crop.
test("doesn't call a crop exact when only the sampled rows match", () => {
  const page = solid(1000, 1000, [255, 255, 255]), stripes = solid(400, 400, [255, 255, 255]);
  for (let y = 1; y < 400; y += 2) fill(stripes, 0, y, 400, 1, [0, 0, 0]);
  assert.equal(findPlacement(page, stripes).exact, false);
});

test("slides the narrower of two window widths to where the page matches, and calls only a crop exact", () => {
  const wide = text(1600, 1200, 250), narrow = text(1200, 1200, 50);
  assert.deepEqual(findPlacement(wide, narrow), { placement: at(200, 0), exact: false });
  const page = tiles(640, 900);
  assert.equal(findPlacement(page, crop(page, 160, 560, 480, 320)).exact, true);
});

// A pixel counts when its channels moved by more than 2 in total (anti-aliasing noise) in either direction.
test("counts pixels whose channels moved by more than the noise threshold, and says whether any did", () => {
  const before = solid(4, 3, [100, 100, 100]);
  const after = solid(4, 3, [100, 100, 100]);
  paint(after, 0, 0, [101, 101, 100]); // +2 in total: noise
  paint(after, 1, 0, [101, 101, 101]); // +3: changed
  paint(after, 2, 1, [90, 100, 100]); // −10: changed
  paint(after, 3, 2, [110, 90, 100]); // +10 and −10: changed once
  assert.equal(diffOverlay(before, after, at(0, 0)).changed, 3);
  assert.equal(anyChange(before, after), true);
  const noise = solid(4, 3, [100, 100, 100]);
  paint(noise, 2, 2, [101, 101, 100]);
  assert.equal(anyChange(before, noise), false);
  assert.equal(anyChange(before, before), false);
});

test("counts only the overlap of a placed pair", () => {
  const wide = solid(10, 4, [0, 0, 0]), narrow = solid(6, 4, [255, 255, 255]);
  assert.equal(diffOverlay(wide, narrow, at(3, 1)).changed, 18);
});

// Red where Before was darker (After lighter), green where After is darker; opacity 0.8 × clamp(6d/255 − 0.06)
// for a total channel difference d, dilated 1px. Full strength from d = 46: alpha round(0.8 × 255) = 204.
test("draws each change in its direction's colour, dilated 1px, only inside the changed box", () => {
  const before = solid(20, 10, [128, 128, 128]), after = solid(20, 10, [128, 128, 128]);
  paint(after, 5, 4, [200, 200, 200]);
  paint(after, 12, 4, [128, 128, 118]); // d = 10: alpha round(0.8 × 255 × (60/255 − 0.06)) = 36
  const overlay = diffOverlay(before, after, at(0, 0));
  assert.deepEqual([overlay.width, overlay.height, overlay.changed], [20, 10, 2]);
  assert.deepEqual(overlay.box, { x: 4, y: 3, width: 10, height: 3 });
  const pixel = (x: number, y: number) => {
    const i = ((y - overlay.box.y) * overlay.box.width + x - overlay.box.x) * 4;
    return Array.from(overlay.data.subarray(i, i + 4));
  };
  for (const [x, y] of [[4, 3], [5, 4], [6, 5]]) assert.deepEqual(pixel(x, y), [219, 36, 46, 204]);
  for (const [x, y] of [[11, 3], [12, 4], [13, 5]]) assert.deepEqual(pixel(x, y), [26, 184, 77, 36]);
  assert.deepEqual(pixel(8, 4), [0, 0, 0, 0]);
});

// On a dark theme content is the light part, so a pixel that turns light in After is content added: green.
test("swaps the colours on mostly dark screenshots, so green still means added", () => {
  const before = solid(20, 10, [20, 20, 20]), after = solid(20, 10, [20, 20, 20]);
  paint(after, 5, 4, [200, 200, 200]);
  assert.equal(isDark(before, after), true);
  assert.equal(isDark(solid(20, 10, [240, 240, 240]), solid(20, 10, [240, 240, 240])), false);
  const overlay = diffOverlay(before, after, at(0, 0), true);
  const i = ((4 - overlay.box.y) * overlay.box.width + 5 - overlay.box.x) * 4;
  assert.deepEqual(Array.from(overlay.data.subarray(i, i + 4)), [26, 184, 77, 204]);
});

test("an unchanged pair has an empty overlay", () => {
  const page = tiles(300, 200);
  assert.deepEqual(diffOverlay(page, page, at(0, 0)).box, { x: 0, y: 0, width: 0, height: 0 });
});

// A retina capture scaled down to 1x has half-dark pixels wherever an edge fell between two 1x pixels.
// Here every bar of the 2x capture sits one device pixel lower, so every bar edge is half-dark once
// box-averaged down, as resampling makes it; only the green button really changed.
test("at two pixel densities, reports the real change and not the resampled edges", () => {
  const bars = (image: Image, scale: number, shift: number) => {
    for (let y = 10; y < 90; y += 12) fill(image, 10 * scale, y * scale + shift, 160 * scale, 5 * scale, [31, 35, 40]);
  };
  const before = solid(200, 100, [255, 255, 255]);
  bars(before, 1, 0);
  const retina = solid(400, 200, [255, 255, 255]);
  bars(retina, 2, 1);
  fill(retina, 360, 20, 30, 20, [26, 127, 55]);
  const after = halve(retina);
  // The diff lights up only around the button (dilated 1px), not along the bars.
  const { box, changed } = densityOverlay(before, after);
  assert.ok(box.x >= 179 && box.x + box.width <= 196 && box.y >= 9 && box.y + box.height <= 21, JSON.stringify(box));
  // Control: the same-size rule marks every shifted bar edge too (7 bars, 2 edges, 160px each), so the
  // fixture does exercise the tolerance.
  const strict = diffOverlay(before, after, at(0, 0)).changed;
  assert.ok(strict > 2000 && changed < 500, `${strict} vs ${changed}`);
});

// ---------- Synthetic screenshots ----------

function blank(width: number, height: number): Image {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function fill(image: Image, left: number, top: number, width: number, height: number, [r, g, b]: number[]) {
  for (let y = top; y < Math.min(image.height, top + height); y++) {
    for (let x = left; x < Math.min(image.width, left + width); x++) image.data.set([r, g, b, 255], (y * image.width + x) * 4);
  }
}

const solid = (width: number, height: number, color: number[]) => {
  const image = blank(width, height);
  fill(image, 0, 0, width, height, color);
  return image;
};
const paint = (image: Image, x: number, y: number, color: number[]) => fill(image, x, y, 1, 1, color);

function random(seed: number) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

function tiles(width: number, height: number, tile = 24): Image {
  const image = blank(width, height), next = random(1);
  for (let y = 0; y < height; y += tile) for (let x = 0; x < width; x += tile) { const shade = Math.floor(next() * 256); fill(image, x, y, tile, tile, [shade, shade, shade]); }
  return image;
}

// A page of text: a dark header, then lines of word-sized bars in a column starting at `columnX`, the same
// words whatever the window width, and a sidebar pinned to the window's right edge, so two widths of the
// page differ beyond a crop, like one page captured in two window sizes.
function text(width: number, height: number, columnX = 0): Image {
  const image = solid(width, height, [255, 255, 255]), next = random(7);
  fill(image, 0, 0, width, 64, [36, 41, 47]);
  for (let y = 96; y < height - 40; y += 22) {
    for (let x = columnX + 20; x < columnX + 1000; ) {
      const word = 20 + Math.floor(next() * 70);
      fill(image, x, y, word, 10, [31, 35, 40]);
      x += word + 8;
    }
  }
  fill(image, width - 280, 64, 260, height - 64, [234, 238, 242]);
  return image;
}

// Every pixel its own grey, so even a one-pixel crop fits in exactly one place.
function noise(width: number, height: number): Image {
  const image = blank(width, height), next = random(9);
  for (let i = 0; i < width * height; i++) { const v = Math.floor(next() * 256); image.data.set([v, v, v, 255], i * 4); }
  return image;
}

function crop(image: Image, left: number, top: number, width: number, height: number): Image {
  const out = blank(width, height);
  for (let y = 0; y < height; y++) out.data.set(image.data.subarray(((top + y) * image.width + left) * 4, ((top + y) * image.width + left + width) * 4), y * width * 4);
  return out;
}

// 2x2 box average: a retina capture scaled down to 1x.
function halve(image: Image): Image {
  const out = blank(image.width / 2, image.height / 2);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) sum += image.data[((2 * y + dy) * image.width + 2 * x + dx) * 4 + c];
        out.data[(y * out.width + x) * 4 + c] = Math.round(sum / 4);
      }
    }
  }
  return out;
}
