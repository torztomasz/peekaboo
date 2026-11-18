// Diff as the compositor paints it, and how pairs of different sizes are laid out, with no extension
// behind the page (the userscript's situation: no Auto, no worker).
// Methodology: screenshots are white with black blocks at known places, so each test knows which pixels
// were removed, added or left alone. The frame is then captured from Chromium and sampled at those
// places: red, green, or neither. Layout is checked by where the two screenshots sit inside the frame.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isGreen, isNeutral, isRed, launch, offsetWithin, pair, picture, pixels, pullRequest, withPullRequest } from "./harness.mjs";

const WHITE = [255, 255, 255], BLACK = [0, 0, 0];

let browser;
before(async () => (browser = await launch()));
after(() => browser?.close());

const frame = (page) => page.locator(".peekaboo-frame").first();
const shot = (page, side) => frame(page).locator(`img.peekaboo-${side}`);
const diffMode = (page) => page.getByRole("button", { name: "Diff" }).first().click();
const alignButtons = (page) => page.locator(".peekaboo-align").first().getByRole("button");
const coloured = (seen) => {
  let count = 0;
  for (let y = 0; y < seen.height; y++) for (let x = 0; x < seen.width; x++) if (isRed(seen.at(x, y)) || isGreen(seen.at(x, y))) count++;
  return count;
};
// A horizontal run of the frame at row `y`: the hatch is white with thin grey lines, so it has both.
const hatched = (seen, x, y) => {
  const strip = Array.from({ length: 40 }, (_, i) => seen.at(x + i, y)[0]);
  return strip.some((r) => r >= 250) && strip.some((r) => r <= 240);
};
// In full screen the frame is sized from the pair's shape: it keeps that shape and fits in the window.
const fitsFullScreen = async (page, shape) => {
  await page.getByRole("button", { name: "Full screen" }).click();
  const { y, width, height } = await page.getByRole("dialog").locator(".peekaboo-frame").boundingBox();
  await page.keyboard.press("Escape");
  return Math.abs(width / height - shape) < 0.01 && y >= 0 && y + height <= 800;
};

// ---------- Diff ----------

// One block only in Before, one only in After, one in both, a 1px line added, and a patch whose colour
// moves by 2 levels in total, which is what anti-aliasing does between two captures of the same thing.
const KEPT = [200, 40, 80, 40, BLACK];
const scene = {
  before: picture(400, 300, WHITE, [KEPT, [40, 40, 80, 40, BLACK], [200, 160, 80, 40, [200, 200, 200]]]),
  after: picture(400, 300, WHITE, [KEPT, [40, 160, 80, 40, BLACK], [200, 160, 80, 40, [201, 201, 200]], [40, 250, 320, 1, BLACK]]),
};

test("Diff paints what was removed red and what was added green, and fades everything unchanged", async () => {
  await withPullRequest(browser, pullRequest(pair(scene.before, scene.after)), {}, async ({ page }) => {
    await diffMode(page);
    const seen = await pixels(frame(page));
    // The frame has a 1px border, so a screenshot's pixel (x, y) is at (x + 1, y + 1).
    const at = (x, y) => seen.at(x + 1, y + 1);
    assert.ok(isRed(at(80, 60)), `removed block: ${at(80, 60)}`);
    assert.ok(isGreen(at(80, 180)), `added block: ${at(80, 180)}`);
    assert.ok(isNeutral(at(240, 60)) && at(240, 60)[0] > 150, `unchanged block should be a pale ghost: ${at(240, 60)}`);
    assert.ok(isNeutral(at(240, 180)), `2 levels of noise is not a change: ${at(240, 180)}`);
    assert.ok(isNeutral(at(320, 120)), `blank where nothing changed: ${at(320, 120)}`);
  });
});

// A 1px border or a 1px shift is exactly what a reviewer misses, so each change is widened by a pixel.
test("Diff widens a hairline change so it can be seen", async () => {
  await withPullRequest(browser, pullRequest(pair(scene.before, scene.after)), {}, async ({ page }) => {
    await diffMode(page);
    const seen = await pixels(frame(page));
    for (const y of [249, 250, 251]) assert.ok(isGreen(seen.at(201, y + 1)), `row ${y}: ${seen.at(201, y + 1)}`);
    for (const y of [248, 252]) assert.ok(isNeutral(seen.at(201, y + 1)), `row ${y}, a pixel further out: ${seen.at(201, y + 1)}`);
  });
});

test("Diff's key reads Before and After beside red and green until the worker has said which is the content", async () => {
  await withPullRequest(browser, pullRequest(pair(scene.before, scene.after)), {}, async ({ page }) => {
    await diffMode(page);
    assert.deepEqual(await page.locator(".peekaboo-tag:visible").allTextContents(), ["Before", "After"]);
    assert.equal(await page.getByText("Click to flip").isVisible(), false);
  });
});

