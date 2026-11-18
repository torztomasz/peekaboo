// Full screen: one pair at a time, the keyboard as the way through a pull request's pairs, and a dialog
// that takes over the page and gives it back as it was.
// Methodology: a pull request with three pairs in two comments (the first table has a label column and a
// caption) is driven with real keys and clicks. Checks read what the dialog shows (counter, title,
// caption, the colour in the frame: white is Before, blue is After) and where focus and the pairs end up.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { image, launch, pair, picture, pixels, pullRequest, settle, table, withPullRequest } from "./harness.mjs";

const WHITE = [255, 255, 255], BLUE = [120, 160, 255];
const beforeShot = picture(400, 300, WHITE), afterShot = picture(400, 300, BLUE);
const CAPTION = "The header no longer overlaps the title.";
const labelled = table({
  headers: ["Viewport", "Before", "After"],
  rows: [["Desktop", image(beforeShot), image(afterShot)], ["Mobile", image(beforeShot), image(afterShot)]],
  caption: CAPTION,
});
const threePairs = pullRequest(labelled, pair(beforeShot, afterShot));

let browser;
before(async () => (browser = await launch()));
after(() => browser?.close());

const dialog = (page) => page.getByRole("dialog");
const open = (page, widget = 0) => page.getByRole("button", { name: "Full screen" }).nth(widget).click();
const colorIn = async (frame) => {
  const seen = await pixels(frame);
  return seen.at(seen.width >> 1, seen.height >> 1);
};
// [counter, title, caption], with null for a part that isn't shown.
async function showing(page) {
  const text = async (part) => ((await dialog(page).locator(`.peekaboo-viewer-${part}`).isVisible()) ? dialog(page).locator(`.peekaboo-viewer-${part}`).textContent() : null);
  return [await text("counter"), await text("title"), await text("caption")];
}

test("steps through every pair on the page in order, across tables, wrapping at both ends", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    await open(page, 1);
    assert.deepEqual(await showing(page), ["3 / 3", null, null], "opens on the pair whose table was clicked");
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await showing(page), ["1 / 3", "Desktop", CAPTION]);
    await dialog(page).getByRole("button", { name: "Next pair (→)" }).click();
    assert.deepEqual(await showing(page), ["2 / 3", "Mobile", CAPTION]);
    await dialog(page).getByRole("button", { name: "Previous pair (←)" }).click();
    await page.keyboard.press("ArrowLeft");
    assert.deepEqual(await showing(page), ["3 / 3", null, null]);
  });
});

// GitHub drops and re-renders comments without a page load; a pair whose table is gone must not come back.
test("leaves out pairs whose table has left the page", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    await page.evaluate(() => document.querySelectorAll(".timeline-item")[1].remove());
    await settle(page);
    await open(page);
    assert.equal((await showing(page))[0], "1 / 2");
  });
});

test("1 and 2 switch every pair between Flip and Diff, and Space flips the pair on screen", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    const pressed = (scope, name) => scope.getByRole("button", { name, exact: true, pressed: true }).count();
    await open(page);
    await page.keyboard.press("2");
    assert.equal(await pressed(dialog(page), "Diff"), 1);
    await page.keyboard.press("Escape");
    assert.equal(await pressed(page, "Diff"), 2, "both tables behind the dialog switched too");
    await open(page);
    await page.keyboard.press("1");
    assert.equal(await pressed(dialog(page), "Flip"), 1);
    await page.keyboard.press("Space");
    assert.deepEqual(await colorIn(dialog(page).locator(".peekaboo-frame")), BLUE);
  });
});

// A clicked button would keep focus and take Space for itself.
// The dialog's own Flip and Diff do what 1 and 2 do, and say which is on. A clicked button would keep
// focus and take Space and Enter for itself, so after a click both still flip the pair.
test("the dialog's Flip and Diff buttons switch every pair, and Space and Enter still flip after a click", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    const pressedInDialog = () => dialog(page).getByRole("button", { pressed: true }).allTextContents();
    await open(page);
    assert.deepEqual(await pressedInDialog(), ["Flip"]);
    await dialog(page).getByRole("button", { name: "Diff", exact: true }).click();
    assert.deepEqual(await pressedInDialog(), ["Diff"]);
    await dialog(page).getByRole("button", { name: "Flip", exact: true }).click();
    assert.deepEqual(await pressedInDialog(), ["Flip"]);
    await page.keyboard.press("Space");
    assert.deepEqual(await colorIn(dialog(page).locator(".peekaboo-frame")), BLUE);
    await dialog(page).getByRole("button", { name: "Next pair (→)" }).click();
    await page.keyboard.press("Enter");
    assert.deepEqual([await showing(page), await colorIn(dialog(page).locator(".peekaboo-frame"))], [["2 / 3", "Mobile", CAPTION], BLUE]);
  });
});

