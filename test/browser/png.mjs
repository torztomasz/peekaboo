// Screenshots as exact pixels, both ways: fixtures are drawn rectangle by rectangle and encoded to PNG, so
// a test knows the colour of every pixel it gives the extension; what Chromium then paints is decoded
// back, so a test can ask what colour is on screen at a point. Why not SVG fixtures: the worker decodes
// with createImageBitmap, which doesn't take SVG. Only the 8-bit RGB(A), non-interlaced PNGs that this
// file and Chromium's screenshots produce are handled.
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// `shapes` are [x, y, width, height, [r, g, b]] rectangles painted in order over `background`.
export const picture = (...args) => `data:image/png;base64,${draw(...args).toString("base64")}`;

export function draw(width, height, background = [255, 255, 255], shapes = []) {
  const rgba = Buffer.alloc(width * height * 4);
  const fill = (left, top, w, h, [r, g, b]) => {
    for (let y = Math.max(0, top); y < Math.min(height, top + h); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, left + w); x++) rgba.set([r, g, b, 255], (y * width + x) * 4);
    }
  };
  fill(0, 0, width, height, background);
  for (const [x, y, w, h, color] of shapes) fill(x, y, w, h, color);
  return encode(width, height, rgba);
}

export function encode(width, height, rgba) {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// What a screenshot shows: `at(x, y)` is that pixel's [r, g, b].
export function decode(png) {
  let width = 0, height = 0, channels = 0;
  const data = [];
  for (let offset = SIGNATURE.length; offset < png.length; ) {
    const length = png.readUInt32BE(offset), type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[body[9]];
      if (body[8] !== 8 || !channels || body[12]) throw new Error("only 8-bit RGB(A), non-interlaced PNGs");
    }
    if (type === "IDAT") data.push(body);
    offset += length + 12;
  }
  const pixels = unfilter(inflateSync(Buffer.concat(data)), width, height, channels);
  return {
    width,
    height,
    at: (x, y) => Array.from(pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3)),
  };
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = y * stride, source = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[line + i - bpp] : 0, up = y ? out[line - stride + i] : 0, upLeft = y && i >= bpp ? out[line - stride + i - bpp] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      out[line + i] = (raw[source + i] + predicted) & 255;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
