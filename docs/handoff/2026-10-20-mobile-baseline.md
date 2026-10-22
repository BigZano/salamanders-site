# Handoff: mobile baseline (2026-10-20)

Site-wide fixes that remove the "this is a website" tells on a phone. They are small on purpose: a
meta tag, a few base-layer rules and two shared buttons. The ~36 per-component `:hover` rules (21 files)
are a separate sweep; nothing here touches them. Design reasoning: `docs/superpowers/specs/2026-10-20-deathwatch-design.md`
("Mobile requirements").

## What changed

| Fix | Where | Why |
| --- | --- | --- |
| `viewport-fit=cover` | `index.html` | Lets the page paint under the notch and home indicator, like an installed app. |
| Side and bottom safe-area padding on `body`; three bottom toasts clear the home indicator | `src/style.css`, `Armoury.vue`, `Builds.vue`, `Planner.vue` | `viewport-fit=cover` alone would slide content under the notch in landscape. |
| `-webkit-tap-highlight-color: transparent` | `src/style.css` | No grey flash on tap. Controls have `:active` feedback instead. |
| `-webkit-text-size-adjust: 100%` | `src/style.css` | No font inflation when a phone turns landscape. |
| `touch-action: manipulation` on `button`, `a`, `[role='button']` | `src/style.css` | A tap fires at once, with no wait for a double-tap. |
| Text fields 16px on touch screens (`@media (pointer: coarse)`) | `src/style.css` | Under 16px iOS zooms the page on focus and never zooms back. Every field was 0.82-0.95rem. |
| `.btn-ember` and `.btn-drake` hovers only where a pointer can hover; press state `scale(0.97)` | `src/style.css` | A touch screen fakes a hover on the first tap and keeps it. |

Deliberately **not** done: `overscroll-behavior: none` (the site is mostly scrolling documents, so
pull-to-refresh should stay) and `user-select: none` on `body` (people copy text).

## Testing on your phone

```
bun run dev:lan
```

It prints a `Network:` URL. Open it on a phone on the same Wi-Fi (allow the firewall prompt if Windows
asks). Discord sign-in will **not** work against it: the redirect address must match one registered with
Discord, and a LAN address is not. Use the fixture instead, which needs no sign-in:

```
VITE_ROSTER_FIXTURE=1 bun run dev:lan
```

then open `/companies?scene=full`. The deployed site is the other place to check anything signed-in.

## Checklist (needs a real phone)

Desktop emulation cannot reproduce any of these.

- [ ] **Tap flash.** Tap links and buttons on `/`, `/builds` and `/armoury`: no grey or blue flash.
- [ ] **Sticky hover.** Tap a `.btn-ember` button on the landing page. It squeezes slightly while pressed and
      does not stay lifted or brightened afterwards.
- [ ] **No zoom on focus.** Focus the search box on `/companies` and on `/builds`: the page must not zoom in.
- [ ] **Landscape.** Rotate a notched phone. Nothing sits under the notch or the rounded corners, and the
      background still fills edge to edge.
- [ ] **Home indicator.** Scroll to the very end of a long page: the footer text clears the indicator.
      Trigger a toast (save a build in the Perk Builder) and check it clears the indicator too.
- [ ] **Double-tap.** Double-tap a button quickly: the page does not zoom.
- [ ] **Pull-to-refresh.** At the top of a long page, drag down: Android refreshes, iOS rubber-bands. Both are
      unchanged on purpose.

## What was verified from code, and what was not

Verified by tests (`src/style.test.js`): the viewport meta, the base-layer rules, the 16px block, the safe-area
padding, that every `:hover` in `style.css` sits inside the hover media query, and the press states.
**Not verified without a device:** everything in the checklist above.
