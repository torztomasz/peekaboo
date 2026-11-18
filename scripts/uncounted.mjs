// Loaded with `node --import` by npm run mutate for tests that run in Node, to keep Stryker's instrumentation
// from swamping the pixel loops, where it turned a 12 s test run into 7 minutes. Two costs, paid on every
// expression of every pass:
// - Stryker counts which changes each line reaches. The command runner never reads those counts, so the
//   counter becomes a no-op as the instrumented file loads.
// - Each expression asks whether it is the change switched on, comparing its id (a string literal) with the
//   one Stryker passes in an environment variable. That one isn't interned, so every comparison reads it
//   character by character; set first as a literal too, it compares by reference.
// Which change is switched on, and what it does, stays exactly as Stryker set it.
import { registerHooks } from "node:module";

const active = process.env.__STRYKER_ACTIVE_MUTANT__;
if (active !== undefined) globalThis.__stryker__ = { activeMutant: (0, eval)(JSON.stringify(active)) };

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.includes("/src/") || loaded.source == null) return loaded;
    const source = String(loaded.source);
    const uncounted = source.replace(/function (stryCov_\w+)\(\) \{/, "function $1() {}\nfunction $1_unused() {");
    return uncounted === source ? loaded : { ...loaded, source: uncounted };
  },
});
