// How long the worker takes on the pairs a pull request carries (npm run test:speed). Kept out of
// test/browser so nothing else drives a browser while the clock runs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launch, openWorker } from "../browser/harness.mjs";

let browser, page;
before(async () => {
  browser = await launch();
  page = await openWorker(browser);
});
after(() => browser?.close());

// A pull request's pairs are all worked out as it opens, on screenshots this size, so the speed-ups in
// the worker are worth holding on to: before them the first scenario took 70 times what it does now and
// the second 8 times.
// Methodology: wall-clock milliseconds depend on the machine and on what else it is doing, so each
// scenario is timed against a yardstick run right before it: a fixed loop of byte arithmetic, the kind of
// work the worker does. A budget is how many yardsticks a scenario may take, about five times what it
// takes today (printed with PEEKABOO_SPEED_REPORT=1). Each scenario is warmed up once and measured five
// times; the best ratio counts, since a busy machine only ever adds time. Each reply's placement is
// checked against where the scenario was cut from.
const BUDGETS = {
  "compare 2560×1600 (one button changed)": 2,
  "align viewport crop of a 1280×6000 full page": 6,
  "align viewport crop below row 4000 of a 1280×9000 full page": 8,
  "align 600×400 detail inside a 2560×1600 screen": 8,
  "compare 2x vs 1x captures of one 1280×800 screen (one button changed)": 5,
  "align 1200 vs 1600 window widths, one button changed": 16,
  "align 1200 vs 1600 window widths": 16,
};

test("works out each kind of pair a pull request carries within its time budget, placed where it belongs", async () => {
  const results = await page.evaluate(async () => {
    // About 70 ms on a 2024 laptop: long enough to time, short next to the scenarios it measures.
    const bytes = new Uint8Array(1 << 22).map((_, index) => (index * 31) & 255);
    const yardstick = () => {
      const start = performance.now();
      let sum = 0;
      for (let pass = 0; pass < 16; pass++) for (let i = 1; i < bytes.length; i++) sum += Math.abs(bytes[i] - bytes[i - 1]);
      // Kept, so the loop can't be optimised away as unused.
      window.yardstickSum = sum;
      return performance.now() - start;
    };
    // The worker remembers answers per pair of URLs, so each run asks about new URLs for the same images.
    const fresh = async (url) => URL.createObjectURL(await (await fetch(url)).blob());
    const out = {};
    for (const [name, { type, before, after, expect }] of Object.entries(await screens.scenarios())) {
      const ratios = [];
      let reply;
      for (let run = 0; run < 6; run++) {
        const message = { type, before: await fresh(before), after: await fresh(after) };
        const unit = yardstick();
        const start = performance.now();
        reply = await ask(message);
        if (run > 0) ratios.push((performance.now() - start) / unit);
      }
      out[name] = { yardsticks: Math.min(...ratios), placement: reply.placement, expect, error: reply.error };
    }
    return out;
  });
  assert.deepEqual(Object.keys(results), Object.keys(BUDGETS), "a benchmark scenario has no budget");
  for (const [name, { yardsticks, placement, expect, error }] of Object.entries(results)) {
    if (process.env.PEEKABOO_SPEED_REPORT) console.log(`${yardsticks.toFixed(2).padStart(6)} of ${BUDGETS[name]}  ${name}`);
    assert.equal(error, undefined, name);
    if (expect) assert.deepEqual(placement, expect, name);
    assert.ok(yardsticks <= BUDGETS[name], `${name}: took ${yardsticks.toFixed(1)} yardsticks, budget ${BUDGETS[name]}`);
  }
});
