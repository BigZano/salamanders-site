# Operate: /planner, /armoury, /builds, /companies

## Scope and mode
- Mode: Operate. The visitor completes a task; scanability and native expectations outrank expression.
- Primary `src/views/Planner.vue` (/planner, Perk Builder). Related: `Armoury.vue` (/armoury, Weapon Armoury), `Builds.vue` (/builds, Recommended Builds), `Companies.vue` (/companies, Companies & Sections).
- The navigation, the volcano and the sign-in flow are shared and not this brief's.

## Audience and job
- Clan members, mostly on phones between games (PRODUCT.md, Users). Saving or posting a build needs Discord sign-in; a Legion member also gets roster tools on /companies (Find me, Expand all, the Infirmary).
- Planner: plan a build for any class, perk by perk, and write down why. Armoury: find a weapon and plan its perk tree. Builds: find a build worth using. Companies: find a company, section or brother.

## Action or task
- Planner: choose a class, one perk per column ("Your Build", n / 8), pick weapons, name it, "Save to library".
- Armoury: choose a slot, search, open a weapon, read its statistics, "Equip for <class>".
- Builds: search, filter by class, open a card; apply or share it in a click. Verified Members' builds come first.
- Companies: search, jump by the company index.

## Proof and content
- Game data follows the installed game files and patch notes (PRODUCT.md, principle 4). A corrected perk is marked "Corrected in game"; a weapon shows where its data came from; weapon trees are re-synced weekly.
- Every list has copy for loading, empty, no-match and failed states ("No builds posted yet", "No weapons match", Retry).
- Member names reach the page from the API at run time and never live in the repo.

## Constraints
- Phone first, single column; 44px tap targets; fields are 16px on touch so the page never zooms.
- Touch has no hover: the Planner's perk preview opens by press and hold, so nothing may need hover alone.
- Every pressable squeezes on press; hover only for fine pointers (DESIGN.md, Motion).
- Long pages of tables get a quieter volcano (DESIGN.md, Layout). Text sits on dense panels.

## Direction and memorable moment
- Memorable moment: none authored. Motion is feedback and state only: press, selection, loading, toast.
- Refuses: decoration that competes with the data (glow, flame or ornament on a list, row or stat) and custom replacements for controls the platform already does well.
- Warm light is for the primary action (Save, Equip), nowhere else.

## Unresolved
- the nine left-border accent cards and the token drift in Planner
