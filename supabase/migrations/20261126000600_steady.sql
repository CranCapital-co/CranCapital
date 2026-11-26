-- Steadier under load.
--
-- 1. One minute job instead of three. pg_cron opened three new database
--    connections at the same second every minute (business tick, world,
--    Renown). On a small server under load, opening them sometimes timed
--    out ("job startup timeout") and that minute's work was skipped. Now one
--    job opens one connection and runs the three in turn. Each still commits
--    as it goes and catches up from elapsed time if a minute is missed.
-- 2. Answers that are the same for everyone are built once and shared:
--    the world as seen on the world map (for up to 10 seconds, rebuilt at
--    once when leaders, wars, alliances, borders or armies change), and the
--    game catalogue and world map data (10 minutes). Before, every player's
--    poll rebuilt them from scratch.

create or replace procedure game.minute_run()
language plpgsql as $$
begin
  call game.tick();
  call game.world_run();
  call game.renown_run();
end $$;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('crancapital-tick', 'crancapital-world', 'crancapital-renown', 'crancapital-minute');
  perform cron.schedule('crancapital-minute', '* * * * *', 'call game.minute_run()');
end $$;

-- Shared answers.
create table if not exists game.api_cache (
  key text primary key,
  at timestamptz not null,
  val jsonb not null
);
alter table game.api_cache enable row level security;
revoke all on game.api_cache from public, anon, authenticated;

-- The builders move out of the public API; the public names now serve the
-- shared copy.
alter function public.world_state() set schema game;
alter function game.world_state() rename to world_state_build;
alter function public.get_catalog() set schema game;
alter function game.get_catalog() rename to catalog_build;
alter function public.world_map() set schema game;
alter function game.world_map() rename to world_map_build;

create or replace function game.cache_put(p_key text, p_val jsonb) returns jsonb
language sql as $$
  insert into game.api_cache (key, at, val) values (p_key, now(), p_val)
  on conflict (key) do update set at = excluded.at, val = excluded.val;
  select p_val;
$$;

create or replace function public.world_state() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v jsonb;
begin
  select val into v from game.api_cache where key = 'world_state' and at > now() - interval '10 seconds';
  return coalesce(v, game.cache_put('world_state', game.world_state_build()));
end $$;

create or replace function public.get_catalog() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v jsonb;
begin
  select val into v from game.api_cache where key = 'catalog' and at > now() - interval '10 minutes';
  return coalesce(v, game.cache_put('catalog', game.catalog_build()));
end $$;

create or replace function public.world_map() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v jsonb;
begin
  select val into v from game.api_cache where key = 'world_map' and at > now() - interval '10 minutes';
  return coalesce(v, game.cache_put('world_map', game.world_map_build()));
end $$;

-- Anything that changes the map drops the shared copy, so nobody sees a
-- stale border, war, alliance or army for long.
create or replace function game.world_changed() returns trigger
language plpgsql set search_path = game, pg_temp as $$
begin
  delete from game.api_cache where key = 'world_state';
  return null;
end $$;

drop trigger if exists world_changed on game.territories;
create trigger world_changed after update of owner_id, controller_id on game.territories for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.nations;
create trigger world_changed after insert or update of leader_id, status, name, color on game.nations for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.wars;
create trigger world_changed after insert or update of status on game.wars for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.war_sides;
create trigger world_changed after insert or delete on game.war_sides for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.alliance_members;
create trigger world_changed after insert or delete on game.alliance_members for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.alliances;
create trigger world_changed after insert or delete on game.alliances for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.movements;
create trigger world_changed after insert or update of status on game.movements for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.battles;
create trigger world_changed after insert on game.battles for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.coalitions;
create trigger world_changed after insert or update of ended_at on game.coalitions for each statement execute function game.world_changed();
drop trigger if exists world_changed on game.coalition_members;
create trigger world_changed after insert or delete on game.coalition_members for each statement execute function game.world_changed();

grant execute on function public.world_state(), public.get_catalog(), public.world_map() to authenticated;
grant execute on function public.get_catalog() to anon;
