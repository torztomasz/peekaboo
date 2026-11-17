// What a reviewer gets on a pull request: which tables become a widget, the three modes, and Flip.
// Methodology: each test opens a pull request page (see harness.mjs) whose screenshots are flat colours,
// drives it with real clicks and keys, and checks what is on screen: which controls are pressed, where
// things sit, and the colour Chromium paints inside the frame (white is Before, blue is After).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { image, launch, pair, picture, pixels, pullRequest, settle, table, withPullRequest } from "./harness.mjs";

const WHITE = [255, 255, 255], BLUE = [120, 160, 255];
const beforeShot = picture(400, 300, WHITE), afterShot = picture(400, 300, BLUE);

let browser;
before(async () => (browser = await launch()));
after(() => browser?.close());

const frames = (page) => page.locator(".peekaboo-frame");
const shownColor = async (frame) => (await pixels(frame)).at(200, 150);
const pressed = (page, name) => page.getByRole("button", { name, exact: true, pressed: true }).count();
const visibleTags = (page) => page.locator(".peekaboo-tag:visible").allTextContents();

// ---------- Which tables ----------

test("finds Before and After by header, whatever the column order, and labels the pair from the other columns", async () => {
  const html = pullRequest(table({
    headers: ["", "AFTER: this PR", "Theme", "Before (main)"],
    rows: [["<strong>Mobile</strong>", image(afterShot), "Dark", image(beforeShot)]],
  }));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    assert.equal(await page.locator(".peekaboo figcaption").textContent(), "Mobile · Dark");
    assert.deepEqual(await shownColor(frames(page)), WHITE, "Flip starts on the Before column's screenshot");
  });
});

test("makes one pair per row that has a screenshot on both sides", async () => {
  const html = pullRequest(table({
    rows: [[image(beforeShot), image(afterShot)], [image(beforeShot), "not captured"], ["n/a", "n/a"], [image(beforeShot), image(afterShot)]],
  }));
  await withPullRequest(browser, html, {}, async ({ page }) => assert.equal(await frames(page).count(), 2));
});

test("leaves alone tables that aren't Before/After pairs or aren't in a comment", async () => {
  const bothShots = [[image(beforeShot), image(afterShot)]];
  const html = pullRequest(
    table({ headers: ["Name", "Value"], rows: bothShots }),
    table({ headers: ["Before", "Result"], rows: bothShots }),
    table({ rows: [["old text", "new text"]] }),
  ).replace("</body>", `<div class="file-diff">${pair(beforeShot, afterShot)}</div></body>`);
  await withPullRequest(browser, html, {}, async ({ page }) => {
    assert.equal(await page.locator(".peekaboo").count(), 0);
    assert.equal(await page.locator("table:visible").count(), 4);
  });
});

// "Side by side" promises GitHub's own rendering, so the table must come through byte for byte.
test("keeps GitHub's table as rendered, hidden under the widget, and Side by side brings it back", async () => {
  const noteTable = () => (window.rendered = document.querySelector("table").outerHTML);
  await withPullRequest(browser, pullRequest(pair(beforeShot, afterShot)), { before: noteTable }, async ({ page }) => {
    assert.equal(await page.locator("table").isVisible(), false);
    assert.equal(await frames(page).isVisible(), true);
    await page.getByRole("button", { name: "Side by side" }).click();
    assert.equal(await page.locator("table").isVisible(), true);
    assert.equal(await frames(page).isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Full screen" }).isVisible(), false);
    // All the extension may leave on it is its own "seen this one" mark.
    const now = await page.evaluate(() => {
      const table = document.querySelector("table").cloneNode(true);
      table.removeAttribute("data-peekaboo");
      return [table.outerHTML, window.rendered];
    });
    assert.equal(now[0], now[1]);
  });
});

// ---------- Modes ----------

test("a mode picked on one table applies to every table and is remembered on the next page", async () => {
  const html = pullRequest(pair(beforeShot, afterShot), pair(beforeShot, afterShot));
  await withPullRequest(browser, html, {}, async ({ page, reload }) => {
    assert.equal(await pressed(page, "Flip"), 2, "Flip is the default");
    await page.getByRole("button", { name: "Diff" }).nth(1).click();
    assert.equal(await pressed(page, "Diff"), 2);
    await reload();
    assert.equal(await pressed(page, "Diff"), 2);
    await page.getByRole("button", { name: "Side by side" }).first().click();
    await reload();
    assert.equal(await page.locator("table:visible").count(), 2);
  });
});

test("falls back to Flip when the saved mode is one this version doesn't have", async () => {
  await withPullRequest(browser, pullRequest(pair(beforeShot, afterShot)), {}, async ({ page, reload }) => {
    await page.evaluate(() => localStorage.setItem("peekaboo-mode", "slider"));
    await reload();
    assert.equal(await pressed(page, "Flip"), 1);
    assert.deepEqual(await shownColor(frames(page)), WHITE);
  });
});

// Switching mode resizes every table above the one clicked; without the anchor the pair under review
// jumps off screen. The control assertion proves the layout above really did change.
test("keeps the clicked toolbar where it is on screen while the tables above it resize", async () => {
  const tall = picture(400, 700, WHITE);
  const html = pullRequest(pair(tall, tall), pair(tall, tall), pair(beforeShot, afterShot), "<p style='height: 2000px'>More of the conversation</p>");
  await withPullRequest(browser, html, {}, async ({ page }) => {
    const button = page.getByRole("button", { name: "Side by side" }).nth(2);
    await button.scrollIntoViewIfNeeded();
    const [topBefore, scrollBefore] = [(await button.boundingBox()).y, await page.evaluate(() => scrollY)];
    await button.click();
    assert.ok(Math.abs((await button.boundingBox()).y - topBefore) <= 1, "the toolbar moved on screen");
    assert.notEqual(await page.evaluate(() => scrollY), scrollBefore, "control: the tables above changed height");
  });
});

// ---------- Flip ----------

test("Flip swaps the picture on click, Space and Enter, and says which side is showing", async () => {
  await withPullRequest(browser, pullRequest(pair(beforeShot, afterShot)), {}, async ({ page }) => {
    const frame = frames(page);
    const showing = async () => [await shownColor(frame), await visibleTags(page)];
    assert.deepEqual(await showing(), [WHITE, ["Before"]]);
    await frame.click();
    assert.deepEqual(await showing(), [BLUE, ["After"]]);
    await page.keyboard.press("Space");
    assert.deepEqual(await showing(), [WHITE, ["Before"]]);
    await page.keyboard.press("Enter");
    assert.deepEqual(await showing(), [BLUE, ["After"]]);
  });
});

test("each pair flips on its own", async () => {
  const html = pullRequest(table({ rows: [[image(beforeShot), image(afterShot)], [image(beforeShot), image(afterShot)]] }));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    await frames(page).nth(1).click();
    assert.deepEqual([await shownColor(frames(page).nth(0)), await shownColor(frames(page).nth(1))], [WHITE, BLUE]);
  });
});

