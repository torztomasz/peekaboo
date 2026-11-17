// The background worker's bundle in headless Chromium (npm run test:browser), where canvas decoding and
// encoding are real. Methodology: a stub `chrome` captures the message listener and lets a test grant or
// revoke the image permission; `fetch` serves the bench's synthetic screenshots for GitHub-style URLs and
// is counted, to see whether an answer was worked out again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { bundle, launch } from "../../bench/browser.mjs";

let browser, page;
before(async () => {
  browser = await launch();
  page = await browser.newPage();
  await page.addScriptTag({ content: readFileSync(new URL("../../bench/screens.js", import.meta.url), "utf8") });
  await page.addScriptTag({
    content: `
      window.granted = true;
      window.fetched = 0;
      window.served = {};
      const fetchImage = window.fetch;
      window.fetch = (url) => { window.fetched++; return fetchImage(window.served[url] ?? url); };
      // Serves a canvas at a URL the page's images would have, as GitHub does.
      window.serve = async (url, canvas) => { window.served[url] = await screens.url(canvas); return url; };
      window.chrome = {
        runtime: { id: "test", onMessage: { addListener: (f) => (window.listener = f) }, onInstalled: { addListener() {} }, getURL: (p) => p },
        action: { onClicked: { addListener() {} } },
        permissions: { contains: async () => window.granted },
        tabs: {},
      };
      window.ask = (message) => new Promise((resolve) => window.listener(message, {}, resolve));`,
  });
  await page.addScriptTag({ content: await bundle(new URL("../../src/background.ts", import.meta.url).pathname) });
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

test("answers a repeated pair of attachments from memory, but not once the permission is revoked", async () => {
  const replies = await page.evaluate(async () => {
    const host = "https://private-user-images.githubusercontent.com/1/";
    const message = { type: "compare", before: await serve(`${host}a.png`, screens.page(1280, 800)), after: await serve(`${host}b.png`, screens.page(1280, 800, { change: true })) };
    window.fetched = 0;
    const first = await ask(message);
    const second = await ask(message);
    const fetched = window.fetched;
    window.granted = false;
    const revoked = await ask(message);
    window.granted = true;
    return { first, second, fetched, revoked };
  });
  assert.deepEqual(replies.second, replies.first);
  assert.equal(replies.first.same, false);
  assert.equal(replies.fetched, 2);
  assert.deepEqual(replies.revoked, { needsPermission: true });
});

// A branch image (raw.githubusercontent.com) changes when someone pushes over it, at the same URL.
test("asks again about images that can change behind their URL", async () => {
  const replies = await page.evaluate(async () => {
    const raw = "https://raw.githubusercontent.com/o/r/branch/";
    const message = { type: "compare", before: await serve(`${raw}a.png`, screens.page(1280, 800)), after: await serve(`${raw}b.png`, screens.page(1280, 800, { change: true })) };
    const first = await ask(message);
    await serve(`${raw}b.png`, screens.page(1280, 800));
    window.fetched = 0;
    const second = await ask(message);
    return { first: first.same, second: second.same, fetched: window.fetched };
  });
  assert.deepEqual(replies, { first: false, second: true, fetched: 2 });
});
