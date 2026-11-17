<p align="center">
  <img src="icons/icon-128.png" alt="Peekaboo icon: an eye over a red and green split" width="96" height="96">
</p>

<h1 align="center">Peekaboo</h1>

<p align="center">Flip or diff the Before/After screenshots in GitHub pull requests.</p>

A Chrome extension for reviewing frontend pull requests. It turns the `| Before | After |` screenshot
tables in GitHub PRs and issues into one image you can **flip** or **diff**, instead of squinting
at two thumbnails side by side.

![Without Peekaboo: GitHub's side-by-side table. With Peekaboo: clicking Flip swaps before and after in place, then Diff shows a removed nav link in red and restyled status pills in green](docs/demo.gif)

## What it does

- **Flip** (default): click or press Space to blink between before and after. Anything that changed jumps.
- **Diff**: only changed pixels light up, red where Before had something, green where After does.
- **Slider**: drag the vertical divider (or press ← → with the image focused, Shift for bigger steps) to reveal
  Before on the left and After on the right.
- **Side by side**: GitHub's own table, which is never modified, only hidden.
- **Different sizes**: a retina capture next to a normal one is scaled to match. Otherwise both keep one
  pixel scale and line up by **Auto**: a crop of the other screenshot (a viewport inside a full-page
  capture, a detail inside a screen) is placed exactly where it matches, and two window widths of one
  page slide sideways to where they match; the diff is then computed at full resolution. Or line them up
  by the left edge, centre or right edge yourself.
- **Full screen**: one pair at a time, ← → through every pair in the PR, 1–3 to switch modes, Esc to close.

Your chosen mode sticks across tables and PRs. Recordings (videos) get a Play button that starts both in
step.

## Which tables it picks up

Any table in a comment whose headers start with `Before` and `After`, with an image or video in each cell.
Extra columns (e.g. `Viewport`, `Theme`) become labels, and a single italic line right under the table
becomes the caption in full screen:

```markdown
| Before | After |
| --- | --- |
| ![Before: Save button overflows the toolbar](before.png) | ![After: Save button wraps below the title](after.png) |

_Save button overflowed the toolbar on 375px screens; it now wraps below the title._
```

### Let your coding agent write them

Nothing else is needed: hand-written tables work. If agents write your PRs, the
[`pr-screenshots`](https://github.com/torztomasz/skills/tree/main/skills/pr-screenshots) skill teaches them
this exact layout (one table and caption per change, fair before/after captures, uploads via
`gh --attach`). It's optional:

```sh
npx skills add torztomasz/skills --skill pr-screenshots -g
```

## Install

Peekaboo isn't on the Chrome Web Store; install it from a [release](../../releases) zip:

1. Download and unzip `peekaboo-<version>.zip`; keep the folder somewhere permanent.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. **Load unpacked** → pick the `peekaboo` folder. Refresh any open GitHub tabs.

Works in Chrome, Edge, Brave, Arc and other Chromium browsers.

### As a userscript

[`src/peekaboo.user.ts`](src/peekaboo.user.ts) wraps the same code with a userscript header, for userscript
managers that build TypeScript (e.g. Ardia: `ardia scripts install src/peekaboo.user.ts`). For Violentmonkey or
Tampermonkey, prepend that header to `dist/content.js`.

## How the diff works

GitHub serves uploaded images without CORS headers, so a canvas can't read their pixels. The browser's
compositor can still blend them: in an isolated group, `lighten` then `difference` leaves
`max(0, other − this)` per channel, which an SVG `feColorMatrix` turns into a red or green overlay whose
opacity grows with the difference, dilated 1px so hairline changes stay visible.

## Privacy

Installs with no permissions beyond running on `github.com`, and no analytics. **Auto** alignment is the one
exception, and it's optional: turn it on from the welcome tab that opens on install, from the toolbar icon
(it opens Peekaboo's settings), or from the prompt on a pull request whose screenshots differ in size.
Chrome then asks once to read images from GitHub's image server (`private-user-images.githubusercontent.com`), because GitHub serves uploads without CORS headers
and page code can't read their pixels. Without it, Left, Center and Right still work. The only things stored
are your chosen mode and alignment, in the page's `localStorage`. See [PRIVACY.md](PRIVACY.md).

## Build it yourself

Rather not install someone else's extension? Paste this into Claude Code, Codex or any coding agent. It
describes the behaviour, not this code, so you get your own version written from scratch. Then load its
folder with **Load unpacked** as above.

```text
Build a Chrome extension (Manifest V3, no permissions, plain TypeScript bundled with esbuild into one content script) that makes before/after screenshots in GitHub pull requests and issues easier to review.

What it should find:
- Any table inside a rendered GitHub comment (.markdown-body table) whose header row has a column starting with "Before" and one starting with "After". Each body row with an image (or video) in both of those cells is one pair. Text in any other column of the row (for example "375px" or "Dark") becomes that pair's label.
- If the paragraph right after the table is a single italic line, treat it as the caption for the whole table. GitHub wraps tables in a custom element, so look for the caption next to that wrapper, not next to the table.
- GitHub is a single-page app and re-renders comments on navigation, edits and previews. Watch the DOM with a MutationObserver (batched with requestAnimationFrame) and process each table only once.

What it should show:
- Above each matching table, a toolbar with modes: Side by side (GitHub's original table, left untouched in the DOM and only hidden), Flip and Diff, plus a "Full screen" button. Both images are stacked at the same width.
- Flip (the default): click or press Space to switch between Before and After, with a label showing which one is on screen.
- Diff: highlight only the pixels that changed, red where Before had something and green where After does. GitHub serves uploaded images without CORS headers, so canvas pixel reads won't work. Do it in the compositor instead: in an isolated group, stack the image, the other image with mix-blend-mode: lighten, then the first image again with mix-blend-mode: difference. That leaves max(0, other - this) per channel. Colour it with an SVG feColorMatrix filter whose alpha rises with the difference (ignore anti-aliasing noise) and dilate it 1px so hairline changes stay visible. For videos, fall back to Flip.
- Never upscale small screenshots inline: cap the comparison at the image's natural width.
- The chosen mode is one preference saved in localStorage and applied to every table on every page. Keep the clicked toolbar at the same place on screen when other tables above it change height.
- Full screen: an overlay showing one pair at a time, as large as fits with its caption underneath. Left/right arrows step through every pair on the page across all tables, keys 1 and 2 switch modes, Esc closes and scrolls back to the pair you were on. Move the existing stage element into the overlay and back instead of cloning it, so the Flip side carries over.
- If a table has videos, add a Play button that restarts both videos together. Mute and loop them.
- Hide things with the hidden attribute, and scope a [hidden] { display: none !important } rule to your own widget: GitHub's global reset does that for you on github.com, but your own display rules would otherwise beat the attribute anywhere it's missing.
- Style it with GitHub's own CSS variables (--bgColor-default, --fgColor-default, --borderColor-default and so on, with fallbacks) so it fits light and dark themes.

Done when: on a PR with a | Before | After | table, every mode works, the original table comes back on Side by side, full screen steps through all pairs, and the extension requests no permissions beyond its content script on https://github.com/*. Include a README with Load unpacked instructions.
```

## Develop

```sh
npm install
npm run build     # or: npm run watch
npm run package   # → release/peekaboo-<version>.zip
```

Reload the extension on `chrome://extensions` and refresh the GitHub tab after a build. Bump `version` in
both `manifest.json` and `package.json` before packaging. `store/` holds listing text and images kept for a
possible Chrome Web Store submission later.

## License

[MIT](LICENSE)
