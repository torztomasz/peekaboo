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
    assert.ok(isNeutral(seen.at(201, 254 + 1)), "but not by more than a pixel");
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

test("two window widths keep one pixel scale and line up by Left, Center or Right; Auto needs the extension", async () => {
  await withPullRequest(browser, pullRequest(wideAndNarrow), {}, async ({ page }) => {
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

test("the narrower side is the one that moves, whichever column it is in", async () => {
  const html = pullRequest(pair(picture(300, 300, WHITE), picture(400, 300, WHITE)));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    await page.getByRole("button", { name: "Right" }).click();
    const canvas = frame(page).locator(".peekaboo-canvas");
    assert.equal((await offsetWithin(shot(page, "before"), canvas)).x, 100);
    assert.equal((await offsetWithin(shot(page, "after"), canvas)).x, 0);
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
    assert.ok(isNeutral(seen.at(351, 151)), `outside the overlap: ${seen.at(351, 151)}`);
    assert.equal(await page.getByText("Not compared").isVisible(), true);
  });
});

// A page that got longer: same width, so the top is where they line up and there is nothing to choose.
test("same width and different heights are top-aligned in a frame as tall as the taller, without alignment buttons", async () => {
  const html = pullRequest(pair(picture(400, 300, WHITE), picture(400, 500, WHITE)));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    const canvas = frame(page).locator(".peekaboo-canvas");
    assert.deepEqual(await offsetWithin(shot(page, "before"), canvas), { x: 0, y: 0, width: 400, height: 300 });
    assert.deepEqual(await offsetWithin(shot(page, "after"), canvas), { x: 0, y: 0, width: 400, height: 500 });
    assert.equal(await page.locator(".peekaboo-align").count(), 0);
    await frame(page).click();
    assert.equal((await frame(page).boundingBox()).height, 502, "the frame keeps the taller screenshot's height on either side");
  });
});
