# SM2 news alert that feeds the bakes (plan sketch)

Status: **not started**. Raised by Bret on 2026-10-14. This is a sketch to brainstorm from, not a spec: it needs the brainstorm, spec and plan steps before anything is built.

## Why

Patch 15.0 showed how the data goes stale:

- The only trigger is the Monday bake (`.github/workflows/data-check.yml`). A patch on a Wednesday waits five days, and the 15.0 data was refreshed by hand on the 14th, two weeks after the patch.
- The wiki lags the patch notes and sometimes contradicts them: *Marksman's Mandate* listed at two Tactical levels, *Passive Chambering* missing, the One-Handed Thunder Hammer page with no perk list. The Thunder Hammer perks only arrived because Bret copied them from the game.
- `scripts/check-updates.mjs` already watches the Steam announcements feed, but it only reads titles (`maxlength=1`) and writes `last-patch.json`. Nothing reads what the notes say, so "the patch notes win" is applied by a person from memory.

## Goal

When SM2 news lands (patch notes, hotfixes, community updates, dev posts), tell Bret and leadership quickly, with the claims in the notes attached, and give the bakes the facts they need to tell corroborated wiki changes from uncorroborated ones without a person doing it by eye.

## What already exists to build on

- `scripts/check-updates.mjs`: the Steam feed check, and `last-patch.json` as its memory.
- `data-check.yml`: a weekly workflow with `workflow_dispatch`, and a PR as the review gate.
- `src/data/patch-overrides.json`: every correction with its `sources`, plus pins and stale-override warnings.
- The hold flags (`--classes`, `--keep-perks`) and the drift report they print.
- `perksPending` and the "Perk tree not published yet" message, which already mark known gaps.
- `server/src/webhook.js` (a Discord notifier that disables mentions) and a workflow that uses a bot-token secret (`discord-members.yml`).

## Sketch

1. **Watch more often and from more places.** A short cron separate from the weekly bake. Sources in one JSON file: the Steam feed (exists), the Focus community blog where the 15.0 notes were published, and the wiki's recent changes for the pages we bake. Prefer feeds and APIs over scraping pages.
2. **Keep the text.** Save each new official post in full (a `news/` folder or similar) so overrides can cite a stable copy, not a link that may change.
3. **Alert.** A Discord message: title, link, and what a dry bake would change (the drift counts, the weapons still pending). Needs a webhook secret and a channel decision.
4. **Corroboration facts.** A `patch-facts.json` of statements taken from the notes ("Tactical level 6 is Improved Efficiency"), which the bake checks wiki changes against, tagging each drift line corroborated or not. Extracting facts from prose is the hard part: by hand in a PR, or LLM-proposed and human-approved. Never adopted automatically.
5. **Pending tracker.** List the weapons with `perksPending` and say in the alert when the wiki page for one of them changes.
6. **Smarter weekly PR.** With corroboration data the bake could adopt corroborated drift and hold the rest, which answers the open question about the weekly workflow in the Patch 15.0 handoff.

## Smallest useful first slice

A short-cron workflow that runs the existing check, saves the full text of any new official post, and posts the title, link and a drift summary to Discord. Everything else comes later.

## Open questions

- Which Discord channel, and who is pinged?
- Which sources does Bret trust beyond Steam and the Focus blog? Is there an official feed for the blog?
- Is a short cron acceptable for the repo's GitHub Actions minutes?
- Should fact extraction be LLM-assisted, with a human approving each fact?
- What counts as news worth an alert: hotfixes, community updates, dev posts?

## Risks

- Scraping third-party pages (terms of use, fragility): use feeds and APIs.
- Alert fatigue: only alert on posts that match patch-shaped titles, or that change the dry-bake drift.
- A wrong extracted fact adopted silently: facts are proposals that a person approves, and the alert never changes data on its own.
- Secrets: the webhook URL stays in the workflow's secrets.

## Next step

Run the brainstorming step for this, then write a spec and plan. It is independent of Spec B+C (the Perk Builder version picker and rationale boxes), so the order is Bret's call.
