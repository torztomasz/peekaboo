// A pull request page for the content script to run on, shared by the browser tests.
//
// How: the page is served at a github.com URL from a route, so the script sees the origin it ships for
// (localStorage works, as it doesn't on about:blank) and no request leaves the machine: anything the
// route doesn't serve is aborted and recorded in `requests`. Tables are marked up the way GitHub renders
// markdown (copied from a real pull request's body_html: the custom-element wrapper, role="table", images
// inside links with an inline max-width). Every test gets its own browser context, so a saved mode or
// alignment never leaks from one test into the next.
//
// `auto: true` loads the background worker's bundle into the same page behind a stand-in `chrome`, so the
// content script talks to the real worker code over the real message shapes; only Chrome's plumbing
// (message passing, the permission, tabs) is faked. Without it there is no `chrome` at all, which is how
// the userscript runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bundle, launch } from "../../bench/browser.mjs";
import { decode } from "./png.mjs";

export { launch };
export { draw, picture } from "./png.mjs";

export const PR_URL = "https://github.com/acme/app/pull/1";
// How long a test waits for something on the page. Generous, because the gate has to hold on a machine
// busy with other work (a cold browser under load took over 5 s to answer its first Auto-align); short
// under `npm run mutate`, where most runs are meant to fail and each wait is paid a thousand times.
export const WAIT_MS = process.env.__STRYKER_ACTIVE_MUTANT__ ? 2000 : 30000;
const source = (name) => new URL(`../../src/${name}`, import.meta.url).pathname;
const bundles = new Map();
export const built = (name) => bundles.get(name) ?? bundles.set(name, bundle(source(name))).get(name);

// ---------- GitHub's markup ----------

export const image = (src, alt = "") =>
  `<a target="_blank" rel="noopener noreferrer" href="${src}"><img src="${src}" alt="${alt}" style="max-width: 100%;"></a>`;

// `rows` are arrays of cell HTML, one per header.
export function table({ headers = ["Before", "After"], rows, caption = "" }) {
  const cells = (tag, row) => row.map((cell) => `<${tag}>${cell}</${tag}>`).join("");
  return `
    <markdown-accessiblity-table><table role="table">
      <thead><tr>${cells("th", headers)}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${cells("td", row)}</tr>`).join("")}</tbody>
    </table></markdown-accessiblity-table>
    ${caption ? `<p dir="auto"><em>${caption}</em></p>` : ""}`;
}

export const pair = (before, after, options = {}) => table({ rows: [[image(before), image(after)]], ...options });

export const comment = (body) => `<div class="timeline-item"><div class="comment-body markdown-body js-comment-body">${body}</div></div>`;

export const pullRequest = (...comments) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body { margin: 0; padding: 16px; }</style></head><body><div class="timeline">${comments.map(comment).join("")}</div></body></html>`;

// ---------- The page ----------

// Opens `html` as a pull request, runs the test, and fails it if the page threw along the way.
// `serve`: extra URLs the route answers, as { url: (resourceType) => body | null }; null fails that request.
// `before` runs in the page ahead of the extension's code, e.g. to note what GitHub rendered.
export async function withPullRequest(browser, html, options, run) {
  const pr = await openPullRequest(browser, html, options);
  try {
    await run(pr);
    assert.deepEqual(pr.errors, [], "the page threw");
  } finally {
    await pr.context.close();
  }
}

async function openPullRequest(browser, html, { auto = false, granted = true, serve = {}, before } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(WAIT_MS);
  const requests = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url === PR_URL) return route.fulfill({ contentType: "text/html", body: html });
    const body = serve[url]?.(route.request().resourceType());
    if (body) return route.fulfill({ contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body });
    if (!serve[url]) requests.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const load = async () => {
    await page.goto(PR_URL);
    if (before) await page.evaluate(before);
    if (auto) {
      await page.evaluate(standInChrome, granted);
      await page.addScriptTag({ content: await built("background.ts") });
    }
    await page.addScriptTag({ content: await built("content.ts") });
    await ready(page);
  };
  await load();
  return { context, page, requests, errors, reload: load };
}

