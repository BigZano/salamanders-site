# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Mostly used on phones: mobile web, not a native app.

## Users

The Salamanders (the XVIIIth Legion), a Warhammer 40,000: Space Marine 2 clan, mostly on phones. Members use the
site to plan perk builds, browse the armoury, share builds, and read the order of battle and the Legion Archive.
Branch heads (company leaders, the Deathwatch's Watch Commander) keep their own corner of it.

## Product Purpose

The clan's home on the web: working game tools plus the community's own records, brought out of Discord into a
place that is clearer and sturdier. Success: a member finds what they need on a phone in a few taps, and each
branch can keep developing its own corner without risking the rest.

## Positioning

A clan site that is also a live tool: a patch-corrected perk builder, armoury and builds, and live Discord role
checks. A generic fan site could not copy that.

## Operating Context

A static site on GitHub Pages (sm2salamanders.site) plus a small API (Bun, Postgres) on a private server. Discord
sign-in and live role verification. The repo is public: no member names, ids or secrets in it. Contributors work
from forks.

## Capabilities and Constraints

Access tiers: public pages; Legion members; role areas; and the Deathwatch area (its role, the Watch Commander, or a
Watch Commander grant). Game data follows the installed game files and patch notes. Phone first.

## Brand Commitments

Salamanders, XVIIIth Legion. "Into the fires of battle, unto the anvil of war." Cold armour, molten core. The
Deathwatch area is a dark-only sub-theme, Watch Fortress Ebonhold.

## Evidence on Hand

The live site, the Legion Archive, `docs/handoff` and `docs/superpowers`. No analytics or user research exist;
none may be invented.

## Product Principles

1. Phone first.
2. Each branch owns its corner.
3. Thematic secrecy; real secrecy where it matters.
4. Truth from source (the game files, live roles).
5. Names never in the repo.

## Accessibility & Inclusion

Reduced motion is respected; text contrast over the volcano is tested (4.5:1); tap targets are at least 44px on
phones.
