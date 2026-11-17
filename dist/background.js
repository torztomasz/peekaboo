(() => {
  // src/origins.ts
  var IMAGE_ORIGINS = ["https://private-user-images.githubusercontent.com/*", "https://user-images.githubusercontent.com/*"];

  // src/pixels.ts
  var CONTAINED_MAX_ERROR = 6;
  function findPlacement(before, after) {
    const fits = (outer, inner) => outer.width >= inner.width && outer.height >= inner.height;
    if (fits(before, after) || fits(after, before)) {
      const beforeOutside = fits(before, after);
      const found = locate(beforeOutside ? before : after, beforeOutside ? after : before);
      if (found.error <= CONTAINED_MAX_ERROR) {
        const placement2 = beforeOutside ? { beforeX: 0, beforeY: 0, afterX: found.x, afterY: found.y } : { beforeX: found.x, beforeY: found.y, afterX: 0, afterY: 0 };
        return { placement: placement2, exact: true };
      }
    }
    const beforeIsWide = before.width >= after.width;
    const dx = slideSideways(beforeIsWide ? before : after, beforeIsWide ? after : before);
    const placement = beforeIsWide ? { beforeX: 0, beforeY: 0, afterX: dx, afterY: 0 } : { beforeX: dx, beforeY: 0, afterX: 0, afterY: 0 };
    return { placement, exact: false };
  }
  var FULL_SIZE_ROWS = 4e3;
  var lumaAt = (d, p) => d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29;
  function grayRows({ data, width }, top, bottom) {
    const out = new Uint8Array(width * (bottom - top));
    for (let i = 0, p = top * width * 4; i < out.length; i++, p += 4) out[i] = lumaAt(data, p) >> 8;
    return { data: out, width, height: bottom - top };
  }
  function shrink(image, scale, top, bottom) {
    if (scale >= 1) return { ...grayRows(image, top, bottom), stepX: 1, stepY: 1 };
    const { data, width: sourceWidth } = image, sourceHeight = bottom - top;
    const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
    const stepX = sourceWidth / width, stepY = sourceHeight / height;
    const column = new Int32Array(sourceWidth), columnCount = new Float64Array(width);
    for (let x = 0; x < sourceWidth; x++) columnCount[column[x] = Math.min(width - 1, Math.floor(x / stepX))]++;
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
  function blur(g) {
    const { width: w, height: h, data } = g, rows = new Uint16Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) rows[r + x] = data[r + Math.max(0, x - 1)] + 2 * data[r + x] + data[r + Math.min(w - 1, x + 1)];
    }
    for (let y = 0; y < h; y++) {
      const up = Math.max(0, y - 1) * w, here = y * w, down = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) out[here + x] = rows[up + x] + 2 * rows[here + x] + rows[down + x] + 8 >> 4;
    }
    return { ...g, data: out };
  }
  function interior(g) {
    const width = g.width - 2, height = g.height - 2, out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) out.set(g.data.subarray((y + 1) * g.width + 1, (y + 1) * g.width + 1 + width), y * width);
    return { ...g, data: out, width, height };
  }
  var COARSE_CANDIDATES = 8;
  function locate(outer, inner) {
    const scale = Math.min(1, Math.max(240 / Math.max(outer.width, outer.height), 24 / Math.min(inner.width, inner.height)));
    const o = shrink(outer, scale, 0, outer.height), i = shrink(inner, scale, 0, inner.height);
    const blurred = i.width >= 3 && i.height >= 3 ? search(outer, inner, blur(o), interior(blur(i)), 1) : null;
    if (blurred?.error === 0) return blurred;
    const plain = search(outer, inner, o, i, 0);
    return blurred && blurred.error <= plain.error ? blurred : plain;
  }
  function search(outer, inner, o, i, border) {
    const candidates = bestMatches(o, i, 0, o.width - i.width, 0, o.height - i.height, COARSE_CANDIDATES);
    const xMax = outer.width - inner.width, yMax = outer.height - inner.height;
    const sx = 2 * Math.ceil(o.stepX) + 1, sy = 2 * Math.ceil(o.stepY) + 1;
    const template = grayRows(inner, 0, Math.min(inner.height, FULL_SIZE_ROWS));
    let best = { x: 0, y: 0, error: Infinity }, bestBand = null, bestTop = 0;
    for (const coarse of candidates) {
      const cx = Math.min(xMax, Math.max(0, Math.round((coarse.x - border) * o.stepX))), cy = Math.min(yMax, Math.max(0, Math.round((coarse.y - border) * o.stepY)));
      const top = Math.max(0, cy - sy), last = Math.min(yMax, cy + sy);
      const band = grayRows(outer, top, last + template.height);
      const exact = bestMatches(band, template, Math.max(0, cx - sx), Math.min(band.width - template.width, cx + sx), 0, band.height - template.height, 1, { x: cx, y: cy - top }, best.error)[0];
      if (exact && exact.error < best.error) {
        best = exact;
        bestBand = band;
        bestTop = top;
      }
    }
    if (!bestBand) return best;
    const [rowStep, colStep] = sampleSteps(template);
    const dense = bestMatches(
      bestBand,
      template,
      Math.max(0, best.x - colStep + 1),
      Math.min(bestBand.width - template.width, best.x + colStep - 1),
      Math.max(0, best.y - rowStep + 1),
      Math.min(bestBand.height - template.height, best.y + rowStep - 1),
      1,
      best,
      Infinity,
      true
    )[0];
    return { x: dense.x, y: dense.y + bestTop, error: dense.error };
  }
  var sampleSteps = (inner) => [Math.max(1, Math.floor(inner.height / 200)), Math.max(1, Math.floor(inner.width / 300))];
  function bestMatches(outer, inner, x0, x1, y0, y1, count, seed, beat = Infinity, everyPixel = false) {
    const [rowStep, colStep] = everyPixel ? [1, 1] : sampleSteps(inner);
    const samples = Math.ceil(inner.height / rowStep) * Math.ceil(inner.width / colStep);
    const od = outer.data, id = inner.data, ow = outer.width, iw = inner.width, ih = inner.height;
    const sumAt = (ox, oy, limit) => {
      let sum = 0;
      for (let y = 0; y < ih && sum < limit; y += rowStep) {
        const orow = (oy + y) * ow + ox, irow = y * iw;
        for (let x = 0; x < iw; x += colStep) sum += Math.abs(od[orow + x] - id[irow + x]);
      }
      return sum;
    };
    const hits = [];
    const worst = () => hits.length < count ? beat : hits[hits.length - 1].error;
    const consider = (x, y) => {
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
    const seeded = seed !== void 0 && seed.x >= x0 && seed.x <= x1 && seed.y >= y0 && seed.y <= y1;
    if (seeded) consider(seed.x, seed.y);
    for (let oy = y0; oy <= y1; oy++) {
      for (let ox = x0; ox <= x1; ox++) if (!(seeded && ox === seed.x && oy === seed.y)) consider(ox, oy);
    }
    return hits;
  }
  function slideSideways(wideImage, narrowImage) {
    const wideRows = Math.min(wideImage.height, FULL_SIZE_ROWS), narrowRows = Math.min(narrowImage.height, FULL_SIZE_ROWS);
    const wide = grayRows(wideImage, 0, wideRows), narrow = grayRows(narrowImage, 0, narrowRows);
    const scale = Math.min(1, 400 / wide.width);
    const w = shrink(wideImage, scale, 0, wideRows), n = shrink(narrowImage, scale, 0, narrowRows);
    const overhang = Math.ceil(16 / w.stepX);
    const coarse = Math.round(bestOffset(w, n, -overhang, w.width - n.width + overhang) * w.stepX);
    const step = Math.ceil(w.stepX) + 1;
    return bestOffset(wide, narrow, coarse - step, coarse + step, coarse);
  }
  function bestOffset(wide, narrow, from, to, seed) {
    const rows = Math.min(wide.height, narrow.height);
    const rowStep = Math.max(1, Math.floor(rows / 300));
    const rowCount = Math.ceil(rows / rowStep);
    const wd = wide.data, nd = narrow.data, ww = wide.width, nw = narrow.width;
    const errorAt = (dx, beat) => {
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
    const seeded = seed !== void 0 && seed >= from && seed <= to;
    let best = seeded ? seed : 0, bestError = seeded ? errorAt(seed, Infinity) : Infinity;
    for (let dx = from; dx <= to; dx++) {
      if (seeded && dx === seed) continue;
      const error = errorAt(dx, bestError);
      if (error < bestError) {
        bestError = error;
        best = dx;
      }
    }
    return best;
  }
  var NOISE = 2;
  var SATURATED = 46;
  var level = (difference) => difference <= NOISE ? 0 : difference >= SATURATED ? SATURATED : difference;
  var AS_IS = { beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 };
  function anyChange(before, after) {
    return compareOverlap(before, after, AS_IS, null) > 0;
  }
  var REMOVED = [219, 36, 46];
  var ADDED = [26, 184, 77];
  function isDark(before, after) {
    const mean = ({ data, width, height }) => {
      const step = Math.max(1, Math.floor(width / 200));
      let sum = 0, count = 0;
      for (let y = 0; y < height; y += step) {
        for (let p = y * width * 4; p < (y + 1) * width * 4; p += step * 4, count++) sum += lumaAt(data, p) >> 8;
      }
      return sum / count;
    };
    return (mean(before) + mean(after)) / 2 < 128;
  }
  function diffOverlay(before, after, placement, dark = false) {
    const { width, height } = canvasSize(before, after, placement);
    const levels = { removed: new Uint8Array(width * height), added: new Uint8Array(width * height), bounds: { left: width, right: 0, top: height, bottom: 0 } };
    const changed = compareOverlap(before, after, placement, levels);
    return { width, height, ...dilate(levels, width, height, dark), changed };
  }
  var canvasSize = (before, after, { beforeX, beforeY, afterX, afterY }) => ({ width: Math.max(before.width + beforeX, after.width + afterX), height: Math.max(before.height + beforeY, after.height + afterY) });
  function compareOverlap(before, after, placement, levels) {
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
        const bi = bRow + x << 2, ai = aRow + x << 2;
        let lighterAfter = 0, lighterBefore = 0;
        for (let c = 0; c < 3; c++) {
          const d = a[ai + c] - b[bi + c];
          if (d > 0) lighterAfter += d;
          else lighterBefore -= d;
        }
        const r = level(lighterAfter), g = level(lighterBefore);
        if (r === 0 && g === 0) continue;
        changed++;
        if (!levels) return changed;
        levels.removed[out + x] = r;
        levels.added[out + x] = g;
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
  var EDGE_TOLERANCE = 0.5;
  var SEED_STRENGTH = 0.25;
  var CELL = 8;
  var REACH = 2;
  function densityOverlay(before, after, dark = false) {
    const width = before.width, height = Math.max(before.height, after.height), overlap = Math.min(before.height, after.height);
    const levels = { removed: new Uint8Array(width * height), added: new Uint8Array(width * height), bounds: { left: width, right: 0, top: height, bottom: 0 } };
    const b = before.data, a = after.data;
    const strength = (gap) => Math.min(1, Math.max(0, 6 * (gap / 255) - 0.06));
    const missing = (own, other, i, x, y) => {
      const darker = (j) => Math.max(0, other[j] - own[i]) + Math.max(0, other[j + 1] - own[i + 1]) + Math.max(0, other[j + 2] - own[i + 2]);
      let least = darker(i);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(overlap - 1, y + 1) && least > 0; yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) least = Math.min(least, darker((yy * width + xx) * 4));
      }
      return least;
    };
    const contrast = (image, x, y) => {
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
    const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
    const seeded = new Uint8Array(cols * rows);
    for (let y = 0; y < overlap; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x, i = p * 4;
        const lost = missing(b, a, i, x, y), gained = missing(a, b, i, x, y);
        const r = level(lost), g = level(gained);
        if (r === 0 && g === 0) continue;
        levels.removed[p] = r;
        levels.added[p] = g;
        const seed = r > 0 && strength(lost - EDGE_TOLERANCE * contrast(a, x, y)) >= SEED_STRENGTH || g > 0 && strength(gained - EDGE_TOLERANCE * contrast(b, x, y)) >= SEED_STRENGTH;
        if (seed) seeded[(y / CELL | 0) * cols + (x / CELL | 0)] = 1;
      }
    }
    const kept = new Uint8Array(cols * rows);
    seeded.forEach((seed, cell) => {
      if (!seed) return;
      const col = cell % cols, row = cell / cols | 0;
      for (let r = Math.max(0, row - REACH); r <= Math.min(rows - 1, row + REACH); r++) kept.fill(1, r * cols + Math.max(0, col - REACH), r * cols + Math.min(cols, col + REACH + 1));
    });
    let changed = 0;
    for (let y = 0; y < overlap; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!levels.removed[p] && !levels.added[p]) continue;
        if (!kept[(y / CELL | 0) * cols + (x / CELL | 0)]) {
          levels.removed[p] = 0;
          levels.added[p] = 0;
          continue;
        }
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
  function dilate({ removed, added, bounds }, width, height, dark) {
    if (bounds.right <= bounds.left) return { box: { x: 0, y: 0, width: 0, height: 0 }, data: new Uint8ClampedArray(0) };
    const opacity = (l) => Math.round(Math.min(1, Math.max(0, 6 * l / 255 - 0.06)) * 0.8 * 255);
    const rgba = (color, alpha) => alpha ? (alpha << 24 | color[2] << 16 | color[1] << 8 | color[0]) >>> 0 : 0;
    const removedColor = new Uint32Array(SATURATED + 1), addedColor = new Uint32Array(SATURATED + 1);
    const [darkerBefore, darkerAfter] = dark ? [ADDED, REMOVED] : [REMOVED, ADDED];
    for (let l = 0; l <= SATURATED; l++) {
      removedColor[l] = rgba(darkerBefore, opacity(l));
      addedColor[l] = rgba(darkerAfter, opacity(l));
    }
    const left = Math.max(0, bounds.left - 1), right = Math.min(width, bounds.right + 1);
    const top = Math.max(0, bounds.top - 1), bottom = Math.min(height, bounds.bottom + 1);
    const boxWidth = right - left;
    const out = new Uint8ClampedArray(boxWidth * (bottom - top) * 4);
    const rowMax = (source, y, into) => {
      if (y < bounds.top || y >= bounds.bottom) {
        into.fill(0);
        return;
      }
      const row = y * width;
      for (let x = left; x < right; x++) {
        let m = source[row + x];
        if (x > 0 && source[row + x - 1] > m) m = source[row + x - 1];
        if (x < width - 1 && source[row + x + 1] > m) m = source[row + x + 1];
        into[x] = m;
      }
    };
    const rows = (source) => {
      const ring = [new Uint8Array(width), new Uint8Array(width), new Uint8Array(width)];
      rowMax(source, top - 1, ring[0]);
      rowMax(source, top, ring[1]);
      rowMax(source, top + 1, ring[2]);
      return {
        ring,
        advance(y) {
          const oldest = ring.shift();
          rowMax(source, y + 2, oldest);
          ring.push(oldest);
        }
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

  // src/background.ts
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === "align" || message?.type === "compare") {
      answer(message).then(reply, (error) => reply({ error: String(error) }));
      return true;
    }
    if (message?.type === "open-options") openSettings(_sender.tab);
    return false;
  });
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("options.html?welcome") });
  });
  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
  function openSettings(tab) {
    if (tab?.id == null) {
      chrome.runtime.openOptionsPage();
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?from=${tab.id}`), index: tab.index + 1, openerTabId: tab.id });
  }
  var answers = /* @__PURE__ */ new Map();
  var ANSWERS_KEPT = 50;
  async function answer(request) {
    if (!await hasImagePermission()) return { needsPermission: true };
    const key = JSON.stringify([request.type, request.before, request.after]);
    let work = answers.get(key);
    if (!work) {
      work = oneAtATime(() => request.type === "align" ? align(request) : compare(request));
      answers.set(key, work);
      const forget = () => answers.get(key) === work && answers.delete(key);
      const keep = isAttachment(request.before) && isAttachment(request.after);
      work.then(() => keep || forget(), forget);
      if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value);
    }
    return work;
  }
  async function align({ before, after }) {
    const [b, a] = await loadBoth(before, after);
    const { placement, exact } = findPlacement(b, a);
    const dark = isDark(b, a);
    const overlay = diffOverlay(b, a, placement, dark);
    return { placement, diff: await toDataUrl(overlay), same: exact ? overlay.changed === 0 : null, dark };
  }
  async function compare({ before, after }) {
    const [b, a] = await loadBoth(before, after);
    const dark = isDark(b, a);
    if (b.width === a.width && b.height === a.height) return { same: !anyChange(b, a), dark };
    const width = Math.min(b.width, a.width);
    const overlay = densityOverlay(resample(b, width), resample(a, width), dark);
    return { same: overlay.changed === 0, dark, diff: await toDataUrl(overlay) };
  }
  function resample(image, width) {
    if (image.width === width) return image;
    const height = Math.round(image.height * width / image.width);
    const source = new OffscreenCanvas(image.width, image.height);
    source.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    const context = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }
  var hasImagePermission = () => chrome.permissions.contains({ origins: IMAGE_ORIGINS });
  var isAttachment = (url) => IMAGE_ORIGINS.some((origin) => url.startsWith(origin.slice(0, -1)));
  var queue = Promise.resolve();
  function oneAtATime(job) {
    const run = queue.then(job, job);
    queue = run.catch(() => {
    });
    return run;
  }
  async function loadBoth(before, after) {
    const [b, a] = await Promise.allSettled([load(before), load(after)]);
    if (b.status === "rejected") throw b.reason;
    if (a.status === "rejected") throw a.reason;
    return [b.value, a.value];
  }
  async function load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`image ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }
  async function toDataUrl({ width, height, box, data }) {
    const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`, close = "</svg>";
    if (!box.width || !box.height) return `data:image/svg+xml,${encodeURIComponent(open + close)}`;
    const canvas = new OffscreenCanvas(box.width, box.height);
    canvas.getContext("2d").putImageData(new ImageData(data, box.width, box.height), 0, 0);
    const png = base64(new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()));
    const image = `<image x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" href="data:image/png;base64,`;
    return `data:image/svg+xml,${encodeURIComponent(open + image)}${png}${encodeURIComponent(`"/>${close}`)}`;
  }
  function base64(bytes) {
    const native = bytes.toBase64;
    if (native) return native.call(bytes);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  }
})();