// Chrome's side of the extension: messages go straight to the worker's listener, and the calls a test
// asserts on (tabs opened, the options page) are recorded on `window.chromeCalls`.
function standInChrome(granted) {
  const listeners = [];
  const calls = (window.chromeCalls = { tabsCreated: [], optionsOpened: 0, unanswered: 0 });
  window.autoGranted = granted;
  window.chrome = {
    runtime: {
      id: "peekaboo-under-test",
      onMessage: { addListener: (listener) => listeners.push(listener) },
      onInstalled: { addListener() {} },
      getURL: (path) => `chrome-extension://peekaboo-under-test/${path}`,
      openOptionsPage: () => calls.optionsOpened++,
      sendMessage(message, callback) {
        if (callback) calls.unanswered++;
        const reply = (answer) => { calls.unanswered--; callback(answer); };
        for (const listener of listeners) listener(message, { tab: { id: 7, index: 2 } }, reply);
      },
    },
    action: { onClicked: { addListener() {} } },
    permissions: { contains: async () => window.autoGranted },
    tabs: { create: (options) => calls.tabsCreated.push(options) },
  };
}

// Every screenshot decoded and the content script's next frame run: widgets are built and sized.
export async function ready(page) {
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
  await settle(page);
}

// The worker has answered everything the page asked it, and the page has drawn the answers.
export async function answered(page) {
  await page.waitForFunction(() => window.chromeCalls.unanswered === 0);
  await settle(page);
}

// Two frames: the content script syncs on the frame after a mutation.
export const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// ---------- What's on screen ----------

// The pixels Chromium paints for `locator`, so a test can ask for the colour at a point inside it.
export const pixels = async (locator) => decode(await locator.screenshot());

// Where `inner` sits inside `outer`, in CSS pixels rounded to whole ones.
export async function offsetWithin(inner, outer) {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  return { x: Math.round(a.x - b.x), y: Math.round(a.y - b.y), width: Math.round(a.width), height: Math.round(a.height) };
}

const visibleHue = ([r, g, b]) => ({ red: r - Math.max(g, b), green: g - Math.max(r, b), spread: Math.max(r, g, b) - Math.min(r, g, b) });
export const isRed = (rgb) => visibleHue(rgb).red > 60;
export const isGreen = (rgb) => visibleHue(rgb).green > 60;
export const isNeutral = (rgb) => visibleHue(rgb).spread < 12;

// ---------- The worker on its own ----------

// A page running the worker's bundle behind a stub `chrome`: `ask(message)` sends it a message and resolves
// with the reply; `screens` (bench/screens.js) draws synthetic screenshots; `serve(url, canvas)` makes a
// canvas fetchable at a GitHub-style URL; `granted`, `fetched` and `opened` are there to set and read.
export async function openWorker(browser) {
  const page = await browser.newPage();
  await page.addScriptTag({ content: readFileSync(new URL("../../bench/screens.js", import.meta.url), "utf8") });
  await page.addScriptTag({
    content: `
      window.granted = true;
      window.fetched = 0;
      window.served = {};
      const fetchImage = window.fetch;
      window.fetch = (url) => { window.fetched++; return fetchImage(window.served[url] ?? url); };
      window.serve = async (url, canvas) => { window.served[url] = await screens.url(canvas); return url; };
      window.opened = { tabs: [], settings: 0 };
      window.chrome = {
        runtime: {
          id: "test", getURL: (p) => p, openOptionsPage: () => window.opened.settings++,
          onMessage: { addListener: (f) => (window.listener = f) }, onInstalled: { addListener: (f) => (window.installed = f) },
        },
        action: { onClicked: { addListener: (f) => (window.iconClicked = f) } },
        permissions: { contains: async () => window.granted },
        tabs: { create: (tab) => window.opened.tabs.push(tab) },
      };
      window.ask = (message) => new Promise((resolve) => window.listener(message, {}, resolve));`,
  });
  await page.addScriptTag({ content: await built("background.ts") });
  return page;
}
