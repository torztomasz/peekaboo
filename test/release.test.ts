// What ships: the permissions the extension installs with, the version it reports, the committed build
// and the zip reviewers install. Methodology: the manifest and the packaged zip are read as Chrome and a
// user would get them, and the committed dist/ is compared with a build of the current source, so none
// of these can drift from the code without a test saying so. The image hosts are written out here on
// purpose: they are the privacy promise in the README, and changing them should take changing this file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const BUNDLES = ["content", "background", "options"];

// dist/ is committed (a checkout can be loaded unpacked), so a source change without a rebuild would
// ship old code. First in this file: the packaging test below rebuilds dist/.
test("the committed dist/ is what the current source builds", async () => {
  const { outputFiles } = await build({
    entryPoints: BUNDLES.map((name) => new URL(`src/${name}.ts`, root).pathname),
    bundle: true, format: "iife", target: "chrome120", outdir: new URL("dist", root).pathname, write: false,
  });
  for (const [index, name] of BUNDLES.entries()) {
    assert.ok(outputFiles[index].text === read(`dist/${name}.js`), `dist/${name}.js is stale: run npm run build and commit it`);
  }
});

test("installs with no permissions: it runs on github.com only, and Auto's image hosts are optional", () => {
  for (const grant of ["permissions", "host_permissions", "optional_permissions", "externally_connectable", "web_accessible_resources"]) {
    assert.equal(manifest[grant], undefined, `manifest.${grant}`);
  }
  assert.deepEqual(manifest.content_scripts.map((script: { matches: string[] }) => script.matches), [["https://github.com/*"]]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://private-user-images.githubusercontent.com/*", "https://user-images.githubusercontent.com/*"]);
});

test("the manifest, package.json and the userscript header carry one version", () => {
  const userscript = read("src/peekaboo.user.ts").match(/@version\s+(\S+)/)?.[1];
  assert.deepEqual({ package: JSON.parse(read("package.json")).version, userscript }, { package: manifest.version, userscript: manifest.version });
});

// "Load unpacked" on the unzipped folder must find everything Chrome will ask for, and the zip should
// carry nothing a reviewer didn't ask to install.
test("the release zip holds every file the extension loads, and only the extension", () => {
  const zip = execFileSync("sh", ["scripts/package.sh"], { cwd: root, encoding: "utf8" }).trim().split("\n").pop()!;
  assert.equal(zip, `release/peekaboo-${manifest.version}.zip`);
  const files = execFileSync("unzip", ["-Z1", zip], { cwd: root, encoding: "utf8" }).split("\n").filter((path) => path && !path.endsWith("/"));
  const loaded = [
    "manifest.json",
    manifest.options_ui.page,
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((script: { js: string[] }) => script.js),
    ...Object.values<string>(manifest.icons),
    ...Object.values<string>(manifest.action.default_icon),
    ...Array.from(read("options.html").matchAll(/\b(?:src|href)="([^"#:]+)"/g), (match) => match[1]),
  ];
  assert.deepEqual(files.sort(), Array.from(new Set(loaded), (path) => `peekaboo/${path}`).sort());
});
