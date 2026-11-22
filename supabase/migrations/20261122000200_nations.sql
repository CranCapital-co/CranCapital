-- Nations: every player leads a real country in one shared world
-- (see docs/PROGRESSION_AND_NATIONS.md). This file: the world's tables,
-- national economy, choosing a country, buildings, recruiting and research.
-- War, diplomacy and the world tick are in 20261122000300_war.sql, the AI in
-- 20261122000400_ai.sql, and the countries themselves in
-- 20261122000500_world_data.sql (generated from Natural Earth).
--
-- Money: national treasuries are in mills like player cash, but they are not
-- player money and do not go through the ledger. Player cash moves into a
-- treasury (invest) or out of it (the leader's stipend) through game.money().

insert into game.ledger_kinds (kind, label, flow) values
  ('nation_invest', 'Invested in your nation', 'world_out'),
  ('stipend', 'Leader''s stipend', 'world_in')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- The map
-- ---------------------------------------------------------------------------
create table game.territories (
  id text primary key,
  name text not null,
  iso2 text,
  continent text not null,
  region text,
  pop_m numeric not null,
  gdp_bn numeric not null,
  lat float8 not null,
  lng float8 not null,
  landlocked boolean not null default false,
  color text not null,
  owner_id text,
  controller_id text,
  occupied_at timestamptz,
  development numeric not null default 1,
  damage numeric not null default 0,
  value numeric not null default 0,  -- share of the world, sums to 1
  income bigint not null default 0,  -- mills an hour at development 1
  manpower int not null default 0,   -- an hour
  militia numeric not null default 0 -- defence when held by its owner
);
create index territories_owner_idx on game.territories (owner_id);
create index territories_controller_idx on game.territories (controller_id);

create table game.territory_links (
  a text not null references game.territories(id),
  b text not null references game.territories(id),
  kind text not null check (kind in ('land', 'sea')),
  km int not null,
  primary key (a, b)
);

create table game.nations (
  id text primary key references game.territories(id), -- its homeland
  name text not null,
  color text not null,
  leader_id uuid unique references game.players(id) on delete set null,
  leader_since timestamptz,
  ai_skill smallint not null default 3 check (ai_skill between 1 and 5),
  personality text not null default 'balanced'
    check (personality in ('aggressive', 'expansionist', 'balanced', 'defensive', 'diplomatic', 'mercantile')),
  status text not null default 'active' check (status in ('active', 'fallen')),
  fallen_at timestamptz,
  treasury bigint not null default 0 check (treasury >= 0),
  manpower bigint not null default 0,
  research_bank numeric not null default 0,
  researching text,
  research_progress numeric not null default 0,
  stability numeric not null default 70,
  exhaustion numeric not null default 0,
  tax text not null default 'normal' check (tax in ('low', 'normal', 'high')),
  research_pct int not null default 15 check (research_pct between 0 and 60),
  infra_pct int not null default 10 check (infra_pct between 0 and 40),
  protected_until timestamptz,
  next_think_at timestamptz not null default now(),
  power numeric not null default 0,
  share numeric not null default 0,
  income_h bigint not null default 0,
  upkeep_h bigint not null default 0,
  last_econ_at timestamptz not null default now(),
  ai jsonb not null default '{}'::jsonb, -- the AI's memory
  created_at timestamptz not null default now()
);
alter table game.territories add foreign key (owner_id) references game.nations(id);
alter table game.territories add foreign key (controller_id) references game.nations(id);

create or replace function game.player_nation(p_player uuid) returns text
language sql stable set search_path = game, pg_temp as $$
  select id from game.nations where leader_id = p_player
$$;

-- ---------------------------------------------------------------------------
-- Research
-- ---------------------------------------------------------------------------
create table game.techs (
  id text primary key,
  name text not null,
  body text not null,
  branch text not null,
  cost int not null,
  requires text[] not null default '{}',
  effect jsonb not null default '{}'::jsonb,
  sort int not null
);
insert into game.techs (id, name, body, branch, cost, requires, effect, sort) values
  ('drills', 'Infantry Drills', 'Infantry +15% attack and defence.', 'land', 150, '{}', '{"atk_infantry":0.15,"def_infantry":0.15}', 1),
  ('artillery', 'Field Artillery', 'Unlocks artillery.', 'land', 200, '{}', '{}', 2),
  ('armor', 'Mechanized Warfare', 'Unlocks armour.', 'land', 300, '{}', '{}', 3),
  ('logistics', 'Logistics', 'Armies move 25% faster and cost 10% less upkeep.', 'strategy', 300, '{}', '{"speed":0.25,"upkeep":-0.10}', 4),
  ('fortification', 'Fortification', 'Forts are 50% stronger.', 'defence', 250, '{}', '{"fort":0.5}', 5),
  ('industry', 'Industrial Policy', '+15% national income.', 'economy', 400, '{}', '{"income":0.15}', 6),
  ('propaganda', 'Propaganda', '+10 stability.', 'economy', 350, '{}', '{"stability":10}', 7),
  ('aviation', 'Aviation', 'Unlocks airbases and air wings.', 'air', 600, '{logistics}', '{}', 8),
  ('navy', 'Blue-Water Navy', 'Unlocks naval bases and fleets.', 'sea', 600, '{logistics}', '{}', 9),
  ('special_forces', 'Special Forces', 'Infantry +25% attack.', 'land', 1000, '{drills}', '{"atk_infantry":0.25}', 10),
  ('composite_armor', 'Composite Armour', 'Armour +25% attack and defence.', 'land', 900, '{armor}', '{"atk_armor":0.25,"def_armor":0.25}', 11),
  ('rocketry', 'Rocket Artillery', 'Artillery +30% attack.', 'land', 900, '{artillery}', '{"atk_artillery":0.3}', 12),
  ('air_defence', 'Air Defence', 'Unlocks air-defence batteries.', 'defence', 500, '{aviation}', '{}', 13),
  ('computing', 'Computing', '+25% research.', 'economy', 700, '{industry}', '{"research":0.25}', 14),
  ('diplomacy', 'Diplomatic Corps', 'Envoys work twice as well; declaring war costs half the stability.', 'strategy', 600, '{propaganda}', '{"diplo":1}', 15),
  ('jets', 'Jet Fighters', 'Air wings +30%.', 'air', 1200, '{aviation}', '{"atk_air":0.3,"def_air":0.3}', 16),
  ('carriers', 'Carrier Groups', 'Fleets +25%, and no penalty for attacking across the sea.', 'sea', 1500, '{navy}', '{"atk_naval":0.25,"def_naval":0.25,"sea":1}', 17),
  ('missiles', 'Ballistic Missiles', 'Unlocks missile silos and missiles.', 'strategy', 2000, '{rocketry,computing}', '{}', 18),
  ('network_warfare', 'Network Warfare', 'All units +10%.', 'strategy', 3000, '{computing,jets}', '{"atk_all":0.1,"def_all":0.1}', 19),
  ('stealth', 'Stealth', 'Air wings +40% and ignore half of air defence.', 'air', 3500, '{jets,network_warfare}', '{"atk_air":0.4,"stealth":0.5}', 20),
  ('hypersonic', 'Hypersonic Missiles', 'Missiles twice as strong and can''t be intercepted.', 'strategy', 4500, '{missiles}', '{"missile":1,"no_intercept":1}', 21);

create table game.nation_techs (
  nation_id text not null references game.nations(id) on delete cascade,
  tech text not null references game.techs(id),
  done_at timestamptz not null default now(),
  primary key (nation_id, tech)
);

create function game.has_tech(p_nation text, p_tech text) returns boolean
language sql stable set search_path = game, pg_temp as $$
  select p_tech is null or exists (select 1 from game.nation_techs where nation_id = p_nation and tech = p_tech)
$$;

create function game.tech_fx(p_nation text, p_key text) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select coalesce(sum((t.effect ->> p_key)::numeric), 0)
    from game.nation_techs nt join game.techs t on t.id = nt.tech
   where nt.nation_id = p_nation and t.effect ? p_key
$$;

-- A human leader's perk rank (AI nations have none).
create function game.leader_perk(p_nation text, p_branch text) returns int
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select game.perk(leader_id, p_branch) from game.nations where id = p_nation and leader_id is not null), 0)
$$;

