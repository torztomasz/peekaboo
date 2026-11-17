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

// A pull request's pairs are all worked out as it opens, on screenshots this size. The budgets are about
// six times what each takes on a 2024 laptop (npm run bench prints the real numbers): loose enough for a
// slower machine (CI doubles them through PEEKABOO_BUDGET_SCALE), tight enough that losing the
// optimisations they guard fails here: before them the first scenario took 1664 ms and the second 694 ms.
// Methodology: the benchmark's own scenarios, each warmed up once and then timed three times from message
// to reply; the fastest run is compared with the budget, since noise only ever adds time. Each reply's
// placement is checked against where the scenario was cut from.
const BUDGETS_MS = {
  "compare 2560×1600 (one button changed)": 150,
  "align viewport crop of a 1280×6000 full page": 500,
  "align viewport crop below row 4000 of a 1280×9000 full page": 650,
  "align 600×400 detail inside a 2560×1600 screen": 600,
  "compare 2x vs 1x captures of one 1280×800 screen (one button changed)": 350,
  "align 1200 vs 1600 window widths, one button changed": 1300,
  "align 1200 vs 1600 window widths": 1300,
};

test("works out each kind of pair a pull request carries within its time budget, placed where it belongs", async () => {
  const results = await page.evaluate(async () => {
    // The worker remembers answers per pair of URLs, so each run asks about new URLs for the same images.
    const fresh = async (url) => URL.createObjectURL(await (await fetch(url)).blob());
    const out = {};
    for (const [name, { type, before, after, expect }] of Object.entries(await screens.scenarios())) {
      const times = [];
      let reply;
      for (let run = 0; run < 4; run++) {
        const message = { type, before: await fresh(before), after: await fresh(after) };
        const start = performance.now();
        reply = await ask(message);
        if (run > 0) times.push(performance.now() - start);
      }
      out[name] = { fastest: Math.min(...times), placement: reply.placement, expect, error: reply.error };
    }
    return out;
  });
  assert.deepEqual(Object.keys(results), Object.keys(BUDGETS_MS), "a benchmark scenario has no budget");
  const scale = Number(process.env.PEEKABOO_BUDGET_SCALE ?? 1);
  for (const [name, { fastest, placement, expect, error }] of Object.entries(results)) {
    assert.equal(error, undefined, name);
    if (expect) assert.deepEqual(placement, expect, name);
    assert.ok(fastest <= BUDGETS_MS[name] * scale, `${name}: ${fastest.toFixed(0)} ms, budget ${BUDGETS_MS[name] * scale} ms`);
  }
});
