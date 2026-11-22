-- Renown: the new progression system (see docs/PROGRESSION_AND_NATIONS.md).
--
-- XP comes from everything a player does: business (scanned from the
-- ledger and business counters, so the existing economy code is untouched)
-- and nation actions (granted directly by the nation functions). Levels come
-- quickly at first and keep coming. Every level gives a perk point and a
-- supply crate; every 5th level is a new rank with a gold crate. There are
-- daily rewards that never reset, daily and weekly missions, tiered
-- achievements and a free monthly season track.
--
-- Hooks the nations migration replaces: game.player_nation() and
-- game.crate_nation_reward().

insert into game.ledger_kinds (kind, label, flow) values
  ('renown_reward', 'Renown rewards', 'world_in'),
  ('perk_bonus', 'Trade perk bonus', 'world_in'),
  ('respec', 'Perk respec', 'world_out')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- Levels and ranks
-- ---------------------------------------------------------------------------
-- XP to go from level L to L+1.
create function game.xp_need(p_level int) returns bigint
language sql immutable as $$
  select (100 + 35 * (p_level - 1) + floor(2 * power(greatest(p_level - 1, 0), 1.6)))::bigint
$$;

-- Total XP needed to reach a level.
create table game.level_xp (level int primary key, total bigint not null);
insert into game.level_xp (level, total)
select l, coalesce((select sum(game.xp_need(k)) from generate_series(1, l - 1) k), 0)
  from generate_series(1, 2000) l;

create function game.level_for_xp(p_xp bigint) returns int
language sql stable set search_path = game, pg_temp as $$
  select coalesce(max(level), 1) from game.level_xp where total <= p_xp
$$;

create table game.ranks (
  level int primary key, -- reached at this level
  name text not null
);
insert into game.ranks (level, name) values
  (1, 'Recruit'), (5, 'Hustler'), (10, 'Trader'), (15, 'Merchant'), (20, 'Magnate'),
  (25, 'Tycoon'), (30, 'Mogul'), (35, 'Baron'), (40, 'Titan'), (45, 'Sovereign'), (50, 'Emperor');

create function game.rank_for(p_level int) returns text
language sql stable set search_path = game, pg_temp as $$
  select case when p_level >= 60
    then 'Legend ' || (array['I','II','III','IV','V','VI','VII','VIII','IX','X'])[least(10, (p_level - 50) / 10)]
    else (select name from game.ranks where level <= p_level order by level desc limit 1) end
$$;

-- What each level opens up. Keys are checked by game.require_level().
create table game.renown_unlocks (
  key text primary key,
  level int not null,
  title text not null,
  body text not null,
  icon text not null default 'star'
);
insert into game.renown_unlocks (key, level, title, body, icon) values
  ('nation', 1, 'Lead a nation', 'Pick a country and lead it: infantry, barracks and taxes.', 'flag'),
  ('weekly', 2, 'Weekly missions', 'Three bigger missions every week.', 'doc'),
  ('research', 3, 'Research', 'Fund scientists and unlock new technology.', 'book'),
  ('artillery', 4, 'Artillery', 'Field guns that hit hard when attacking.', 'target'),
  ('fort', 4, 'Forts', 'Fortify your territories: +15% defence a level.', 'shield'),
  ('armor', 5, 'Armour', 'Tanks: strong in attack and defence.', 'tank'),
  ('war', 5, 'Declare war', 'Go to war to take territory.', 'swords'),
  ('alliance', 6, 'Alliances', 'Found or join alliances that defend each other.', 'people'),
  ('nap', 6, 'Non-aggression pacts', 'Promise peace with a neighbour.', 'handshake'),
  ('air_defence', 8, 'Air defence', 'Shoot down air wings and missiles.', 'radar'),
  ('lab', 8, 'Research labs', 'Labs speed up research in a territory.', 'flask'),
  ('airbase', 10, 'Airbases', 'Build airbases to train air wings.', 'plane'),
  ('air', 10, 'Air wings', 'Strike anywhere within 2,500 km.', 'plane'),
  ('naval_base', 12, 'Naval bases', 'Build ports for your fleet.', 'ship'),
  ('naval', 12, 'Fleets', 'Cross the sea without losing strength.', 'ship'),
  ('perk_high', 15, 'Master perks', 'Perk ranks 4 and 5.', 'star'),
  ('silo', 20, 'Missile silos', 'Silos to launch ballistic missiles.', 'rocket'),
  ('missile', 20, 'Missiles', 'Strike garrisons and buildings 3,000 km away.', 'rocket');

-- ---------------------------------------------------------------------------
-- Player progress
-- ---------------------------------------------------------------------------
create table game.renown (
  player_id uuid primary key references game.players(id) on delete cascade,
  xp bigint not null default 0,
  level int not null default 1,
  perk_points int not null default 0,
  perks jsonb not null default '{}'::jsonb,
  crates jsonb not null default '{}'::jsonb,
  tokens jsonb not null default '{}'::jsonb,
  titles text[] not null default '{}',
  pity int not null default 0,
  boost_until timestamptz,
  boost_pct int not null default 0,
  respec_at timestamptz,
  season_key text,
  season_xp bigint not null default 0,
  season_claimed int[] not null default '{}',
  daily_last date,
  daily_count int not null default 0,
  streak int not null default 0,
  best_streak int not null default 0,
  shields int not null default 0,
  rev_seen bigint,
  sales_seen bigint,
  rev_scanned_at timestamptz not null default now(),
  scanned_at timestamptz not null default now(),
  invest_day date,
  invest_xp int not null default 0,
  created_at timestamptz not null default now()
);
create index renown_xp_idx on game.renown (xp desc);

create table game.renown_log (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id) on delete cascade,
  at timestamptz not null default now(),
  xp int not null,
  reason text not null
);
create index renown_log_player_idx on game.renown_log (player_id, at desc);