-- ---------------------------------------------------------------------------
-- Buildings and units
-- ---------------------------------------------------------------------------
create table game.facility_types (
  id text primary key,
  name text not null,
  body text not null,
  icon text not null,
  max_level int not null,
  cost bigint not null,    -- mills for level 1; level L costs cost * L^2
  minutes int not null,    -- level L takes minutes * L
  upkeep bigint not null,  -- mills an hour per level
  unlock text not null,    -- Renown unlock key (human leaders)
  tech text references game.techs(id),
  coastal boolean not null default false,
  sort int not null
);
insert into game.facility_types (id, name, body, icon, max_level, cost, minutes, upkeep, unlock, tech, coastal, sort) values
  ('barracks', 'Barracks', 'Trains infantry. Each level trains faster and takes bigger orders.', 'people', 5, 2000000, 5, 20000, 'nation', null, false, 1),
  ('factory', 'Arms factory', 'Builds artillery and armour.', 'industry', 5, 6000000, 10, 60000, 'artillery', null, false, 2),
  ('fort', 'Fort', '+15% defence a level for everyone defending this territory.', 'shield', 5, 3000000, 8, 30000, 'fort', null, false, 3),
  ('lab', 'Research lab', '+40 research an hour a level.', 'flask', 5, 5000000, 10, 50000, 'lab', null, false, 4),
  ('airbase', 'Airbase', 'Trains air wings.', 'plane', 5, 12000000, 15, 120000, 'airbase', 'aviation', false, 5),
  ('naval_base', 'Naval base', 'Builds fleets. Coast only.', 'ship', 5, 12000000, 15, 120000, 'naval_base', 'navy', true, 6),
  ('air_defence', 'Air defence', 'Each level weakens air attacks by 20% and stops 25% of missiles.', 'radar', 3, 8000000, 12, 80000, 'air_defence', 'air_defence', false, 7),
  ('silo', 'Missile silo', 'Builds and launches ballistic missiles.', 'rocket', 3, 25000000, 30, 200000, 'silo', 'missiles', false, 8);

create table game.facilities (
  territory_id text not null references game.territories(id),
  kind text not null references game.facility_types(id),
  level int not null default 0,
  target int,
  ready_at timestamptz,
  primary key (territory_id, kind)
);

create function game.blevel(p_territory text, p_kind text) returns int
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select level from game.facilities where territory_id = p_territory and kind = p_kind), 0)
$$;

