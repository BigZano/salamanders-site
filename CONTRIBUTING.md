# Contributing to the Salamanders site

This page is for the invited group of contributors. The repo is public so the work is visible, but it is not an open
call for pull requests: reach out by email to a maintainer or the owner before you start anything big, so nobody
builds the same thing twice. It assumes you are new to GitHub.

## The one rule

> **Real-world values are checked on a clock, Owner-held, and a live feed to the guild.**

So your pull request never adds them: no real names, handles, Discord user ids, role ids, passwords, tokens or
anything from the sealed Legion Archive, whether in code, tests, fixtures, screenshots or docs. Show things with
invented values, and make invented ids obviously fake, like `111111111111111111`. Links to the guild's Discord server
and Discord channel ids are fine; user ids and role ids are not.

Two files already hold real member data: `src/data/discord-members.json` (kept in sync by a bot) and
`src/data/companies.json` (extracted by hand). The owner maintains them. Do not edit them and do not copy values out
of them. Moving that data out of the repo is tracked in
[#42](https://github.com/BigZano/salamanders-site/issues/42), and this paragraph goes when that is done.

If you find a real value somewhere else in the repo, email a maintainer or the owner directly. Do not open a public
issue or pull request about it, because that would publish it again.

## One-time setup

1. Install [Git](https://git-scm.com/), [Bun](https://bun.sh/) and [Node.js](https://nodejs.org/) 24 (the version CI
   uses; the commit hook needs Node). On Node 25 or newer, set `NODE_OPTIONS=--no-experimental-webstorage` in your
   terminal before you run the tests or `git commit`: `export NODE_OPTIONS=--no-experimental-webstorage` in bash or
   zsh, `$env:NODE_OPTIONS='--no-experimental-webstorage'` in PowerShell.
2. **Fork** the repo: on `github.com/BigZano/salamanders-site` press **Fork** (top right) and create the fork under
   your own account. You work in your fork and never push to the original. A fork is a full copy, so you can run the
   site on your own machine (`bun run dev`) and see your changes before anyone else does.
3. Clone your fork and add the original as `upstream`:

   ```
   git clone https://github.com/<your-username>/salamanders-site.git
   cd salamanders-site
   git remote add upstream https://github.com/BigZano/salamanders-site.git
   git fetch upstream
   bun install
   ```

## Starting a piece of work

Branch from `main`, unless your work belongs to an area branch (see below). Give your branch a prefix that says what
it is:

```
git fetch upstream
git switch -c fix/nav-overflow upstream/main
```

| Prefix | For |
|---|---|
| `feat/` | a new feature |
| `fix/` | a bug fix |
| `chore/` | upkeep and things that need fixing: dependencies, tooling, clean-up |
| `docs/` | documentation |
| `data/` | game data or content |
| `design/` | visual design work |

### Area branches

Big pieces of work get their own long-lived branch, named `feat/<area>` (or `chore/<area>` for a large clean-up). If
your work belongs to one, branch from it and open your pull request into it instead of `main`. The maintainers bring
an area branch into `main` at milestones. The current ones are listed here:

- **`feat/deathwatch`**: the Deathwatch pages (`/deathwatch`). Name your branch `dw/<topic>`:

  ```
  git switch -c dw/standings upstream/feat/deathwatch
  ```

  Read the design (`docs/superpowers/specs/2026-10-20-deathwatch-design.md`) and the build plan
  (`docs/superpowers/plans/2026-10-20-deathwatch-foundation-and-shell.md`) first, and keep to the plan's file layout;
  if a change does not fit it, ask before inventing a new one. `docs/handoff/2026-10-20-deathwatch-shell.md` says
  what the area has so far. No `v-html` anywhere in the Deathwatch code: text from the database is shown by normal
  Vue interpolation.

## Running and checking it

```
bun run dev        # the site, at http://localhost:5173
bun run test       # the whole test suite
bun run build      # a production build
bun run dev:lan    # the site on your network, to open on your phone
```

- Most of the community is on phones, so look at your change on one before you open a pull request.
- To work on the Deathwatch pages without the real server or a sign-in, create a file named `.env.local` in the
  project folder containing `VITE_DEATHWATCH_FIXTURE=1` (Git ignores it), then run `bun run dev`. The site then
  pretends the sign-in check answered. Add `?scene=` to the page address, followed by `allowed`, `commander`,
  `denied`, `signin`, `checking` or `unavailable`, to pick which state you see.

## Code style

Follow what the code already does. It is not enforced by a tool yet, so a reviewer will point it out:

- Vue components use `<script setup>`.
- Plain JavaScript, no TypeScript, and single quotes.
- Tests sit beside the code as `*.test.js`.
- Visual work follows [DESIGN.md](DESIGN.md).

## Commits and pull request titles

Write commit messages and pull request titles as `type(scope): subject`, for example `fix(roster): keep the filter
on reload`. The types in use are `feat`, `fix`, `docs`, `test`, `data`, `chore`, `refactor`, `ci`, `perf` and
`build`, plus `archive` for Legion Archive work. The pull request title becomes the commit subject when a pull request
is squashed (see Review and merge), so get it right. Small branches are easier to review.

## What happens when you commit and push

`bun install` sets up Git hooks on your machine:

- **On `git commit`** the hook checks that no archive files or raw Discord exports are staged, and runs the tests.
- **On `git push`** the hook runs the maintainers' full gate: the tests, then 100% test coverage on the gated units,
  then mutation testing. Mutation testing can take several minutes. CI does not run this gate.

If the push hook is too slow, fails on code you did not touch, or you are pushing work in progress, push with
`git push --no-verify` and say so in the pull request.

## Opening a pull request

```
git push -u origin fix/nav-overflow
```

GitHub then shows a **Compare & pull request** button. Before you create it, check the base:

- base repository: `BigZano/salamanders-site`
- base branch: **`main`**, or the area branch your work started from (for example `feat/deathwatch`)

A short checklist appears in the description. Fill it in: what changed, how to see it, and that you used invented
values.

## What a machine checks, and what it does not

A check called **PR check** runs on every pull request into `main` and into `feat/` branches. A pull request into any
other branch gets no automatic check. The first time you contribute, GitHub waits for a maintainer to approve that
run, which is expected.

| Rule | Checked by |
|---|---|
| No archive files or raw Discord exports committed | The commit hook and **PR check** |
| The tests pass | The commit hook and **PR check** |
| The production build works | **PR check** |
| 100% coverage and mutation testing on the gated units | The push hook on your machine, and nowhere else. It is not part of CI and you can skip it with `--no-verify` |
| `main` cannot be deleted or force-pushed, except by an admin | A repository rule |
| Only the maintainers merge | You have no write access to the original repo |
| No real names, handles or ids | **Review only**: a maintainer reads the diff |
| You did not edit the two member data files | **Review only** |
| Branch prefix, `type(scope): subject` titles, code style | **Review only** |
| Phone check, `DESIGN.md` rules | **Review only** |

A green check does not mean your pull request is free of real values. Nothing automatic looks for them, so that part
is on you.

## Review and merge

The maintainers review and merge every pull request. Merging into `main` publishes the live site within minutes, so
expect questions and small changes. The default is a squash merge; a branch that carries a stack of commits worth
keeping may be merged as it is. A failing check is yours to fix on your own branch, and the maintainers do not merge a
pull request with a red check.

## Keeping your fork current

```
git fetch upstream
git switch fix/nav-overflow
git merge upstream/main
```

If you branched from an area branch, merge that one instead (for example `upstream/feat/deathwatch`).

## Other rules

- Do not edit `.github/` or `server/` without asking first.
- Your fork never holds secrets and you should never add one. Nothing here needs one.
- If you use an AI coding assistant, it follows the same rules. Give it the box at the top of this page, and check the
  base branch of the pull request yourself before you create it.

## Terms

By opening a pull request you agree your contribution can be used on this site.