-- Counters for things that have no table of their own (troops recruited,
-- battles won, money invested...). Nation code bumps them with game.count().
create table game.player_counters (
  player_id uuid not null references game.players(id) on delete cascade,
  key text not null,
  value bigint not null default 0,
  primary key (player_id, key)
);

create function game.count(p_player uuid, p_key text, p_n bigint default 1) returns void
language sql set search_path = game, pg_temp as $$
  insert into game.player_counters as c (player_id, key, value) values (p_player, p_key, p_n)
  on conflict (player_id, key) do update set value = c.value + excluded.value
$$;

-- Keep the highest value seen (domination share).
create function game.count_max(p_player uuid, p_key text, p_v bigint) returns void
language sql set search_path = game, pg_temp as $$
  insert into game.player_counters as c (player_id, key, value) values (p_player, p_key, p_v)
  on conflict (player_id, key) do update set value = greatest(c.value, excluded.value)
$$;

create function game.renown_row(p_player uuid) returns game.renown
language plpgsql set search_path = game, pg_temp as $$
declare
  r game.renown;
begin
  insert into game.renown (player_id) values (p_player) on conflict do nothing;
  select * into r from game.renown where player_id = p_player;
  return r;
end $$;

create function game.perk(p_player uuid, p_branch text) returns int
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select (perks ->> p_branch)::int from game.renown where player_id = p_player), 0)
$$;

create function game.player_level(p_player uuid) returns int
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select level from game.renown where player_id = p_player), 1)
$$;

create function game.require_level(p_player uuid, p_key text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  u game.renown_unlocks;
begin
  select * into u from game.renown_unlocks where key = p_key;
  if found and game.player_level(p_player) < u.level then
    perform game.fail(format('%s unlocks at Renown level %s.', u.title, u.level));
  end if;
end $$;

-- Hooks, replaced by the nations migration.
create function game.player_nation(p_player uuid) returns text
language sql stable as $$ select null::text $$;

create function game.crate_nation_reward(p_player uuid, p_kind text, p_amount bigint) returns text
language sql as $$ select null::text $$;

create function game.add_crate(p_player uuid, p_kind text, p_n int default 1) returns void
language sql set search_path = game, pg_temp as $$
  update game.renown set crates = jsonb_set(crates, array[p_kind], to_jsonb(coalesce((crates ->> p_kind)::int, 0) + p_n))
   where player_id = p_player
$$;

-- The one way to give XP. Applies perks and boosts, levels up, rewards.
create function game.grant_xp(p_player uuid, p_xp int, p_reason text) returns int
language plpgsql set search_path = game, pg_temp as $$
declare
  r game.renown := game.renown_row(p_player);
  v_mult numeric := 1 + 0.05 * game.perk(p_player, 'fortune');
  v_xp int;
  v_key text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_new int;
  v_lvl int;
  v_rank text;
begin
  if coalesce(p_xp, 0) <= 0 then return 0; end if;
  if r.boost_until is not null and r.boost_until > now() then
    v_mult := v_mult + r.boost_pct / 100.0;
  end if;
  v_xp := round(p_xp * v_mult);
  update game.renown set
    xp = xp + v_xp,
    season_xp = case when season_key = v_key then season_xp + v_xp else v_xp end,
    season_claimed = case when season_key = v_key then season_claimed else '{}' end,
    season_key = v_key
  where player_id = p_player returning * into r;
  insert into game.renown_log (player_id, xp, reason) values (p_player, v_xp, p_reason);
  v_new := game.level_for_xp(r.xp);
  if v_new > r.level then
    for v_lvl in r.level + 1 .. v_new loop
      perform game.add_crate(p_player, 'supply');
      if v_lvl % 5 = 0 then
        perform game.add_crate(p_player, 'gold');
        v_rank := game.rank_for(v_lvl);
        update game.renown set titles = array_append(titles, v_rank)
         where player_id = p_player and not (v_rank = any(titles));
      end if;
    end loop;
    update game.renown set level = v_new, perk_points = perk_points + (v_new - r.level) where player_id = p_player;
    perform game.notify(p_player, 'levelup', format('Level %s!', v_new),
      format('You reached Renown level %s (%s). Open your crates and spend your perk points.', v_new, game.rank_for(v_new)),
      jsonb_build_object('level', v_new, 'from', r.level, 'rank', game.rank_for(v_new),
        'rank_up', (v_new / 5) > (r.level / 5),
        'unlocks', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'title', title, 'body', body, 'icon', icon) order by level), '[]'::jsonb)
                      from game.renown_unlocks where level > r.level and level <= v_new)));
  end if;
  perform game.push('user:' || p_player::text, 'renown',
    jsonb_build_object('xp', v_xp, 'reason', p_reason, 'total', r.xp, 'level', greatest(v_new, r.level)));
  return v_xp;
end $$;

-- ---------------------------------------------------------------------------
-- Stats, achievements and missions
-- ---------------------------------------------------------------------------
create function game.renown_stat(p_player uuid, p_stat text) returns bigint
language plpgsql stable set search_path = game, pg_temp as $$
begin
  return case p_stat
    when 'sales' then (select coalesce(sum(lifetime_sales), 0) from game.businesses where owner_id = p_player)
    when 'revenue' then (select coalesce(sum(lifetime_revenue), 0) / 1000 from game.businesses where owner_id = p_player)
    when 'businesses' then (select count(*) from game.businesses where owner_id = p_player and status not in ('sold', 'abandoned'))
    when 'net_worth' then (select peak_net_worth / 1000 from game.players where id = p_player)
    when 'trades' then (select count(*) from game.trades where buyer_id = p_player or seller_id = p_player)
    when 'contracts' then (select count(*) from game.contracts where taker_id = p_player and status = 'done')
    when 'projects' then (select count(*) from game.project_contributions where player_id = p_player)
    when 'days' then (select days_played from game.players where id = p_player)
    when 'upgrades' then (select count(*) from game.ledger where player_id = p_player and kind = 'upgrade')
    when 'level' then (select level from game.renown where player_id = p_player)
    when 'xp' then (select xp from game.renown where player_id = p_player)
    when 'streak' then (select best_streak from game.renown where player_id = p_player)
    else (select value from game.player_counters where player_id = p_player and key = p_stat)
  end;