// The keys are the fast way through a pull request's pairs, and tooltips only tell people who hover. In
// Diff, Space has nothing to flip and Shift shows After, whether Diff was on before opening or not.
test("lists its keys, as they work in Flip and in Diff", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    const keys = () => dialog(page).locator(".peekaboo-viewer-key:visible").allTextContents();
    const inFlip = ["←→ pair", "Space flip", "Shift hold to peek", "12 Flip / Diff", "Esc close"];
    const inDiff = ["←→ pair", "Shift hold for After", "12 Flip / Diff", "Esc close"];
    await open(page);
    assert.deepEqual(await keys(), inFlip);
    await page.keyboard.press("2");
    assert.deepEqual(await keys(), inDiff);
    await page.keyboard.press("Escape");
    await open(page);
    assert.deepEqual(await keys(), inDiff, "opened in Diff");
  });
});

// GitHub re-renders a comment by building it anew; the pairs still come in page order.
test("steps through the pairs in page order after GitHub re-renders a comment above", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    await page.evaluate((html) => (document.querySelector(".markdown-body").innerHTML = html), labelled);
    await settle(page);
    await open(page, 1);
    assert.deepEqual(await showing(page), ["3 / 3", null, null]);
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await showing(page), ["1 / 3", "Desktop", CAPTION]);
  });
});

// PR authors put one italic line under a table to say what it fixes; other text there isn't its caption.
test("takes as a pair's caption only an italic line of its own right under the table", async () => {
  const shots = [[image(beforeShot), image(afterShot)]];
  const html = pullRequest(
    `${table({ rows: shots })}<p dir="auto"><em>Only part</em> of this line is italic</p>`,
    `${table({ rows: shots })}<p dir="auto">Plain text under the table</p>`,
    `${table({ rows: shots })}<p dir="auto"><strong>Bold, not italic</strong></p>`,
    `${table({ rows: shots })}<div><em>Italic, but not a paragraph</em></div>`,
    pair(beforeShot, afterShot, { caption: CAPTION }),
  );
  await withPullRequest(browser, html, {}, async ({ page }) => {
    await open(page);
    const captions = [];
    for (let i = 0; i < 5; i++) {
      captions.push((await showing(page))[2]);
      await page.keyboard.press("ArrowRight");
    }
    assert.deepEqual(captions, [null, null, null, null, CAPTION]);
  });
});

test("its buttons show their icons, and Close closes", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    // Pixels darker than the border (#d1d9e0) in the button, or in its first `width` pixels from the left.
    const inked = async (button, width = Infinity) => {
      const seen = await pixels(button);
      let dark = 0;
      for (let y = 0; y < seen.height; y++) for (let x = 0; x < Math.min(width, seen.width); x++) if (seen.at(x, y)[0] < 180) dark++;
      return dark;
    };
    // The page's button has its 16px icon left of the label, after 10px of padding and before a 6px gap.
    const expand = page.getByRole("button", { name: "Full screen", exact: true }).first();
    const labelStarts = await expand.evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button.lastChild);
      return range.getBoundingClientRect().left - button.getBoundingClientRect().left;
    });
    assert.ok(labelStarts >= 32 && (await inked(expand, 27)) > 10, `Full screen has an icon beside its label (label at ${labelStarts})`);
    await expand.click();
    for (const name of ["Previous pair (←)", "Next pair (→)", "Close (Esc)"]) {
      const button = dialog(page).getByRole("button", { name });
      assert.ok((await inked(button)) > 10 && (await button.innerText()) === "", `${name} has an icon and no text`);
    }
    await dialog(page).getByRole("button", { name: "Close (Esc)" }).click();
    assert.equal(await dialog(page).count(), 0);
  });
});

test("the side a pair shows carries into full screen and back out", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    await page.locator(".peekaboo-frame").first().click();
    await open(page);
    assert.deepEqual(await colorIn(dialog(page).locator(".peekaboo-frame")), BLUE);
    await page.keyboard.press("Space");
    await page.keyboard.press("Escape");
    assert.deepEqual(await colorIn(page.locator(".peekaboo-frame").first()), WHITE);
  });
});

test("Shift peeks at the pair on screen, wherever the mouse is", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    await open(page);
    await page.mouse.move(5, 5);
    await page.keyboard.down("Shift");
    assert.deepEqual(await colorIn(dialog(page).locator(".peekaboo-frame")), BLUE);
    await page.keyboard.up("Shift");
    assert.deepEqual(await colorIn(dialog(page).locator(".peekaboo-frame")), WHITE);
  });
});

// ---------- Taking over the page, and giving it back ----------

