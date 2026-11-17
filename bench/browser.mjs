// Shared by the benchmarks and the browser tests: a headless Chromium and an esbuild bundle of any source
// file, so a benchmark can load the current code or an older copy of it (pass a path) into the same page.
import { build } from "esbuild";
import { chromium } from "playwright-core";

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
}

export async function bundle(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, format: "iife", target: "chrome120", write: false, banner: { js: activeMutant() } });
  return result.outputFiles[0].text;
}

// Under `npm run mutate`, Stryker names the one change to switch on in an environment variable, which
// code running in a page can't read, so the bundle carries it in.
function activeMutant() {
  const id = process.env.__STRYKER_ACTIVE_MUTANT__;
  return id === undefined ? "" : `globalThis.__stryker__ = { activeMutant: ${JSON.stringify(id)} };`;
}

export const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
