-- Your country, your money.
--
-- Before, a player-led country had its own treasury: building bases,
-- recruiting and research never touched the leader's cash, so it felt free.
-- Now a player-led country runs on its leader's money:
--   * taxes (after the research and infrastructure budgets) are paid to the
--     leader as income every minute;
--   * army and base upkeep is charged to the leader every minute (if it
--     can't be paid, troops desert);
--   * recruiting, construction, envoys and research are paid from the
--     leader's cash, through the ledger like everything else;
--   * research now has a price ($20 per research point), paid when you start it.
-- AI countries keep their treasuries. Minefields join the military buildings.

insert into game.ledger_kinds (kind, label, flow) values
  ('nation_income', 'Taxes from your country', 'world_in'),
  ('military', 'Military spending', 'world_out'),
  ('military_upkeep', 'Army and base upkeep', 'world_out'),
  ('research', 'Research', 'world_out'),
  ('reparations', 'War payments', 'transfer')
on conflict (kind) do nothing;

-- What a country can spend: its leader's cash, or an AI treasury.
create function game.nation_funds(p_nation text) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select p.cash from game.nations n join game.players p on p.id = n.leader_id where n.id = p_nation),
                  (select treasury from game.nations where id = p_nation), 0)
$$;

-- Take up to p_amount (never more than there is); returns what was taken.
create function game.take_funds(p_nation text, p_amount bigint, p_memo text) returns bigint
language plpgsql set search_path = game, pg_temp as $$
declare
  v_leader uuid := (select leader_id from game.nations where id = p_nation);
  v bigint := greatest(0, least(coalesce(p_amount, 0), game.nation_funds(p_nation)));
begin
  if v <= 0 then return 0; end if;
  if v_leader is not null then
    perform game.money(v_leader, -v, 'reparations', p_memo);
  else
    update game.nations set treasury = treasury - v where id = p_nation;
  end if;
  return v;
end $$;

