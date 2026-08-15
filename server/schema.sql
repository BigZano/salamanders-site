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