create table game.unit_types (
  id text primary key,
  name text not null,
  plural text not null,
  icon text not null,
  atk numeric not null,
  def numeric not null,
  cost bigint not null,      -- mills each
  manpower int not null,
  upkeep bigint not null,    -- mills an hour each
  minutes numeric not null,  -- training time for an order of 20
  speed numeric not null,    -- km a minute
  building text not null references game.facility_types(id),
  tech text references game.techs(id),
  unlock text not null,
  sort int not null
);
insert into game.unit_types (id, name, plural, icon, atk, def, cost, manpower, upkeep, minutes, speed, building, tech, unlock, sort) values
  ('infantry', 'Infantry', 'infantry', 'people', 1, 2, 300000, 50, 8000, 6, 100, 'barracks', null, 'nation', 1),
  ('artillery', 'Artillery', 'artillery', 'target', 3, 1.5, 1200000, 30, 25000, 12, 80, 'factory', 'artillery', 'artillery', 2),
  ('armor', 'Armour', 'armour', 'tank', 4, 3, 1800000, 25, 45000, 16, 140, 'factory', 'armor', 'armor', 3),
  ('air', 'Air wing', 'air wings', 'plane', 5, 2.5, 4000000, 10, 100000, 24, 600, 'airbase', 'aviation', 'air', 4),
  ('naval', 'Fleet', 'fleets', 'ship', 3, 5, 5000000, 40, 120000, 30, 90, 'naval_base', 'navy', 'naval', 5),
  ('missile', 'Missile', 'missiles', 'rocket', 0, 0, 8000000, 0, 0, 40, 1500, 'silo', 'missiles', 'missile', 6);

create table game.garrisons (
  territory_id text not null references game.territories(id),
  nation_id text not null references game.nations(id) on delete cascade,
  unit text not null references game.unit_types(id),
  qty int not null check (qty >= 0),
  primary key (territory_id, nation_id, unit)
);
create index garrisons_nation_idx on game.garrisons (nation_id);

create function game.garrison_add(p_territory text, p_nation text, p_unit text, p_qty int) returns void
language sql set search_path = game, pg_temp as $$
  insert into game.garrisons as g (territory_id, nation_id, unit, qty) values (p_territory, p_nation, p_unit, greatest(0, p_qty))
  on conflict (territory_id, nation_id, unit) do update set qty = greatest(0, g.qty + p_qty)
$$;

create table game.recruit_queue (
  id bigint generated always as identity primary key,
  nation_id text not null references game.nations(id) on delete cascade,
  territory_id text not null references game.territories(id),
  unit text not null references game.unit_types(id),
  qty int not null,
  ready_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index recruit_queue_ready_idx on game.recruit_queue (ready_at);

create table game.world_news (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,
  title text not null,
  body text,
  nations text[] not null default '{}',
  data jsonb
);
create index world_news_at_idx on game.world_news (at desc);

-- ---------------------------------------------------------------------------
-- Diplomacy and war (the rules are in 20261122000300_war.sql)
-- ---------------------------------------------------------------------------
-- Relations between two nations, -100 (hatred) to 100 (friends); a < b.
create table game.relations (
  a text not null references game.nations(id) on delete cascade,
  b text not null references game.nations(id) on delete cascade,
  score numeric not null default 0,
  rival_a boolean not null default false, -- a has denounced b
  rival_b boolean not null default false,
  denounced_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);

-- Truces after a war, and non-aggression pacts.
create table game.treaties (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('truce', 'nap')),
  a text not null references game.nations(id) on delete cascade,
  b text not null references game.nations(id) on delete cascade,
  until timestamptz not null
);
create index treaties_pair_idx on game.treaties (a, b);

create table game.alliances (
  id bigint generated always as identity primary key,
  name text not null,
  color text not null,
  founder_id text references game.nations(id) on delete set null,
  created_at timestamptz not null default now()
);

create table game.alliance_members (
  nation_id text primary key references game.nations(id) on delete cascade,
  alliance_id bigint not null references game.alliances(id) on delete cascade,
  joined_at timestamptz not null default now()
);

create table game.wars (
  id bigint generated always as identity primary key,
  name text not null,
  attacker_id text not null references game.nations(id),
  defender_id text not null references game.nations(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active' check (status in ('active', 'ended')),
  outcome text,
  score numeric not null default 0, -- from the attackers' side, -100 to 100
  att_wins int not null default 0,
  def_wins int not null default 0
);
create index wars_active_idx on game.wars (status) where status = 'active';

create table game.war_sides (
  war_id bigint not null references game.wars(id) on delete cascade,
  nation_id text not null references game.nations(id) on delete cascade,
  side text not null check (side in ('att', 'def')),
  joined_at timestamptz not null default now(),
  primary key (war_id, nation_id)
);
create index war_sides_nation_idx on game.war_sides (nation_id);

create table game.diplo_offers (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('alliance', 'nap', 'peace')),
  from_id text not null references game.nations(id) on delete cascade,
  to_id text not null references game.nations(id) on delete cascade,
  war_id bigint references game.wars(id) on delete cascade,
  terms jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 hours'
);
create index diplo_offers_to_idx on game.diplo_offers (to_id, status);

create table game.movements (
  id bigint generated always as identity primary key,
  nation_id text not null references game.nations(id) on delete cascade,
  from_t text not null references game.territories(id),
  to_t text not null references game.territories(id),
  units jsonb not null,
  kind text not null check (kind in ('move', 'attack', 'raid', 'missile')),
  depart_at timestamptz not null default now(),
  arrive_at timestamptz not null,
  status text not null default 'moving' check (status in ('moving', 'done')),
  result jsonb
);
create index movements_arrive_idx on game.movements (arrive_at) where status = 'moving';

create table game.battles (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  war_id bigint references game.wars(id) on delete set null,
  territory_id text not null references game.territories(id),
  attacker_id text not null references game.nations(id),
  defender_id text not null references game.nations(id),
  kind text not null,
  att_units jsonb not null,
  def_units jsonb not null,
  att_lost jsonb not null,
  def_lost jsonb not null,
  att_power numeric not null,
  def_power numeric not null,
  winner text not null check (winner in ('attacker', 'defender')),
  captured boolean not null default false,
  summary text not null
);
create index battles_at_idx on game.battles (at desc);
create index battles_nations_idx on game.battles (attacker_id, defender_id);