end $$;

create table game.achievement_defs (
  id text primary key,
  title text not null,
  body text not null, -- %s is the target
  stat text not null,
  tiers bigint[] not null,
  money boolean not null default false,
  nation boolean not null default false,
  icon text not null default 'star',
  sort int not null default 0
);
insert into game.achievement_defs (id, title, body, stat, tiers, money, nation, icon, sort) values
  ('seller', 'Street Seller', 'Sell %s things to customers', 'sales', '{100,1000,10000,100000}', false, false, 'cart', 1),
  ('earner', 'Money Maker', 'Earn %s from sales', 'revenue', '{10000,250000,5000000,100000000}', true, false, 'cash', 2),
  ('worth', 'High Roller', 'Reach a net worth of %s', 'net_worth', '{50000,1000000,25000000,500000000}', true, false, 'chart', 3),
  ('builder', 'Empire Builder', 'Own %s businesses', 'businesses', '{3,10,25,60}', false, false, 'empire', 4),
  ('trader', 'Floor Trader', 'Make %s trades on the exchange', 'trades', '{10,100,1000,10000}', false, false, 'market', 5),
  ('supplier', 'Reliable Supplier', 'Deliver %s contracts', 'contracts', '{1,10,50,200}', false, false, 'doc', 6),
  ('civic', 'Civic Pride', 'Give to city projects %s times', 'projects', '{1,10,50,200}', false, false, 'apartments', 7),
  ('regular', 'Regular', 'Play on %s days', 'days', '{7,30,100,365}', false, false, 'calendar', 8),
  ('renowned', 'Renowned', 'Reach Renown level %s', 'level', '{10,25,50,100}', false, false, 'star', 9),
  ('unbroken', 'Unbroken', 'Keep a %s-day streak', 'streak', '{7,30,90,365}', false, false, 'fire', 10),
  ('missions', 'Mission Ready', 'Complete %s missions', 'missions_done', '{10,50,200,1000}', false, false, 'target', 11),
  ('lucky', 'Lucky Dip', 'Open %s crates', 'crates_opened', '{10,50,200,1000}', false, false, 'gift', 12),
  ('sergeant', 'Drill Sergeant', 'Recruit %s units', 'recruited', '{100,1000,10000,100000}', false, true, 'people', 20),
  ('architect', 'Fortress Architect', 'Finish %s military buildings', 'buildings', '{5,25,100,400}', false, true, 'shield', 21),
  ('scientist', 'Scientist', 'Research %s technologies', 'techs', '{3,8,15,21}', false, true, 'flask', 22),
  ('victor', 'Victorious', 'Win %s battles', 'battles_won', '{1,10,50,250}', false, true, 'swords', 23),
  ('shieldwall', 'Shield Wall', 'Hold off %s attacks', 'defended', '{1,10,50,200}', false, true, 'shield', 24),
  ('conqueror', 'Conqueror', 'Capture %s territories', 'territories', '{1,5,20,60}', false, true, 'flag', 25),
  ('statesman', 'Statesman', 'Join %s alliances', 'alliances', '{1,3,8,15}', false, true, 'handshake', 26),
  ('peacemaker', 'Peacemaker', 'Sign %s peace treaties', 'treaties', '{1,5,15,40}', false, true, 'dove', 27),
  ('patriot', 'Patriot', 'Invest %s in your nation', 'invested', '{10000,250000,5000000,100000000}', true, true, 'bank', 28),
  ('hegemon', 'Hegemon', 'Hold %s of the world', 'domination', '{10,50,150,500}', false, true, 'globe', 29);

create table game.achievements (
  player_id uuid not null references game.players(id) on delete cascade,
  id text not null references game.achievement_defs(id),
  tier int not null,
  at timestamptz not null default now(),
  primary key (player_id, id)
);

create function game.achievement_xp(p_tier int) returns int
language sql immutable as $$ select (array[100, 300, 800, 2000])[p_tier] $$;

create function game.tier_name(p_tier int) returns text
language sql immutable as $$ select (array['Bronze', 'Silver', 'Gold', 'Platinum'])[p_tier] $$;

create function game.fmt_target(d game.achievement_defs, v bigint) returns text
language sql immutable as $$
  select case when d.stat = 'domination' then trim(to_char(v / 10.0, 'FM990.0')) || '%'
              when d.money then '$' || to_char(v, 'FM999,999,999,990')
              else to_char(v, 'FM999,999,999,990') end
$$;

create function game.check_achievements(p_player uuid) returns int
language plpgsql set search_path = game, pg_temp as $$
declare
  d game.achievement_defs;
  v bigint;
  v_have int;
  v_tier int;
  v_t int;
  v_n int := 0;
begin
  for d in select * from game.achievement_defs order by sort loop
    v := coalesce(game.renown_stat(p_player, d.stat), 0);
    v_have := coalesce((select tier from game.achievements where player_id = p_player and id = d.id), 0);
    v_tier := (select count(*) from unnest(d.tiers) t where v >= t);
    if v_tier > v_have then
      insert into game.achievements (player_id, id, tier) values (p_player, d.id, v_tier)
      on conflict (player_id, id) do update set tier = excluded.tier, at = now();
      for v_t in v_have + 1 .. v_tier loop
        perform game.grant_xp(p_player, game.achievement_xp(v_t), format('%s: %s', d.title, game.tier_name(v_t)));
        if v_t >= 3 then perform game.add_crate(p_player, 'gold', v_t - 2); end if;
      end loop;
      perform game.notify(p_player, 'achievement', format('%s %s', game.tier_name(v_tier), d.title),
        format(d.body, game.fmt_target(d, d.tiers[v_tier])), jsonb_build_object('id', d.id, 'tier', v_tier));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

