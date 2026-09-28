-- Shared builds gallery. Mirrors the shape saveBuild() already produces
-- client-side (see src/stores/planner.js) — the API is a thin layer over
-- this, not a redesign of what a "build" is.
create table if not exists builds (
  id              bigserial primary key,
  title           text not null,
  role            text not null default '',
  notes           text not null default '',
  class_name      text not null,
  level           integer not null,
  prestige        integer not null default 0,
  prestige_picks  jsonb not null default '[]',
  perks           jsonb not null default '[]',
  perk_ids        jsonb not null default '{}',
  justifications  jsonb not null default '{}',
  weapons         jsonb not null default '{}',
  weapon_perks    jsonb not null default '{}',

  -- Verified server-side against Discord on create, never trusted from the
  -- client — see src/index.js. This is what makes delete permissions real
  -- instead of "whoever has the id can delete it."
  author_discord_id       text not null,
  author_discord_username text not null,

  created_at      timestamptz not null default now()
);

create index if not exists builds_class_name_idx on builds (class_name);
create index if not exists builds_author_idx on builds (author_discord_id);

-- Member incident reports (see docs/superpowers/specs/2026-09-26-member-reports-design.md).
-- Kept permanently: nothing in the API deletes a report or an event.
create table if not exists reports (
  id                   bigserial primary key,
  reporter_discord_id  text not null,
  reporter_username    text not null,
  incident_date        date,
  reported_member      text not null,
  witnesses            text not null default '',
  medium               text not null check (medium in ('text', 'voice', 'dm', 'other')),
  medium_other         text not null default '',
  description          text not null,
  status               text not null default 'received'
                       check (status in ('received', 'under_review', 'resolved', 'escalated')),
  handler_discord_id   text,
  handler_username     text,
  resolution_note      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  closed_at            timestamptz
);

create index if not exists reports_reporter_idx on reports (reporter_discord_id);
create index if not exists reports_status_idx on reports (status);

-- One row per state change, written in the same transaction as the change.
create table if not exists report_events (
  id                bigserial primary key,
  report_id         bigint not null references reports (id),
  actor_discord_id  text not null,
  actor_username    text not null,
  action            text not null check (action in ('filed', 'claimed', 'resolved', 'escalated', 'reopened')),
  note              text,
  created_at        timestamptz not null default now()
);

create index if not exists report_events_report_idx on report_events (report_id);

-- Perk corrections and version history
-- (see docs/superpowers/specs/2026-09-27-perk-corrections-design.md).
-- Nothing in the API deletes from these tables.
alter table builds add column if not exists deleted_at timestamptz;
alter table builds add column if not exists deleted_by text;

create table if not exists perk_corrections (
  id                 bigserial primary key,
  kind               text not null check (kind in ('weapon', 'class')),
  target             text not null,
  quality            text check (quality in ('Standard', 'Master-Crafted', 'Artificer', 'Relic', 'Heroic')),
  op                 text not null check (op in ('add', 'remove', 'edit')),
  perk_name          text not null,
  description        text,
  note               text,
  active             boolean not null default true,
  author_discord_id  text not null,
  author_username    text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((kind = 'weapon' and quality is not null) or (kind = 'class' and quality is null and op = 'edit'))
);

create index if not exists perk_corrections_active_idx on perk_corrections (active, created_at, id);

create table if not exists edit_events (
  id                bigserial primary key,
  subject           text not null check (subject in ('perk_correction', 'build', 'privilege')),
  subject_id        text not null,
  action            text not null check (action in ('created', 'edited', 'reverted', 'deleted', 'revoked', 'reinstated')),
  actor_discord_id  text not null,
  actor_username    text not null,
  snapshot          jsonb,
  note              text,
  created_at        timestamptz not null default now()
);

create index if not exists edit_events_subject_idx on edit_events (subject, id desc);

create table if not exists privilege_revocations (
  id                   bigserial primary key,
  discord_id           text not null,
  username             text not null,
  revoked_by           text not null,
  revoked_by_username  text not null,
  reason               text not null,
  created_at           timestamptz not null default now(),
  lifted_by            text,
  lifted_by_username   text,
  lifted_at            timestamptz
);

-- At most one open revocation per member.
create unique index if not exists privilege_revocations_open_idx
  on privilege_revocations (discord_id) where lifted_at is null;