-- An era lasts until a nation holds half the world, or 90 days.
create table game.eras (
  id bigint generated always as identity primary key,
  number int not null,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  ended_at timestamptz,
  winner_id text,
  winner_name text,
  leader_name text,
  share numeric
);

create function game.news(p_kind text, p_title text, p_body text, p_nations text[], p_data jsonb default null) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  insert into game.world_news (kind, title, body, nations, data) values (p_kind, p_title, p_body, p_nations, p_data);
  perform game.push('world:nations', 'news', jsonb_build_object('kind', p_kind, 'title', p_title, 'body', p_body, 'nations', p_nations));
end $$;

-- Tell a nation's human leader, if it has one.
create function game.tell(p_nation text, p_kind text, p_title text, p_body text default null, p_data jsonb default null) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v uuid;
begin
  select leader_id into v from game.nations where id = p_nation;
  if v is not null then perform game.notify(v, p_kind, p_title, p_body, coalesce(p_data, '{}'::jsonb) || jsonb_build_object('nation', p_nation)); end if;
end $$;

-- XP and counters for a nation's human leader.
create function game.leader_xp(p_nation text, p_xp int, p_reason text, p_counter text default null, p_n bigint default 1) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v uuid;
begin
  select leader_id into v from game.nations where id = p_nation;
  if v is null then return; end if;
  if p_counter is not null then perform game.count(v, p_counter, p_n); end if;
  if p_xp > 0 then perform game.grant_xp(v, p_xp, p_reason); end if;
end $$;

-- ---------------------------------------------------------------------------
-- The national economy
-- ---------------------------------------------------------------------------
create function game.tax_mult(p_tax text) returns numeric
language sql immutable as $$ select case p_tax when 'low' then 0.85 when 'high' then 1.2 else 1 end $$;

create function game.active_wars(p_nation text) returns int
language sql stable set search_path = game, pg_temp as $$
  select count(*)::int from game.war_sides s join game.wars w on w.id = s.war_id
   where s.nation_id = p_nation and w.status = 'active'
$$;

create function game.alliance_size(p_nation text) returns int
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select count(*)::int - 1 from game.alliance_members m
                    where m.alliance_id = (select alliance_id from game.alliance_members where nation_id = p_nation)), 0)
$$;

-- Everything a nation earns and spends in an hour, right now.
create function game.nation_income(p_id text) returns jsonb
language plpgsql stable set search_path = game, pg_temp as $$
declare
  n game.nations;
  v_own numeric;
  v_occ numeric;
  v_gdp numeric;
  v_wars int;
  v_mult numeric;
  v_gross numeric;
  v_rs numeric;
  v_inf numeric;
  v_up_units numeric;
  v_up_bld numeric;
  v_stipend numeric;
  v_mp numeric;
  v_rp numeric;
  v_labs int;
  v_stab numeric;
  v_target numeric;
begin
  select * into n from game.nations where id = p_id;
  select coalesce(sum(income * development * (1 - damage)), 0), coalesce(sum(gdp_bn), 0), coalesce(sum(manpower), 0)
    into v_own, v_gdp, v_mp
    from game.territories where owner_id = p_id and controller_id = p_id;
  select coalesce(sum(0.5 * income * (1 - damage)), 0) into v_occ
    from game.territories where controller_id = p_id and owner_id <> p_id;
  v_wars := game.active_wars(p_id);
  v_stab := 0.5 + n.stability / 200.0;
  v_mult := game.tax_mult(n.tax) * v_stab
          * (1 + game.tech_fx(p_id, 'income') + 0.05 * game.leader_perk(p_id, 'statecraft'))
          * (1 - least(0.25, 0.05 * v_wars));
  v_gross := (v_own + v_occ) * v_mult;
  v_rs := v_gross * n.research_pct / 100.0;
  v_inf := v_gross * n.infra_pct / 100.0;
  select coalesce(sum(g.qty * u.upkeep), 0) into v_up_units
    from game.garrisons g join game.unit_types u on u.id = g.unit where g.nation_id = p_id;
  v_up_units := v_up_units + coalesce((select sum((e.value)::numeric * u.upkeep)
    from game.movements m cross join lateral jsonb_each_text(m.units) e join game.unit_types u on u.id = e.key
   where m.nation_id = p_id and m.status = 'moving'), 0);
  v_up_units := v_up_units * greatest(0.3, 1 + game.tech_fx(p_id, 'upkeep') - 0.05 * game.leader_perk(p_id, 'logistics'));
  select coalesce(sum(b.level * bt.upkeep), 0), coalesce(sum(b.level) filter (where b.kind = 'lab'), 0) into v_up_bld, v_labs
    from game.facilities b join game.facility_types bt on bt.id = b.kind
    join game.territories t on t.id = b.territory_id
   where t.owner_id = p_id and t.controller_id = p_id;
  v_stipend := case when n.leader_id is not null then 0.03 * v_gross else 0 end;
  v_rp := (10 + 2 * sqrt(v_gdp) + 40 * v_labs + v_rs / 20000.0)
        * (1 + game.tech_fx(p_id, 'research') + 0.05 * game.leader_perk(p_id, 'statecraft'));
  v_target := 75 + case n.tax when 'low' then 10 when 'high' then -15 else 0 end
            + game.tech_fx(p_id, 'stability') - 6 * v_wars - 0.3 * n.exhaustion
            + 3 * least(3, game.alliance_size(p_id))
            - 5 * (select count(*) from game.territories where owner_id = p_id and controller_id <> p_id)
            - case when n.treasury = 0 and v_gross - v_rs - v_inf - v_up_units - v_up_bld - v_stipend < 0 then 15 else 0 end;
  return jsonb_build_object(
    'gross', round(v_gross), 'territory', round(v_own * v_mult), 'occupied', round(v_occ * v_mult),
    'research', round(v_rs), 'infrastructure', round(v_inf),
    'upkeep_units', round(v_up_units), 'upkeep_buildings', round(v_up_bld), 'stipend', round(v_stipend),
    'net', round(v_gross - v_rs - v_inf - v_up_units - v_up_bld - v_stipend),
    'manpower', round(v_mp * v_stab), 'manpower_cap', round(v_mp * 24),
    'rp', round(v_rp, 1), 'wars', v_wars, 'mult', round(v_mult, 3),
    'stability_target', greatest(0, least(100, round(v_target, 1))));
