// The content script on a GitHub-like conversation, in headless Chromium (npm run test:browser). These pin
// what the page-watching code must keep doing however it decides when to re-scan: tables that arrive
// later, comments GitHub re-renders, tables it removes, and Flip. Methodology: the page is mutated the
// way GitHub does it, then the widgets in the DOM are counted after the script has had its frame.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { conversation, openConversation, pairTable, settle } from "../../bench/github-page.mjs";

let browser, page;
before(async () => ({ browser, page } = await openConversation(conversation({ comments: 20, every: 10 }))));
after(() => browser?.close());

const widgets = () => page.evaluate(() => document.querySelectorAll(".peekaboo").length);

test("turns each Before/After table into a widget and leaves other tables alone", async () => {
  assert.equal(await widgets(), 2);
  assert.equal(await page.evaluate(() => document.querySelectorAll("table:not([hidden])").length), 1);
});

test("picks up a comment that arrives later, table nested inside it", async () => {
  await page.evaluate((table) => {
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.innerHTML = `<div class="markdown-body">${table}</div>`;
    document.querySelector(".timeline").append(item);
  }, pairTable("#fed"));
  await settle(page);
  assert.equal(await widgets(), 3);
});

test("rebuilds a comment GitHub re-renders, without leaving the old widget", async () => {
  await page.evaluate((table) => (document.querySelector("#item-9 .markdown-body").innerHTML = table), pairTable("#efe"));
  await settle(page);
  assert.equal(await widgets(), 3);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#item-9 .peekaboo").length), 1);
});

test("drops a widget whose table GitHub removed", async () => {
  await page.evaluate(() => document.querySelector("#item-19 markdown-accessiblity-table").remove());
  await settle(page);
  assert.equal(await widgets(), 2);
});

test("Flip blinks between before and after", async () => {
  const showing = () => page.evaluate(() => document.querySelector(".peekaboo-frame").dataset.showing);
  assert.equal(await showing(), "before");
  await page.locator(".peekaboo-frame").first().dispatchEvent("pointerdown");
  assert.equal(await showing(), "after");
});

// The ratchet on the cost every GitHub tab pays: the page mutates constantly for reasons that have nothing
// to do with tables (times ticking, reactions, hovercards, our own Flip), and none of that may cost a scan
// of the whole document. Counted by wrapping querySelectorAll before the script loads.
test("unrelated page churn and Flip never re-scan the page", async () => {
  const counted = await openConversation(conversation({ comments: 20, every: 10 }), {
    before: () => {
      window.scans = 0;
      for (const proto of [Document.prototype, Element.prototype]) {
        const original = proto.querySelectorAll;
        proto.querySelectorAll = function (...args) { window.scans++; return original.apply(this, args); };
      }
    },
  });
  try {
    const scansAfterLoad = await counted.page.evaluate(() => window.scans);
    await counted.page.evaluate(() => {
      for (const [index, item] of Array.from(document.getElementsByClassName("timeline-item")).entries()) {
        item.getElementsByTagName("relative-time")[0].textContent = `${index} seconds ago`;
        const card = document.createElement("div");
        card.innerHTML = "<img alt=''><span>user</span>";
        document.body.append(card);
        card.remove();
      }
      document.getElementsByClassName("peekaboo-frame")[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await settle(counted.page);
    assert.equal(await counted.page.evaluate(() => window.scans), scansAfterLoad);
  } finally {
    await counted.browser.close();
  }
});

// ---------- Hold to peek ----------

async function withPage(run) {
  const opened = await openConversation(conversation({ comments: 20, every: 10 }));
  try {
    await run(opened.page);
  } finally {
    await opened.browser.close();
  }
}

test("holding Shift over a pair shows the other side, and letting go comes back", async () => {
  await withPage(async (page) => {
    const frame = page.locator(".peekaboo-frame").first();
    const state = () => frame.evaluate((node) => `${node.dataset.mode}:${node.dataset.showing}`);
    await frame.hover();
    await page.keyboard.down("Shift");
    assert.equal(await state(), "flip:after");
    await page.keyboard.up("Shift");
    assert.equal(await state(), "flip:before");
    await page.getByRole("button", { name: "Diff" }).first().click();
    await frame.hover();
    await page.keyboard.down("Shift");
    assert.equal(await state(), "flip:after");
    await page.keyboard.up("Shift");
    assert.equal(await frame.evaluate((node) => node.dataset.mode), "diff");
  });
});

test("a click while peeking in Diff doesn't change which side Flip shows later", async () => {
  await withPage(async (page) => {
    const frame = page.locator(".peekaboo-frame").first();
    await page.getByRole("button", { name: "Diff" }).first().click();
    await frame.hover();
    await page.keyboard.down("Shift");
    await frame.dispatchEvent("pointerdown");
    await page.keyboard.up("Shift");
    await page.getByRole("button", { name: "Flip" }).first().click();
    assert.equal(await frame.evaluate((node) => node.dataset.showing), "before");
  });
});
