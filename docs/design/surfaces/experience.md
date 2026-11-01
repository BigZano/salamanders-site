# Experience: /accolades, /ranks, /accolades/legacy, /deathwatch

## Scope and mode
- Mode: Experience. The visitor is inside the work itself; the artifact leads and the interface recedes.
- Primary `src/views/ArchiveView.vue` (a Legion Archive thread at /accolades and /ranks). Related: `LegacyAccolades.vue` (/accolades/legacy) and `deathwatch/DeathwatchHub.vue` (/deathwatch, the fortress's front hall).
- Two worlds, one mode: the Archive (the Forge at Night, a brass plaque) and Watch Fortress Ebonhold (the War Room, a dark-only scoped sub-theme). The pages under /deathwatch/:area have no brief yet.

## Audience and job
- Archive: XVIIIth Legion members only (the gate says so). They read the clan's own records, brought out of Discord: accolades and ranks.
- Hub: the Deathwatch and those the Watch Commander has cleared. Job: arrive in the fortress and choose where to go.

## Action or task
- Archive: sign in, pass the gate, read a thread, move by its table of contents, switch between Accolades and Legacy Accolades.
- Hub: "Choose your destination" from four painted cards (Event Tracker, Armouring Hall, Chronicles of Valor, Hall of Relics); "Enlist now" for Recruitment; Manage for the Watch Commander only.

## Proof and content
- The record is the content: sealed archive threads, opened for a signed-in member after an integrity check, and the retired roles of Legacy Accolades with their holders as of a snapshot date.
- Hub: the crest, "Watch Fortress Ebonhold", "Suffer not the alien to live." and the painted card art.
- The plaintext archive and member names stay out of the repo; only sealed ciphertext ships.

## Constraints
- Both are gated: the Archive by Discord sign-in and the Legion role, the Deathwatch by clearance. Each gate state has plain copy and, where it helps, Try again or Reload. Thematic secrecy, real secrecy where it matters.
- The Archive's thread view is fidelity-critical: do not restyle its shared headings casually. Near ash falls over the plaque, not behind it.
- Deathwatch tokens live on the `.dw` wrapper and never on `:root`; text sits on a dense framed panel, never on the painting; dark only.
- Phone first; 44px taps; reduced motion shows the volcano still and stops the drift and flicker.

## Direction and memorable moment
- Archive: the unsealing, and `brand-cool` on an honour (DESIGN.md, Motion, the authored list).
- Deathwatch: the backdrop's slow drift and flicker.
- Refuses: dashboard or card-grid chrome around the plaque; a second glow competing with an honour; the cogitator look leaking onto the main site, or the main site's ember-and-glass inside the fortress.

## Unresolved
- dragons default-on, Time of Trial polish
