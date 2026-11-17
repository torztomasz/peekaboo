# Peekaboo

The tests are the specification: this code is written by agents, and the owner reads behaviour, not diffs.
`npm run check` is the gate (types, pixel tests, browser tests, the packaged extension, time budgets). CI
runs it on every push and pull request.

## Before every commit

1. `npm run check` is green.
2. `dist/` is rebuilt and committed with the source change (`npm run build`; a test compares them).

## Changing behaviour

- A behaviour change lands with a test that fails without it. Run the test against the old code once to
  see it go red; a test that never failed proves nothing.
- A red test is a finding. Fix the code. When the behaviour is meant to change, change the test in the
  same commit and name the old and new behaviour in the commit message.
- Loosening a test (a wider tolerance, a bigger time budget, a deleted assertion or test) is the owner's
  decision: say so and stop, with the failing output.
- Tests check what a reviewer sees: what is on screen (colours, positions, text), which control is
  pressed, where focus is, what Chrome was asked for. Each test file opens with why it exists and how it
  measures; expected values come from how the fixture was built, never from the code under test.

## Where a test goes

| What changed | Test it in |
| --- | --- |
| Pixel work in `src/pixels.ts` (placement, diff, densities) | `test/pixels.test.ts` |
| Anything on the pull request page | `test/browser/` by area: `widget`, `diff`, `fullscreen`, `auto` (page and worker together) |
| The worker's messages, cache, tabs | `test/browser/worker.test.mjs` |
| The settings page | `test/browser/options.test.mjs` |
| Manifest, version, zip contents | `test/release.test.ts` |
| Something only real Chrome decides (manifest loading, injection, permissions) | `test/browser/extension.test.mjs` |
| A speed-up worth keeping | a budget in `test/speed/` |

`test/browser/harness.mjs` builds pull request pages in GitHub's real markup with screenshots whose every
pixel is known. When GitHub's markup changes, update the harness from a real `body_html` and
`test/canary/` (which runs against live github.com on a schedule, outside the gate).

## Promises the tests hold

- Installs with no permissions; the only optional ones are GitHub's two image hosts.
- The page asks the network for nothing; the worker fetches only the two screenshots it was asked about.
- GitHub's own table is never modified, only hidden.

A change that needs to break one of these is the owner's decision.

## Finding what the tests miss

`npm run mutate` (slow; `npm run mutate -- content` for one source file) breaks the source one small change at a time and lists the
changes no test noticed in `reports/mutation/`. Run it after adding a feature and give each
surviving change in the new code a test, or a reason it can't matter.