// ---------- Recordings ----------

const recording = (name) => `<video src="https://private-user-images.githubusercontent.com/1/${name}.mp4" controls></video>`;
const recordings = pullRequest(table({ rows: [[recording("before"), recording("after")]] }));
// No media is decoded here, so the browser's own playback calls are what gets recorded.
const recordPlayback = () => {
  const proto = HTMLMediaElement.prototype;
  const side = (video) => video.src.match(/(before|after)\.mp4$/)[1];
  const note = (video, call) => window.playback[side(video)].push(call);
  window.playback = { before: [], after: [] };
  proto.play = function () { note(this, "play"); return Promise.resolve(); };
  proto.pause = function () { note(this, "pause"); };
  Object.defineProperty(proto, "currentTime", { set(time) { note(this, `seek ${time}`); }, get: () => 3 });
};

test("recordings get a Play button that starts both from the beginning together, and pauses both", async () => {
  await withPullRequest(browser, recordings, { before: recordPlayback }, async ({ page }) => {
    await page.getByRole("button", { name: "▶ Play" }).click();
    // Per recording, in the order they were made: rewound first, then played.
    const calls = () => page.evaluate(() => ({ before: window.playback.before.splice(0), after: window.playback.after.splice(0) }));
    assert.deepEqual(await calls(), { before: ["seek 0", "play"], after: ["seek 0", "play"] });
    await page.getByRole("button", { name: "❚❚ Pause" }).click();
    assert.deepEqual(await calls(), { before: ["pause"], after: ["pause"] });
    assert.equal(await page.getByRole("button", { name: "▶ Play" }).count(), 1);
  });
  await withPullRequest(browser, pullRequest(pair(beforeShot, afterShot)), {}, async ({ page }) => {
    assert.equal(await page.getByRole("button", { name: "▶ Play" }).count(), 0, "screenshots have nothing to play");
  });
});

// The widget's copies loop silently with no controls of their own; a still-frame blend of two videos
// would mislead, so Diff flips them instead.
test("recordings loop muted without their own controls, and flip in Diff", async () => {
  await withPullRequest(browser, recordings, {}, async ({ page }) => {
    const copies = await page.locator(".peekaboo-frame video").evaluateAll((videos) => videos.map((video) => [video.controls, video.muted, video.loop]));
    assert.deepEqual(copies, [[false, true, true], [false, true, true]]);
    await page.getByRole("button", { name: "Diff" }).click();
    assert.deepEqual(await visibleTags(page), ["Before"]);
    await frames(page).click();
    assert.deepEqual(await visibleTags(page), ["After"]);
  });
});

// ---------- Size on the page ----------

test("shows a small screenshot at its own size and shrinks a wide one to fit the comment", async () => {
  const wide = picture(3000, 300, WHITE);
  const html = pullRequest(pair(beforeShot, afterShot), pair(wide, wide));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    const width = async (index) => (await frames(page).nth(index).locator("img:visible").first().boundingBox()).width;
    assert.equal(await width(0), 400);
    assert.ok((await width(1)) <= 1280 - 32, "the wide pair overflows the comment");
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true, "the page scrolls sideways");
  });
});

// ---------- Privacy ----------

// The README's promise: no analytics, nothing fetched. Every request the page makes other than the pull
// request itself is recorded by the harness, through a session that touches each mode.
test("asks the network for nothing, in any mode", async () => {
  await withPullRequest(browser, pullRequest(pair(beforeShot, afterShot, { caption: "What changed" })), {}, async ({ page, requests }) => {
    await frames(page).click();
    await page.getByRole("button", { name: "Diff" }).click();
    await page.getByRole("button", { name: "Full screen" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Side by side" }).click();
    await settle(page);
    assert.deepEqual(requests, []);
  });
});