create function game.give_funds(p_nation text, p_amount bigint, p_memo text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_leader uuid := (select leader_id from game.nations where id = p_nation);
begin
  if coalesce(p_amount, 0) <= 0 then return; end if;
  if v_leader is not null then
    perform game.money(v_leader, p_amount, 'reparations', p_memo);
  else
    update game.nations set treasury = treasury + p_amount where id = p_nation;
  end if;
end $$;

-- Spending: a player-led country pays from its leader's cash.
create or replace function game.spend(p_nation text, p_amount bigint, p_what text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_leader uuid := (select leader_id from game.nations where id = p_nation);
  v_cash bigint;
begin
  if v_leader is not null then
    select cash into v_cash from game.players where id = v_leader;
    if v_cash < p_amount then
      perform game.fail(format('You can''t afford %s: it costs %s and you have %s.', p_what, game.fmt(p_amount), game.fmt(v_cash)));
    end if;
    perform game.money(v_leader, -p_amount, 'military', initcap(p_what), jsonb_build_object('nation', p_nation));
    return;
  end if;
  update game.nations set treasury = treasury - p_amount where id = p_nation and treasury >= p_amount;
  if not found then
    perform game.fail(format('The treasury can''t afford %s: it needs %s.', p_what, game.fmt(p_amount)));
  end if;
end $$;

-- The hourly economy. Player-led: taxes to the leader, upkeep from them.
create or replace function game.nation_economy(p_id text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  e jsonb;
  dt numeric;
  v_net numeric;
  v_pay numeric;
  v_upkeep numeric;
  v_tech game.techs;
  v_base numeric;
  v_left numeric;
begin
  select * into n from game.nations where id = p_id for update;
  dt := least(1.0, extract(epoch from now() - n.last_econ_at) / 3600.0);
  if dt <= 0 then return; end if;
  e := game.nation_income(p_id);
  if n.leader_id is not null then
    -- What the country pays its leader: taxes after the research and
    -- infrastructure budgets. Upkeep comes out of the leader's cash.
    v_pay := ((e ->> 'gross')::numeric - (e ->> 'research')::numeric - (e ->> 'infrastructure')::numeric) * dt;
    v_upkeep := ((e ->> 'upkeep_units')::numeric + (e ->> 'upkeep_buildings')::numeric) * dt;
    if round(v_pay) >= 1 then
      perform game.money(n.leader_id, round(v_pay)::bigint, 'nation_income', 'Taxes from ' || n.name, jsonb_build_object('nation', p_id), true);
    end if;
    if round(v_upkeep) >= 1 and not game.try_money(n.leader_id, -round(v_upkeep)::bigint, 'military_upkeep', 'Upkeep in ' || n.name, jsonb_build_object('nation', p_id), true) then
      -- Unpaid troops desert.
      update game.garrisons set qty = floor(qty * (1 - 0.03 * dt)) where nation_id = p_id;
    end if;
    -- Anything left in an old treasury goes to the leader.
    if n.treasury > 0 then
      perform game.money(n.leader_id, n.treasury, 'nation_income', 'Treasury of ' || n.name, jsonb_build_object('nation', p_id));
      update game.nations set treasury = 0 where id = p_id;
    end if;
  else
    v_net := (e ->> 'net')::numeric * dt;
    if n.treasury + v_net < 0 then
      update game.garrisons set qty = floor(qty * (1 - 0.03 * dt)) where nation_id = p_id;
      update game.nations set treasury = 0 where id = p_id;
    else
      update game.nations set treasury = treasury + round(v_net)::bigint where id = p_id;
    end if;
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

-- Research has a price, paid once per technology when you start it.
create table game.research_paid (
  nation_id text not null references game.nations(id) on delete cascade,
  tech text not null references game.techs(id),
  primary key (nation_id, tech)
);
alter table game.research_paid enable row level security;
revoke all on game.research_paid from public, anon, authenticated;

create function game.research_price(p_tech text) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select cost::bigint * 20000 from game.techs where id = p_tech
$$;

create or replace function game.do_research(p_nation text, p_tech text) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  v game.techs;
  v_price bigint := 0;
begin
  perform game.check_unlock(p_nation, 'research');
  select * into v from game.techs where id = p_tech;
  if not found then perform game.fail('Unknown technology.'); end if;
  if game.has_tech(p_nation, p_tech) then perform game.fail('Already researched.'); end if;
  if exists (select 1 from unnest(v.requires) r where not game.has_tech(p_nation, r)) then
    perform game.fail('Research what it needs first: ' || (select string_agg(name, ', ') from game.techs where id = any(v.requires)));
  end if;
  -- A player pays for each technology once, from their own cash. AI
  -- governments already fund research from their budget, so it's free for them.
  if (select leader_id from game.nations where id = p_nation) is not null
     and not exists (select 1 from game.research_paid where nation_id = p_nation and tech = p_tech) then
    v_price := game.research_price(p_tech);
    perform game.spend(p_nation, v_price, 'research into ' || v.name);
    insert into game.research_paid (nation_id, tech) values (p_nation, p_tech);
  end if;
  -- Switching keeps the work done: it goes back in the bank.
  update game.nations set research_bank = research_bank + research_progress, research_progress = 0, researching = p_tech
   where id = p_nation;
  return jsonb_build_object('researching', p_tech, 'paid', v_price);
end $$;

-- A fresh start (claiming, a new era) also clears what was paid for.
create or replace function game.nation_start(p_id text, p_full boolean) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  t game.territories;
begin
  select * into t from game.territories where id = p_id;
  delete from game.nation_techs where nation_id = p_id;
  delete from game.research_paid where nation_id = p_id;
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

-- A new leader's country starts with an empty treasury: they fund it.
create or replace function game.claim_clear_treasury() returns trigger
language plpgsql set search_path = game, pg_temp as $$
begin
  if new.leader_id is not null and (old.leader_id is distinct from new.leader_id) then
    new.treasury := 0;
  end if;
  return new;
end $$;
create trigger nation_claim_treasury before update of leader_id on game.nations
for each row execute function game.claim_clear_treasury();

-- Investing is no longer needed: the country already spends your money.
create or replace function public.nation_invest(p_amount bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin
  perform game.fail('Your country already spends your own money directly. There''s nothing to transfer.');
  return null;
end $$;

-- Crate prizes for your nation's funds now go to you.
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
    perform game.money(p_player, p_amount, 'renown_reward', 'War chest for ' || n.name);
    return format('%s war chest for %s', game.fmt(p_amount), n.name);
  end if;
  return null;
end $$;

-- Minefields: each level destroys 6% of attacking ground forces before the battle.
insert into game.facility_types (id, name, body, icon, max_level, cost, minutes, upkeep, unlock, tech, coastal, sort) values
  ('minefield', 'Minefield', 'Each level destroys 6% of attacking infantry, artillery and armour before the battle.', 'minefield', 3, 2500000, 6, 15000, 'fort', null, false, 4)
on conflict (id) do nothing;

-- Income per hour for the HUD's ticking counter: sales and other income in
-- the last hour, plus your country's taxes, minus its upkeep, right now.
create or replace function public.my_income() returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v_n text := game.player_nation(p.id);
  e jsonb;
  v_biz bigint;
  v_nation bigint := 0;
begin
  select coalesce(sum(amount), 0) into v_biz from game.ledger
   where player_id = p.id and kind in ('sales', 'npc_rent', 'rent_income', 'perk_bonus') and at > now() - interval '1 hour';
  if v_n is not null then
    e := game.nation_income(v_n);
    v_nation := (e ->> 'gross')::bigint - (e ->> 'research')::bigint - (e ->> 'infrastructure')::bigint
              - (e ->> 'upkeep_units')::bigint - (e ->> 'upkeep_buildings')::bigint;
  end if;
  return jsonb_build_object('per_hour', v_biz + v_nation, 'business', v_biz, 'nation', v_nation);
end $$;
create or replace function game.end_war(p_war bigint, p_terms text, p_winner text, p_outcome text, p_amount bigint default 0) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  w game.wars;
  t record;
  a text;
  b text;
  v_loser_lead text;
  v_win_lead text;
  v_pay bigint;
  v_outcome text;
  v_taken int := 0;
begin
  select * into w from game.wars where id = p_war for update;
  if not found or w.status <> 'active' then return; end if;
  v_win_lead := case p_winner when 'att' then w.attacker_id when 'def' then w.defender_id end;
  v_loser_lead := case p_winner when 'att' then w.defender_id when 'def' then w.attacker_id end;
  -- Occupied land changes hands or goes back.
  for t in select tt.id, tt.owner_id, tt.controller_id, cs.side as occ_side
             from game.territories tt
             join game.war_sides os on os.war_id = p_war and os.nation_id = tt.owner_id
             join game.war_sides cs on cs.war_id = p_war and cs.nation_id = tt.controller_id and cs.side <> os.side loop
    if p_terms in ('annex', 'surrender') and t.occ_side = p_winner then
      update game.territories set owner_id = t.controller_id, occupied_at = null where id = t.id;
      update game.facilities set level = greatest(0, level - 1), target = null, ready_at = null where territory_id = t.id;
      v_taken := v_taken + 1;
    else
      perform game.send_home(t.id, t.controller_id);
      update game.territories set controller_id = owner_id, occupied_at = null where id = t.id;
    end if;
  end loop;
  -- Payments come from a player-led country's leader (their own money) or
  -- an AI country's treasury.
  if p_terms = 'reparations' and v_loser_lead is not null and p_amount > 0 then
    v_pay := game.take_funds(v_loser_lead, least(p_amount, game.nation_funds(v_loser_lead) / 2), 'Reparations to ' || game.nation_name(v_win_lead));
    perform game.give_funds(v_win_lead, v_pay, 'Reparations from ' || game.nation_name(v_loser_lead));
  elsif p_terms = 'surrender' and v_loser_lead is not null then
    v_pay := game.take_funds(v_loser_lead, game.nation_funds(v_loser_lead) / 4, 'Surrender to ' || game.nation_name(v_win_lead));
    perform game.give_funds(v_win_lead, v_pay, 'Surrender of ' || game.nation_name(v_loser_lead));
  end if;
  -- Truces between everyone on opposite sides.
  for a, b in select x.nation_id, y.nation_id from game.war_sides x join game.war_sides y on y.war_id = x.war_id and x.side = 'att' and y.side = 'def'
               where x.war_id = p_war loop
    perform game.add_treaty('truce', a, b, 24);
    perform game.rel_add(a, b, 15);
  end loop;
  if v_loser_lead is not null and p_terms <> 'white' then
    update game.nations set stability = greatest(0, stability - 10) where id in (select nation_id from game.war_sides where war_id = p_war and side <> p_winner);
  end if;
  v_outcome := coalesce(p_outcome, case p_terms
    when 'white' then 'White peace: everyone goes home'
    when 'annex' then format('%s takes the land it holds (%s territories)', game.nation_name(v_win_lead), v_taken)
    when 'reparations' then format('%s is paid %s', game.nation_name(v_win_lead), game.fmt(coalesce(v_pay, 0)))
    when 'surrender' then format('%s surrenders to %s', game.nation_name(v_loser_lead), game.nation_name(v_win_lead))
    else 'Peace' end);
  update game.wars set status = 'ended', ended_at = now(), outcome = v_outcome, score = game.war_score(p_war) where id = p_war;
  update game.diplo_offers set status = 'expired' where war_id = p_war and status = 'open';
  for a in select nation_id from game.war_sides where war_id = p_war loop
    perform game.leader_xp(a, 80, 'Peace: ' || w.name, 'treaties');
    perform game.tell(a, 'war', 'Peace: ' || w.name, v_outcome, jsonb_build_object('war', p_war));
  end loop;
  perform game.news('peace', 'Peace: ' || w.name, v_outcome, array[w.attacker_id, w.defender_id], jsonb_build_object('war', p_war));
  for a in select nation_id from game.war_sides where war_id = p_war loop
    perform game.check_fallen(a);
  end loop;
end $$;
create or replace function game.arrive(p_id bigint) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  m game.movements;
  t game.territories;
  r jsonb;
  v_mines int;
  v_before jsonb;
  v_lost jsonb;
begin
  select * into m from game.movements where id = p_id and status = 'moving' for update skip locked;
  if not found then return; end if;
  select * into t from game.territories where id = m.to_t;
  if m.kind = 'missile' then
    r := game.missile_strike(m);
  elsif game.allied(m.nation_id, t.controller_id) then
    perform game.return_units(m.nation_id, m.to_t, m.units);
    r := jsonb_build_object('arrived', true);
  elsif game.at_war(m.nation_id, t.controller_id) and m.kind in ('attack', 'raid', 'move') then
    if m.kind = 'move' then m.kind := 'attack'; end if;
    -- Minefields: ground forces lose some of their number before the fight.
    v_mines := game.blevel(t.id, 'minefield');
    if v_mines > 0 and m.kind = 'attack' then
      v_before := m.units;
      select coalesce(jsonb_object_agg(key, case when key in ('infantry', 'armor', 'artillery') then floor(value::int * (1 - 0.06 * v_mines))::int else value::int end), '{}'::jsonb)
        into m.units from jsonb_each_text(v_before);
      v_lost := game.units_minus(v_before, m.units);
      if exists (select 1 from jsonb_each_text(v_lost) where value::int > 0) then
        perform game.tell(m.nation_id, 'battle', 'Minefields at ' || t.name, 'Your troops lost ' || game.units_text(v_lost) || ' crossing the minefields.');
        perform game.tell(t.controller_id, 'battle', 'Your minefields struck at ' || t.name, 'The enemy lost ' || game.units_text(v_lost) || ' before the battle.');
      end if;
    end if;
    r := game.battle(m);
  else
    -- Peace broke out on the way: back home.
    perform game.return_units(m.nation_id, m.from_t, m.units);
    r := jsonb_build_object('returned', true);
  end if;
  update game.movements set status = 'done', result = r where id = m.id;
end $$;

-- Countries already led by a player: their treasury goes to the leader.
do $$
declare
  n record;
begin
  for n in select id, leader_id, treasury, name from game.nations where leader_id is not null and treasury > 0 loop
    perform game.money(n.leader_id, n.treasury, 'nation_income', 'Treasury of ' || n.name, jsonb_build_object('nation', n.id));
    update game.nations set treasury = 0 where id = n.id;
  end loop;
end $$;

-- Your country's screen: your cash, and which research is already paid for.
create or replace function public.my_nation() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  n game.nations;
  v_level int := game.player_level(p.id);
begin
  select * into n from game.nations where leader_id = p.id;
  if not found then
    return jsonb_build_object('nation', null, 'free', (select count(*) from game.nations where leader_id is null));
  end if;
  return jsonb_build_object(
    'nation', jsonb_build_object('id', n.id, 'name', n.name, 'color', n.color, 'treasury', p.cash, 'manpower', n.manpower,
      'research_bank', round(n.research_bank, 1), 'researching', n.researching, 'research_progress', round(n.research_progress, 1),
      'stability', round(n.stability, 1), 'exhaustion', round(n.exhaustion, 1), 'tax', n.tax, 'research_pct', n.research_pct,
      'infra_pct', n.infra_pct, 'protected_until', case when n.protected_until > now() then n.protected_until end,
      'power', n.power, 'share', round(n.share * 100, 2), 'leader_since', n.leader_since, 'status', n.status),
    'income', game.nation_income(n.id),
    'level', v_level,
    'territories', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'owned', t.owner_id = n.id, 'held', t.controller_id = n.id, 'owner', t.owner_id, 'controller', t.controller_id,
        'landlocked', t.landlocked, 'development', round(t.development, 3), 'damage', round(t.damage, 3), 'militia', t.militia,
        'defence', round(game.defence_power(t.id, null)),
        'garrison', (select coalesce(jsonb_object_agg(unit, qty), '{}'::jsonb) from game.garrisons where territory_id = t.id and nation_id = n.id and qty > 0),
        'allies', (select coalesce(jsonb_agg(jsonb_build_object('nation', nation_id, 'unit', unit, 'qty', qty)), '[]'::jsonb)
                     from game.garrisons where territory_id = t.id and nation_id <> n.id and qty > 0),
        'buildings', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'level', level, 'target', target, 'ready_at', ready_at)), '[]'::jsonb)
                        from game.facilities where territory_id = t.id),
        'queue', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'unit', unit, 'qty', qty, 'ready_at', ready_at) order by ready_at), '[]'::jsonb)
                    from game.recruit_queue where territory_id = t.id and nation_id = n.id),
        'neighbours', (select coalesce(jsonb_agg(jsonb_build_object('id', l.b, 'kind', l.kind, 'km', l.km, 'controller', x.controller_id)), '[]'::jsonb)
                         from game.territory_links l join game.territories x on x.id = l.b where l.a = t.id)
      ) order by (t.id = n.id) desc, t.value desc), '[]'::jsonb)
      from game.territories t where t.owner_id = n.id or t.controller_id = n.id
         or exists (select 1 from game.garrisons g where g.territory_id = t.id and g.nation_id = n.id and g.qty > 0)),
    'armies', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'from', from_t, 'to', to_t, 'units', units, 'kind', kind,
                 'depart_at', depart_at, 'arrive_at', arrive_at) order by arrive_at), '[]'::jsonb)
               from game.movements where nation_id = n.id and status = 'moving'),
    'incoming', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nation', m.nation_id, 'from', m.from_t, 'to', m.to_t, 'kind', m.kind,
                   'arrive_at', m.arrive_at, 'size', game.intel((select sum(value::int) from jsonb_each_text(m.units))::int)) order by m.arrive_at), '[]'::jsonb)
                 from game.movements m join game.territories t on t.id = m.to_t
                where m.status = 'moving' and m.kind <> 'move' and t.controller_id = n.id),
    'techs', (select jsonb_agg(jsonb_build_object('id', t.id, 'done', nt.tech is not null,
                'paid', exists (select 1 from game.research_paid rp where rp.nation_id = n.id and rp.tech = t.id),
                'available', nt.tech is null and not exists (select 1 from unnest(t.requires) r where not game.has_tech(n.id, r))) order by t.sort)
              from game.techs t left join game.nation_techs nt on nt.nation_id = n.id and nt.tech = t.id),
    'unlocks', (select jsonb_object_agg(key, level) from game.renown_unlocks),
    'wars', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'side', s.side, 'leader', n.id in (w.attacker_id, w.defender_id),
               'enemy_leader', case when s.side = 'att' then w.defender_id else w.attacker_id end,
               'score', round(case when s.side = 'att' then w.score else -w.score end), 'started_at', w.started_at,
               'allies', (select jsonb_agg(nation_id) from game.war_sides where war_id = w.id and side = s.side and nation_id <> n.id),
               'enemies', (select jsonb_agg(nation_id) from game.war_sides where war_id = w.id and side <> s.side),
               'wins', case when s.side = 'att' then w.att_wins else w.def_wins end,
               'losses', case when s.side = 'att' then w.def_wins else w.att_wins end) order by w.started_at), '[]'::jsonb)
             from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active' where s.nation_id = n.id),
    'alliance', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'founder', a.founder_id,
                   'members', (select jsonb_agg(nation_id order by joined_at) from game.alliance_members where alliance_id = a.id))
                 from game.alliances a where a.id = game.alliance_of(n.id)),
    'offers', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'from', o.from_id, 'to', o.to_id, 'war', o.war_id,
                 'terms', o.terms, 'incoming', o.to_id = n.id, 'created_at', o.created_at, 'expires_at', o.expires_at) order by o.created_at desc), '[]'::jsonb)
               from game.diplo_offers o where (o.to_id = n.id or o.from_id = n.id) and o.status = 'open' and o.expires_at > now()),
    'relations', (select coalesce(jsonb_agg(jsonb_build_object('nation', case when r.a = n.id then r.b else r.a end, 'score', round(r.score),
                    'they_denounced', case when r.a = n.id then r.rival_b else r.rival_a end,
                    'we_denounced', case when r.a = n.id then r.rival_a else r.rival_b end) order by r.score), '[]'::jsonb)
                  from game.relations r where r.a = n.id or r.b = n.id),
    'treaties', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'nation', case when a = n.id then b else a end, 'until', until)), '[]'::jsonb)
                 from game.treaties where (a = n.id or b = n.id) and until > now()),
    'battles', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'at', b.at, 'territory', b.territory_id, 'attacker', b.attacker_id,
                  'defender', b.defender_id, 'kind', b.kind, 'winner', b.winner, 'captured', b.captured, 'summary', b.summary,
                  'att_lost', b.att_lost, 'def_lost', b.def_lost, 'att_power', b.att_power, 'def_power', b.def_power) order by b.at desc), '[]'::jsonb)
                from (select * from game.battles where attacker_id = n.id or defender_id = n.id order by at desc limit 20) b));
end $$;
