// npm run mutate [target ...]: breaks the source one small change at a time (a flipped comparison, a
// removed statement, an emptied string) and reruns the tests that own that file, to list the changes no
// test notices. A surviving change is behaviour nothing holds in place: it gets a test, or a reason it
// can't matter. Reports land in reports/mutation/<target>.html.
//
// Each source file runs only the tests that own it, so a run takes minutes, not hours. The speed tests
// and the packaged-extension test stay out: under this load they fail on timing, and a change "caught"
// by a slow clock isn't caught.
import { Stryker } from "@stryker-mutator/core";

const browser = (...names) => `node --test ${names.map((name) => `test/browser/${name}.test.mjs`).join(" ")}`;
const TARGETS = {
  pixels: { mutate: ["src/pixels.ts"], command: "node --test test/pixels.test.ts" },
  content: { mutate: ["src/content.ts"], command: browser("content", "widget", "diff", "fullscreen", "auto") },
  background: { mutate: ["src/background.ts"], command: browser("worker", "auto") },
  options: { mutate: ["src/options.ts", "src/origins.ts"], command: browser("options") },
};

const chosen = process.argv.slice(2);
const unknown = chosen.filter((name) => !TARGETS[name]);
if (unknown.length) throw new Error(`unknown target ${unknown}: pick from ${Object.keys(TARGETS)}`);

const summary = [];
for (const name of chosen.length ? chosen : Object.keys(TARGETS)) {
  const { mutate, command } = TARGETS[name];
  const results = await new Stryker({
    testRunner: "command",
    commandRunner: { command },
    mutate,
    ignorePatterns: ["release", "dist", "docs", "store", "reports", ".github"],
    reporters: ["html", "json", "progress"],
    htmlReporter: { fileName: `reports/mutation/${name}.html` },
    jsonReporter: { fileName: `reports/mutation/${name}.json` },
    concurrency: Number(process.env.MUTATE_CONCURRENCY ?? 4),
    // A change that breaks the page makes every test wait out its own timeout; that is a catch, so call it early.
    timeoutMS: 15000,
  }).runMutationTest();
  const count = (...statuses) => results.filter((mutant) => statuses.includes(mutant.status)).length;
  const caught = count("Killed", "Timeout", "RuntimeError", "CompileError"), survived = count("Survived", "NoCoverage");
  summary.push(`${name.padEnd(10)} ${caught} of ${caught + survived} changes caught (${((100 * caught) / (caught + survived)).toFixed(0)}%), ${survived} unnoticed → reports/mutation/${name}.html`);
}
console.log(`\n${summary.join("\n")}`);
