# Persuade: /

## Scope and mode
- Mode: Persuade. The visitor decides and acts: join the Chapter, or open a tool.
- Route `/` (`src/views/Landing.vue`): the `HeroForge` first screen, then four cards under "Muster the Chapter".
- The navigation and the volcano behind it belong to every route and are not this brief's.

## Audience and job
- Two visitors, mostly on phones: someone not yet in the Salamanders' Discord (the page offers "Join the Chapter") and a Legion member who is (the same button reads "Open the Discord").
- Job: see in one screen that this is the clan's home and a working tool, then take the next step.

## Action or task
- Primary: the Discord button (join, or open the server for a signed-in member).
- Secondary: "Open the Perk Builder". Then the four cards, each "Enter →": Perk Builder, Weapon Armoury, Recommended Builds, Companies & Roster.

## Proof and content
- The proof is the product (PRODUCT.md, Positioning): a patch-corrected perk builder, armoury and builds, and live Discord role checks. The cards name the real tools and open them.
- Copy on the page: the eyebrow "XVIII Legion · Sons of Vulkan", the wordmark "Salamanders", the tagline "Into the fires of battle, unto the anvil of war."
- No analytics or user research exist. The page shows no counts or quotes and none may be invented. No member names, ids or secrets.

## Constraints
- Phone first: the hero fills the small viewport (svh, never a fixed 100vh), single column, 44px tap targets, safe-area padding.
- Text over the volcano is tested at 4.5:1; body copy sits on dense panels, never straight on the fire.
- Reduced motion is respected; the volcano shows a still frame.
- Signing in changes only the button's label and target (a live role check); the page works signed out.

## Direction and memorable moment
- Memorable moment: the forge itself, the volcano and the FireText title (the authored list in DESIGN.md, Motion). Warm light stays on that fire and the primary action (the Molten Core Rule).
- Refuses: a generic three-column feature grid of icon, heading and blurb as the argument for the clan. The proof is the tools; the cards are doors into them. Today's page still has a grid of four equal cards (kicker, title, blurb, "Enter →") under the hero; that is the arrangement this direction moves away from.

## Unresolved
- divider marks (flame, anvil, hammer) and the cold-armour material