// ---------- Two sizes ----------

// At two densities every edge that falls between two pixels of the smaller capture is drawn differently by
// each (here the 2x blocks start on odd device pixels), and Diff must not mark those; a real change of a
// few pixels still shows. Diff adds nothing to the page's height either.
test("Diff of a retina capture and a normal one marks a real change but not edges between pixels", async () => {
  const blocks = [[101, 61, 200, 100], [401, 301, 120, 60], [151, 401, 300, 41]];
  const retina = picture(800, 600, WHITE, blocks.map((block) => [...block, BLACK]));
  // The same blocks at 1x: whole pixels black, the half pixel on each side mid-grey.
  const normal = picture(400, 300, WHITE, [
    ...blocks.map(([x, y, w, h]) => [(x - 1) / 2, (y - 1) / 2, (w + 2) / 2, (h + 2) / 2, [128, 128, 128]]),
    ...blocks.map(([x, y, w, h]) => [(x + 1) / 2, (y + 1) / 2, (w - 2) / 2, (h - 2) / 2, BLACK]),
    [300, 60, 8, 8, BLACK],
  ]);
  await withPullRequest(browser, pullRequest(pair(retina, normal)), {}, async ({ page }) => {
    const pageHeight = () => page.evaluate(() => document.body.getBoundingClientRect().height);
    const heightInFlip = await pageHeight();
    await diffMode(page);
    const seen = await pixels(frame(page));
    assert.ok(isGreen(seen.at(305, 65)), `the added block: ${seen.at(305, 65)}`);
    const elsewhere = coloured(seen) - coloured({ width: 16, height: 16, at: (x, y) => seen.at(296 + x, 56 + y) });
    assert.equal(elsewhere, 0, "edges marked as changes");
    assert.equal(await pageHeight(), heightInFlip);
  });
});

test("scales a retina capture and a normal one of the same view to one size, with nothing to line up", async () => {
  const html = pullRequest(pair(picture(800, 600, WHITE), picture(400, 300, WHITE)));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    const size = { x: 0, y: 0, width: 400, height: 300 };
    assert.deepEqual(await offsetWithin(shot(page, "before"), frame(page).locator(".peekaboo-canvas")), size);
    assert.deepEqual(await offsetWithin(shot(page, "after"), frame(page).locator(".peekaboo-canvas")), size);
    assert.equal(await page.locator(".peekaboo-align").count(), 0);
  });
});

const wideAndNarrow = pair(picture(400, 300, WHITE), picture(300, 300, [120, 160, 255]));

// On an ordinary Chrome page, where the userscript runs, `chrome` exists but has no extension runtime.
test("two window widths keep one pixel scale and line up by Left, Center or Right; Auto needs the extension", async () => {
  await withPullRequest(browser, pullRequest(wideAndNarrow), { before: () => (window.chrome = { app: {} }) }, async ({ page }) => {
    const canvas = frame(page).locator(".peekaboo-canvas");
    const placed = async () => [await offsetWithin(shot(page, "before"), canvas), await offsetWithin(shot(page, "after"), canvas)];
    const wide = { x: 0, y: 0, width: 400, height: 300 };
    assert.match(await page.locator(".peekaboo-align").textContent(), /Different sizes \(before 400 × 300, after 300 × 300\)/);
    assert.deepEqual(await alignButtons(page).allTextContents(), ["Left", "Center", "Right"]);
    assert.deepEqual(await placed(), [wide, { x: 0, y: 0, width: 300, height: 300 }]);
    await page.getByRole("button", { name: "Right" }).click();
    assert.deepEqual(await placed(), [wide, { x: 100, y: 0, width: 300, height: 300 }]);
    await page.getByRole("button", { name: "Center" }).click();
    assert.deepEqual(await placed(), [wide, { x: 50, y: 0, width: 300, height: 300 }]);
  });
});

// The shared canvas is as wide as the wider side and as tall as the taller, whichever column each is in.
test("the narrower side is the one that moves, whichever column it is in", async () => {
  const html = pullRequest(pair(picture(300, 300, WHITE), picture(400, 350, WHITE)));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    assert.equal((await frame(page).boundingBox()).width, 402, "the frame holds the wider side and its 1px border");
    assert.ok(await fitsFullScreen(page, 400 / 350), "the canvas's shape, in full screen");
    await page.getByRole("button", { name: "Right" }).click();
    const canvas = frame(page).locator(".peekaboo-canvas");
    assert.deepEqual(await offsetWithin(shot(page, "before"), canvas), { x: 100, y: 0, width: 300, height: 300 });
    assert.deepEqual(await offsetWithin(shot(page, "after"), canvas), { x: 0, y: 0, width: 400, height: 350 });
  });
});

