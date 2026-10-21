# Handoff: the Deathwatch shell (2026-10-20)

The front-end frame of the Deathwatch area ("Watch Fortress Ebonhold") at `/deathwatch`, built on a dev-only
fixture so it needs no server. Design: `docs/superpowers/specs/2026-10-20-deathwatch-design.md`; the plan that
built it: `docs/superpowers/plans/2026-10-20-deathwatch-foundation-and-shell.md`. This note holds no names, ids or
real data, and nothing that is added to the area may either.

## What exists

| Piece | Where |
| --- | --- |
| The REDACTED banner on `/companies` (signed out: one click signs in and returns to `/deathwatch`) | `src/components/company/DeathwatchBanner.vue` |
| The gate: signed out, verifying, cleared, not on record, or the fortress cannot be reached | `src/components/deathwatch/DeathwatchGate.vue`, `src/stores/deathwatch.js` |
| The scoped dark theme (`--dw-*` tokens, Cinzel titles, translucent backdrop) | `src/components/deathwatch/deathwatch.css`, `DeathwatchShell.vue` |
| The hub and the four areas (Event Tracker, Armouring Hall, Chronicles of Valor, Manage) | `src/views/deathwatch/` |
| Every view's address, kept canonical on entry and on a change of tab | `src/lib/deathwatch/areas.js`, `redirect.js`, the guard in `src/router.js` |
| The phone navigation: a bar that opens a bottom sheet (the sidebar from 900px) | `DeathwatchAreaBar.vue`, `DeathwatchNavSheet.vue`, `DeathwatchNav.vue` |
| The volcano profile for the whole section | `'/deathwatch/*'` in `src/lib/fireTuning.js` |
| Sign-in with a return path (and a ten-minute fallback copy for a phone's Discord app) | `src/lib/discordAuth.js`, `src/stores/auth.js` |

Every view is a placeholder ("This view is being rebuilt.") until its own chunk. The server does not exist yet:
on the real site `GET /deathwatch/me` fails, so the gate shows "The fortress could not be reached".

## Running it

```
VITE_DEATHWATCH_FIXTURE=1 bun run dev      # then open http://localhost:5173/deathwatch
```

`?scene=` picks what the gate shows, with no sign-in: `allowed`, `commander` (adds the Manage card and area),
`denied`, `signin`, `checking` and `unavailable`. It survives the address being tidied. The volcano's look for the
section can be tuned with `?tune=1` (the `/deathwatch/*` row).

## Real-phone checks (nothing here can be proved on a desktop)

Use `bun run dev:lan` (from the mobile-baseline pull request) and open the Network URL on a phone. The sign-in
check needs the deployed site.

- [ ] **The sheet.** Tap the bar under the site header: the list slides up from the foot, the page behind is dimmed
      and does not scroll. Drag the grip down slowly and let go: it springs back. Flick it down: it slides away.
- [ ] **Bottom edge.** The last link ("Back to the Fortress") clears the home indicator (needs `viewport-fit=cover`,
      so the mobile-baseline pull request).
- [ ] **iOS Back swipe.** Swiping in from the left edge goes Back, as in any page; the sheet does not fight it.
- [ ] **One finger.** Put a second finger down while dragging: the sheet ignores it.
- [ ] **Reduced motion.** With the OS setting on, the sheet opens and closes without sliding.
- [ ] **Sign-in return.** Signed out, tap REDACTED on `/companies` with the Discord app installed: authorize, and you
      land on `/deathwatch`, not `/`.
- [ ] **Tap targets.** The REDACTED strip, the bar, the cards and the list links are all easy to hit with a thumb.

## How it was checked, and what was not

Unit and component tests cover every piece; the two pure modules (`areas.js`, `sheetDrag.js`) are in the 100%
coverage and mutation gate. The sheet, the gate and the banner were also weakened by hand (seven, three and four
ways) to see that the tests notice. In Chrome at a 375px-wide frame, with real pointer events, the sheet followed a
drag, gave with friction upwards, sprang back from a slow drag and a cancelled touch, ignored a second finger,
closed on a flick, on a click on the scrim and on a real Escape, and released the page scroll. **Not checked:** touch
hardware, the iOS edge swipe, safe areas and the Discord app hand-off. That is the list above.