test("Esc closes, puts each pair back in its place, lets the page scroll again and returns focus to the button that opened it", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    const pageScrolls = () => page.evaluate(() => getComputedStyle(document.documentElement).overflow !== "hidden");
    await open(page);
    assert.equal(await dialog(page).getAttribute("aria-modal"), "true");
    assert.equal(await pageScrolls(), false);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");
    assert.equal(await dialog(page).count(), 0);
    assert.deepEqual(await page.locator(".peekaboo").first().locator("figcaption").allTextContents(), ["Desktop", "Mobile"]);
    assert.equal(await page.locator(".peekaboo").nth(1).locator(".peekaboo-frame").count(), 1);
    assert.equal(await pageScrolls(), true);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".peekaboo-expand")), true);
  });
});

// Closing on a pair far from where the viewer was opened: the reviewer lands on that pair, not back up the page.
test("closing on another pair scrolls to it and focuses it", async () => {
  const farApart = pullRequest(pair(beforeShot, afterShot), "<p style='height: 3000px'>A long discussion</p>", pair(beforeShot, afterShot));
  await withPullRequest(browser, farApart, {}, async ({ page }) => {
    await open(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    const last = page.locator(".peekaboo-frame").nth(1);
    const { y, height } = await last.boundingBox();
    assert.ok(y >= 0 && y + height <= 800, `the pair is at ${y}, off screen`);
    assert.equal(await last.evaluate((frame) => document.activeElement === frame), true);
  });
});

// The dialog opens with the pair focused; Tab walks its controls in order and wraps around, both ways.
test("Tab and Shift+Tab stay inside the dialog, going round its controls in order", async () => {
  await withPullRequest(browser, threePairs, {}, async ({ page }) => {
    await open(page);
    const focused = () => page.evaluate(() => {
      const node = document.activeElement;
      if (!node.closest("[role=dialog]")) return "outside the dialog";
      return node.getAttribute("aria-label") ?? (node.tagName === "BUTTON" ? node.textContent : "the pair");
    });
    const after = async (key, times) => {
      const seen = [];
      for (let i = 0; i < times; i++) {
        await page.keyboard.press(key);
        seen.push(await focused());
      }
      return seen;
    };
    assert.equal(await focused(), "the pair");
    assert.deepEqual(await after("Tab", 7), ["Previous pair (←)", "Next pair (→)", "Flip", "Diff", "Close (Esc)", "the pair", "Previous pair (←)"]);
    assert.deepEqual(await after("Shift+Tab", 3), ["the pair", "Close (Esc)", "Diff"]);
  });
});

// Closing on the first pair, opened from one lower down: the opener is now below the screen, so focus
// goes to the pair the reviewer was looking at.
test("closing on the first pair, opened from further down, scrolls to it and focuses it", async () => {
  const farApart = pullRequest(pair(beforeShot, afterShot), "<p style='height: 3000px'>A long discussion</p>", pair(beforeShot, afterShot));
  await withPullRequest(browser, farApart, {}, async ({ page }) => {
    await open(page, 1);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");
    const first = page.locator(".peekaboo-frame").first();
    const { y, height } = await first.boundingBox();
    assert.ok(y >= 0 && y + height <= 800, `the pair is at ${y}, off screen`);
    assert.equal(await first.evaluate((frame) => document.activeElement === frame), true);
  });
});

// GitHub binds single keys (arrows, digits, Esc) on pull request pages.
test("the page behind never sees the keys the viewer handles", async () => {
  const listen = () => {
    window.heard = [];
    document.addEventListener("keydown", (event) => window.heard.push(event.key));
  };
  await withPullRequest(browser, threePairs, { before: listen }, async ({ page }) => {
    await open(page);
    for (const key of ["ArrowRight", "ArrowLeft", "2", "1", "Space", "Escape"]) await page.keyboard.press(key);
    assert.deepEqual(await page.evaluate(() => window.heard), []);
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await page.evaluate(() => window.heard), ["ArrowRight"], "control: once closed, keys reach the page again");
  });
});

test("fits a tall pair and its caption in the window, and enlarges a small one", async () => {
  const tall = picture(600, 2400, WHITE), small = picture(200, 100, WHITE);
  const html = pullRequest(pair(tall, tall, { caption: CAPTION }), pair(small, small));
  await withPullRequest(browser, html, {}, async ({ page }) => {
    await open(page);
    const frame = await dialog(page).locator(".peekaboo-frame").boundingBox();
    const caption = await dialog(page).locator(".peekaboo-viewer-caption").boundingBox();
    assert.ok(frame.y >= 0 && caption.y >= frame.y + frame.height && caption.y + caption.height <= 800, JSON.stringify({ frame, caption }));
    assert.ok(Math.abs(frame.width / frame.height - 600 / 2400) < 0.01, "the screenshot keeps its shape");
    assert.ok(frame.height > 500, "and uses the room there is");
    await page.keyboard.press("ArrowRight");
    const enlarged = await dialog(page).locator(".peekaboo-frame").boundingBox();
    assert.ok(enlarged.width > 800 && enlarged.width <= 1280 && enlarged.height <= 800, JSON.stringify(enlarged));
  });
});