create table game.mission_templates (
  kind text primary key,
  scope text not null check (scope in ('daily', 'weekly')),
  title text not null, -- %s is the target
  stat text not null,
  base bigint not null,
  per_level numeric not null default 0,
  xp int not null,
  money boolean not null default false,
  nation boolean not null default false,
  min_level int not null default 1,
  weight int not null default 1
);
insert into game.mission_templates (kind, scope, title, stat, base, per_level, xp, money, nation, min_level, weight) values
  ('d_sell', 'daily', 'Sell %s things to customers', 'sales', 30, 3, 120, false, false, 1, 3),
  ('d_earn', 'daily', 'Earn %s from sales', 'revenue', 500, 250, 120, true, false, 1, 3),
  ('d_trade', 'daily', 'Make %s trades on the exchange', 'trades', 2, 0, 100, false, false, 1, 2),
  ('d_upgrade', 'daily', 'Upgrade a business', 'upgrades', 1, 0, 150, false, false, 2, 1),
  ('d_crate', 'daily', 'Open a crate', 'crates_opened', 1, 0, 80, false, false, 2, 1),
  ('d_recruit', 'daily', 'Recruit %s units', 'recruited', 10, 1, 120, false, true, 1, 3),
  ('d_build', 'daily', 'Build or upgrade a military building', 'buildings', 1, 0, 150, false, true, 1, 2),
  ('d_invest', 'daily', 'Invest %s in your nation', 'invested', 1000, 500, 120, true, true, 1, 2),
  ('d_diplomacy', 'daily', 'Take a diplomatic action', 'diplomacy', 1, 0, 100, false, true, 3, 2),
  ('w_earn', 'weekly', 'Earn %s from sales', 'revenue', 10000, 5000, 600, true, false, 2, 3),
  ('w_trades', 'weekly', 'Make %s trades on the exchange', 'trades', 15, 0, 500, false, false, 2, 2),
  ('w_contracts', 'weekly', 'Deliver %s contracts', 'contracts', 2, 0, 500, false, false, 6, 1),
  ('w_xp', 'weekly', 'Gain %s XP', 'xp', 2000, 200, 400, false, false, 2, 2),
  ('w_recruit', 'weekly', 'Recruit %s units', 'recruited', 100, 10, 500, false, true, 2, 3),
  ('w_research', 'weekly', 'Finish %s research projects', 'techs', 2, 0, 600, false, true, 3, 2),
  ('w_battles', 'weekly', 'Win %s battles', 'battles_won', 3, 0, 700, false, true, 5, 2),
  ('w_buildings', 'weekly', 'Finish %s military buildings', 'buildings', 5, 0, 500, false, true, 2, 2);

create table game.missions (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id) on delete cascade,
  scope text not null,
  period text not null,
  kind text not null references game.mission_templates(kind),
  title text not null,
  stat text not null,
  target bigint not null,
  base bigint not null,
  xp int not null,
  claimed boolean not null default false,
  unique (player_id, period, kind)
);
create index missions_player_idx on game.missions (player_id, period);

create function game.mission_period(p_scope text) returns text
language sql stable as $$
  select case when p_scope = 'daily' then to_char(now() at time zone 'utc', 'YYYY-MM-DD')
              else to_char(now() at time zone 'utc', 'IYYY-"W"IW') end
$$;

create function game.ensure_missions(p_player uuid) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_level int := game.player_level(p_player);
  v_nation boolean := game.player_nation(p_player) is not null;
  v_scope text;
  v_period text;
  t game.mission_templates;
  v_target bigint;
begin
  foreach v_scope in array array['daily', 'weekly'] loop
    v_period := game.mission_period(v_scope);
    continue when exists (select 1 from game.missions where player_id = p_player and period = v_period);
    continue when v_scope = 'weekly' and v_level < 2;
    for t in
      select * from game.mission_templates
       where scope = v_scope and min_level <= v_level and (not nation or v_nation)
       order by -ln(random()) / weight
       limit 3
    loop
      v_target := t.base + floor(t.per_level * v_level);
      insert into game.missions (player_id, scope, period, kind, title, stat, target, base, xp)
      values (p_player, v_scope, v_period, t.kind,
              format(t.title, case when t.money then '$' || to_char(v_target, 'FM999,999,990') else to_char(v_target, 'FM999,999,990') end),
              t.stat, v_target, coalesce(game.renown_stat(p_player, t.stat), 0), t.xp)
      on conflict do nothing;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Scanning the business game for XP (runs every minute for active players)
-- ---------------------------------------------------------------------------
create function game.renown_scan(p_player uuid) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  r game.renown := game.renown_row(p_player);
  v_rev bigint;
  v_sales bigint;
  v_d bigint;
  v_n bigint;
  v_xp int := 0;
  v_now timestamptz := now();
  v_trade int := game.perk(p_player, 'trade');
