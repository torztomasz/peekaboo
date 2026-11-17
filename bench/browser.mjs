// Shared by the benchmarks and the browser tests: a headless Chromium and an esbuild bundle of any source
// file, so a benchmark can load the current code or an older copy of it (pass a path) into the same page.
import { build } from "esbuild";
import { chromium } from "playwright-core";

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
}

export async function bundle(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, format: "iife", target: "chrome120", write: false });
  return result.outputFiles[0].text;
}

export const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
