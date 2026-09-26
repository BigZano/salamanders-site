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