begin
  perform 1 from game.renown where player_id = p_player for update skip locked;
  if not found then return; end if;
  select coalesce(sum(lifetime_revenue), 0), coalesce(sum(lifetime_sales), 0) into v_rev, v_sales
    from game.businesses where owner_id = p_player;
  if r.rev_seen is null then
    -- First scan: a one-off welcome for what the player has already built.
    update game.renown set rev_seen = v_rev, sales_seen = v_sales, rev_scanned_at = v_now, scanned_at = v_now where player_id = p_player;
    if v_rev > 0 then
      perform game.grant_xp(p_player, least(20000, floor(300 * ln(1 + v_rev / 100000.0)))::int, 'Your business so far');
    end if;
    return;
  end if;
  -- Sales: log-scaled, at most every 5 minutes, so XP never runs away with money.
  if v_now - r.rev_scanned_at >= interval '5 minutes' then
    v_d := v_rev - r.rev_seen;
    if v_d > 0 then
      perform game.grant_xp(p_player, least(60, floor(8 * log(1 + v_d / 1000.0)))::int, 'Sales');
      if v_trade > 0 then
        perform game.money(p_player, (v_d * v_trade * 2 / 100), 'perk_bonus', 'Trade perk bonus', null, true);
      end if;
    end if;
    update game.renown set rev_seen = v_rev, sales_seen = v_sales, rev_scanned_at = v_now where player_id = p_player;
  end if;
  -- Actions since the last scan.
  select count(*) into v_n from game.trades where (buyer_id = p_player or seller_id = p_player) and at >= r.scanned_at and at < v_now;
  v_xp := v_xp + least(v_n, 10) * 15;
  select count(*) into v_n from game.ledger where player_id = p_player and kind = 'upgrade' and at >= r.scanned_at and at < v_now and bucket is null;
  v_xp := v_xp + least(v_n, 5) * 60;
  select count(*) into v_n from game.ledger where player_id = p_player and kind in ('purchase', 'fitout') and at >= r.scanned_at and at < v_now and bucket is null;
  v_xp := v_xp + least(v_n, 5) * 40;
  select count(*) into v_n from game.ledger where player_id = p_player and kind = 'travel' and at >= r.scanned_at and at < v_now and bucket is null;
  v_xp := v_xp + least(v_n, 3) * 25;
  select count(*) into v_n from game.contracts where taker_id = p_player and status = 'done' and done_at >= r.scanned_at and done_at < v_now;
  v_xp := v_xp + least(v_n, 5) * 120;
  select count(*) into v_n from game.project_contributions where player_id = p_player and at >= r.scanned_at and at < v_now;
  v_xp := v_xp + least(v_n, 5) * 40;
  update game.renown set scanned_at = v_now where player_id = p_player;
  if v_xp > 0 then perform game.grant_xp(p_player, v_xp, 'Business'); end if;
end $$;

create function game.renown_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_id uuid;
begin
  for v_id in select id from game.players where status = 'active' and last_seen_at > now() - interval '15 minutes' loop
    begin
      perform game.renown_scan(v_id);
      perform game.check_achievements(v_id);
    exception when others then
      raise warning 'renown scan % failed: %', v_id, sqlerrm;
    end;
  end loop;
  delete from game.renown_log where at < now() - interval '14 days';
end $$;

