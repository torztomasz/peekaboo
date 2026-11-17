// The release zip, installed in Chromium the way a reviewer installs it ("Load unpacked" on the unzipped
// folder), on a pull request page. Everything else in test/browser runs source bundles behind stand-ins
// for Chrome; this is the one place where Chrome reads the real manifest, injects the real content
// script, starts the real service worker and enforces the real (ungranted) permission.
// Methodology: scripts/package.sh builds the zip, it is unzipped into a temporary folder and loaded into
// a fresh profile; github.com is served from a route, so no request reaches GitHub. Chrome's permission
// prompt can't be driven from a test, so the granted side of Auto-align is covered in auto.test.mjs.
// Needs the full Chromium (extensions don't load in the headless shell): npx playwright-core install chromium
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { PR_URL, pair, picture, pullRequest } from "./harness.mjs";

const root = new URL("../../", import.meta.url).pathname;
let context, folder;

before(async () => {
  const zip = execFileSync("sh", ["scripts/package.sh"], { cwd: root, encoding: "utf8" }).trim().split("\n").pop();
  folder = mkdtempSync(join(tmpdir(), "peekaboo-"));
  execFileSync("unzip", ["-q", join(root, zip), "-d", folder]);
  const extension = join(folder, "peekaboo");
  context = await chromium.launchPersistentContext(join(folder, "profile"), {
    channel: "chromium",
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const html = pullRequest(pair(picture(400, 300), picture(300, 300, [120, 160, 255])));
  await context.route("https://github.com/**", (route) => (route.request().url() === PR_URL ? route.fulfill({ contentType: "text/html", body: html }) : route.abort()));
});
after(async () => {
  await context?.close();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

const tabAt = async (pattern) => context.pages().find((page) => pattern.test(page.url())) ?? context.waitForEvent("page", (page) => pattern.test(page.url()));

test("installing opens the welcome page, with Auto-align off", async () => {
  const welcome = await tabAt(/^chrome-extension:\/\/[a-z]+\/options\.html\?welcome$/);
  await welcome.getByRole("heading", { name: "Peekaboo is ready" }).waitFor();
  await welcome.getByText(/^Off:/).waitFor();
  assert.equal(await welcome.getByRole("button", { name: "Turn on Auto-align" }).isVisible(), true);
});

test("on a pull request the pair flips, and Auto-align asks to be turned on in a settings tab beside it", async () => {
  const page = await context.newPage();
  await page.goto(PR_URL);
  const frame = page.locator(".peekaboo-frame");
  await frame.click();
  assert.deepEqual(await page.locator(".peekaboo-tag:visible").allTextContents(), ["After"]);

  // The worker answered that it may not read the images: the pair is centred, and Auto is offered.
  const turnOn = page.getByRole("button", { name: "Turn on Auto-align" });
  await turnOn.waitFor();
  assert.deepEqual(await page.locator(".peekaboo-align").getByRole("button", { pressed: true }).allTextContents(), ["Center"]);
  const [settings] = await Promise.all([context.waitForEvent("page"), turnOn.click()]);
  await settings.getByRole("heading", { name: "Line up these screenshots" }).waitFor();
  assert.match(settings.url(), /options\.html\?from=\d+$/);
});
