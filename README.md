# Before/After Compare

Chrome extension that turns `| Before | After |` screenshot tables in GitHub PRs and issues into a
comparison you can slide, fade, flip or pixel-diff, with a full-screen viewer (← → between pairs, 1–4
switch modes, Esc closes).

Ported from the Ardia userscript `~/ardia-scripts/before-after-compare.user.ts` so it works in any
Chromium browser. `dist/content.js` is committed, so the extension loads without a build step.

## Install

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick this folder.

## Develop

```sh
npm install
npm run build   # or: npm run watch
```

Then hit the reload icon on the extension card and refresh the GitHub tab.

## Share a build

```sh
npm run package   # → release/before-after-compare-<version>.zip
```

The zip holds one `before-after-compare/` folder with only what Chrome loads (manifest, `dist/`, icons).
Bump `version` in both `manifest.json` and `package.json` first, so reviewers can tell builds apart on
the `chrome://extensions` card.
