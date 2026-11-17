// Times the background worker's pixel work (Auto-align, the diff and the same-picture check) end to end,
// message in to reply out, on synthetic screenshots of the sizes PRs carry.
//
// How: the worker bundle runs in a headless Chromium page with a stub `chrome` that grants the image
// permission and captures the message listener; images are blob URLs, so `fetch` costs no network. Each
// scenario runs once to warm up, then RUNS times; the median is reported, with the reply's placement,
// `same` answer and diff size, so an optimisation shows changed results as well as speed.
//
//   node bench/background.mjs [path/to/background.ts] [--json]
import { readFileSync } from "node:fs";
import { bundle, launch, median } from "./browser.mjs";

const RUNS = 7;
const entry = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? new URL("../src/background.ts", import.meta.url).pathname;

const browser = await launch();
const page = await browser.newPage();
await page.addScriptTag({ content: readFileSync(new URL("./screens.js", import.meta.url), "utf8") });
await page.addScriptTag({
  content: `
    window.chrome = {
      runtime: { id: "bench", onMessage: { addListener: (f) => (window.listener = f) }, onInstalled: { addListener() {} }, getURL: (p) => p },
      action: { onClicked: { addListener() {} } },
      permissions: { contains: async () => true },
      tabs: {},
    };`,
});
await page.addScriptTag({ content: await bundle(entry) });

const results = await page.evaluate(async (runs) => {
  const ask = (message) => new Promise((resolve) => window.listener(message, {}, resolve));
  // The worker keeps answers per pair of URLs, so each run asks about new URLs for the same images.
  const fresh = async (url) => URL.createObjectURL(await (await fetch(url)).blob());
  const askFresh = async ({ type, before, after }) => ask({ type, before: await fresh(before), after: await fresh(after) });
  const out = {};
  for (const [name, { type, before, after, expect }] of Object.entries(await window.screens.scenarios())) {
    let reply = await askFresh({ type, before, after });
    const times = [];
    for (let i = 0; i < runs; i++) {
      const message = { type, before: await fresh(before), after: await fresh(after) };
      const start = performance.now();
      reply = await ask(message);
      times.push(performance.now() - start);
    }
    out[name] = { times, placement: reply.placement, expect, same: reply.same, error: reply.error, diffBytes: reply.diff?.length };
  }
  return out;
}, RUNS);
await browser.close();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results));
} else {
  for (const [name, r] of Object.entries(results)) {
    const placed = r.placement ? `placed ${JSON.stringify(r.placement)}${r.expect && JSON.stringify(r.placement) !== JSON.stringify(r.expect) ? " (EXPECTED " + JSON.stringify(r.expect) + ")" : ""}` : "";
    console.log(`${median(r.times).toFixed(0).padStart(6)} ms  ${name}`);
    console.log(`          ${placed} same ${r.same}${r.diffBytes ? ` diff ${r.diffBytes}B` : ""}${r.error ? " ERROR " + r.error : ""}`);
  }
}