do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'crancapital-renown';
    perform cron.schedule('crancapital-renown', '* * * * *', 'select game.renown_tick()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Crates
-- ---------------------------------------------------------------------------
create function game.pick(p_weights jsonb) returns text
language plpgsql as $$
declare
  v_total numeric := 0;
  v_r numeric;
  k text;
  w numeric;
begin
  for k, w in select key, value::numeric from jsonb_each_text(p_weights) loop v_total := v_total + w; end loop;
  v_r := random() * v_total;
  for k, w in select key, value::numeric from jsonb_each_text(p_weights) order by key loop
    v_r := v_r - w;
    if v_r <= 0 then return k; end if;
  end loop;
  return k;
end $$;

create function public.open_crate(p_kind text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  r game.renown;
  v_kind text := p_kind;
  v_level int;
  v_nation text := game.player_nation(p.id);
  v_fortune int := game.perk(p.id, 'fortune');
  v_weights jsonb;
  v_prize text;
  v_amt bigint;
  v_label text;
  v_rare boolean := false;
begin
  perform game.rate_limit(p.id::text, 'open_crate', 20, 30);
  r := game.renown_row(p.id);
  select * into r from game.renown where player_id = p.id for update;
  if p_kind not in ('supply', 'gold', 'war') then perform game.fail('Unknown crate.'); end if;
  if coalesce((r.crates ->> p_kind)::int, 0) < 1 then perform game.fail('You have no crates of that kind.'); end if;
  update game.renown set crates = jsonb_set(crates, array[p_kind], to_jsonb((crates ->> p_kind)::int - 1)) where player_id = p.id;
  v_level := r.level;
  -- Pity: every 10th supply crate is a gold one. Fortune shortens the wait.
  if p_kind = 'supply' then
    if r.pity + 1 >= 10 - v_fortune then
      v_kind := 'gold';
      v_rare := true;
      update game.renown set pity = 0 where player_id = p.id;
    else
      update game.renown set pity = pity + 1 where player_id = p.id;
    end if;
  end if;
  v_weights := case v_kind
    when 'supply' then jsonb_build_object('xp', 30, 'cash', 25, 'points', 15, 'boost', 10)
                       || case when v_nation is not null then jsonb_build_object('research', 10, 'troops', 10) else '{}'::jsonb end
    when 'gold' then jsonb_build_object('xp', 20, 'cash', 25, 'boost', 15, 'respec', 10)
                       || case when v_nation is not null then jsonb_build_object('research', 15, 'funds', 15) else '{}'::jsonb end
    else jsonb_build_object('xp', 15, 'cash', 15)
         || case when v_nation is not null then jsonb_build_object('troops', 40, 'funds', 30, 'research', 15) else '{}'::jsonb end
  end;
  v_prize := game.pick(v_weights);
  case v_prize
    when 'xp' then
      v_amt := case v_kind when 'gold' then 300 + 30 * v_level else 60 + 8 * v_level end;
      v_amt := game.grant_xp(p.id, v_amt::int, 'Crate');
      v_label := format('%s XP', v_amt);
    when 'cash' then
      v_amt := round((case v_kind when 'gold' then 5000 + 1500 * v_level when 'war' then 2000 + 600 * v_level else 500 + 150 * v_level end)
                     * (0.6 + random() * 0.8)) * 1000;
      perform game.money(p.id, v_amt, 'renown_reward', 'Crate', jsonb_build_object('crate', v_kind));
      v_label := game.fmt(v_amt);
    when 'points' then
      v_amt := 10 + floor(random() * 21);
      update game.players set loyalty_points = loyalty_points + v_amt where id = p.id;
      v_label := format('%s loyalty points', v_amt);
    when 'boost' then
      v_amt := case v_kind when 'gold' then 120 else 30 end;
      update game.renown set boost_pct = 50,
        boost_until = greatest(coalesce(boost_until, now()), now()) + make_interval(mins => v_amt::int)
       where player_id = p.id;
      v_label := format('+50%% XP for %s minutes', v_amt);
    when 'respec' then
      update game.renown set tokens = jsonb_set(tokens, '{respec}', to_jsonb(coalesce((tokens ->> 'respec')::int, 0) + 1)) where player_id = p.id;
      v_amt := 1;
      v_label := 'A perk respec token';
    else
      v_amt := case v_prize
        when 'research' then case v_kind when 'gold' then 300 + 40 * v_level else 50 + 10 * v_level end
        when 'troops' then case v_kind when 'war' then 10 + v_level else 5 + v_level / 2 end
        else (case v_kind when 'gold' then 6000 + 1500 * v_level else 2000 + 500 * v_level end) * 1000 end;
      v_label := game.crate_nation_reward(p.id, v_prize, v_amt);
      if v_label is null then
        v_amt := (500 + 150 * v_level) * 1000;
        perform game.money(p.id, v_amt, 'renown_reward', 'Crate', jsonb_build_object('crate', v_kind));
        v_prize := 'cash';
        v_label := game.fmt(v_amt);
      end if;
  end case;
  perform game.count(p.id, 'crates_opened');
  return jsonb_build_object('crate', p_kind, 'opened_as', v_kind, 'rare', v_rare or v_kind = 'gold', 'prize', v_prize, 'amount', v_amt, 'label', v_label);
end $$;

-- ---------------------------------------------------------------------------
-- Perks
-- ---------------------------------------------------------------------------
create table game.perk_branches (
  id text primary key,
  name text not null,
  body text not null, -- per rank
  icon text not null,
  sort int not null
);
insert into game.perk_branches (id, name, body, icon, sort) values
  ('trade', 'Trade', '+2% sales, paid to you as a bonus', 'cash', 1),
  ('fortune', 'Fortune', '+5% XP and rare crates come sooner', 'gift', 2),
  ('command', 'Command', '+4% army strength and 4% cheaper recruits', 'swords', 3),
  ('statecraft', 'Statecraft', '+5% national income and research', 'flag', 4),
  ('logistics', 'Logistics', '+6% army speed and 5% less upkeep', 'truck', 5);

create function public.spend_perk(p_branch text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  r game.renown;
  v_rank int;
begin
  r := game.renown_row(p.id);
  select * into r from game.renown where player_id = p.id for update;
  if not exists (select 1 from game.perk_branches where id = p_branch) then perform game.fail('Unknown perk.'); end if;
  v_rank := coalesce((r.perks ->> p_branch)::int, 0);
  if v_rank >= 5 then perform game.fail('That perk is maxed out.'); end if;
  if v_rank >= 3 then perform game.require_level(p.id, 'perk_high'); end if;
  if r.perk_points < v_rank + 1 then
    perform game.fail(format('Rank %s costs %s perk points. You have %s.', v_rank + 1, v_rank + 1, r.perk_points));
  end if;
  update game.renown set perk_points = perk_points - (v_rank + 1), perks = jsonb_set(perks, array[p_branch], to_jsonb(v_rank + 1))
   where player_id = p.id returning * into r;
  return jsonb_build_object('perks', r.perks, 'perk_points', r.perk_points);
end $$;

create function public.respec_perks() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  r game.renown;
  v_refund int := 0;
  v_free boolean;
  k text;
  v int;
begin
  r := game.renown_row(p.id);
  select * into r from game.renown where player_id = p.id for update;
  if r.perks = '{}'::jsonb then perform game.fail('You have no perks to reset.'); end if;
  v_free := r.respec_at is null or r.respec_at < now() - interval '7 days';
  if not v_free then
    if coalesce((r.tokens ->> 'respec')::int, 0) < 1 then
      perform game.fail('Free resets come once a week. Respec tokens come from gold crates.');
    end if;
    update game.renown set tokens = jsonb_set(tokens, '{respec}', to_jsonb((tokens ->> 'respec')::int - 1)) where player_id = p.id;
  end if;
  for k, v in select key, value::int from jsonb_each_text(r.perks) loop
    v_refund := v_refund + v * (v + 1) / 2;
  end loop;
  update game.renown set perks = '{}'::jsonb, perk_points = perk_points + v_refund,
    respec_at = case when v_free then now() else respec_at end
   where player_id = p.id;
  return jsonb_build_object('refunded', v_refund, 'free', v_free);
end $$;

-- ---------------------------------------------------------------------------
-- Daily reward and streak
-- ---------------------------------------------------------------------------
create function game.daily_reward(p_day int, p_level int) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'day', p_day,
    'xp', (array[50, 75, 100, 125, 150, 200, 300])[p_day],
    'cash', case when p_day in (2, 5) then (300 + 100 * p_level) * 1000 else 0 end,
    'crate', case p_day when 3 then 'supply' when 7 then 'gold' else null end)
$$;

create function public.claim_daily() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  r game.renown;
  v_today date := (now() at time zone 'utc')::date;
  v_gap int;
  v_streak int;
  v_shields int;
  v_used int := 0;
  v_day int;
  v_rew jsonb;
  v_xp int;
begin
  r := game.renown_row(p.id);
  select * into r from game.renown where player_id = p.id for update;
  if r.daily_last = v_today then perform game.fail('Already collected today. Come back tomorrow!'); end if;
  v_shields := r.shields;
  if r.daily_last is null then
    v_streak := 1;
  else
    v_gap := v_today - r.daily_last - 1;
    if v_gap = 0 then
      v_streak := r.streak + 1;
    elsif v_gap <= v_shields then
      v_streak := r.streak + 1;
      v_shields := v_shields - v_gap;
      v_used := v_gap;
    else
      v_streak := 1;
    end if;
  end if;
  if v_streak % 7 = 0 then v_shields := least(2, v_shields + 1); end if;
  v_day := (r.daily_count % 7) + 1;
  v_rew := game.daily_reward(v_day, r.level);
  update game.renown set daily_last = v_today, daily_count = daily_count + 1, streak = v_streak,
    best_streak = greatest(best_streak, v_streak), shields = v_shields
   where player_id = p.id;
  v_xp := (v_rew ->> 'xp')::int + least(v_streak, 30) * 5;
  v_xp := game.grant_xp(p.id, v_xp, format('Daily reward, day %s', v_day));
  if (v_rew ->> 'cash')::bigint > 0 then
    perform game.money(p.id, (v_rew ->> 'cash')::bigint, 'renown_reward', 'Daily reward');
  end if;
  if v_rew ->> 'crate' is not null then perform game.add_crate(p.id, v_rew ->> 'crate'); end if;
  return v_rew || jsonb_build_object('xp', v_xp, 'streak', v_streak, 'shields', v_shields, 'shields_used', v_used);
end $$;

-- ---------------------------------------------------------------------------
-- Missions, season, titles
-- ---------------------------------------------------------------------------
create function public.claim_mission(p_id bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  m game.missions;
  v_xp int;
begin
  perform game.rate_limit(p.id::text, 'claim_mission', 10, 20);
  select * into m from game.missions where id = p_id and player_id = p.id for update;
  if not found then perform game.fail('That mission isn''t yours.'); end if;
  if m.period <> game.mission_period(m.scope) then perform game.fail('That mission has ended.'); end if;
  if m.claimed then perform game.fail('Already collected.'); end if;
  if coalesce(game.renown_stat(p.id, m.stat), 0) - m.base < m.target then perform game.fail('Not done yet: keep going!'); end if;
  update game.missions set claimed = true where id = m.id;
  v_xp := game.grant_xp(p.id, m.xp, 'Mission: ' || m.title);
  perform game.count(p.id, 'missions_done');
  if m.scope = 'weekly' then perform game.add_crate(p.id, 'supply'); end if;
  return jsonb_build_object('xp', v_xp, 'crate', case when m.scope = 'weekly' then 'supply' end);
end $$;

create function game.season_reward(p_tier int, p_level int) returns jsonb
language sql immutable as $$
  select case
    when p_tier = 40 then jsonb_build_object('crate', 'gold', 'n', 3, 'title', 'Season Champion')
    when p_tier = 20 then jsonb_build_object('crate', 'gold', 'n', 2, 'title', 'Season Veteran')
    when p_tier % 5 = 0 then jsonb_build_object('crate', 'gold', 'n', 1)
    when p_tier % 2 = 1 then jsonb_build_object('crate', 'supply', 'n', 1)
    else jsonb_build_object('cash', (1000 + 200 * p_level) * 1000) end
$$;

create function public.claim_season(p_tier int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  r game.renown;
  v_rew jsonb;
  v_key text := to_char(now() at time zone 'utc', 'YYYY-MM');
begin
  r := game.renown_row(p.id);
  select * into r from game.renown where player_id = p.id for update;
  if r.season_key is distinct from v_key then perform game.fail('Earn some XP this month to start the season.'); end if;
  if p_tier < 1 or p_tier > 40 then perform game.fail('No such tier.'); end if;
  if r.season_xp / 400 < p_tier then perform game.fail('Not reached yet.'); end if;
  if p_tier = any(r.season_claimed) then perform game.fail('Already collected.'); end if;
  v_rew := game.season_reward(p_tier, r.level);
  update game.renown set season_claimed = array_append(season_claimed, p_tier) where player_id = p.id;
  if v_rew ? 'crate' then perform game.add_crate(p.id, v_rew ->> 'crate', (v_rew ->> 'n')::int); end if;
  if v_rew ? 'cash' then perform game.money(p.id, (v_rew ->> 'cash')::bigint, 'renown_reward', format('Season tier %s', p_tier)); end if;
  if v_rew ? 'title' then
    update game.renown set titles = array_append(titles, (v_rew ->> 'title') || ' ' || to_char(now(), 'Mon YYYY'))
     where player_id = p.id;
  end if;
  return v_rew;
end $$;

create function public.use_title(p_title text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  r game.renown := game.renown_row(p.id);
begin
  if p_title is not null and not (p_title = any(r.titles)) then perform game.fail('You haven''t earned that title.'); end if;
  update game.players set title = p_title where id = p.id;
  return jsonb_build_object('title', p_title);
end $$;

-- ---------------------------------------------------------------------------
-- Reading it all
-- ---------------------------------------------------------------------------
create function game.renown_brief(p_player uuid) returns jsonb
language sql stable set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'level', r.level, 'xp', r.xp, 'rank', game.rank_for(r.level),
    'into', r.xp - (select total from game.level_xp where level = r.level),
    'need', game.xp_need(r.level),
    'perk_points', r.perk_points,
    'crates', (select coalesce(sum(value::int), 0) from jsonb_each_text(r.crates)),
    'daily', r.daily_last is distinct from (now() at time zone 'utc')::date,
    'boost_until', case when r.boost_until > now() then r.boost_until end)
  from game.renown r where r.player_id = p_player
$$;

create function public.my_renown() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  r game.renown;
  v_today date := (now() at time zone 'utc')::date;
  v_key text := to_char(now() at time zone 'utc', 'YYYY-MM');
begin
  perform game.renown_row(p.id);
  begin
    perform game.renown_scan(p.id);
    perform game.check_achievements(p.id);
  exception when others then
    raise warning 'renown refresh failed: %', sqlerrm;
  end;
  perform game.ensure_missions(p.id);
  select * into r from game.renown where player_id = p.id;
  return game.renown_brief(p.id) || jsonb_build_object(
    'next_rank', (select jsonb_build_object('level', level, 'name', name) from game.ranks where level > r.level order by level limit 1),
    'perks', r.perks,
    'perk_branches', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'body', body, 'icon', icon) order by sort) from game.perk_branches),
    'respec_free', r.respec_at is null or r.respec_at < now() - interval '7 days',
    'crate_counts', r.crates,
    'tokens', r.tokens,
    'pity', r.pity,
    'boost_pct', r.boost_pct,
    'titles', to_jsonb(r.titles),
    'title', p.title,
    'streak', jsonb_build_object(
      'streak', case when r.daily_last >= v_today - 1 - r.shields then r.streak else 0 end,
      'best', r.best_streak, 'shields', r.shields,
      'claimed_today', r.daily_last = v_today,
      'next', game.daily_reward((r.daily_count % 7) + 1, r.level),
      'week', (select jsonb_agg(game.daily_reward(d, r.level) order by d) from generate_series(1, 7) d),
      'cycle_day', case when r.daily_last = v_today then ((r.daily_count - 1) % 7) + 1 else (r.daily_count % 7) end),
    'missions', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'scope', m.scope, 'title', m.title, 'target', m.target,
                    'progress', least(m.target, greatest(0, coalesce(game.renown_stat(p.id, m.stat), 0) - m.base)),
                    'xp', m.xp, 'claimed', m.claimed) order by m.scope, m.id), '[]'::jsonb)
                   from game.missions m where m.player_id = p.id and m.period in (game.mission_period('daily'), game.mission_period('weekly'))),
    'achievements', (select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'icon', d.icon, 'nation', d.nation,
                        'tier', coalesce(a.tier, 0),
                        'value', coalesce(game.renown_stat(p.id, d.stat), 0),
                        'next', d.tiers[coalesce(a.tier, 0) + 1],
                        'prev', coalesce(d.tiers[coalesce(a.tier, 0)], 0),
                        'goal', case when coalesce(a.tier, 0) < 4 then format(d.body, game.fmt_target(d, d.tiers[coalesce(a.tier, 0) + 1])) end,
                        'xp', case when coalesce(a.tier, 0) < 4 then game.achievement_xp(coalesce(a.tier, 0) + 1) end) order by d.sort)
                       from game.achievement_defs d left join game.achievements a on a.player_id = p.id and a.id = d.id),
    'season', jsonb_build_object(
      'key', v_key,
      'xp', case when r.season_key = v_key then r.season_xp else 0 end,
      'per_tier', 400,
      'claimed', to_jsonb(case when r.season_key = v_key then r.season_claimed else '{}'::int[] end),
      'ends_at', date_trunc('month', now() at time zone 'utc') + interval '1 month',
      'rewards', (select jsonb_agg(game.season_reward(t, r.level) || jsonb_build_object('tier', t) order by t) from generate_series(1, 40) t)),
    'unlocks', (select jsonb_agg(jsonb_build_object('key', key, 'level', level, 'title', title, 'body', body, 'icon', icon, 'open', level <= r.level) order by level, key)
                  from game.renown_unlocks),
    'log', (select coalesce(jsonb_agg(jsonb_build_object('xp', l.xp, 'reason', l.reason, 'at', l.at) order by l.at desc), '[]'::jsonb)
              from (select * from game.renown_log where player_id = p.id order by at desc limit 15) l)
  );
