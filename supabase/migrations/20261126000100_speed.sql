-- Speed under load.
--
-- What was slow: the minute jobs ran as single long transactions. The world
-- tick pays every player-led country's income to its leader, which locks
-- that player's row, and then kept the lock until the whole tick finished
-- (seconds, sometimes a minute). Any button that touched the player's money
-- (and the heartbeat) queued behind it, holding one of the API's few
-- database connections while it waited, until everything else queued too.
-- The net-worth, property and Renown jobs did the same for all players.
--
-- Now each of those jobs is a procedure that commits after every country,
-- AI and player, so a row is only ever locked for a moment. The heartbeat
-- never waits for a lock. Small helper functions no longer pin their
-- search_path (they name every table and function in full), which lets
-- PostgreSQL inline the simple ones and skips a per-call settings switch.

-- 1. Helpers: unpin search_path (security invoker, fully qualified bodies).
alter function game.level_for_xp(bigint) reset all;
alter function game.rank_for(integer) reset all;
alter function game.perk(uuid, text) reset all;
alter function game.player_level(uuid) reset all;
alter function game.player_nation(uuid) reset all;
alter function game.renown_brief(uuid) reset all;
alter function game.has_tech(text, text) reset all;
alter function game.tech_fx(text, text) reset all;
alter function game.leader_perk(text, text) reset all;
alter function game.blevel(text, text) reset all;
alter function game.room_rent(game.buildings) reset all;
alter function game.building_value(game.buildings) reset all;
alter function game.level_mult(integer) reset all;
alter function game.menu_slots(text, integer) reset all;
alter function game.is_open_hour(integer, integer, integer) reset all;
alter function game.hour_factor(text, integer, integer) reset all;
alter function game.rel(text, text) reset all;
alter function game.alliance_of(text) reset all;
alter function game.allied(text, text) reset all;
alter function game.treaty(text, text) reset all;
alter function game.at_war(text, text) reset all;
alter function game.war_between(text, text) reset all;
alter function game.side_of(bigint, text) reset all;
alter function game.nation_name(text) reset all;
alter function game.move_minutes(text, jsonb, numeric) reset all;
alter function game.unit_mult(text, text, text) reset all;
alter function game.units_text(jsonb) reset all;
alter function game.military_power(text) reset all;
alter function game.owns_cosmetic(game.players, game.cosmetics) reset all;
alter function game.event_mult(text, text) reset all;
alter function game.debt(uuid) reset all;
alter function game.building_range(game.buildings) reset all;
alter function game.cfg(text) reset all;
alter function game.fmt(bigint) reset all;
alter function game.city_xy(game.cities, double precision, double precision) reset all;
alter function game.dist_m(double precision, double precision, double precision, double precision) reset all;
alter function game.bit_at(bytea, bigint) reset all;
alter function game.in_city(game.cities, double precision, double precision) reset all;
alter function game.plot_of(game.cities, double precision, double precision) reset all;
alter function game.plot_center(game.cities, integer, integer) reset all;
alter function game.plot_buildable(game.cities, integer, integer) reset all;
alter function game.plot_coastal(game.cities, integer, integer) reset all;
alter function game.local_hour(text) reset all;
alter function game.ai_neighbours(text) reset all;
alter function game.ai_border_threat(text, text, integer) reset all;
alter function game.attack_strength(text) reset all;
alter function game.ai_front_defence(text, text, integer) reset all;
alter function game.ai_pick_tech(text, integer, text, boolean, boolean) reset all;
alter function game.local_dow(text) reset all;
alter function game.ai_common_enemy(text, text) reset all;
alter function game.home_city(text) reset all;
alter function game.nation_funds(text) reset all;
alter function game.research_price(text) reset all;
alter function game.uid() reset all;
alter function game.tier_threshold(integer) reset all;
alter function game.npc_bid(double precision) reset all;
alter function game.npc_ask(double precision) reset all;
alter function game.npc_quote(text) reset all;
alter function game.impact_k(text) reset all;
alter function game.city_km(text, text) reset all;
alter function game.travel_quote(text, text) reset all;
alter function game.storage_used(uuid, text) reset all;
alter function game.upgrade_cost(game.business_types, integer) reset all;
alter function game.resolve_building(bigint) reset all;
alter function game.clamp_ref(text, double precision) reset all;
alter function game.ring_for(bigint) reset all;
alter function game.public_player(game.players) reset all;
alter function game.message_json(game.chat_messages) reset all;
alter function game.can_read_channel(game.players, game.chat_channels) reset all;
alter function game.post_json(game.board_posts, uuid) reset all;
alter function game.rand01(text) reset all;
alter function game.import_mult(text, text) reset all;
alter function game.business_json(game.businesses, boolean) reset all;
alter function game.filter_pattern(text) reset all;
alter function game.has_link(text) reset all;
alter function game.goal_progress(game.goals) reset all;
alter function game.player_json(game.players) reset all;
alter function game.active_wars(text) reset all;
alter function game.alliance_size(text) reset all;
alter function game.rooms_free(bigint) reset all;

