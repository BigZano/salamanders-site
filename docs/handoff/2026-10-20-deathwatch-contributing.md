# Contributing to the Deathwatch area

> **Superseded by [CONTRIBUTING.md](../../CONTRIBUTING.md).** Where the two disagree, that file wins. This page is kept
> for history; it was written for the Deathwatch area alone.

For anyone building the Watch Fortress Ebonhold pages (`/deathwatch`) who is new to GitHub. The repo is public,
so the rule that matters most comes first.

> **Never commit real names, Discord ids, role ids or passwords** - not in code, fixtures, tests, screenshots
> or docs. Anything you need to show uses invented values. Real data lives only in the server's database.

Read these two first (they are on the `feat/deathwatch` branch): the design,
`docs/superpowers/specs/2026-10-20-deathwatch-design.md`, and the build plan,
`docs/superpowers/plans/2026-10-20-deathwatch-foundation-and-shell.md`.

## One-time setup

1. Install [Git](https://git-scm.com/) and [Bun](https://bun.sh/). If your Node.js is v25 or newer, put
   `NODE_OPTIONS=--no-experimental-webstorage` in front of test commands.
2. **Fork** the repo: on `github.com/BigZano/salamanders-site` press **Fork** (top right) and create the fork
   under your own account. You work in your fork; you never push to the original.
3. Clone your fork and add the original as `upstream`:

   ```
   git clone https://github.com/<your-username>/salamanders-site.git
   cd salamanders-site
   git remote add upstream https://github.com/BigZano/salamanders-site.git
   git fetch upstream
   bun install
   ```

## Starting a piece of work

Branch from the Deathwatch branch, not from `main`, and name it `dw/<topic>`:

```
git switch -c dw/standings upstream/feat/deathwatch
```

Commit as you go with plain messages (`feat: standings table`). Small branches are easier to review.

## Running and checking it

```
bun run dev        # the site, at http://localhost:5173
bun run test       # the whole test suite
bun run build      # a production build
```

- `VITE_DEATHWATCH_FIXTURE=1 bun run dev` serves invented data, and `?scene=allowed`, `commander`, `denied`,
  `signin`, `checking` and `unavailable` show each state of the gate. Sign-in and the real server are not needed.
  `docs/handoff/2026-10-20-deathwatch-shell.md` (on `feat/deathwatch`) says what the area has so far.
- `bun run dev:lan` serves the site on your network so you can open it on your phone. Most of the community is
  on phones, so check there too.

## Opening a pull request

```
git push -u origin dw/standings
```

GitHub then shows a **Compare & pull request** button. Before you create it, check the **base**:

- base repository: `BigZano/salamanders-site`
- base branch: **`feat/deathwatch`** (not `main`)

Describe what changed and how to see it. A check called **PR check** then runs the tests and a build. The first
time you contribute, GitHub waits for the maintainer to approve that run - that is expected. The maintainer reviews
and merges, and brings `feat/deathwatch` into `main` at milestones.

## Keeping your fork current

```
git fetch upstream
git switch dw/standings
git merge upstream/feat/deathwatch
```

## Rules

- Names, ids, passwords: never (see the top of this page).
- No `v-html` anywhere in the Deathwatch code. Text from the database is shown by normal Vue interpolation.
- Do not edit `.github/` or `server/` without asking first.
- Your fork never holds secrets, and you should never add one. Nothing here needs one.
- Keep to the plan's file layout; if a change does not fit it, ask before inventing a new one.

## Using Claude Code

Point it at the design and the plan above and at this page, and tell it the rules in the box at the top. It can
run the git steps for you; check the base branch of the pull request yourself before you create it.
