// What the content script costs a GitHub tab that is just sitting there, plus Flip. GitHub mutates a PR page
// constantly (relative times tick, reactions update, hovercards come and go), and the script watches every
// mutation, so this cost is paid on every page, tables or not.
//
// How: a 600-comment conversation with 10 Before/After tables runs 600 frames of that churn, then 200
// flips. Reported per phase: full-document scans (querySelectorAll calls, counted by wrapping the DOM
// API: deterministic, so it's the number to compare) and main-thread script and style time from Chrome's
// own metrics, minus the same run with no script loaded (median of RUNS; wall clock, so only roughly).
//
//   node bench/content.mjs [path/to/content.ts ...]   (default: this checkout's)
import { median } from "./browser.mjs";
import { conversation, openConversation } from "./github-page.mjs";

const RUNS = 5;
const entries = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!entries.length) entries.push(new URL("../src/content.ts", import.meta.url).pathname);
const html = conversation({ comments: 600, every: 60 });
const blank = new URL("./blank.ts", import.meta.url).pathname;

const countScans = () => {
  window.scans = 0;
  for (const proto of [Document.prototype, Element.prototype]) {
    const original = proto.querySelectorAll;
    proto.querySelectorAll = function (...args) {
      window.scans++;
      return original.apply(this, args);
    };
  }
};

async function measure(entry) {
  const { browser, page } = await openConversation(html, { entry, before: countScans });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const phase = async (run) => {
    const [start, scans] = [await metrics(), await page.evaluate(() => window.scans)];
    await page.evaluate(run);
    const end = await metrics();
    return {
      scans: (await page.evaluate(() => window.scans)) - scans,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000,
      styleMs: (end.RecalcStyleDuration - start.RecalcStyleDuration + end.LayoutDuration - start.LayoutDuration) * 1000,
    };
  };
  const churn = await phase(() => new Promise((resolve) => {
    const items = document.querySelectorAll(".timeline-item");
    let frame = 0;
    const tick = () => {
      const item = items[frame % items.length];
      item.querySelector("relative-time").textContent = `${frame} seconds ago`;
      item.querySelector(".reactions span").textContent = String(frame);
      const card = document.createElement("div");
      card.className = "hovercard";
      card.innerHTML = `<img alt=""><span>user${frame}</span>`;
      document.body.append(card);
      document.querySelector(".hovercard:not(:last-child)")?.remove();
      if (++frame < 600) requestAnimationFrame(tick);
      else requestAnimationFrame(() => requestAnimationFrame(resolve));
    };
    requestAnimationFrame(tick);
  }));
  const flips = await phase(() => new Promise((resolve) => {
    const frames = document.querySelectorAll(".peekaboo-frame");
    let flip = 0;
    const tick = () => {
      frames[flip % frames.length]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      if (++flip < 200) requestAnimationFrame(tick);
      else requestAnimationFrame(() => requestAnimationFrame(resolve));
    };
    requestAnimationFrame(tick);
  }));
  const widgets = await page.evaluate(() => document.querySelectorAll(".peekaboo").length);
  await browser.close();
  return { churn, flips, widgets };
}

async function medianOf(entry) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measure(entry));
  const pick = (phase, key) => median(runs.map((run) => run[phase][key]));
  return Object.fromEntries(["churn", "flips"].map((phase) => [phase, { scans: pick(phase, "scans"), scriptMs: pick(phase, "scriptMs"), styleMs: pick(phase, "styleMs") }]).concat([["widgets", runs[0].widgets]]));
}

const none = await medianOf(blank);
for (const entry of entries) {
  const result = await medianOf(entry);
  console.log(entry);
  for (const phase of ["churn", "flips"]) {
    const r = result[phase], base = none[phase];
    console.log(`  ${phase.padEnd(6)} ${String(r.scans).padStart(5)} scans   script +${(r.scriptMs - base.scriptMs).toFixed(1)} ms   style+layout +${(r.styleMs - base.styleMs).toFixed(1)} ms`);
  }
  console.log(`  ${result.widgets} widgets`);
}
