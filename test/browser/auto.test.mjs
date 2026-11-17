// Auto-align, the same-picture warning and Removed/Added colours: everything the page gets from the
// extension's worker.
// Methodology: the content script and the real worker code run in one page, joined by a stand-in for
// Chrome's message passing and permission (see harness.mjs), so both sides and the messages between them
// are the shipped code. Screenshots are built from blocks of different greys at irregular places, so a
// crop of the screen fits in exactly one place and the expected placement is known from how the crop was
// cut, not from the code under test.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { answered, draw, isGreen, isNeutral, isRed, launch, offsetWithin, pair, picture, pixels, pullRequest, withPullRequest } from "./harness.mjs";

const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
const BLOCKS = [
  [30, 20, 120, 40, [40, 40, 40]], [200, 70, 90, 60, [90, 90, 90]], [420, 30, 150, 50, [140, 60, 60]], [60, 150, 200, 30, [60, 120, 160]],
  [330, 180, 100, 90, [20, 20, 20]], [520, 240, 180, 40, [170, 170, 90]], [100, 300, 260, 50, [110, 40, 140]], [450, 380, 120, 120, [50, 50, 50]],
  [40, 440, 180, 60, [150, 150, 150]], [620, 100, 120, 80, [30, 90, 60]], [280, 500, 300, 40, [70, 70, 70]], [650, 480, 100, 90, [120, 120, 200]],
];
const SCREEN = picture(800, 600, WHITE, BLOCKS);
// 440 wide, not 400: half the screen's width would read as a retina capture of the same view.
const CROP = [120, 100, 440, 300];
// The part of the screen at (x, y), with `extra` blocks (in the screen's coordinates) drawn on top.
const cropOfScreen = (x, y, width, height, extra = []) => picture(width, height, WHITE, [...BLOCKS, ...extra].map(([bx, by, ...rest]) => [bx - x, by - y, ...rest]));
const scaled = (shapes, by) => shapes.map(([x, y, w, h, color]) => [x * by, y * by, w * by, h * by, color]);

let browser;
before(async () => (browser = await launch()));
after(() => browser?.close());

const frame = (page, index = 0) => page.locator(".peekaboo-frame").nth(index);
const afterShot = (page) => offsetWithin(page.locator("img.peekaboo-after").first(), page.locator(".peekaboo-canvas").first());
const alignButtons = (page) => page.locator(".peekaboo-align").first().getByRole("button");
const pressedAlign = (page) => page.locator(".peekaboo-align").first().getByRole("button", { pressed: true }).allTextContents();
const SAME = "No visible difference. The same screenshot twice?";
const warnings = (page) => page.getByText(SAME).filter({ visible: true }).count();
const diffMode = (page) => page.getByRole("button", { name: "Diff" }).first().click();

async function withAuto(html, options, run) {
  await withPullRequest(browser, html, { auto: true, ...options }, async (pr) => {
    await answered(pr.page);
    await run(pr);
  });
}

// ---------- Placement ----------

test("Auto puts a crop where it matches the full screenshot, and Diff then shows only what changed", async () => {
  const added = [260, 240, 40, 20, BLACK];
  await withAuto(pullRequest(pair(SCREEN, cropOfScreen(...CROP, [added]))), {}, async ({ page }) => {
    assert.deepEqual(await alignButtons(page).allTextContents(), ["Auto", "Left", "Center", "Right"]);
    assert.deepEqual(await pressedAlign(page), ["Auto"]);
    assert.deepEqual(await afterShot(page), { x: 120, y: 100, width: 440, height: 300 });
    assert.equal(await warnings(page), 0);
    await diffMode(page);
    const seen = await pixels(frame(page));
    assert.ok(isGreen(seen.at(281, 251)), `the added block: ${seen.at(281, 251)}`);
    assert.ok(isNeutral(seen.at(381, 226)), `a block both have, once lined up: ${seen.at(381, 226)}`);
    assert.ok(isNeutral(seen.at(701, 521)), `a block only the full screenshot reaches: ${seen.at(701, 521)}`);
  });
});

