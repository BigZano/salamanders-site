# Operate: /planner, /armoury, /builds, /companies, /reports, /reports/review

## Scope and mode
- Mode: Operate. The visitor completes a task; scanability and native expectations outrank expression.
- Primary `src/views/Planner.vue` (/planner, Perk Builder). Related: `Armoury.vue` (/armoury, Weapon Armoury), `Builds.vue` (/builds, Recommended Builds), `Companies.vue` (/companies, Companies & Sections), `Reports.vue` (/reports, File a Report), `ReportsReview.vue` (/reports/review, Report Review).
- The navigation, the volcano and the sign-in flow are shared and not this brief's.

## Audience and job
- Clan members, mostly on phones between games (PRODUCT.md, Users). Saving or posting a build needs Discord sign-in; a Legion member also gets roster tools on /companies (Find me, Expand all, the Infirmary).
- Planner: plan a build for any class, perk by perk, and write down why. Armoury: find a weapon and plan its perk tree. Builds: find a build worth using. Companies: find a company, section or brother.
- Reports: a Legion member reports conduct that breaks the Chapter's code and follows its status. Review: a Reclusiarch works the queue (administrators read only).

## Action or task
- Planner: choose a class, one perk per column ("Your Build", n / 8), pick weapons, name it, "Save to library"; "Copy build" or "Share link" to pass it on.
- Armoury: choose a slot, search, open a weapon, read its statistics, "Equip for <class>".
- Builds: search, filter by class, "Open in builder" on a card ("Delete" shows only to those allowed). Verified Members' builds come first.
- Companies: search, jump by the company index.
- Reports: fill the form (required fields are starred), "File report", then follow "My reports".
- Review: open a report, "Claim" it, then resolve or escalate to the official form.

## Proof and content
- Game data follows the installed game files and patch notes (PRODUCT.md, principle 4). A corrected perk is marked "Corrected in game"; a weapon shows where its data came from; weapon trees are re-synced weekly.
- Builds and the Armoury have copy for loading, empty, no-match and failed states ("No builds posted yet", "No weapons match", Retry); the other lists do not yet.
- Member names reach the page from the API at run time and never live in the repo.

## Constraints
- Phone first, single column; 44px tap targets; fields are 16px on touch so the page never zooms.
- Touch has no hover: the Planner's perk preview opens by press and hold, so nothing may need hover alone.
- Every pressable squeezes on press; hover only for fine pointers (DESIGN.md, Motion).
- Long pages of tables get a quieter volcano (DESIGN.md, Layout); /reports and /reports/review have no profile of their own today. Text sits on dense panels.
- Reports and Review wall on Discord sign-in, then a role check ("Checking your roles…"); a refusal has short plain copy.

## Direction and memorable moment
- Memorable moment: none authored. Motion is feedback and state only: press, selection, loading, toast.
- Refuses: decoration that competes with the data (glow, flame or ornament on a list, row or stat) and custom replacements for controls the platform already does well.
- Warm light is for the primary action (Save, Equip, File report), nowhere else.

## Unresolved
- the nine left-border accent cards and the token drift in Planner
