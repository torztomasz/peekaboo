# Changelog

What changed for people reviewing pull requests with Peekaboo. Each version is a
[release](https://github.com/torztomasz/peekaboo/releases) with a zip to Load unpacked.

## 1.6.0 (2026-11-17)

### Added

- **Retina next to normal.** A 2x capture beside a 1x one no longer lights up every letter and outline in
  Diff; with Auto on, only what really changed shows. Without Auto, most of the edge noise is filtered out too.
- **Hold Shift to peek.** Hold Shift over a pair to see the other side, let go to come back: no clicking twice
  and remembering which side is up. In Diff it shows the plain After under the colours, so you can see what a
  red or green patch is. Works in full screen too, and does nothing while you're typing in a comment.
- With Auto on, a pair whose Before and After are pixel-identical says so, since that looks just like a clean Diff.

### Changed

- **Diff colours mean removed and added, on dark screenshots too.** Red was "darker in Before", which on a
  dark theme made a removed heading show green. With Auto on, dark screenshots are detected and the colours
  swap, so the key reads Removed / Added either way.
- **One Before/After chip.** Flip shows which side is on screen in one place at the left, with After tinted
  so a flip registers without reading the word.
- **Clearer Diff.** After fades to white behind the colours in both themes, and rows only one screenshot
  covers are hatched as "Not compared" instead of passing for unchanged.
- **Auto-align is 3-60x faster** and places screenshots exactly: a 2560x1600 pair went from 1.7 s to 23 ms, and
  a small detail inside a large screen is now found where it used to fall back to sliding sideways.
- **Lighter on every GitHub tab.** The content script no longer re-scans the page on each of GitHub's constant
  DOM updates (ticking timestamps, reactions, hovercards): 600 scans to 0 on a long conversation.
- Polish from a design review: GitHub's own button states and icons, key hints in full screen that follow the
  mode, Tab kept inside full screen and focus returned to the button that opened it.

### Fixed

- Auto-align finds a crop anywhere down a tall capture; past 4000 rows it used to fail silently.
- A 2x capture is no longer placed 1px off, which lit up every edge in Diff.
- Alignment bars no longer pile up listeners as you move between GitHub pages.
- A click while peeking in Diff no longer flips the pair's hidden side.
- Picking an alignment while Auto is still working is no longer overridden when Auto gives up.

## 1.5.0 (2026-11-16)

### Added

- A welcome tab on install explains Peekaboo and its one optional switch, Auto-align. The toolbar icon opens
  the same page, and the prompt on a pull request takes you there and back to the PR once Auto is on.

## 1.4.1 (2026-11-16)

### Fixed

- Pairs with the same width and different heights (a page that got longer) no longer get an alignment bar
  that does nothing. The bar appears only when Auto finds one screenshot is a crop of the other.

## 1.4.0 (2026-11-16)

### Added

- Auto lines up a screenshot that is a crop of the other: a viewport inside a full-page capture, or a detail
  inside a screen.

## 1.3.0 (2026-11-16)

### Added

- Screenshots captured at different widths line up. A retina capture next to a normal one is scaled to
  match; two window widths keep one pixel scale and line up by **Auto**, Left, Center or Right.
- Auto needs one optional permission to read GitHub's image server, asked once. The extension still installs
  with no permissions.

## 1.2.1 (2026-11-16)

### Changed

- New icon: two eyes peeking over a ledge.
- A userscript entry point (`src/peekaboo.user.ts`) ships the same code to userscript managers.

## 1.2.0 (2026-11-16)

### Changed

- Two modes, Flip (default) and Diff, plus GitHub's own Side by side. Fade is gone; full-screen keys are 1-2.
- Videos stay in Flip, since Diff can't compare them.

### Fixed

- Side by side no longer shows the comparison as well on pages without GitHub's global `[hidden]` reset.

## 1.1.0 (2026-11-16)

### Changed

- Renamed to Peekaboo. Flip is the default mode; the Slider is gone.

## 1.0.0 (2026-11-16)

First release: Flip, Fade, Slider and Diff for `| Before | After |` screenshot tables in GitHub PRs and
issues, with a full-screen review mode.