test("choosing an edge by hand overrides Auto's placement", async () => {
  await withAuto(pullRequest(pair(SCREEN, cropOfScreen(...CROP))), {}, async ({ page }) => {
    await page.getByRole("button", { name: "Right" }).click();
    assert.deepEqual(await afterShot(page), { x: 360, y: 0, width: 440, height: 300 });
    await page.getByRole("button", { name: "Auto" }).click();
    assert.deepEqual(await afterShot(page), { x: 120, y: 100, width: 440, height: 300 });
  });
});

// A viewport capture next to a full-page one: same width, so only Auto's find earns the pair a bar.
test("a same-width crop is placed down the taller capture, with Top as the way back", async () => {
  const tall = [...BLOCKS, ...BLOCKS.map(([x, y, w, h, [r, g, b]]) => [(x * 7) % 300, y + 620, w, h, [b, r, g]])];
  const html = pullRequest(pair(picture(400, 1200, WHITE, tall), picture(400, 300, WHITE, tall.map(([x, y, ...rest]) => [x, y - 700, ...rest]))));
  await withAuto(html, {}, async ({ page }) => {
    assert.match(await page.locator(".peekaboo-align").textContent(), /One screenshot is a crop of the other \(before 400 × 1200, after 400 × 300\)/);
    assert.deepEqual(await alignButtons(page).allTextContents(), ["Auto", "Top"]);
    assert.equal((await afterShot(page)).y, 700);
    await page.getByRole("button", { name: "Top" }).click();
    assert.equal((await afterShot(page)).y, 0);
  });
});

test("a page that only got longer gets no alignment bar, with or without Auto", async () => {
  const longer = picture(800, 800, WHITE, [...BLOCKS, [100, 650, 300, 60, BLACK]]);
  await withAuto(pullRequest(pair(SCREEN, longer)), {}, async ({ page }) => {
    assert.equal(await page.locator(".peekaboo-align").count(), 0);
    assert.equal((await afterShot(page)).y, 0);
  });
});

// ---------- Without the permission ----------

