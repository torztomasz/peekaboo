// Auto-align, the same-picture warning and Removed/Added colours: everything the page gets from the
// extension's worker.
// Methodology: the content script and the real worker code run in one page, joined by a stand-in for
// Chrome's message passing and permission (see harness.mjs), so both sides and the messages between them
// are the shipped code. Screenshots are built from blocks of different greys at irregular places, so a
// crop of the screen fits in exactly one place and the expected placement is known from how the crop was
// cut, not from the code under test.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { answered, draw, isGreen, isNeutral, isRed, launch, offsetWithin, pair, picture, pixels, pullRequest, settle, withPullRequest } from "./harness.mjs";

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
const cropShapes = (x, y, extra = []) => [...BLOCKS, ...extra].map(([bx, by, ...rest]) => [bx - x, by - y, ...rest]);
const cropOfScreen = (x, y, width, height, extra = []) => picture(width, height, WHITE, cropShapes(x, y, extra));
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
const visibleTags = (page) => page.locator(".peekaboo-tag:visible").allTextContents();
const barText = (page, index = 0) => page.locator(".peekaboo-align").nth(index).textContent();
// A horizontal run of a frame at row `y`: the Not compared hatch is white with thin grey lines, so it has both.
const hatched = (seen, x, y) => {
  const strip = Array.from({ length: 40 }, (_, i) => seen.at(x + i, y)[0]);
  return strip.some((r) => r >= 250) && strip.some((r) => r <= 240);
};

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
    // Lined up by hand, Auto's diff no longer applies: the page's own Diff compares what is now on top of
    // what. At (280, 250) both are white; at (60, 40) only the full screenshot has a block.
    await page.getByRole("button", { name: "Left" }).click();
    const byHand = await pixels(frame(page));
    assert.ok(isNeutral(byHand.at(281, 251)), `Auto's added block is gone: ${byHand.at(281, 251)}`);
    assert.ok(isRed(byHand.at(61, 41)), `what the crop doesn't have where it now sits: ${byHand.at(61, 41)}`);
  });
});

// Either side can be the crop. In Diff, what the crop doesn't cover is hatched as not compared (to its
// right, above it and below it), and what it covers isn't. Every strip runs over white in the screen.
test("a crop is placed where it matches whichever side it is, and Diff hatches what it doesn't cover", async () => {
  await withAuto(pullRequest(pair(SCREEN, cropOfScreen(...CROP)), pair(cropOfScreen(...CROP), SCREEN)), {}, async ({ page }) => {
    const canvas = (index) => page.locator(".peekaboo-canvas").nth(index);
    assert.deepEqual(await offsetWithin(page.locator("img.peekaboo-after").nth(0), canvas(0)), { x: 120, y: 100, width: 440, height: 300 });
    assert.deepEqual(await offsetWithin(page.locator("img.peekaboo-before").nth(1), canvas(1)), { x: 120, y: 100, width: 440, height: 300 });
    await diffMode(page);
    for (const index of [0, 1]) {
      const seen = await pixels(frame(page, index));
      for (const [x, y] of [[601, 521], [201, 11], [301, 451]]) assert.equal(hatched(seen, x, y), true, `pair ${index + 1}, outside the crop at ${x}, ${y}`);
      assert.equal(hatched(seen, 131, 251), false, `pair ${index + 1}, inside the crop`);
    }
  });
});

// While the worker works the pair waits on Auto, and says so.
test("says it is lining up while the worker reads the screenshots, with Auto pressed", async () => {
  const host = "https://private-user-images.githubusercontent.com/1/";
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const forThePageNow = (png) => (resourceType) => (resourceType === "image" ? png : held.then(() => png));
  const serve = { [`${host}screen.png`]: forThePageNow(draw(800, 600, WHITE, BLOCKS)), [`${host}crop.png`]: forThePageNow(draw(440, 300, WHITE, cropShapes(120, 100))) };
  await withPullRequest(browser, pullRequest(pair(`${host}screen.png`, `${host}crop.png`)), { auto: true, serve }, async ({ page }) => {
    assert.match(await barText(page), /Lining up…/);
    assert.deepEqual(await pressedAlign(page), ["Auto"]);
    release();
    await answered(page);
    assert.doesNotMatch(await barText(page), /Lining up…/);
    assert.deepEqual(await afterShot(page), { x: 120, y: 100, width: 440, height: 300 });
  });
});

