# Chrome Web Store listing

Paste these into the Developer Dashboard (https://chrome.google.com/webstore/devconsole).

## Store listing

**Name** (from manifest): Before/After Compare

**Summary** (from manifest description, ≤132 chars):
Turns Before/After screenshot tables in GitHub PRs and issues into a slider, fade, flip or pixel-diff comparison, with a full-screen view.

**Category**: Developer Tools · **Language**: English

**Description**:

Review frontend pull requests faster. When a PR or issue on GitHub has a Before | After screenshot table, this extension stacks each pair at the same scale so you can see exactly what changed instead of comparing two thumbnails side by side.

• Slider: drag a divider across the two screenshots
• Fade: cross-fade one into the other
• Flip: click or press Space to blink between them; anything that moved jumps
• Diff: only changed pixels light up, red where the old version had something, green where the new one does
• Full screen: one pair at a time, arrow keys step through every pair in the PR, 1–4 switch modes
• Side by side: GitHub's original table, untouched

Your chosen mode sticks across PRs. Screen recordings get a Play button that starts both videos together.

It picks up any table whose column headers start with "Before" and "After" and has an image or video in each cell. Extra columns such as "Viewport" become labels, and an italic line under the table becomes the caption.

No extra permissions, no network requests, no tracking. Open source (MIT): https://github.com/torztomasz/before-after-compare

**Graphics** (all in this folder):
- Icon: `../icons/icon-128.png`
- Screenshots (1280×800): `store-1-slider.png`, `store-2-diff.png`, `store-3-flip.png`, `store-4-fullscreen.png`
- Small promo tile (440×280): `promo-small-440x280.png`
- Marquee (1400×560, optional): `promo-marquee-1400x560.png`

**Website**: https://github.com/torztomasz/before-after-compare
**Support**: https://github.com/torztomasz/before-after-compare/issues

## Privacy practices

**Single purpose**: Displays the Before/After screenshot tables in GitHub pull requests and issues as an interactive comparison (slider, fade, flip, diff).

**Permission justification**
- Host access to https://github.com/* (content script): the extension only works on GitHub pull request and issue pages, where it finds Before/After screenshot tables and renders the comparison next to them. It requests no other permissions.
- Remote code: No. All code ships in the package.

**Data usage**: collects none of the listed data types. Certify: not sold to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending.

**Privacy policy URL**: https://github.com/torztomasz/before-after-compare/blob/main/PRIVACY.md

## Distribution

Visibility: Public (or Unlisted to share by link only) · Regions: all.
