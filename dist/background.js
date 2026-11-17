(() => {
  // src/origins.ts
  var IMAGE_ORIGINS = ["https://private-user-images.githubusercontent.com/*", "https://user-images.githubusercontent.com/*"];

  // src/match.ts
  var FULL_SIZE_ROWS = 4e3;
  function locate(outer, inner, gray2) {
    let scale = Math.min(1, 240 / Math.max(outer.width, outer.height));
    scale = Math.min(1, Math.max(scale, 24 / Math.min(inner.width, inner.height)));
    const o = gray2(outer, scale, 0, outer.height), i = gray2(inner, scale, 0, inner.height);
    const coarse = match(o, i, 0, o.width - i.width, 0, o.height - i.height, 1);
    const step = Math.ceil(1 / scale) + 1;
    const xMax = outer.width - inner.width, yMax = outer.height - inner.height;
    const cx = Math.min(xMax, Math.round(coarse.x / scale)), cy = Math.min(yMax, Math.round(coarse.y / scale));
    const template = gray2(inner, 1, 0, Math.min(inner.height, FULL_SIZE_ROWS));
    const top = Math.max(0, cy - step), last = Math.min(yMax, cy + step);
    const band = gray2(outer, 1, top, last + template.height);
    const exact = match(band, template, Math.max(0, cx - step), Math.min(band.width - template.width, cx + step), 0, band.height - template.height, 1);
    return { ...exact, y: exact.y + top };
  }
  function match(outer, inner, x0, x1, y0, y1, stride) {
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

  // src/changes.ts
  var AS_IS = { beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 };
  function lineUpChanges(before, after) {
    const asPlaced = changeMaps(before, after, AS_IS);
    if (before.width !== after.width || asPlaced.stats.changed === 0) return asPlaced;
    const { width, height } = asPlaced;
    const removed = new Float32Array(width * height), added = new Float32Array(width * height);
    let changed = 0, moved = false;
    for (const [x0, x1] of columnBands(asPlaced)) {
      const placedCount = countBand(asPlaced, x0, x1);
      const lined = edgeMargins(x1 - x0).map((margin) => lineUpBand(before, after, x0, x1, margin)).reduce((best, next) => next && (!best || next.changed < best.changed) ? next : best, null);
      const better = lined && lined.changed < placedCount ? lined : null;
      const source = better ?? asPlaced;
      for (let y = 0; y < height; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * width + x;
          removed[i] = source.removed[i];
          added[i] = source.added[i];
        }
      }
      changed += better ? better.changed : placedCount;
      moved ||= Boolean(better);
    }
    if (!moved) return asPlaced;
    const stats = { changed, compared: asPlaced.stats.compared, moved, regions: visibleRegions(removed, added, width, height) };
    return { removed, added, width, height, stats };
  }
  var strength = (difference) => Math.min(1, Math.max(0, 6 * difference - 0.06));
  function changeMaps(before, after, { beforeX, beforeY, afterX, afterY }) {
    const width = Math.max(before.width + beforeX, after.width + afterX), height = Math.max(before.height + beforeY, after.height + afterY);
    const b = before.data, a = after.data;
    const removed = new Float32Array(width * height), added = new Float32Array(width * height);
    const stats = { changed: 0, compared: 0, moved: false, regions: [] };
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
  var differs = (b, bi, a, ai) => {
    const [r, g] = comparePixel(b, bi, a, ai);
    return r > 0 || g > 0;
  };
  function comparePixel(b, bi, a, ai) {
    let lighterAfter = 0, lighterBefore = 0;
    for (let c = 0; c < 3; c++) {
      const d = (a[ai + c] - b[bi + c]) / 255;
      if (d > 0) lighterAfter += d;
      else lighterBefore -= d;
    }
    return [strength(lighterAfter), strength(lighterBefore)];
  }
  function columnBands({ removed, added, width, height }) {
    const boxes = findRegions(removed, added, width, height);
    if (boxes.length >= MAX_REGIONS) return [[0, width]];
    const spans = boxes.map(({ x0, x1 }) => [x0, x1]).sort((p, q) => p[0] - q[0]);
    const bands = [];
    for (const [x0, x1] of spans) {
      const last = bands[bands.length - 1];
      if (last && x0 <= last[1]) last[1] = Math.max(last[1], x1);
      else bands.push([x0, x1]);
    }
    return bands;
  }
  function countBand({ removed, added, width, height }, x0, x1) {
    let count = 0;
    for (let y = 0; y < height; y++) for (let x = x0; x < x1; x++) if (removed[y * width + x] > 0 || added[y * width + x] > 0) count++;
    return count;
  }
  var MAX_ROW_EDITS = 1200;
  var edgeMargins = (width) => [.../* @__PURE__ */ new Set([Math.min(24, Math.floor(width * 0.05)), Math.min(128, Math.floor(width * 0.15))])];
  function lineUpBand(before, after, x0, x1, margin) {
    const beforeRows = rowHashes(before, x0 + margin, x1 - margin), afterRows = rowHashes(after, x0 + margin, x1 - margin);
    const pairs = matchRows(before.height, after.height, (b2, a2) => beforeRows[b2] === afterRows[a2]);
    if (!pairs) return null;
    const viewport = before.height === after.height;
    const hunks = slideDeletions(toHunks(pairs, before.height, after.height), beforeRows, plainRows(after, x0, x1), viewport);
    const width = Math.max(before.width, after.width), height = Math.max(before.height, after.height);
    const removed = new Float32Array(width * height), added = new Float32Array(width * height);
    let changed = 0;
    const paint = (i, r, g) => {
      if (r <= 0 && g <= 0) return;
      if (removed[i] === 0 && added[i] === 0) changed++;
      removed[i] = Math.max(removed[i], r);
      added[i] = Math.max(added[i], g);
    };
    const compareRow = (y, other, start, step = 4) => {
      for (let x = x0, oi = start; x < x1; x++, oi += step) {
        const ai = (y * after.width + x) * 4;
        const [r, g] = comparePixel(other, oi, after.data, ai);
        if ((r > 0 || g > 0) && y < before.height && !differs(before.data, (y * before.width + x) * 4, after.data, ai)) continue;
        paint(y * width + x, r, g);
      }
    };
    const fromBefore = (y, b2) => compareRow(y, before.data, (b2 * before.width + x0) * 4);
    const edit = ({ b0, b1, a0, a1 }) => {
      const common = Math.min(b1 - b0, a1 - a0);
      for (let k = 0; k < common; k++) fromBefore(a0 + k, b0 + k);
      if (b1 === before.height && a1 === after.height && viewport) return;
      const grownFrom = a0 > 0 ? a0 - 1 : a1 < after.height ? a1 : -1;
      for (let y = a0 + common; y < a1; y++) {
        if (grownFrom >= 0) compareRow(y, after.data, (grownFrom * after.width + x0) * 4);
        else compareRow(y, commonColour(before, x0, x1), 0, 0);
      }
      if (b1 - b0 > common) markDeletion(before, after, b0 + common, b1, x0, x1, a1, width, (i) => paint(i, 1, 0));
    };
    let b = 0, a = 0;
    for (const hunk of [...hunks, { b0: before.height, b1: before.height, a0: after.height, a1: after.height }]) {
      for (; a < hunk.a0 && b < hunk.b0; a++, b++) fromBefore(a, b);
      edit(hunk);
      b = hunk.b1;
      a = hunk.a1;
    }
    return { removed, added, changed };
  }
  function toHunks(pairs, n, m) {
    const hunks = [];
    let b0 = 0, a0 = 0;
    for (const [b, a] of [...pairs, [n, m]]) {
      if (b > b0 || a > a0) hunks.push({ b0, b1: b, a0, a1: a });
      b0 = b + 1;
      a0 = a + 1;
    }
    return hunks;
  }
  function slideDeletions(hunks, beforeRows, plain, viewport) {
    const n = beforeRows.length, m = plain.length;
    return hunks.map((hunk, i) => {
      if (hunk.a0 !== hunk.a1) return hunk;
      const floor = i > 0 ? hunks[i - 1].b1 : 0, ceiling = i + 1 < hunks.length ? hunks[i + 1].b0 : n;
      let up = 0, down = 0;
      while (hunk.b0 - up > floor && beforeRows[hunk.b0 - up - 1] === beforeRows[hunk.b1 - up - 1]) up++;
      while (hunk.b1 + down < ceiling && beforeRows[hunk.b0 + down] === beforeRows[hunk.b1 + down]) down++;
      const at = (shift) => ({ b0: hunk.b0 + shift, b1: hunk.b1 + shift, a0: hunk.a0 + shift, a1: hunk.a1 + shift });
      if (viewport && hunk.b1 + down === n) return at(down);
      const inGap = [];
      for (let shift = -up; shift <= down; shift++) {
        const row = hunk.a0 + shift;
        if (row > 0 && row < m && plain[row - 1] && plain[row]) inGap.push(shift);
      }
      return inGap.length ? at(inGap[Math.floor(inGap.length / 2)]) : hunk;
    });
  }
  function plainRows({ data, width, height }, x0, x1) {
    const plain = new Uint8Array(height);
    for (let y = 0; y < height; y++) {
      const first = (y * width + x0) * 4;
      let same = true;
      for (let i = first + 4, end = (y * width + x1) * 4; i < end && same; i += 4) {
        same = data[i] === data[first] && data[i + 1] === data[first + 1] && data[i + 2] === data[first + 2];
      }
      plain[y] = same ? 1 : 0;
    }
    return plain;
  }
  function markDeletion(before, after, b0, b1, x0, x1, at, width, paint) {
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
  function rowHashes({ data, width, height }, x0, x1) {
    const hashes = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      let h = 2166136261;
      for (let i = (y * width + x0) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
        h = Math.imul(h ^ data[i], 16777619);
        h = Math.imul(h ^ data[i + 1], 16777619);
        h = Math.imul(h ^ data[i + 2], 16777619);
      }
      hashes[y] = h;
    }
    return hashes;
  }
  function commonColour({ data, width, height }, x0, x1) {
    const counts = /* @__PURE__ */ new Map();
    const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * height / 2e4)));
    let best = 0, bestCount = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * width + x) * 4, key = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > bestCount) {
          bestCount = count;
          best = key;
        }
      }
    }
    return new Uint8ClampedArray([best >> 16, best >> 8 & 255, best & 255, 255]);
  }
  function matchRows(n, m, same, maxEdits = MAX_ROW_EDITS) {
    let tail = 0;
    while (tail < n && tail < m && same(n - 1 - tail, m - 1 - tail)) tail++;
    const pairs = myers(n - tail, m - tail, same, maxEdits);
    if (!pairs) return null;
    for (let i = tail; i > 0; i--) pairs.push([n - i, m - i]);
    return pairs;
  }
  function myers(n, m, same, maxEdits) {
    if (n === 0 || m === 0) return [];
    const offset = maxEdits + 1;
    let v = new Int32Array(2 * offset + 1);
    const trace = [];
    for (let d = 0; d <= maxEdits; d++) {
      trace.push(v.slice(offset - d - 1, offset + d + 2));
      const next = v.slice();
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || k !== d && v[offset + k - 1] < v[offset + k + 1] ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && same(x, y)) {
          x++;
          y++;
        }
        next[offset + k] = x;
        if (x >= n && y >= m) return walkBack(trace, d, k, x);
      }
      v = next;
    }
    return null;
  }
  function walkBack(trace, d, k, x) {
    const pairs = [];
    let y = x - k;
    for (; d > 0; d--) {
      const v = trace[d], at = (kk) => v[kk + d + 1];
      const down = k === -d || k !== d && at(k - 1) < at(k + 1);
      const prevK = down ? k + 1 : k - 1, prevX = at(prevK), prevY = prevX - prevK;
      const startX = down ? prevX : prevX + 1;
      while (x > startX) {
        x--;
        y--;
        pairs.push([x, y]);
      }
      x = prevX;
      y = prevY;
      k = prevK;
    }
    while (x > 0 && y > 0) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    return pairs.reverse();
  }
  var CELL = 8;
  var REACH = 2;
  var MAX_REGIONS = 99;
  var FAINT = 0.25;
  function visibleRegions(removed, added, width, height) {
    const peak = ({ x0, y0, x1, y1 }) => {
      let max = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) max = Math.max(max, removed[y * width + x], added[y * width + x]);
      return max;
    };
    return findRegions(removed, added, width, height).filter((box) => peak(box) >= FAINT).map((box) => toRegion(box, width, height));
  }
  var toRegion = ({ x0, y0, x1, y1 }, width, height) => ({ x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height });
  function findRegions(removed, added, width, height) {
    const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
    const hit = new Uint8Array(cols * rows);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (removed[i] > 0 || added[i] > 0) hit[(y / CELL | 0) * cols + (x / CELL | 0)] = 1;
      }
    }
    const tighten = (bx0, by0, bx1, by1) => {
      let x0 = bx1, y0 = by1, x1 = bx0, y1 = by0;
      for (let y = by0; y < by1; y++) {
        for (let x = bx0; x < bx1; x++) {
          const i = y * width + x;
          if (removed[i] > 0 || added[i] > 0) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x + 1);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y + 1);
          }
        }
      }
      return { x0, y0, x1, y1 };
    };
    const seen = new Uint8Array(cols * rows);
    const boxes = [];
    for (let start = 0; start < hit.length && boxes.length < MAX_REGIONS; start++) {
      if (!hit[start] || seen[start]) continue;
      let left = cols, right = 0, top = rows, bottom = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const cell = stack.pop(), col = cell % cols, row = cell / cols | 0;
        left = Math.min(left, col);
        right = Math.max(right, col);
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
        for (let r = Math.max(0, row - REACH); r <= Math.min(rows - 1, row + REACH); r++) {
          for (let c = Math.max(0, col - REACH); c <= Math.min(cols - 1, col + REACH); c++) {
            const next = r * cols + c;
            if (hit[next] && !seen[next]) {
              seen[next] = 1;
              stack.push(next);
            }
          }
        }
      }
      boxes.push(tighten(left * CELL, top * CELL, Math.min(width, (right + 1) * CELL), Math.min(height, (bottom + 1) * CELL)));
    }
    return boxes;
  }

  // src/background.ts
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === "align" || message?.type === "compare") {
      const work = message.type === "align" ? findOffset(message) : compare(message);
      work.then(reply, (error) => reply({ error: String(error) }));
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
  var CONTAINED_MAX_ERROR = 6;
  async function findOffset({ before, after }) {
    if (!await chrome.permissions.contains({ origins: IMAGE_ORIGINS })) return { needsPermission: true };
    const [b, a] = await Promise.all([load(before), load(after)]);
    const fits = (outer, inner) => outer.width >= inner.width && outer.height >= inner.height;
    let placement = null;
    let exact = false;
    if (fits(b, a) || fits(a, b)) {
      const beforeOutside = fits(b, a);
      const found = locate(beforeOutside ? b : a, beforeOutside ? a : b, gray);
      if (found.error <= CONTAINED_MAX_ERROR) {
        placement = beforeOutside ? { beforeX: 0, beforeY: 0, afterX: found.x, afterY: found.y } : { beforeX: found.x, beforeY: found.y, afterX: 0, afterY: 0 };
        exact = true;
      }
    }
    if (!placement && b.width === a.width) {
      const changes2 = lineUpChanges(pixels(b), pixels(a));
      return { placement: AS_IS, diff: await diffImage(changes2), stats: changes2.stats };
    }
    if (!placement) {
      const beforeIsWide = b.width >= a.width;
      const dx = slideSideways(beforeIsWide ? b : a, beforeIsWide ? a : b);
      placement = beforeIsWide ? { beforeX: 0, beforeY: 0, afterX: dx, afterY: 0 } : { beforeX: dx, beforeY: 0, afterX: 0, afterY: 0 };
    }
    const changes = changeMaps(pixels(b), pixels(a), placement);
    return { placement, diff: await diffImage(changes), stats: exact ? changes.stats : null };
  }
  async function compare({ before, after }) {
    if (!await chrome.permissions.contains({ origins: IMAGE_ORIGINS })) return { needsPermission: true };
    const [b, a] = await Promise.all([load(before), load(after)]);
    if (b.width !== a.width || b.height !== a.height) return { error: "sizes differ" };
    const changes = lineUpChanges(pixels(b), pixels(a));
    return { stats: changes.stats, diff: changes.stats.moved ? await diffImage(changes) : null };
  }
  function slideSideways(wide, narrow) {
    const slack = wide.width - narrow.width;
    const scale = Math.min(1, 400 / wide.width);
    const coarse = bestOffset(gray(wide, scale), gray(narrow, scale), Math.round(slack * scale), Math.ceil(16 * scale));
    const step = Math.ceil(1 / scale) + 1;
    return bestOffset(gray(wide, 1), gray(narrow, 1), slack, 0, Math.round(coarse / scale) - step, Math.round(coarse / scale) + step);
  }
  async function load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`image ${response.status}`);
    return createImageBitmap(await response.blob());
  }
  function gray(bitmap, scale, top = 0, bottom = Math.min(bitmap.height, FULL_SIZE_ROWS)) {
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round((bottom - top) * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, top, bitmap.width, bottom - top, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
    return { data, width, height };
  }
  function bestOffset(wide, narrow, slack, overhang, from = -overhang, to = slack + overhang) {
    const rows = Math.min(wide.height, narrow.height);
    const rowStep = Math.max(1, Math.floor(rows / 300));
    let best = 0, bestError = Infinity;
    for (let dx = from; dx <= to; dx++) {
      let sum = 0, count = 0;
      const x0 = Math.max(0, -dx), x1 = Math.min(narrow.width, wide.width - dx);
      if (x1 - x0 < narrow.width * 0.6) continue;
      for (let y = 0; y < rows; y += rowStep) {
        const wRow = y * wide.width + dx, nRow = y * narrow.width;
        for (let x = x0; x < x1; x++) {
          sum += Math.abs(wide.data[wRow + x] - narrow.data[nRow + x]);
          count++;
        }
      }
      const error = sum / count;
      if (error < bestError) {
        bestError = error;
        best = dx;
      }
    }
    return best;
  }
  var REMOVED = [219, 36, 46];
  var ADDED = [26, 184, 77];
  function pixels(bitmap) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return { data: context.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
  }
  async function diffImage({ removed, added, width, height }) {
    const out = new ImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= height || xx >= width) continue;
          r = Math.max(r, removed[yy * width + xx]);
          g = Math.max(g, added[yy * width + xx]);
        }
        const [color, alpha] = r >= g ? [REMOVED, r] : [ADDED, g];
        const i = (y * width + x) * 4;
        out.data[i] = color[0];
        out.data[i + 1] = color[1];
        out.data[i + 2] = color[2];
        out.data[i + 3] = Math.round(alpha * 0.8 * 255);
      }
    }
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").putImageData(out, 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return `data:image/png;base64,${btoa(binary)}`;
  }
})();