end $$;

create function public.renown_leaders() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(x order by x.xp desc), '[]'::jsonb) from (
    select pl.player_no, pl.display_name as name, pl.skin, r.level, r.xp, game.rank_for(r.level) as rank
      from game.renown r join game.players pl on pl.id = r.player_id
     where pl.status = 'active'
     order by r.xp desc limit 50) x
$$;

-- The player record now carries their Renown summary for the HUD.
create or replace function game.player_json(p game.players) returns jsonb
language sql stable set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'player_no', p.player_no, 'display_name', p.display_name, 'title', p.title, 'skin', p.skin,
    'ring_style', p.ring_style, 'cash', p.cash, 'net_worth', p.net_worth, 'peak_net_worth', p.peak_net_worth, 'tier', p.tier,
    'city_id', p.city_id, 'lat', p.lat, 'lng', p.lng, 'inside_building', p.inside_building,
    'travel_from', p.travel_from, 'travel_to', p.travel_to, 'travel_arrive_at', p.travel_arrive_at,
    'created_at', p.created_at, 'days_played', p.days_played, 'loyalty_points', p.loyalty_points,
    'referral_code', p.referral_code, 'role', p.role, 'status', p.status, 'status_until', p.status_until,
    'status_reason', p.status_reason, 'tutorial_done', p.tutorial_done, 'prefs', p.prefs,
    'unread', (select count(*) from game.notifications n where n.player_id = p.id and not n.read),
    'next_tier', (select jsonb_build_object('tier', t.tier, 'name', t.name, 'net_worth', game.tier_threshold(t.tier))
                    from game.tiers t where t.tier = p.tier + 1),
    'renown', game.renown_brief(p.id),
    'nation', game.player_nation(p.id)
  )
