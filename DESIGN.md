---
name: Salamanders
description: Cold armour, molten core — a dark, forged clan site with a volcano burning behind every page.
colors:
  obsidian: "#050a08"
  pitch: "#07110d"
  basalt: "#0b1511"
  basalt-2: "#0e1c16"
  basalt-3: "#111b18"
  ash: "#26372f"
  ash-2: "#3a5246"
  bone: "#e8efe9"
  smoke: "#96a59c"
  drake: "#59d66c"
  drake-deep: "#173c23"
  ember: "#ff6a2b"
  magma: "#e0431d"
  gold: "#dfb85b"
  averland: "#fdb825"
  whitehot: "#f2d27a"
  cobalt: "#6cc4ef"
  violet: "#bb82e0"
  vacant: "#ff9a7a"
  dw-bg: "#060906"
  dw-surface: "#0b110c"
  dw-surface-2: "#111a12"
  dw-ink: "#e2ecdc"
  dw-muted: "#83978a"
  dw-line: "#1a2b1c"
  dw-line-2: "#2a4a2d"
  dw-accent: "#7fd35c"
  dw-accent-ink: "#041004"
  dw-silver: "#c3ccd5"
  dw-gold: "#e0b43c"
  dw-up: "#5fcf8b"
  dw-down: "#e5736a"
typography:
  display:
    fontFamily: "'Oswald Variable', Bahnschrift, 'DIN Condensed', Oswald, 'Arial Narrow', system-ui, sans-serif"
    fontSize: "clamp(2.2rem, 7vw, 3.6rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "0.02em"
  body:
    fontFamily: "system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'Cascadia Code', 'Cascadia Mono', ui-monospace, Consolas, monospace"
    fontSize: "0.72rem"
    fontWeight: 400
    letterSpacing: "0.32em"
  dw-title:
    fontFamily: "'Cinzel Variable', Cinzel, Georgia, serif"
    fontSize: "clamp(2rem, 8vw, 3.4rem)"
    fontWeight: 700
    lineHeight: 1.05
rounded:
  sm: "2px"
  md: "3px"
  lg: "8px"
  pill: "999px"
spacing:
  gutter: "1.25rem"
  page-x: "1.5rem"
  page-top: "4rem"
components:
  button-ember:
    backgroundColor: "{colors.ember}"
    textColor: "#1a0d06"
    typography: "{typography.display}"
    rounded: "{rounded.sm}"
    padding: "0.7rem 1.4rem"
  button-drake:
    backgroundColor: "rgba(89, 214, 108, 0.06)"
    textColor: "{colors.drake}"
    typography: "{typography.display}"
    rounded: "{rounded.sm}"
    padding: "0.7rem 1.4rem"
  panel:
    backgroundColor: "{colors.basalt-2}"
    textColor: "{colors.bone}"
    rounded: "{rounded.md}"
    padding: "1.5rem"
  field:
    backgroundColor: "{colors.basalt-2}"
    textColor: "{colors.bone}"
    rounded: "{rounded.md}"
    padding: "0.7rem 1rem"
  chip:
    backgroundColor: "{colors.obsidian}"
    textColor: "{colors.smoke}"
    rounded: "{rounded.pill}"
    padding: "0.35rem 0.7rem"
  dw-card:
    backgroundColor: "{colors.dw-surface}"
    textColor: "{colors.dw-ink}"
    typography: "{typography.dw-title}"
    rounded: "{rounded.md}"
    padding: "1rem 1.2rem"
---

# Design System: Salamanders

## Overview

**Creative North Star: "The Forge at Night"**

A cold, dark workshop with one furnace burning in it. The ground is basalt and obsidian, the armour-grey panels are
quiet, and molten light turns up only where it means something: the primary action, the lava down the volcano that
sits behind every page, an honour. The site is a tool people use on a phone between games, so the dark is for
readability first and atmosphere second: text sits on dense panels, never directly on the fire.

The system is hard-edged and condensed. Titles are forged capitals in a narrow display face; small technical
labels are spaced-out mono; corners are nearly square. Panels are glass over the volcano (a blur and a one-pixel
ash border), and controls answer a touch with a visible squeeze. Nothing is soft, rounded or pastel.

**Key Characteristics:**
- Dark only: obsidian ground, bone text, no light theme.
- One furnace: warm colour is rare, and always means something live.
- Forged capitals for titles, spaced mono for labels, plain system type for reading.
- Near-square corners (2-3px), 1px ash borders, glass panels over a fixed procedural volcano.
- Press feedback on everything pressable (`scale(0.97)`); hover only where a pointer can hover.
- Phone first: single column, 44px minimum tap targets, safe-area padding.

