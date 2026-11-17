// The welcome and settings page, where Auto-align's one optional permission is granted and taken back.
// Methodology: options.html is served as shipped, with its script built from src/options.ts, behind a
// stand-in `chrome` that records what the page asks Chrome for and answers as Chrome would (granting or
// refusing). The hosts it may ask for are written out here, not imported: they are the privacy promise.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { WAIT_MS, built, launch } from "./harness.mjs";

const ORIGIN = "https://peekaboo.test";
const IMAGE_HOSTS = { origins: ["https://private-user-images.githubusercontent.com/*", "https://user-images.githubusercontent.com/*"] };
const file = (path) => readFileSync(new URL(`../../${path}`, import.meta.url));

let browser;
before(async () => (browser = await launch()));
after(() => browser?.close());

// `on`: whether Auto-align is already allowed. `chromeAllows`: what Chrome's prompt answers.
async function withSettings(query, { on = false, chromeAllows = true }, run) {
  const context = await browser.newContext();
  context.setDefaultTimeout(WAIT_MS);
  await context.route("**/*", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/options.html") return route.fulfill({ contentType: "text/html", body: file("options.html") });
    if (pathname === "/dist/options.js") return route.fulfill({ contentType: "text/javascript", body: await built("options.ts") });
    if (pathname === "/icons/icon-128.png") return route.fulfill({ contentType: "image/png", body: file("icons/icon-128.png") });
    return route.fulfill({ status: 404, body: "not part of the extension" });
  });
  await context.addInitScript(({ on, chromeAllows }) => {
    const asked = (window.asked = { checked: [], requested: [], removed: [], activated: [], closed: 0 });
    window.chrome = {
      permissions: {
        contains: async (permissions) => { asked.checked.push(permissions); return on; },
        request: async (permissions) => { asked.requested.push(permissions); return (on = chromeAllows); },
        remove: async (permissions) => { asked.removed.push(permissions); on = false; return true; },
      },
      tabs: { update: async (...args) => asked.activated.push(args) },
    };
    window.close = () => asked.closed++;
  }, { on, chromeAllows });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(String(error)));
  page.on("response", (response) => response.status() === 404 && failures.push(`missing ${response.url()}`));
  try {
    await page.goto(`${ORIGIN}/options.html${query}`);
    await page.getByText(/^(On|Off):/).waitFor();
    await run(page);
    assert.deepEqual(failures, []);
  } finally {
    await context.close();
  }
}

const heading = async (page) => [await page.getByRole("heading", { level: 1 }).textContent(), await page.locator("#lede").textContent()];
const focused = (page) => page.evaluate(() => document.activeElement.textContent);
const state = (page) => page.locator("#stateText").textContent();
const buttons = (page) => page.getByRole("button").filter({ visible: true }).allTextContents();
const asked = (page) => page.evaluate(() => window.asked);

test("greets a new install, a visit from the toolbar and a visit from a pull request each in its own words", async () => {
  await withSettings("?welcome", {}, async (page) => {
    assert.deepEqual(await heading(page), ["Peekaboo is ready", "Open a GitHub pull request with Before and After screenshots. Click one to flip between them."]);
  });
  await withSettings("", {}, async (page) => {
    assert.deepEqual(await heading(page), ["Peekaboo", "Flip and diff the Before and After screenshots in GitHub pull requests."]);
    assert.notEqual(await focused(page), "Turn on Auto-align", "nothing is pre-selected on a plain visit");
  });
  await withSettings("?from=7", {}, async (page) => {
    assert.equal((await heading(page))[0], "Line up these screenshots");
    assert.match((await heading(page))[1], /Turn on Auto-align and Peekaboo takes you back with them lined up\.$/);
    assert.equal(await focused(page), "Turn on Auto-align", "the one step is ready under Enter");
  });
});

// The switch must show the state of the permission Auto-align actually uses.
test("reads whether Auto-align is on from the permission for GitHub's two image hosts", async () => {
  await withSettings("", { on: true }, async (page) => {
    assert.match(await state(page), /^On:/);
    assert.deepEqual((await asked(page)).checked, [IMAGE_HOSTS]);
  });
});

test("Turn on asks Chrome for GitHub's two image hosts and nothing else, then shows Auto-align as on", async () => {
  await withSettings("", {}, async (page) => {
    assert.match(await state(page), /^Off:/);
    assert.deepEqual(await buttons(page), ["Turn on Auto-align"]);
    await page.getByRole("button", { name: "Turn on Auto-align" }).click();
    await page.getByText(/^On\. /).waitFor();
    assert.deepEqual((await asked(page)).requested, [IMAGE_HOSTS]);
    assert.match(await state(page), /^On:/);
    assert.deepEqual(await buttons(page), ["Turn off"]);
    assert.deepEqual([(await asked(page)).activated, (await asked(page)).closed], [[], 0], "not from a pull request: stays open");
  });
});

test("from a pull request, turning it on goes back to that tab and closes the settings", async () => {
  await withSettings("?from=7", {}, async (page) => {
    await page.getByRole("button", { name: "Turn on Auto-align" }).click();
    await page.getByText("On. Taking you back to the pull request…").waitFor();
    await page.waitForFunction(() => window.asked.closed === 1);
    assert.deepEqual((await asked(page)).activated, [[7, { active: true }]]);
  });
});

test("when Chrome refuses, it says so, stays off and stays open", async () => {
  await withSettings("?from=7", { chromeAllows: false }, async (page) => {
    await page.getByRole("button", { name: "Turn on Auto-align" }).click();
    await page.getByText("Chrome didn't allow it.", { exact: false }).waitFor();
    assert.match(await state(page), /^Off:/);
    assert.deepEqual(await buttons(page), ["Turn on Auto-align"]);
    assert.deepEqual([(await asked(page)).activated, (await asked(page)).closed], [[], 0]);
  });
});

test("Turn off gives the permission back", async () => {
  await withSettings("", { on: true }, async (page) => {
    assert.deepEqual(await buttons(page), ["Turn off"]);
    await page.getByRole("button", { name: "Turn off" }).click();
    await page.getByText(/^Off\. /).waitFor();
    assert.deepEqual((await asked(page)).removed, [IMAGE_HOSTS]);
    assert.match(await state(page), /^Off:/);
    assert.deepEqual(await buttons(page), ["Turn on Auto-align"]);
  });
});