// Two window widths where the narrower is the right-hand part of the wider, either way round. Placed at
// Right, the block both have lines up and shows no change, and a block only the narrower has is coloured
// where it sits: green when it is After, red when it is Before.
test("Diff compares a pair where it is placed, not where each screenshot starts", async () => {
  const wide = picture(400, 300, WHITE, [[150, 100, 60, 40, BLACK]]);
  const narrow = picture(300, 300, WHITE, [[50, 100, 60, 40, BLACK], [200, 200, 40, 20, BLACK]]);
  await withPullRequest(browser, pullRequest(pair(wide, narrow), pair(narrow, wide)), {}, async ({ page }) => {
    await page.getByRole("button", { name: "Right" }).first().click();
    await diffMode(page);
    for (const [index, onlyNarrow] of [[0, isGreen], [1, isRed]]) {
      const seen = await pixels(page.locator(".peekaboo-frame").nth(index));
      assert.ok(isNeutral(seen.at(181, 121)), `pair ${index + 1}, the block both have: ${seen.at(181, 121)}`);
      assert.ok(onlyNarrow(seen.at(321, 211)), `pair ${index + 1}, the block only the narrower has: ${seen.at(321, 211)}`);
    }
  });
});

test("an alignment picked on one pair applies to every pair and is remembered on the next page", async () => {
  await withPullRequest(browser, pullRequest(wideAndNarrow, wideAndNarrow), {}, async ({ page, reload }) => {
    const pressedRight = () => page.getByRole("button", { name: "Right", pressed: true }).count();
    const secondAfter = () => offsetWithin(page.locator("img.peekaboo-after").nth(1), page.locator(".peekaboo-canvas").nth(1));
    await page.getByRole("button", { name: "Right" }).first().click();
    assert.equal(await pressedRight(), 2);
    assert.equal((await secondAfter()).x, 100);
    await reload();
    assert.equal(await pressedRight(), 2);
    assert.equal((await secondAfter()).x, 100);
  });
});

// Only the overlap can be compared. Before is wider here and has a block in the part After doesn't reach:
// painting that red would claim it was removed, when After never showed that part of the page.
test("Diff compares only where both screenshots reach and hatches the rest as Not compared", async () => {
  const before = picture(400, 300, WHITE, [[40, 40, 80, 40, BLACK], [320, 120, 60, 60, BLACK]]);
  const after = picture(300, 300, WHITE);
  await withPullRequest(browser, pullRequest(pair(before, after)), {}, async ({ page }) => {
    assert.equal(await page.getByText("Not compared").isVisible(), false, "the key belongs to Diff");
    await diffMode(page);
    const seen = await pixels(frame(page));
    assert.ok(isRed(seen.at(81, 61)), `removed inside the overlap: ${seen.at(81, 61)}`);
    // Outside the overlap, through Before's block: a row of the hatch, which is white with thin grey lines.
    const strip = Array.from({ length: 40 }, (_, x) => seen.at(321 + x, 151));
    assert.ok(!strip.some((rgb) => isRed(rgb) || isGreen(rgb)), `no red or green outside the overlap: ${strip}`);
    assert.ok(strip.some(([r]) => r >= 250) && strip.some(([r]) => r <= 240), `hatched, not blank: ${strip.map(([r]) => r)}`);
    assert.equal(await page.getByText("Not compared").isVisible(), true);
  });
});

// A page that got longer: same width, so the top is where they line up and there is nothing to choose.
// Showing Before, the taller After must not peek out below it; in Diff, the rows only After has are hatched.
test("same width and different heights are top-aligned in a frame as tall as the taller, without alignment buttons", async () => {
  const BLUE = [120, 160, 255];
  const html = pullRequest(pair(picture(400, 300, WHITE), picture(400, 500, BLUE)));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    const canvas = frame(page).locator(".peekaboo-canvas");
    assert.deepEqual(await offsetWithin(shot(page, "before"), canvas), { x: 0, y: 0, width: 400, height: 300 });
    assert.deepEqual(await offsetWithin(shot(page, "after"), canvas), { x: 0, y: 0, width: 400, height: 500 });
    assert.equal(await page.locator(".peekaboo-align").count(), 0);
    assert.notDeepEqual((await pixels(frame(page))).at(201, 401), BLUE, "After shows below Before");
    assert.ok(await fitsFullScreen(page, 400 / 500), "the canvas's shape, in full screen");
    await frame(page).click();
    assert.equal((await frame(page).boundingBox()).height, 502, "the frame keeps the taller screenshot's height on either side");
    await diffMode(page);
    assert.ok(hatched(await pixels(frame(page)), 101, 401), "the rows only After has are hatched");
  });
});
