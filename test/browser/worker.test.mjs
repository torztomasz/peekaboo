// The background worker's bundle in headless Chromium (npm run test:browser), where canvas decoding and
// encoding are real. Methodology: a stub `chrome` (openWorker in harness.mjs) captures the worker's
// listeners, records the tabs it opens, and lets a test grant or revoke the image permission; `fetch`
// serves the bench's synthetic screenshots for GitHub-style URLs and is counted, to see whether an answer
// was worked out again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { launch, openWorker } from "./harness.mjs";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));

let browser, page;
before(async () => {
  browser = await launch();
  page = await openWorker(browser);
});
after(() => browser?.close());

// Main found this crop at its broad coarse scale; shrinking text that far makes the right spot rank low
// unless the shrunk copies are blurred.
test("places a narrow crop of a text-heavy screen exactly", async () => {
  const reply = await page.evaluate(async () => {
    const screen = screens.page(2560, 1600, { columnX: 150 });
    return ask({ type: "align", before: await screens.url(screen), after: await screens.url(screens.crop(screen, 768, 282, 200, 440)) });
  });
  assert.deepEqual([reply.placement, reply.same], [{ beforeX: 0, beforeY: 0, afterX: 768, afterY: 282 }, true]);
});

// The permission asked about is the optional one the manifest declares: GitHub's two image hosts.
test("answers a repeated pair of attachments from memory, but not once the permission is revoked", async () => {
  const replies = await page.evaluate(async () => {
    window.permissionQueries = [];
    const host = "https://private-user-images.githubusercontent.com/1/";
    const message = { type: "compare", before: await serve(`${host}a.png`, screens.page(1280, 800)), after: await serve(`${host}b.png`, screens.page(1280, 800, { change: true })) };
    window.fetched = 0;
    const first = await ask(message);
    const second = await ask(message);
    const fetched = window.fetched;
    window.granted = false;
    const revoked = await ask(message);
    window.granted = true;
    return { first, second, fetched, revoked, queries: window.permissionQueries };
  });
  assert.deepEqual(replies.second, replies.first);
  assert.equal(replies.first.same, false);
  assert.equal(replies.fetched, 2);
  assert.deepEqual(replies.revoked, { needsPermission: true });
  const imageHosts = [...manifest.optional_host_permissions].sort();
  assert.deepEqual(replies.queries.map(({ origins, ...rest }) => [[...origins].sort(), rest]), Array(3).fill([imageHosts, {}]));
});

// Kept for the last 50 pairs of attachments asked about, so a long-open tab doesn't hold every answer.
test("keeps the answers for the last 50 pairs and works out older ones again", async () => {
  const fetched = await page.evaluate(async () => {
    const host = "https://user-images.githubusercontent.com/kept/";
    const tiny = new OffscreenCanvas(8, 8);
    tiny.getContext("2d").fillRect(0, 0, 8, 8);
    const pairs = [];
    for (let i = 0; i < 51; i++) pairs.push({ type: "compare", before: await serve(`${host}${i}a.png`, tiny), after: await serve(`${host}${i}b.png`, tiny) });
    for (const message of pairs) await ask(message);
    const fetchesFor = async (message) => {
      window.fetched = 0;
      await ask(message);
      return window.fetched;
    };
    // The second-oldest first: asking about the oldest again stores it anew and pushes the next one out.
    return { fiftiethNewest: await fetchesFor(pairs[1]), oldest: await fetchesFor(pairs[0]) };
  });
  assert.deepEqual(fetched, { fiftiethNewest: 0, oldest: 2 });
});

// A branch image (raw.githubusercontent.com) changes when someone pushes over it, at the same URL, so a
// pair with one isn't remembered, even when the other side is an attachment.
test("asks again about images that can change behind their URL", async () => {
  const replies = await page.evaluate(async () => {
    const raw = "https://raw.githubusercontent.com/o/r/branch/", attachment = "https://user-images.githubusercontent.com/1/";
    const replies = [];
    for (const [name, beforeHost] of [["both from the branch", raw], ["one an attachment", attachment]]) {
      const message = { type: "compare", before: await serve(`${beforeHost}${name}-a.png`, screens.page(1280, 800)), after: await serve(`${raw}${name}-b.png`, screens.page(1280, 800, { change: true })) };
      const first = await ask(message);
      await serve(message.after, screens.page(1280, 800));
      window.fetched = 0;
      const second = await ask(message);
      replies.push({ name, first: first.same, second: second.same, fetched: window.fetched });
    }
    return replies;
  });
  for (const { name, ...reply } of replies) assert.deepEqual(reply, { first: false, second: true, fetched: 2 }, name);
});

// A reply must always come: the page waits on it to stop saying "Lining up…".
test("replies with an error when a screenshot can't be read, and still answers the next pair", async () => {
  const replies = await page.evaluate(async () => {
    const good = await screens.url(screens.page(640, 400));
    const failed = await ask({ type: "align", before: good, after: "blob:missing" });
    const next = await ask({ type: "compare", before: good, after: good });
    return { failed, next };
  });
  assert.equal(typeof replies.failed.error, "string");
  assert.deepEqual(replies.next, { same: true, dark: false });
});

test("opens the welcome page on install only, and settings from the toolbar icon", async () => {
  const opened = await page.evaluate(() => {
    window.opened = { tabs: [], settings: 0 };
    const seen = () => JSON.parse(JSON.stringify(window.opened));
    window.installed({ reason: "update" });
    const update = seen();
    window.installed({ reason: "install" });
    const install = seen();
    window.iconClicked();
    return { update, install, icon: seen() };
  });
  const welcome = { url: "options.html?welcome" };
  assert.deepEqual(opened, { update: { tabs: [], settings: 0 }, install: { tabs: [welcome], settings: 0 }, icon: { tabs: [welcome], settings: 1 } });
});

// Chrome before 140 has no Uint8Array.prototype.toBase64, and the worker encodes the diff itself there. Faint
// noise (up to 15 levels off white) makes a diff of every strength, so its PNG is well over one 32 KB chunk
// of that encoder; it must come out as the native one's, byte for byte.
test("encodes a big diff the same without Chrome's own base64", async () => {
  const diffOfNoise = async (page) => page.evaluate(async () => {
    const blank = new OffscreenCanvas(400, 300), noise = new OffscreenCanvas(400, 300);
    blank.getContext("2d").fillStyle = "#fff";
    blank.getContext("2d").fillRect(0, 0, 400, 300);
    const pixels = new ImageData(400, 300);
    for (let i = 0, seed = 1; i < pixels.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      pixels.data.fill(255 - (seed >>> 28), i, i + 3);
      pixels.data[i + 3] = 255;
    }
    noise.getContext("2d").putImageData(pixels, 0, 0);
    return (await ask({ type: "align", before: await screens.url(blank), after: await screens.url(noise) })).diff;
  });
  const older = await openWorker(browser, () => delete Uint8Array.prototype.toBase64);
  const [native, encodedHere] = [await diffOfNoise(page), await diffOfNoise(older)];
  assert.equal(await older.evaluate(() => "toBase64" in Uint8Array.prototype), false, "control: the older page has no native encoder");
  assert.ok(native.length > 2 * 0x8000 * (4 / 3), `the diff spans more than one chunk: ${native.length}`);
  assert.equal(encodedHere, native);
});
