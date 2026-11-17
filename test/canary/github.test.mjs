// The one thing the hermetic tests can't know: whether github.com still renders pull requests the way
// the fixtures say. They are built from markup copied on the day they were written; when GitHub changes
// its own (a renamed class, tables rendered by script instead of in the page), every other test stays
// green while the extension quietly stops finding tables. So this one is not part of `npm run check`:
// it runs on a schedule (.github/workflows/canary.yml) and by hand with `npm run canary`.
// Methodology: a real, merged pull request with Before/After tables is loaded from github.com, signed
// out, letting through only the document itself (no scripts, so what's tested is the HTML GitHub
// serves). The content script then runs on it, and the pairs and captions it finds are compared with
// what that pull request holds.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { built, launch, settle } from "../browser/harness.mjs";

// Merged, so its description no longer changes. Counted in its markdown source, not with the extension:
// 6 Before/After tables holding 11 rows with a screenshot on both sides, an italic line under each
// table, and one table that isn't a Before/After (the review scores) to leave alone.
const PULL_REQUEST = "https://github.com/torztomasz/peekaboo/pull/10";
const EXPECTED = { widgets: 6, pairs: 11, captions: 6 };

let browser, page;
before(async () => {
  browser = await launch();
  page = await browser.newPage();
  await page.route("**/*", (route) => (route.request().resourceType() === "document" ? route.continue() : route.abort()));
  const response = await page.goto(PULL_REQUEST, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200, "GitHub didn't serve the pull request");
  // Evaluated, not added as a script tag: GitHub's Content-Security-Policy forbids inline scripts, and a
  // content script doesn't run as one. The policy still applies to the stylesheet the script injects.
  await page.evaluate(await built("content.ts"));
  await settle(page);
});
after(() => browser?.close());

test("finds the Before/After tables in a pull request as GitHub serves it today", async () => {
  const found = await page.evaluate(() => ({
    widgets: document.querySelectorAll(".peekaboo").length,
    pairs: document.querySelectorAll(".peekaboo-frame").length,
  }));
  assert.deepEqual(found, { widgets: EXPECTED.widgets, pairs: EXPECTED.pairs });
});

test("its stylesheet takes effect under GitHub's Content-Security-Policy", async () => {
  assert.equal(await page.locator(".peekaboo-toolbar").first().evaluate((toolbar) => getComputedStyle(toolbar).display), "flex");
});

// The caption is found next to GitHub's wrapper element around the table, which is theirs to rename.
test("reads the caption under each table", async () => {
  const captions = new Set();
  await page.getByRole("button", { name: "Full screen" }).first().click();
  for (let pair = 0; pair < EXPECTED.pairs; pair++) {
    captions.add(await page.locator(".peekaboo-viewer-caption").textContent());
    await page.keyboard.press("ArrowRight");
  }
  captions.delete("");
  assert.equal(captions.size, EXPECTED.captions);
});