$$;

-- Permissions: only the public API is callable.
do $$
declare
  f text;
begin
  foreach f in array array[
    'open_crate(text)', 'spend_perk(text)', 'respec_perks()', 'claim_daily()', 'claim_mission(bigint)',
    'claim_season(int)', 'use_title(text)', 'my_renown()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  execute 'revoke all on function public.renown_leaders() from public';
  execute 'grant execute on function public.renown_leaders() to anon, authenticated, service_role';
end $$;

-- The HUD's summary, refreshed after XP arrives.
create function public.renown_brief() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  perform game.renown_row(p.id);
  return game.renown_brief(p.id);
end $$;
revoke all on function public.renown_brief() from public, anon;
grant execute on function public.renown_brief() to authenticated, service_role;

-- The heartbeat keeps the HUD's level and country fresh too.
create or replace function public.heartbeat() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  update game.players set last_seen_at = now() where id = p.id;
  return jsonb_build_object('cash', p.cash, 'net_worth', p.net_worth, 'tier', p.tier,
    'unread', (select count(*) from game.notifications n where n.player_id = p.id and not n.read),
    'city_id', p.city_id, 'travel_to', p.travel_to, 'travel_arrive_at', p.travel_arrive_at, 'status', p.status,
    'renown', game.renown_brief(p.id), 'nation', game.player_nation(p.id));
end $$;
