// Auto-align's crop finder on synthetic screenshots, in Node. Methodology: a tall image of random 24px
// tiles (distinctive everywhere, and still distinctive once shrunk) stands in for a full-page capture;
// crops cut from it at known spots must be found exactly. `toGray` box-averages like the worker's canvas
// downscale, and returns only the rows asked for, as the worker does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { locate, type Gray } from "../src/match.ts";

type Image = { width: number; height: number; pixels: Float32Array };

test("finds a crop taken below row 4000 of a tall capture", () => {
  const page = tiles(1200, 7000);
  assert.deepEqual(find(page, crop(page, 300, 5500, 600, 900)), { x: 300, y: 5500, error: 0 });
});

test("finds a same-width viewport at the bottom of a tall capture", () => {
  const page = tiles(1200, 7000);
  assert.deepEqual(find(page, crop(page, 0, 7000 - 1400, 1200, 1400)), { x: 0, y: 5600, error: 0 });
});

test("finds a template taller than the full-size row cap", () => {
  const page = tiles(1200, 9000);
  assert.deepEqual(find(page, crop(page, 0, 3800, 1200, 5000)), { x: 0, y: 3800, error: 0 });
});

test("still finds a crop near the top", () => {
  const page = tiles(640, 900);
  assert.deepEqual(find(page, crop(page, 160, 560, 480, 320)), { x: 160, y: 560, error: 0 });
});

function find(outer: Image, inner: Image) {
  return locate(outer, inner, toGray);
}

function tiles(width: number, height: number, tile = 24): Image {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const columns = Math.ceil(width / tile), shades = Array.from({ length: columns * Math.ceil(height / tile) }, () => Math.floor(random() * 256));
  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = shades[Math.floor(y / tile) * columns + Math.floor(x / tile)];
  return { width, height, pixels };
}

function crop(image: Image, left: number, top: number, width: number, height: number): Image {
  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y++) pixels.set(image.pixels.subarray((top + y) * image.width + left, (top + y) * image.width + left + width), y * width);
  return { width, height, pixels };
}

function toGray(image: Image, scale: number, top: number, bottom: number): Gray {
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round((bottom - top) * scale));
  const data = new Float32Array(width * height);
  for (let gy = 0; gy < height; gy++) {
    const y0 = top + Math.floor((gy * (bottom - top)) / height), y1 = top + Math.floor(((gy + 1) * (bottom - top)) / height);
    for (let gx = 0; gx < width; gx++) {
      const x0 = Math.floor((gx * image.width) / width), x1 = Math.floor(((gx + 1) * image.width) / width);
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += image.pixels[y * image.width + x];
      data[gy * width + gx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { data, width, height };
}
