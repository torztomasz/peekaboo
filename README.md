<p align="center">
  <img src="icons/icon-128.png" alt="Peekaboo icon: an eye over a red and green split" width="96" height="96">
</p>

<h1 align="center">Peekaboo</h1>

<p align="center">Flip, fade or diff the Before/After screenshots in GitHub pull requests.</p>

A Chrome extension for reviewing frontend pull requests. It turns the `| Before | After |` screenshot
tables in GitHub PRs and issues into one image you can **flip**, **fade** or **diff**, instead of squinting
at two thumbnails side by side.

![Flipping between two versions of an invoices page, fading between them, then Diff showing a removed nav link in red and restyled status pills in green](docs/demo.gif)

## What it does

- **Flip** (default): click or press Space to blink between before and after. Anything that changed jumps.
- **Fade**: cross-fade one into the other, for subtle colour and shadow changes.
- **Diff**: only changed pixels light up, red where Before had something, green where After does.
- **Side by side**: GitHub's own table, which is never modified, only hidden.
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

## How the diff works

GitHub serves uploaded images without CORS headers, so a canvas can't read their pixels. The browser's
compositor can still blend them: in an isolated group, `lighten` then `difference` leaves
`max(0, other − this)` per channel, which an SVG `feColorMatrix` turns into a red or green overlay whose
opacity grows with the difference, dilated 1px so hairline changes stay visible.

## Privacy

No permissions beyond running on `github.com`, no network requests, no analytics. The only thing stored
is your last chosen mode, in the page's `localStorage`. See [PRIVACY.md](PRIVACY.md).

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