### The Deathwatch area (a scoped sub-theme)

**Creative North Star for this area: "The War Room"** (the War-Room Ledger). The Deathwatch's Watch Fortress
Ebonhold is the Salamanders' own, so it keeps the site's dark and its fire, but it presents itself as the artifact
does: a black-green command room of ledgers, standings and records, in a serif display (Cinzel) over a translucent
backdrop, with only a light fire motif (the volcano's sparks showing through). Its tokens are the `dw-*` colours
above, set on one wrapper (`.dw`) and never on `:root`. It is dark only too.

## Colors

A near-black green ground with grey-green armour, one living green, and a furnace: ember, magma and gold.

### Primary
- **Drake Green** (#59d66c): the "alive" colour: active links, outlines of secondary buttons, focus rings, small
  status marks. Used sparingly. (**Drake Deep**, #173c23, is in the theme but nothing uses it yet.)

### Secondary
- **Ember** (#ff6a2b) and **Magma** (#e0431d): the molten core. Ember is the primary call to action (a vertical
  ember-to-magma gradient with a glow); magma is its shadow and the lava. Never used for body text or large fills.

### Tertiary
- **Gold** (#dfb85b), **Averland** (#fdb825) and **Whitehot** (#f2d27a): honours and record. Averland is the
  Legion Archive's brass plaque; whitehot is the hot end of the rank heat ramp; gold is rules and edges.
- **Cobalt** (#6cc4ef) and **Violet** (#bb82e0): the weapon tree's two branches. **Vacant** (#ff9a7a): a post nobody holds.

### Neutral
- **Obsidian** (#050a08): the page ground. **Pitch** (#07110d): the end of the ground gradient.
- **Basalt** (#0b1511), **Basalt 2** (#0e1c16, the panel colour) and **Basalt 3** (#111b18): layered surfaces.
- **Ash** (#26372f) and **Ash 2** (#3a5246): borders and dividers.
- **Bone** (#e8efe9): text. **Smoke** (#96a59c): secondary text.

### Deathwatch (`dw-*`)
Ground **dw-bg** (#060906), panels **dw-surface** (#0b110c) and **dw-surface-2** (#111a12), text **dw-ink**
(#e2ecdc) and **dw-muted** (#83978a), lines **dw-line** (#1a2b1c) and **dw-line-2** (#2a4a2d), accent
**dw-accent** (#7fd35c) with **dw-accent-ink** (#041004) on it, **dw-silver** (#c3ccd5) for the Deathwatch,
**dw-gold** (#e0b43c) for honours, **dw-up** (#5fcf8b) and **dw-down** (#e5736a) for movement. Every text colour
is tested at 4.5:1 on the surface.

### Named Rules
**The Molten Core Rule.** Warm light is rare and always live: the primary action, the lava, an honour. If a screen
has more than one glowing thing competing, one of them is wrong.

**The Dense Panel Rule.** Text never sits directly on the volcano. It sits on a panel dense enough to keep body
text at 4.5:1 against the brightest lava.

## Typography

**Display Font:** Oswald Variable (with Bahnschrift, DIN Condensed, Arial Narrow)
**Body Font:** the system sans (system-ui, Segoe UI, Roboto)
**Label/Mono Font:** Cascadia Code (with ui-monospace, Consolas)
**Deathwatch titles:** Cinzel Variable (with Georgia), self-hosted and loaded only with the Deathwatch routes.

**Character:** a forged, condensed title face over plain reading text, with spaced-out mono for the technical
labels, like stamped plates on armour. Fonts are self-hosted: no third-party font requests.

### Hierarchy
- **Display** (700, `clamp(2.2rem, 7vw, 3.6rem)`, 1.05): page titles, uppercase, 0.02em tracking.
- **Body** (400, 1rem, 1.6): reading text; ledes stay near 52 characters wide.
- **Label** (400, 0.72rem, 0.32em, uppercase mono): eyebrows above titles and small data labels.
- **Deathwatch title** (700, `clamp(2rem, 8vw, 3.4rem)`, 1.05, Cinzel): area titles and card titles in the Deathwatch area only.

### Named Rules
**The Forged Caps Rule.** Display type is uppercase and condensed. A title in sentence case is a bug.

## Layout

Mobile first, single column, with a left-aligned reading column and the volcano placed in the empty half
(each route has its own volcano profile, quieter on long pages of tables). Pages set their own width: 60rem for
Companies, 68rem for Builds, 76rem for the Armoury, the landing page and the sticky navigation (1.25rem padding);
the reading page has 1.5rem side padding. Breakpoints seen: 600px, 640px, 860px and 900px. On a phone cards go full width, tap targets are at least 44px (the banner strips are 56px),
and the page pads the safe areas so nothing hides under a notch or the home indicator. The Deathwatch area shows
the list of views as a bottom sheet below 900px and as a sidebar from 900px.

## Elevation & Depth

A hybrid: depth is **glass layered over a fixed procedural volcano**, with glow reserved for the primary action.
Panels are translucent with a blur (6-8px) and a one-pixel ash border; the navigation is the same glass at 10px.
There are no drop shadows on content.

### Shadow Vocabulary
- **Ember glow** (`box-shadow: 0 8px 30px -8px rgba(224, 67, 29, 0.7)`): the primary button at rest.
- **Ember glow, lit** (`0 12px 40px -8px rgba(224, 67, 29, 0.85)`): the primary button on hover (pointer devices only).

### Named Rules
**The Flat Content Rule.** Content panels are flat glass. Only the primary action glows, and only the volcano burns.

## Shapes

Hard-edged. Corners are 2px on controls and 3px on panels and fields; 6-8px appears only on larger blocks; chips are
pills (999px); the Deathwatch bottom sheet rounds only its top corners (14px). Borders are one pixel, in ash.

## Components

### Buttons
- **Shape:** nearly square (2px).
- **Primary (ember):** a vertical ember-to-magma gradient with a dark label (#1a0d06) in uppercase display type, a
  one-pixel warm border, and a glow. Padding about 0.7rem 1.4rem, and at least 44px tall on a phone.
- **Secondary (drake):** a faint drake tint with a drake outline and drake uppercase label.
- **Press:** `scale(0.97)` on every pressable thing, 150ms. **Hover:** only inside `@media (hover: hover) and (pointer: fine)`.

### Chips
- **Style:** pill (999px), one-pixel ash border, smoke text on a dark backing (`rgba(5, 10, 8, 0.6)`) so it
  stays readable where it crosses the lava; the border turns drake on hover.

### Panels
- **Glass panel** (`.surface`): `basalt-2` at 86-90% over a blur, one-pixel ash border, 3px corners, dense enough for
  4.5:1 text. `.panel-forge` is the lighter version.

### Inputs / Fields
- **Style:** `rgba(14, 28, 22, 0.6)` fill, one-pixel ash border, 3px corners, bone text. On a touch screen every
  field is 16px so the page never zooms. **Focus:** a 2px drake outline, offset 2px.

### Navigation
- **Style:** sticky, translucent obsidian glass with a 10px blur and an ash bottom border; the brand is spaced
  uppercase display type. On a phone it collapses to a menu button.

### Deathwatch signature components
- **Area bar and bottom sheet:** the banner at the head of an area says where you are and opens the list of views
  in a native modal sheet from the foot of the screen, where a thumb reaches it. It drags and flicks away.
- **Gate card and hub cards:** dw-surface panels with a dw-line-2 border, Cinzel titles, an accent in dw-accent.
- **REDACTED strip:** a black striped bar with spaced mono text, on `/companies`, the way into the area.

## Do's and Don'ts

### Do:
- **Do** keep warm colour for the primary action, the lava and honours (the Molten Core Rule).
- **Do** put text on dense panels and keep it at 4.5:1 over the brightest lava.
- **Do** make every pressable thing squeeze on press, and gate every hover behind `(hover: hover) and (pointer: fine)`.
- **Do** keep tap targets at 44px or more on a phone, and pad the safe areas.
- **Do** animate `transform` and `opacity` only, under 300ms, with the forge easing (`cubic-bezier(0.2, 0.8, 0.2, 1)`),
  and give every animation a reduced-motion variant.
- **Do** self-host fonts and keep the Deathwatch area dark only.

### Don't:
- **Don't** add a light theme or a pastel.
- **Don't** put body text straight onto the volcano.
- **Don't** round corners softly: nothing here is a bubble.
- **Don't** use a fixed `100vh`; use `dvh` or `svh`.
- **Don't** request third-party fonts or put real names, ids or secrets in a screenshot, fixture or doc.