-- How hostile one country is to another: a plain expression now.
create or replace function game.ai_hostility(p_n text, p_x text) returns numeric
language sql stable as $$
  select (case
    when game.allied(p_n, p_x) then 0
    when game.at_war(p_n, p_x) then 1
    when exists (select 1 from game.treaties t where t.a = least(p_n, p_x) and t.b = greatest(p_n, p_x) and t.until > now()) then 0.05
    when game.rel(p_n, p_x) < -30 then 0.6
    when game.rel(p_n, p_x) < 0 then 0.35
    else 0.15 end)::numeric
$$;

-- 2. The world tick, in stages that can each be committed on their own.
create or replace function game.world_stage(p_stage text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_id text;
  q game.recruit_queue;
  b record;
  v_mid bigint;
  w record;
  v_home text;
begin
  if p_stage = 'training' then
    for q in select * from game.recruit_queue where ready_at <= now() order by ready_at loop
      v_home := case when (select controller_id from game.territories where id = q.territory_id) = q.nation_id then q.territory_id
                     else (select id from game.territories where controller_id = q.nation_id order by (id = q.nation_id) desc limit 1) end;
      if v_home is not null then perform game.garrison_add(v_home, q.nation_id, q.unit, q.qty); end if;
      delete from game.recruit_queue where id = q.id;
    end loop;
  elsif p_stage = 'construction' then
    for b in update game.facilities set level = target, target = null, ready_at = null
              where ready_at <= now() and target is not null returning territory_id, kind, level loop
      v_id := (select owner_id from game.territories where id = b.territory_id);
      perform game.leader_xp(v_id, 40 * b.level, 'Built ' || (select name from game.facility_types where id = b.kind), 'buildings');
      perform game.tell(v_id, 'nation', format('%s level %s finished', (select name from game.facility_types where id = b.kind), b.level),
        'In ' || (select name from game.territories where id = b.territory_id) || '.');
    end loop;
  elsif p_stage = 'arrivals' then
    for v_mid in select id from game.movements where status = 'moving' and arrive_at <= now() order by arrive_at loop
      begin
        perform game.arrive(v_mid);
      exception when others then
        raise warning 'arrival % failed: %', v_mid, sqlerrm;
        update game.movements set status = 'done', result = jsonb_build_object('error', sqlerrm) where id = v_mid;
      end;
    end loop;
    delete from game.movements where status = 'done' and arrive_at < now() - interval '1 day';
  elsif p_stage = 'wars' then
    for w in select id, started_at from game.wars where status = 'active' loop
      update game.wars set score = game.war_score(w.id) where id = w.id;
      if w.started_at < now() - interval '7 days' then
        perform game.end_war(w.id, 'white', null, 'Exhausted, both sides went home');
      end if;
    end loop;
  elsif p_stage = 'revolts' then
    for b in select t.id, t.owner_id, t.controller_id, t.name from game.territories t join game.nations c on c.id = t.controller_id
              where t.controller_id <> t.owner_id
                and not exists (select 1 from game.garrisons g where g.territory_id = t.id and g.nation_id = t.controller_id and g.qty > 0)
                and (c.stability < 35 or t.occupied_at < now() - interval '48 hours') loop
      perform game.nation_revive(b.owner_id);
      update game.territories set controller_id = owner_id, occupied_at = null where id = b.id;
      perform game.news('revolt', format('%s rises up against %s', b.name, game.nation_name(b.controller_id)), null, array[b.owner_id, b.controller_id]);
    end loop;
  elsif p_stage = 'diplomacy' then
    if extract(minute from now())::int % 10 = 0 then
      update game.relations r set score = score * 0.97,
        rival_a = rival_a and denounced_at > now() - interval '24 hours',
        rival_b = rival_b and denounced_at > now() - interval '24 hours'
       where not game.at_war(r.a, r.b);
      delete from game.relations where abs(score) < 0.5 and not rival_a and not rival_b;
    end if;
    update game.diplo_offers set status = 'expired' where status = 'open' and expires_at < now();
    delete from game.treaties where until < now();
  elsif p_stage = 'scores' then
    if extract(minute from now())::int % 5 = 0 then perform game.world_scores(); end if;
  elsif p_stage = 'away' then
    if extract(minute from now())::int = 41 then
      for w in select n.id, n.name, n.leader_id from game.nations n join game.players p on p.id = n.leader_id
                where p.last_seen_at < now() - interval '14 days' loop
        update game.nations set leader_id = null, leader_since = null where id = w.id;
        perform game.notify(w.leader_id, 'nation', 'You were away, so the AI now runs ' || w.name, 'Pick a country when you are back.');
        perform game.news('leader', w.name || '''s leader has gone quiet', 'The civil service (the AI) is running the country.', array[w.id]);
      end loop;
    end if;
  end if;
end $$;

-- One AI government thinks, then waits before thinking again.
create or replace function game.world_ai_one(p_id text) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  begin
    perform game.ai_think(p_id);
  exception when others then
    raise warning 'ai % failed: %', p_id, sqlerrm;
  end;
  update game.nations set next_think_at = now() + make_interval(secs => (60 * (4 + 2 * (6 - ai_skill)) + floor(random() * 120))::int)
   where id = p_id and next_think_at <= now();
end $$;

create or replace function game.world_economy_one(p_id text) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  perform game.nation_economy(p_id);
exception when others then
  raise warning 'economy % failed: %', p_id, sqlerrm;
end $$;

-- The whole tick in one go (tests, and anything that wants it in one transaction).
create or replace function game.world_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_id text;
  v_stage text;
begin
  if not pg_try_advisory_xact_lock(434343) then return; end if;
  for v_id in select id from game.nations where status = 'active' loop
    perform game.world_economy_one(v_id);
  end loop;
  foreach v_stage in array array['training', 'construction', 'arrivals', 'wars', 'revolts', 'diplomacy'] loop
    perform game.world_stage(v_stage);
  end loop;
  for v_id in select id from game.nations where leader_id is null and status = 'active' and next_think_at <= now()
               order by next_think_at limit 25 loop
    perform game.world_ai_one(v_id);
  end loop;
  perform game.world_stage('scores');
  perform game.world_stage('away');
end $$;

-- What pg_cron runs: the same, committing after every country so no row
-- stays locked for more than a moment.
create or replace procedure game.world_run()
language plpgsql as $$
declare
  v_ids text[];
  v_id text;
  v_stage text;
begin
  if not pg_try_advisory_lock(434343) then return; end if;
  select coalesce(array_agg(id order by id), '{}') into v_ids from game.nations where status = 'active';
  commit;
  foreach v_id in array v_ids loop
    perform game.world_economy_one(v_id);
    commit;
  end loop;
  foreach v_stage in array array['training', 'construction', 'arrivals', 'wars', 'revolts', 'diplomacy'] loop
    begin
      perform game.world_stage(v_stage);
    exception when others then
      raise warning 'world stage % failed: %', v_stage, sqlerrm;
    end;
    commit;
  end loop;
  select coalesce(array_agg(id order by next_think_at), '{}') into v_ids from (
    select id, next_think_at from game.nations where leader_id is null and status = 'active' and next_think_at <= now()
     order by next_think_at limit 25) x;
  commit;
  foreach v_id in array v_ids loop
    perform game.world_ai_one(v_id);
    commit;
  end loop;
  foreach v_stage in array array['scores', 'away'] loop
    begin
      perform game.world_stage(v_stage);
    exception when others then
      raise warning 'world stage % failed: %', v_stage, sqlerrm;
    end;
    commit;
  end loop;
  perform pg_advisory_unlock(434343);
end $$;

-- 3. Renown: one player at a time.
create or replace function game.renown_one(p_id uuid) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  perform game.renown_scan(p_id);
  perform game.check_achievements(p_id);
exception when others then
  raise warning 'renown scan % failed: %', p_id, sqlerrm;
end $$;

create or replace function game.renown_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_id uuid;
begin
  for v_id in select id from game.players where status = 'active' and last_seen_at > now() - interval '15 minutes' loop
    perform game.renown_one(v_id);
  end loop;
  delete from game.renown_log where at < now() - interval '14 days';
end $$;

create or replace procedure game.renown_run()
language plpgsql as $$
declare
  v_ids uuid[];
  v_id uuid;
begin
  if not pg_try_advisory_lock(454545) then return; end if;
  select coalesce(array_agg(id), '{}') into v_ids from game.players where status = 'active' and last_seen_at > now() - interval '15 minutes';
  commit;
  foreach v_id in array v_ids loop
    perform game.renown_one(v_id);
    commit;
  end loop;
  delete from game.renown_log where at < now() - interval '14 days';
  commit;
  perform pg_advisory_unlock(454545);
end $$;

-- 4. The business tick's net-worth and property stages: one player at a time.
create or replace function game.worth_due() returns boolean
language plpgsql set search_path = game, pg_temp as $$
declare
  v_last timestamptz;
begin
  select ts into v_last from game.state where key = 'worth_tick' for update;
  if v_last > now() - interval '10 minutes' then return false; end if;
  update game.state set ts = now() where key = 'worth_tick';
  return true;
end $$;

create or replace function game.worth_one(p_id uuid) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  perform game.refresh_worth(p_id);
exception when others then
  insert into game.tick_errors (business_id, message) values (null, 'worth ' || p_id || ': ' || sqlerrm);
end $$;

create or replace function game.tick_worth() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  r record;
begin
  if not game.worth_due() then return; end if;
  for r in select id from game.players where status = 'active' and last_seen_at > now() - interval '3 days' loop
    perform game.worth_one(r.id);
  end loop;
  perform game.markets_stats();
end $$;

-- Property: how much of an hour has passed (0 if it isn't time yet).
create or replace function game.property_due() returns float8
language plpgsql set search_path = game, pg_temp as $$
declare
  v_last timestamptz;
  v_dt float8;
begin
  select ts into v_last from game.state where key = 'property_tick' for update;
  v_dt := least(1, extract(epoch from now() - v_last) / 3600.0);
  if v_dt < 0.01 then return 0; end if;
  update game.state set ts = now() where key = 'property_tick';
  return v_dt;
end $$;

create or replace function game.property_one(p_owner uuid, p_dt float8) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  bl game.buildings;
  v_income bigint;
  v_tax bigint;
  v_total bigint;
begin
  for bl in select * from game.buildings where owner_id = p_owner loop
    v_income := round(greatest(0, game.rooms_free(bl.id)) * game.room_rent(bl) * 100.0 / bl.rent_pct * bl.npc_occupancy
      * least(1, 100.0 / bl.rent_pct) * p_dt / 24.0);
    if v_income > 0 then
      perform game.money(p_owner, v_income, 'npc_rent', 'Rent from local tenants', jsonb_build_object('building', bl.id), true);
    end if;
    v_tax := round(coalesce(bl.bought_price, 0) * game.cfg('property_tax_pct_day') / 100.0 * p_dt / 24.0);
    if v_tax > 0 then
      perform game.try_money(p_owner, -v_tax, 'tax', 'Property tax', null, true);
    end if;
  end loop;
  select sum(bought_price) into v_total from game.plots where owner_id = p_owner;
  v_tax := round(coalesce(v_total, 0) * game.cfg('property_tax_pct_day') / 100.0 * p_dt / 24.0);
  if v_tax > 0 then
    perform game.try_money(p_owner, -v_tax, 'tax', 'Property tax', null, true);
  end if;
exception when others then
  insert into game.tick_errors (business_id, message) values (null, 'property ' || p_owner || ': ' || sqlerrm);
end $$;

create or replace function game.property_owners() returns uuid[]
language sql stable set search_path = game, pg_temp as $$
  select coalesce(array_agg(distinct o), '{}') from (
    select b.owner_id o from game.buildings b join game.players p on p.id = b.owner_id
     where p.status = 'active' and p.last_seen_at > now() - make_interval(hours => game.cfg('offline_cap_hours')::int)
    union
    select pt.owner_id from game.plots pt join game.players p on p.id = pt.owner_id
     where p.status = 'active' and p.last_seen_at > now() - make_interval(hours => game.cfg('offline_cap_hours')::int)) x
$$;

create or replace function game.tick_property() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_dt float8 := game.property_due();
  v_id uuid;
begin
  if v_dt <= 0 then return; end if;
  foreach v_id in array game.property_owners() loop
    perform game.property_one(v_id, v_dt);
  end loop;
end $$;

create or replace procedure game.tick()
language plpgsql as $$
declare
  v_start timestamptz := clock_timestamp();
  v_ids bigint[];
  v_id bigint;
  v_uids uuid[];
  v_uid uuid;
  v_dt float8;
  v_good text;
  v_n int := 0;
  v_err int := 0;
begin
  -- Only one tick at a time (session lock: released when pg_cron's
  -- connection closes, even if something below fails).
  if not pg_try_advisory_lock(424242) then
    return;
  end if;
  select coalesce(array_agg(id order by owner_id, id), '{}') into v_ids
    from game.businesses where status in ('open', 'closed') and last_tick_at < now() - interval '15 seconds';
  commit;
  foreach v_id in array v_ids loop
    if game.tick_business_safe(v_id) then v_n := v_n + 1; else v_err := v_err + 1; end if;
    commit;
  end loop;
  -- Property income and tax, one owner at a time.
  v_dt := game.property_due();
  v_uids := case when v_dt > 0 then game.property_owners() else '{}' end;
  commit;
  foreach v_uid in array v_uids loop
    perform game.property_one(v_uid, v_dt);
    commit;
  end loop;
  if not game.tick_stage_safe('shipments') then v_err := v_err + 1; end if;
  commit;
  for v_good in select id from game.goods order by id loop
    if not game.tick_stage_safe('market', v_good) then v_err := v_err + 1; end if;
    commit;
  end loop;
  if not game.tick_stage_safe('finance') then v_err := v_err + 1; end if;
  commit;
  -- Net worth every 10 minutes, one player at a time.
  if game.worth_due() then
    select coalesce(array_agg(id), '{}') into v_uids from game.players where status = 'active' and last_seen_at > now() - interval '3 days';
    commit;
    foreach v_uid in array v_uids loop
      perform game.worth_one(v_uid);
      commit;
    end loop;
    perform game.markets_stats();
  end if;
  commit;
  if not game.tick_stage_safe('hourly') then v_err := v_err + 1; end if;
  insert into game.tick_log (started_at, finished_at, businesses, errors) values (v_start, clock_timestamp(), v_n, v_err);
  commit;
  perform pg_advisory_unlock(424242);
end $$;

-- 5. The heartbeat never waits: if the row is busy, last_seen can wait a beat.
create or replace function public.heartbeat() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  update game.players set last_seen_at = now()
   where id = (select id from game.players where id = p.id and last_seen_at < now() - interval '20 seconds' for update skip locked);
  return jsonb_build_object('cash', p.cash, 'net_worth', p.net_worth, 'tier', p.tier,
    'unread', (select count(*) from game.notifications n where n.player_id = p.id and not n.read),
    'city_id', p.city_id, 'travel_to', p.travel_to, 'travel_arrive_at', p.travel_arrive_at, 'status', p.status,
    'renown', game.renown_brief(p.id), 'nation', game.player_nation(p.id));
end $$;

-- 6. Fail fast rather than queue: a request that can't get a lock within 5 s
--    gives up (and the game says the server is busy) instead of holding one
--    of the API's few connections for the full 8 s timeout.
do $$
begin
  execute 'alter role authenticated set lock_timeout = ''5s''';
exception when others then
  raise notice 'could not set lock_timeout: %', sqlerrm;
end $$;

-- 7. pg_cron runs the committing versions.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('crancapital-world', 'crancapital-renown');
  perform cron.schedule('crancapital-world', '* * * * *', 'call game.world_run()');
  perform cron.schedule('crancapital-renown', '* * * * *', 'call game.renown_run()');
end $$;
