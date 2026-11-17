// The background worker's bundle in headless Chromium (npm run test:browser), where canvas decoding and
// encoding are real. Methodology: a stub `chrome` (openWorker in harness.mjs) captures the worker's
// listeners, records the tabs it opens, and lets a test grant or revoke the image permission; `fetch`
// serves the bench's synthetic screenshots for GitHub-style URLs and is counted, to see whether an answer
// was worked out again.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launch, openWorker } from "./harness.mjs";

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
    window.installed({ reason: "update" });
    window.installed({ reason: "install" });
    window.iconClicked();
    return window.opened;
  });
  assert.deepEqual(opened, { tabs: [{ url: "options.html?welcome" }], settings: 1 });
});

// Asked from a pull request, settings open beside that tab and know which tab to go back to.
test("opens settings next to the pull request that asked for them", async () => {
  const opened = await page.evaluate(() => {
    window.opened.tabs = [];
    window.listener({ type: "open-options" }, { tab: { id: 41, index: 5 } }, () => {});
    return window.opened.tabs;
  });
  assert.deepEqual(opened, [{ url: "options.html?from=41", index: 6, openerTabId: 41 }]);
});