test("until Auto-align is turned on, pairs are centred with a button that opens settings beside the tab, then line up on return", async () => {
  await withAuto(pullRequest(pair(SCREEN, cropOfScreen(...CROP))), { granted: false }, async ({ page }) => {
    assert.deepEqual(await afterShot(page), { x: 180, y: 0, width: 440, height: 300 });
    assert.deepEqual(await pressedAlign(page), ["Center"]);
    assert.match(await page.locator(".peekaboo-align").textContent(), /Centered for now\. Auto-align finds where they match:/);

    await page.getByRole("button", { name: "Turn on Auto-align" }).click();
    assert.deepEqual(await page.evaluate(() => window.chromeCalls.tabsCreated), [
      { url: "chrome-extension://peekaboo-under-test/options.html?from=7", index: 3, openerTabId: 7 },
    ]);

    // Granted on the settings page; coming back to the tab is a visibilitychange.
    await page.evaluate(() => {
      window.autoGranted = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await answered(page);
    assert.deepEqual(await afterShot(page), { x: 120, y: 100, width: 440, height: 300 });
    assert.deepEqual(await pressedAlign(page), ["Auto"]);
    assert.equal(await page.getByRole("button", { name: "Turn on Auto-align" }).count(), 0);
  });
});

// The page shows the screenshots, but the worker's own request for them fails.
test("says so and centres the pair when the worker can't read the screenshots", async () => {
  const host = "https://private-user-images.githubusercontent.com/1/";
  const onlyForThePage = (png) => (resourceType) => (resourceType === "image" ? png : null);
  const serve = { [`${host}before.png`]: onlyForThePage(draw(400, 300)), [`${host}after.png`]: onlyForThePage(draw(300, 300)) };
  await withAuto(pullRequest(pair(`${host}before.png`, `${host}after.png`)), { serve }, async ({ page }) => {
    assert.match(await page.locator(".peekaboo-align").textContent(), /Couldn't line them up; centered instead\./);
    assert.deepEqual(await pressedAlign(page), ["Center"]);
    assert.equal((await afterShot(page)).x, 50);
  });
});

// ---------- The same picture ----------

// Diff shows the same blank for "nothing changed" and "uploaded the same file twice".
test("warns when Before and After are the same picture, at one size or two densities, and not when they differ", async () => {
  const small = scaled(BLOCKS, 0.5), retina = picture(800, 600, WHITE, BLOCKS);
  const html = pullRequest(
    pair(SCREEN, SCREEN),
    pair(SCREEN, picture(800, 600, WHITE, [...BLOCKS, [260, 240, 40, 20, BLACK]])),
    pair(retina, picture(400, 300, WHITE, small)),
  );
  await withAuto(html, {}, async ({ page }) => {
    const warned = await page.locator(".peekaboo-stage").evaluateAll((stages, text) => stages.map((stage) => stage.innerText.includes(text)), SAME);
    assert.deepEqual(warned, [true, false, true]);
  });
});

test("a crop that matches exactly warns too, but only while Auto is how the pair is lined up", async () => {
  await withAuto(pullRequest(pair(SCREEN, cropOfScreen(...CROP))), {}, async ({ page }) => {
    assert.equal(await warnings(page), 1);
    await page.getByRole("button", { name: "Left" }).click();
    assert.equal(await warnings(page), 0);
    await page.getByRole("button", { name: "Auto" }).click();
    assert.equal(await warnings(page), 1);
  });
});

test("without the permission nothing is claimed about the pair being the same", async () => {
  await withAuto(pullRequest(pair(SCREEN, SCREEN)), { granted: false }, async ({ page }) => assert.equal(await warnings(page), 0));
});

// ---------- Removed and added ----------

// The compositor only knows which side is darker. On a dark theme the content is the light part, so the
// same rule would paint a new light button red; the worker says the pair is dark and the colours swap.
test("red means removed and green means added on dark screenshots as on light ones, and the key says so", async () => {
  const pairOn = (background, ink) => pair(
    picture(400, 300, background, [[200, 40, 80, 40, ink], [40, 40, 80, 40, ink]]),
    picture(400, 300, background, [[200, 40, 80, 40, ink], [40, 160, 80, 40, ink]]),
  );
  await withAuto(pullRequest(pairOn([20, 22, 26], [230, 230, 230]), pairOn(WHITE, BLACK)), {}, async ({ page }) => {
    await diffMode(page);
    for (const [index, theme] of ["dark", "light"].entries()) {
      const seen = await pixels(frame(page, index));
      assert.ok(isRed(seen.at(81, 61)), `${theme}, removed block: ${seen.at(81, 61)}`);
      assert.ok(isGreen(seen.at(81, 181)), `${theme}, added block: ${seen.at(81, 181)}`);
    }
    assert.deepEqual(await page.locator(".peekaboo-tag:visible").allTextContents(), ["Removed", "Added", "Removed", "Added"]);
  });
});

// ---------- Two densities ----------

test("a retina capture against a normal one is diffed by the worker, at the size the page shows", async () => {
  const added = [130, 120, 30, 20, BLACK];
  const html = pullRequest(pair(picture(800, 600, WHITE, BLOCKS), picture(400, 300, WHITE, [...scaled(BLOCKS, 0.5), added])));
  await withAuto(html, {}, async ({ page }) => {
    await diffMode(page);
    const seen = await pixels(frame(page));
    assert.ok(isGreen(seen.at(146, 131)), `the added block: ${seen.at(146, 131)}`);
    assert.ok(isNeutral(seen.at(191, 113)), `a block both have: ${seen.at(191, 113)}`);
    assert.equal(await warnings(page), 0);
  });
});
