# Read: /history, /reports, /reports/review

## Scope and mode
- Mode: Read. The visitor understands something; structure serves comprehension.
- Primary `src/views/History.vue` (/history, Version History). Related: `Reports.vue` (/reports, File a Report) and `ReportsReview.vue` (/reports/review, Report Review).
- Reports and Review also carry a form and queue actions. They sit here by assignment; their controls follow native expectations, as in Operate.

## Audience and job
- History: signed-in members; the server decides who sees it, and a refusal reads "restricted to the forge and Legion leadership". Job: see what changed, when, and by whom. "Nothing here is ever removed."
- Reports: Legion members, who read how reporting works, file, and follow their report's status. Review: Reclusiarchs (administrators read only), who read a report and its history before acting.

## Action or task
- History: filter (All, Perks, Builds, Privileges), search, open an entry for its note and before/after text, page back with "Older". Revert and revoke show only to those allowed.
- Reports: fill the form (required fields are starred), then read "My reports". Review: open a report, claim it, then resolve or escalate.

## Proof and content
- The text is the content: dated entries, before/after descriptions, status labels, event histories. Nothing is summarised or invented.
- Reports and history carry member names at run time from the API. They never appear in the repo, a fixture or a screenshot.

## Constraints
- Each page walls on Discord sign-in first. Reports and Review then check roles ("Checking your roles…"); History shows the server's refusal. Each has short plain copy.
- Phone first: a left-aligned reading column, ledes near 52 characters, 44px taps, no horizontal page scroll (an expanded entry's raw snapshot wraps inside its panel).
- A long list, so it takes the quiet volcano profile (DESIGN.md, Layout); text on dense panels at 4.5:1.

## Direction and memorable moment
- Memorable moment: none. Motion is feedback and state only (an entry opening, press, loading).
- Refuses: stat tiles, charts or a card grid over what is a dated record, and any glow or flame on a log. Heading, intro, controls, list: structure does the work.

## Unresolved
- none