end $$;

create function game.nation_economy(p_id text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  e jsonb;
  dt numeric;
  v_net numeric;
  v_tech game.techs;
  v_base numeric;
  v_left numeric;
begin
  select * into n from game.nations where id = p_id for update;
  dt := least(1.0, extract(epoch from now() - n.last_econ_at) / 3600.0);
  if dt <= 0 then return; end if;
  e := game.nation_income(p_id);
  v_net := (e ->> 'net')::numeric * dt;
  if n.treasury + v_net < 0 then
    -- Broke: unpaid troops desert.
    update game.garrisons set qty = floor(qty * (1 - 0.03 * dt)) where nation_id = p_id;
    update game.nations set treasury = 0 where id = p_id;
  else
    update game.nations set treasury = treasury + round(v_net)::bigint where id = p_id;
  end if;
  if (e ->> 'stipend')::numeric * dt >= 1 then
    perform game.money(n.leader_id, round((e ->> 'stipend')::numeric * dt)::bigint, 'stipend',
      'Leader''s stipend from ' || n.name, jsonb_build_object('nation', p_id), true);
  end if;
  -- Infrastructure raises development (and so income) in the homeland and annexed land.
  select sum(income) into v_base from game.territories where owner_id = p_id and controller_id = p_id;
  if coalesce(v_base, 0) > 0 then
    update game.territories set development = least(2, development + (e ->> 'infrastructure')::numeric * dt / (v_base * 40))
     where owner_id = p_id and controller_id = p_id;
  end if;
  update game.territories set damage = greatest(0, damage - 0.02 * dt) where owner_id = p_id and damage > 0;
  update game.nations set
    manpower = least((e ->> 'manpower_cap')::bigint, manpower + round((e ->> 'manpower')::numeric * dt)::bigint),
    research_bank = research_bank + (e ->> 'rp')::numeric * dt,
    stability = greatest(0, least(100, stability + ((e ->> 'stability_target')::numeric - stability) * least(1, dt / 2))),
    exhaustion = greatest(0, least(100, exhaustion + case when (e ->> 'wars')::int > 0 then 2 * (e ->> 'wars')::int else -4 end * dt)),
    income_h = (e ->> 'gross')::bigint,
    upkeep_h = (e ->> 'upkeep_units')::bigint + (e ->> 'upkeep_buildings')::bigint,
    last_econ_at = now()
  where id = p_id returning * into n;
  -- Research: the bank feeds the current project.
  if n.researching is not null then
    select * into v_tech from game.techs where id = n.researching;
    v_left := v_tech.cost - n.research_progress;
    if n.research_bank >= v_left then
      insert into game.nation_techs (nation_id, tech) values (p_id, v_tech.id) on conflict do nothing;
      update game.nations set research_bank = research_bank - v_left, research_progress = 0, researching = null where id = p_id;
      perform game.tell(p_id, 'nation', 'Research complete: ' || v_tech.name, v_tech.body, jsonb_build_object('tech', v_tech.id));
      perform game.leader_xp(p_id, 100 + v_tech.cost / 10, 'Research: ' || v_tech.name, 'techs');
    else
      update game.nations set research_progress = research_progress + research_bank, research_bank = 0 where id = p_id;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Starting fresh: the whole world, or one nation
-- ---------------------------------------------------------------------------
create function game.nation_start(p_id text, p_full boolean) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  t game.territories;
begin
  select * into t from game.territories where id = p_id;
  delete from game.nation_techs where nation_id = p_id;
  delete from game.recruit_queue where nation_id = p_id;
  delete from game.garrisons where territory_id = p_id;
  delete from game.facilities where territory_id = p_id;
  insert into game.facilities (territory_id, kind, level) values (p_id, 'barracks', 1);
  perform game.garrison_add(p_id, p_id, 'infantry', round(10 + 4 * sqrt(t.pop_m))::int);
  update game.territories set owner_id = p_id, controller_id = p_id, occupied_at = null, development = 1, damage = 0 where id = p_id;
  update game.nations set status = 'active', fallen_at = null,
    treasury = round(t.income * case when p_full then 8 else 4 end)::bigint,
    manpower = t.manpower * 12, research_bank = 0, researching = null, research_progress = 0,
    stability = 70, exhaustion = 0, tax = 'normal', research_pct = 15, infra_pct = 10,
    ai = '{}'::jsonb, last_econ_at = now(), next_think_at = now() + make_interval(secs => 60 + floor(random() * 240)::int)
  where id = p_id;
end $$;

-- Bring a fallen nation back (an AI one) in its homeland.
create function game.nation_revive(p_id text) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  if (select status from game.nations where id = p_id) = 'fallen' then
    perform game.nation_start(p_id, false);
  else
    update game.territories set owner_id = p_id, controller_id = p_id, occupied_at = null where id = p_id;
  end if;
end $$;

create function game.world_reset() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_gdp numeric;
  v_pop numeric;
  v_n int;
  v_t record;
begin
  select sum(gdp_bn), sum(pop_m), count(*) into v_gdp, v_pop, v_n from game.territories;
  update game.territories set
    income = round((800 + 120 * sqrt(gdp_bn)) * 1000)::bigint,
    manpower = round(200 + 60 * sqrt(pop_m))::int,
    militia = round(10 + 3 * sqrt(pop_m), 1),
    value = 0.5 * gdp_bn / v_gdp + 0.3 * pop_m / v_pop + 0.2 / v_n;
  -- Every country has a nation. Skill follows economic weight, with
  -- surprises; personality is fixed per country.
  insert into game.nations (id, name, color, ai_skill, personality)
  select t.id, t.name, t.color,
    greatest(1, least(5, case when r <= 12 then 5 when r <= 32 then 4 when r <= 70 then 3 when r <= 120 then 2 else 1 end
      + case when abs(hashtext(t.id)) % 100 < 12 then 1 when abs(hashtext(t.id)) % 100 > 88 then -1 else 0 end)),
    case when abs(hashtext(t.id || 'p')) % 100 < 18 then 'aggressive'
         when abs(hashtext(t.id || 'p')) % 100 < 36 then 'expansionist'
         when abs(hashtext(t.id || 'p')) % 100 < 56 then 'balanced'
         when abs(hashtext(t.id || 'p')) % 100 < 71 then 'defensive'
         when abs(hashtext(t.id || 'p')) % 100 < 86 then 'diplomatic'
         else 'mercantile' end
  from (select *, rank() over (order by gdp_bn desc) r from game.territories) t
  on conflict (id) do nothing;
  delete from game.movements;
  delete from game.diplo_offers;
  delete from game.war_sides;
  update game.wars set status = 'ended', ended_at = now(), outcome = coalesce(outcome, 'A new era began') where status = 'active';
  delete from game.treaties;
  delete from game.relations;
  delete from game.alliance_members;
  delete from game.alliances;
  delete from game.garrisons;
  delete from game.recruit_queue;
  delete from game.facilities;
  for v_t in select id from game.territories loop
    perform game.nation_start(v_t.id, true);
  end loop;
  update game.nations set protected_until = now() + interval '24 hours' where leader_id is not null;
  update game.eras set ended_at = coalesce(ended_at, now()) where ended_at is null;
  insert into game.eras (number, started_at, ends_at)
  values (coalesce((select max(number) from game.eras), 0) + 1, now(), now() + interval '90 days');
  update game.nations set income_h = (game.nation_income(id) ->> 'gross')::bigint where status = 'active';
  perform game.world_scores();
end $$;

-- ---------------------------------------------------------------------------
-- Choosing a country (first come, first served)
-- ---------------------------------------------------------------------------
create function game.skill_name(p_skill int) returns text
language sql immutable as $$ select (array['Novice', 'Cautious', 'Capable', 'Shrewd', 'Mastermind'])[p_skill] $$;

-- Hand a country back to the AI, or give it a fresh start for a new leader.
create function game.nation_release(p_id text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  w record;
  t record;
  v_prev_owner text;
  v_prev_ctrl text;
begin
  -- Its wars end: as war leader, with a white peace; otherwise it just leaves.
  for w in select s.war_id, x.attacker_id, x.defender_id from game.war_sides s join game.wars x on x.id = s.war_id
            where s.nation_id = p_id and x.status = 'active' loop
    if w.attacker_id = p_id or w.defender_id = p_id then
      perform game.end_war(w.war_id, 'white', null, 'A new government made peace');
    else
      delete from game.war_sides where war_id = w.war_id and nation_id = p_id;
    end if;
  end loop;
  perform game.leave_alliance_internal(p_id);
  delete from game.movements where nation_id = p_id;
  delete from game.recruit_queue where nation_id = p_id;
  delete from game.garrisons where nation_id = p_id;
  delete from game.diplo_offers where from_id = p_id or to_id = p_id;
  delete from game.treaties where a = p_id or b = p_id;
  delete from game.relations where a = p_id or b = p_id;
  -- Land it held that isn't its homeland goes back to its own people.
  for t in select id, owner_id from game.territories where (owner_id = p_id or controller_id = p_id) and id <> p_id loop
    update game.territories set controller_id = owner_id, occupied_at = null where id = t.id and controller_id = p_id and owner_id <> p_id;
    if t.owner_id = p_id then perform game.nation_revive(t.id); end if;
  end loop;
  -- The homeland comes back, whoever (AI) holds it.
  select owner_id, controller_id into v_prev_owner, v_prev_ctrl from game.territories where id = p_id;
  delete from game.garrisons where territory_id = p_id;
  perform game.nation_start(p_id, true);
  if v_prev_owner <> p_id then perform game.check_fallen(v_prev_owner); end if;
  if v_prev_ctrl <> p_id and v_prev_ctrl <> v_prev_owner then perform game.check_fallen(v_prev_ctrl); end if;
end $$;

create function public.claim_nation(p_id text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations;
  v_holder game.nations;
begin
  perform game.rate_limit(p.id::text, 'claim_nation', 3, 2);
  if exists (select 1 from game.nations where leader_id = p.id) then
    perform game.fail('You already lead a country. Step down first to pick another.');
  end if;
  if (p.prefs ->> 'abdicated_at') is not null and (p.prefs ->> 'abdicated_at')::timestamptz > now() - interval '12 hours' then
    perform game.fail('You stepped down recently. You can lead a country again 12 hours after stepping down.');
  end if;
  select * into n from game.nations where id = p_id for update;
  if not found then perform game.fail('No such country.'); end if;
  if n.leader_id is not null then perform game.fail(n.name || ' already has a leader. Pick another country.'); end if;
  select h.* into v_holder from game.territories t join game.nations h on h.id = t.owner_id where t.id = p_id;
  if v_holder.id <> p_id and v_holder.leader_id is not null then
    perform game.fail(format('%s has been conquered by %s, a player-led nation.', n.name, v_holder.name));
  end if;
  perform game.nation_release(p_id);
  update game.nations set leader_id = p.id, leader_since = now(), protected_until = now() + interval '24 hours' where id = p_id
  returning * into n;
  perform game.news('leader', format('%s now leads %s', p.display_name, n.name),
    'A new government has taken office. The world will be watching.', array[p_id]);
  perform game.grant_xp(p.id, 100, 'Took office in ' || n.name);
  return jsonb_build_object('nation', n.id, 'name', n.name, 'protected_until', n.protected_until);
end $$;

create function public.abdicate() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations;
begin
  select * into n from game.nations where leader_id = p.id for update;
  if not found then perform game.fail('You don''t lead a country.'); end if;
  update game.nations set leader_id = null, leader_since = null, protected_until = null,
    next_think_at = now() + interval '2 minutes' where id = n.id;
  update game.players set prefs = prefs || jsonb_build_object('abdicated_at', now()) where id = p.id;
  perform game.news('leader', format('%s has stepped down in %s', p.display_name, n.name), 'The country is run by its civil service (the AI) for now.', array[n.id]);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Running your nation
-- ---------------------------------------------------------------------------
create function game.my_nation_row(p game.players) returns game.nations
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
begin
  select * into n from game.nations where leader_id = p.id for update;
  if not found then perform game.fail('Pick a country to lead first.'); end if;
  if n.status = 'fallen' then perform game.fail(n.name || ' has fallen. Pick a new country to lead.'); end if;
  return n;
end $$;

create function game.check_unlock(p_nation text, p_key text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v uuid := (select leader_id from game.nations where id = p_nation);
begin
  if v is not null then perform game.require_level(v, p_key); end if;
end $$;

create function game.spend(p_nation text, p_amount bigint, p_what text) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  update game.nations set treasury = treasury - p_amount where id = p_nation and treasury >= p_amount;
  if not found then
    perform game.fail(format('The treasury can''t afford %s: it needs %s.', p_what, game.fmt(p_amount)));
  end if;
end $$;

-- Shared by players and the AI: same rules, same costs.
create function game.do_recruit(p_nation text, p_territory text, p_unit text, p_qty int) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  t game.territories;
  u game.unit_types;
  v_lvl int;
  v_cost bigint;
  v_mp bigint;
  v_min numeric;
  v_q game.recruit_queue;
begin
  select * into t from game.territories where id = p_territory;
  if not found or t.owner_id <> p_nation or t.controller_id <> p_nation then
    perform game.fail('You can only recruit in territory you own and hold.');
  end if;
  select * into u from game.unit_types where id = p_unit;
  if not found then perform game.fail('Unknown unit.'); end if;
  perform game.check_unlock(p_nation, u.unlock);
  if not game.has_tech(p_nation, u.tech) then
    perform game.fail(format('Research %s first.', (select name from game.techs where id = u.tech)));
  end if;
  v_lvl := game.blevel(p_territory, u.building);
  if v_lvl < 1 then perform game.fail(format('Build a %s here first.', lower((select name from game.facility_types where id = u.building)))); end if;
  if p_qty < 1 or p_qty > 20 * v_lvl then perform game.fail(format('Orders here are 1 to %s.', 20 * v_lvl)); end if;
  if (select count(*) from game.recruit_queue q join game.unit_types x on x.id = q.unit
       where q.territory_id = p_territory and q.nation_id = p_nation and x.building = u.building) >= v_lvl + 1 then
    perform game.fail('That building''s queue is full. Upgrade it for a longer queue.');
  end if;
  v_cost := round(u.cost * p_qty * (1 - 0.04 * game.leader_perk(p_nation, 'command')));
  v_mp := u.manpower * p_qty;
  if (select manpower from game.nations where id = p_nation) < v_mp then
    perform game.fail(format('Not enough manpower: you need %s.', v_mp));
  end if;
  perform game.spend(p_nation, v_cost, format('%s %s', p_qty, u.plural));
  update game.nations set manpower = manpower - v_mp where id = p_nation;
  v_min := u.minutes * (0.5 + p_qty / 40.0) / (1 + 0.15 * (v_lvl - 1));
  insert into game.recruit_queue (nation_id, territory_id, unit, qty, ready_at)
  values (p_nation, p_territory, p_unit, p_qty,
          greatest(now(), coalesce((select max(ready_at) from game.recruit_queue q join game.unit_types x on x.id = q.unit
                                     where q.territory_id = p_territory and q.nation_id = p_nation and x.building = u.building), now()))
          + make_interval(secs => round(v_min * 60)::int))
  returning * into v_q;
  perform game.leader_xp(p_nation, least(100, p_qty * 2), 'Recruited ' || u.plural, 'recruited', p_qty);
  return jsonb_build_object('id', v_q.id, 'ready_at', v_q.ready_at, 'cost', v_cost);
end $$;

create function game.do_build(p_nation text, p_territory text, p_kind text) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  t game.territories;
  bt game.facility_types;
  b game.facilities;
  v_next int;
  v_cost bigint;
begin
  select * into t from game.territories where id = p_territory;
  if not found or t.owner_id <> p_nation or t.controller_id <> p_nation then
    perform game.fail('You can only build in territory you own and hold.');
  end if;
  select * into bt from game.facility_types where id = p_kind;
  if not found then perform game.fail('Unknown building.'); end if;
  perform game.check_unlock(p_nation, bt.unlock);
  if not game.has_tech(p_nation, bt.tech) then
    perform game.fail(format('Research %s first.', (select name from game.techs where id = bt.tech)));
  end if;
  if bt.coastal and t.landlocked then perform game.fail(t.name || ' has no coast.'); end if;
  select * into b from game.facilities where territory_id = p_territory and kind = p_kind for update;
  if found and b.target is not null then perform game.fail('That is already being built.'); end if;
  if (select count(*) from game.facilities where territory_id = p_territory and target is not null) >= 2 then
    perform game.fail('Two projects at a time per territory.');
  end if;
  v_next := coalesce(b.level, 0) + 1;
  if v_next > bt.max_level then perform game.fail('Already at the top level.'); end if;
  v_cost := bt.cost * v_next * v_next;
  perform game.spend(p_nation, v_cost, bt.name);
  insert into game.facilities as x (territory_id, kind, level, target, ready_at)
  values (p_territory, p_kind, 0, v_next, now() + make_interval(mins => bt.minutes * v_next))
  on conflict (territory_id, kind) do update set target = excluded.target, ready_at = excluded.ready_at;
  return jsonb_build_object('kind', p_kind, 'level', v_next, 'cost', v_cost,
    'ready_at', now() + make_interval(mins => bt.minutes * v_next));
end $$;

create function game.do_research(p_nation text, p_tech text) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  v game.techs;
  n game.nations;
begin
  perform game.check_unlock(p_nation, 'research');
  select * into v from game.techs where id = p_tech;
  if not found then perform game.fail('Unknown technology.'); end if;
  if game.has_tech(p_nation, p_tech) then perform game.fail('Already researched.'); end if;
  if exists (select 1 from unnest(v.requires) r where not game.has_tech(p_nation, r)) then
    perform game.fail('Research what it needs first: ' || (select string_agg(name, ', ') from game.techs where id = any(v.requires)));
  end if;
  select * into n from game.nations where id = p_nation;
  -- Switching keeps the work done: it goes back in the bank.
  update game.nations set research_bank = research_bank + research_progress, research_progress = 0, researching = p_tech
   where id = p_nation;
  return jsonb_build_object('researching', p_tech);
end $$;

create function public.nation_recruit(p_territory text, p_unit text, p_qty int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
begin
  perform game.rate_limit(n.id, 'recruit', 20, 30);
  return game.do_recruit(n.id, p_territory, p_unit, p_qty);
end $$;

create function public.nation_build(p_territory text, p_kind text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
begin
  perform game.rate_limit(n.id, 'build', 10, 20);
  return game.do_build(n.id, p_territory, p_kind);
end $$;

create function public.nation_research(p_tech text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
begin
  return game.do_research(n.id, p_tech);
end $$;

create function public.nation_disband(p_territory text, p_unit text, p_qty int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
  v int;
begin
  select qty into v from game.garrisons where territory_id = p_territory and nation_id = n.id and unit = p_unit for update;
  if coalesce(v, 0) < p_qty or p_qty < 1 then perform game.fail('You don''t have that many there.'); end if;
  update game.garrisons set qty = qty - p_qty where territory_id = p_territory and nation_id = n.id and unit = p_unit;
  -- Half the manpower goes home.
  update game.nations set manpower = manpower + (select manpower from game.unit_types where id = p_unit) * p_qty / 2 where id = n.id;
  return jsonb_build_object('ok', true);
end $$;

create function public.nation_policy(p_tax text, p_research_pct int, p_infra_pct int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
begin
  if p_tax not in ('low', 'normal', 'high') then perform game.fail('Tax is low, normal or high.'); end if;
  if p_research_pct not between 0 and 60 or p_infra_pct not between 0 and 40 then perform game.fail('Those budget shares are out of range.'); end if;
  update game.nations set tax = p_tax, research_pct = p_research_pct, infra_pct = p_infra_pct where id = n.id;
  return jsonb_build_object('ok', true);
end $$;

-- Business money into the national treasury.
create function public.nation_invest(p_amount bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations := game.my_nation_row(p);
  r game.renown := game.renown_row(p.id);
  v_xp int;
  v_today date := (now() at time zone 'utc')::date;
begin
  perform game.rate_limit(p.id::text, 'invest', 10, 10);
  if p_amount < 1000 then perform game.fail('Invest at least $1.'); end if;
  perform game.money(p.id, -p_amount, 'nation_invest', 'Invested in ' || n.name, jsonb_build_object('nation', n.id));
  update game.nations set treasury = treasury + p_amount where id = n.id;
  perform game.count(p.id, 'invested', p_amount / 1000);
  -- XP: 1 per $100, at most 300 a day.
  if r.invest_day is distinct from v_today then
    update game.renown set invest_day = v_today, invest_xp = 0 where player_id = p.id;
    r.invest_xp := 0;
  end if;
  v_xp := least(300 - r.invest_xp, (p_amount / 100000)::int);
  if v_xp > 0 then
    update game.renown set invest_xp = invest_xp + v_xp where player_id = p.id;
    perform game.grant_xp(p.id, v_xp, 'Invested in ' || n.name);
  end if;
  return jsonb_build_object('treasury', n.treasury + p_amount);
end $$;

-- Crate prizes that go to your nation.
create or replace function game.crate_nation_reward(p_player uuid, p_kind text, p_amount bigint) returns text
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
begin
  select * into n from game.nations where leader_id = p_player and status = 'active';
  if not found then return null; end if;
  if p_kind = 'research' then
    update game.nations set research_bank = research_bank + p_amount where id = n.id;
    return format('%s research for %s', p_amount, n.name);
  elsif p_kind = 'troops' then
    if (select controller_id from game.territories where id = n.id) <> n.id then return null; end if;
    perform game.garrison_add(n.id, n.id, 'infantry', p_amount::int);
    return format('%s infantry in %s', p_amount, n.name);
  elsif p_kind = 'funds' then
    update game.nations set treasury = treasury + p_amount where id = n.id;
    return format('%s for the treasury of %s', game.fmt(p_amount), n.name);
  end if;
  return null;
end $$;