// The extension reloaded or removed while the pull request stays open: every message to it throws.
test("with the extension gone from under the open page, pairs are centred and say so, and nothing claims they match", async () => {
  const tall = [...BLOCKS, ...BLOCKS.map(([x, y, w, h, [r, g, b]]) => [(x * 7) % 300, y + 620, w, h, [b, r, g]])];
  const html = pullRequest(
    pair(SCREEN, cropOfScreen(...CROP)),
    pair(SCREEN, SCREEN),
    pair(picture(400, 1200, WHITE, tall), picture(400, 300, WHITE, tall.map(([x, y, ...rest]) => [x, y - 700, ...rest]))),
  );
  await withAuto(html, { disconnected: true }, async ({ page }) => {
    assert.match(await barText(page), /Couldn't line them up; centered instead\./);
    assert.deepEqual(await pressedAlign(page), ["Center"]);
    assert.deepEqual(await afterShot(page), { x: 180, y: 0, width: 440, height: 300 });
    assert.equal(await page.locator(".peekaboo-align").count(), 1, "the same-width pair gets no bar");
    assert.equal(await warnings(page), 0);
    await diffMode(page);
    assert.deepEqual(await visibleTags(page), ["Before", "After", "Before", "After", "Before", "After"]);
  });
});

// The page's own Diff can't line a crop up exactly, so the worker's diff stands in for it, blank or not.
test("Diff shows no colour at all on an exact crop, on the page or in full screen", async () => {
  const coloured = (seen) => {
    let count = 0;
    for (let y = 0; y < seen.height; y++) for (let x = 0; x < seen.width; x++) if (isRed(seen.at(x, y)) || isGreen(seen.at(x, y))) count++;
    return count;
  };
  await withAuto(pullRequest(pair(SCREEN, cropOfScreen(...CROP))), {}, async ({ page }) => {
    await diffMode(page);
    assert.equal(coloured(await pixels(frame(page))), 0, "on the page");
    await page.getByRole("button", { name: "Full screen" }).click();
    assert.equal(coloured(await pixels(page.getByRole("dialog").locator(".peekaboo-frame"))), 0, "in full screen");
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

// Auto is what finds a crop in a same-width pair, so with an edge saved instead, it is a page that got longer.
test("with an edge picked earlier, a same-width crop is top-aligned and gets no bar", async () => {
  const tall = [...BLOCKS, ...BLOCKS.map(([x, y, w, h, [r, g, b]]) => [(x * 7) % 300, y + 620, w, h, [b, r, g]])];
  const html = pullRequest(pair(picture(400, 1200, WHITE, tall), picture(400, 300, WHITE, tall.map(([x, y, ...rest]) => [x, y - 700, ...rest]))));
  await withAuto(html, { before: () => localStorage.setItem("peekaboo-align", "left") }, async ({ page }) => {
    assert.equal(await page.locator(".peekaboo-align").count(), 0);
    assert.equal((await afterShot(page)).y, 0);
  });
});

// A crop's bar has only Auto and Top, so an edge picked on another pair shows there as Top.
test("an edge picked on another pair shows as Top on a same-width crop's bar", async () => {
  const tall = [...BLOCKS, ...BLOCKS.map(([x, y, w, h, [r, g, b]]) => [(x * 7) % 300, y + 620, w, h, [b, r, g]])];
  const html = pullRequest(pair(picture(400, 1200, WHITE, tall), picture(400, 300, WHITE, tall.map(([x, y, ...rest]) => [x, y - 700, ...rest]))), pair(SCREEN, cropOfScreen(...CROP)));
  await withAuto(html, {}, async ({ page }) => {
    await page.locator(".peekaboo-align").nth(1).getByRole("button", { name: "Right" }).click();
    assert.deepEqual(await page.locator(".peekaboo-align").first().getByRole("button", { pressed: true }).allTextContents(), ["Top"]);
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

// The offer is about Auto: once the reviewer picks an edge instead, it goes.
test("without the permission, picking an edge drops the offer to turn Auto-align on", async () => {
  await withAuto(pullRequest(pair(SCREEN, cropOfScreen(...CROP))), { granted: false }, async ({ page }) => {
    await page.getByRole("button", { name: "Left" }).click();
    assert.equal(await page.getByRole("button", { name: "Turn on Auto-align" }).count(), 0);
    assert.doesNotMatch(await barText(page), /Centered for now/);
    assert.deepEqual(await afterShot(page), { x: 0, y: 0, width: 440, height: 300 });
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
    await diffMode(page);
    assert.deepEqual(await visibleTags(page), ["Before", "After"], "without an answer, nothing says which side is the content");
  });
});

// ---------- The same picture ----------

// Diff shows the same blank for "nothing changed" and "uploaded the same file twice". The last pair is the
// same view at two densities, but the normal capture also holds 50 more rows of the page: the part both
// have is the same, the pair isn't.
test("warns when Before and After are the same picture, at one size or two densities, and not when they differ", async () => {
  const small = scaled(BLOCKS, 0.5), retina = picture(800, 600, WHITE, BLOCKS);
  const html = pullRequest(
    pair(SCREEN, SCREEN),
    pair(SCREEN, picture(800, 600, WHITE, [...BLOCKS, [260, 240, 40, 20, BLACK]])),
    pair(retina, picture(400, 300, WHITE, small)),
    pair(retina, picture(400, 350, WHITE, [...small, [100, 310, 200, 30, BLACK]])),
  );
  await withAuto(html, {}, async ({ page }) => {
    const warned = await page.locator(".peekaboo-stage").evaluateAll((stages, text) => stages.map((stage) => stage.innerText.includes(text)), SAME);
    assert.deepEqual(warned, [true, false, true, false]);
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
    assert.deepEqual(await visibleTags(page), ["Before", "Before"], "Flip names the side on screen");
    await diffMode(page);
    for (const [index, theme] of ["dark", "light"].entries()) {
      const seen = await pixels(frame(page, index));
      assert.ok(isRed(seen.at(81, 61)), `${theme}, removed block: ${seen.at(81, 61)}`);
      assert.ok(isGreen(seen.at(81, 181)), `${theme}, added block: ${seen.at(81, 181)}`);
    }
    assert.deepEqual(await page.locator(".peekaboo-tag:visible").allTextContents(), ["Removed", "Added", "Removed", "Added"]);
  });
});

// Already in Diff when the worker's answer arrives: the key changes as it arrives, not at the next click.
test("the key reads Removed and Added as soon as the worker has answered, also when Diff was already on", async () => {
  const html = pullRequest(pair(picture(400, 300, WHITE, [[40, 40, 80, 40, BLACK]]), picture(400, 300, WHITE, [[40, 160, 80, 40, BLACK]])));
  await withAuto(html, { before: () => localStorage.setItem("peekaboo-mode", "diff") }, async ({ page }) => {
    assert.deepEqual(await visibleTags(page), ["Removed", "Added"]);
  });
});

// ---------- Two densities ----------

// The page's own Diff has to erase marks under 2px wide for such a pair (every resampled edge is one), so
// a 1px line on screen can only have come from the worker's diff.
test("a retina capture against a normal one is diffed by the worker, at the size the page shows", async () => {
  const added = [60, 200, 200, 1, BLACK];
  const html = pullRequest(pair(picture(800, 600, WHITE, BLOCKS), picture(400, 300, WHITE, [...scaled(BLOCKS, 0.5), added])));
  await withAuto(html, {}, async ({ page }) => {
    await diffMode(page);
    const seen = await pixels(frame(page));
    assert.ok(isGreen(seen.at(161, 201)), `the added 1px line: ${seen.at(161, 201)}`);
    assert.ok(isNeutral(seen.at(191, 113)), `a block both have: ${seen.at(191, 113)}`);
    assert.equal(await warnings(page), 0);
  });
});
