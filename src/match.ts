// Template matching on grayscale pixels, apart from the worker's canvas code so Node can test it.

export type Gray = { data: Float32Array; width: number; height: number };
type Size = { width: number; height: number };
// Grayscale copy of source rows [top, bottom), shrunk by `scale`.
type ToGray<T> = (image: T, scale: number, top: number, bottom: number) => Gray;

// Full-size grayscale copies stop here, for speed and memory; a taller template still matches on these rows.
export const FULL_SIZE_ROWS = 4000;

// Template match of `inner` inside `outer`: every position on a shrunk copy, then exact around the best.
// Every search range comes from the grayscale copies' own sizes, so `match` never reads past their ends.
export function locate<T extends Size>(outer: T, inner: T, gray: ToGray<T>) {
  let scale = Math.min(1, 240 / Math.max(outer.width, outer.height));
  scale = Math.min(1, Math.max(scale, 24 / Math.min(inner.width, inner.height)));
  // Pass 1: whole images, so a crop from anywhere down a tall capture can be found.
  const o = gray(outer, scale, 0, outer.height), i = gray(inner, scale, 0, inner.height);
  const coarse = match(o, i, 0, o.width - i.width, 0, o.height - i.height, 1);
  // Pass 2: full size, but only the band of rows the coarse hit could be off by.
  const step = Math.ceil(1 / scale) + 1;
  const xMax = outer.width - inner.width, yMax = outer.height - inner.height;
  const cx = Math.min(xMax, Math.round(coarse.x / scale)), cy = Math.min(yMax, Math.round(coarse.y / scale));
  const template = gray(inner, 1, 0, Math.min(inner.height, FULL_SIZE_ROWS));
  const top = Math.max(0, cy - step), last = Math.min(yMax, cy + step);
  const band = gray(outer, 1, top, last + template.height);
  const exact = match(band, template, Math.max(0, cx - step), Math.min(band.width - template.width, cx + step), 0, band.height - template.height, 1);
  return { ...exact, y: exact.y + top };
}

// Smallest mean absolute difference over positions [x0..x1] x [y0..y1]; abandons a position once it can't win.
export function match(outer: Gray, inner: Gray, x0: number, x1: number, y0: number, y1: number, stride: number) {
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
