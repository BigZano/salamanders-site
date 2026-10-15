# Roster design mock (reference)

The approved visual and interaction reference for
`docs/superpowers/specs/2026-10-13-roster-design-pass-design.md`. Plain HTML, CSS and
JS over the synthetic roster fixture. It is a reference, not shipped code: copy the CSS
values and behaviour from it, do not import it.

## Run it

From the repo root (PowerShell or bash):

    node docs/superpowers/specs/2026-10-13-roster-design-pass-mock/serve.mjs

but first copy the two assets it expects next to `index.html`:

    cp src/data/roster.fixture.json docs/superpowers/specs/2026-10-13-roster-design-pass-mock/fixture.json
    cp node_modules/@fontsource-variable/oswald/files/oswald-latin-wght-normal.woff2 docs/superpowers/specs/2026-10-13-roster-design-pass-mock/oswald.woff2

Then open http://localhost:5180/index.html. A `#company-3` style hash opens that branch.

## What to read in it

- `<style>`: every colour, size, easing and delay the spec pins (heat spine, bar grid,
  chip, dais, peers, lateral stub, aside). Selectors map to the real components as
  listed in the implementation plan.
- `buildRosterView`-equivalent logic lives in `ladder()`, `summary()`, `heat()` and
  `showTag` (inside `chip()`); the plan's `rosterView.js` ports those.
- `pinned()`, `openNow()` and `settle()` are the reader-pinning and instant-open rules.

## Measurement helpers (not shipped)

- `bench.js`: the frame sampler (rAF deltas, long-animation-frame, pinned-element
  position). It is loaded by `index.html`; use `__run()`, `__frames()` from the console.
- `genpng.mjs`: writes 220 synthetic 64 px PNGs to `av/` for the avatar-loading checks
  (`?img=eager|lazy|onopen&dec=async`).

Mock-only liberties, not part of the design: a synthetic Company Champion added to 1st
Company (to show same-tier peers), and the viewer is hard-wired to a 3rd Company
Battle-Brother (Find me).
