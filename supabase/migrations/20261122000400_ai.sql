-- Nations, part 3: AI governments.
--
-- Every country without a human leader is run by an AI with a skill (1-5)
-- and a personality. Every few minutes it scores its options and takes the
-- best ones, using exactly the same functions, rules and costs as players.
-- Skill changes judgement, never the rules:
--   * low skill misjudges strength (a fixed per-pair error of up to ±40%),
--     keeps its army in the capital, recruits mostly infantry, picks the
--     cheapest research and forgets that a target's allies will join in;
--   * high skill sees strength accurately, moves troops to threatened
--     borders, builds forts where it is threatened, mixes unit types,
--     researches what the situation needs and counts allies.
-- Wars are never sudden: an AI denounces its target first (the target is
-- told), waits at least an hour, and declares only if the odds still favour
-- it by a margin set by its caution. It makes peace when exhaustion or the
-- war score says so.

create function game.ai_traits(p_personality text) returns jsonb
language sql immutable as $$
  select case p_personality
    when 'aggressive' then '{"aggr":0.9,"caution":0.25,"eco":0.3,"dip":0.2}'
    when 'expansionist' then '{"aggr":0.7,"caution":0.4,"eco":0.45,"dip":0.35}'
    when 'balanced' then '{"aggr":0.45,"caution":0.5,"eco":0.5,"dip":0.5}'
    when 'defensive' then '{"aggr":0.15,"caution":0.9,"eco":0.45,"dip":0.55}'
    when 'diplomatic' then '{"aggr":0.2,"caution":0.6,"eco":0.6,"dip":0.9}'
    else '{"aggr":0.25,"caution":0.6,"eco":0.9,"dip":0.6}' end::jsonb
$$;

-- A fixed misjudgement of x by n: up to ±40% at skill 1, none at 4 and 5.
create function game.ai_noise(p_n text, p_x text, p_skill int) returns numeric
language sql immutable as $$
  select 1 + ((abs(hashtext(p_n || '>' || p_x)) % 81) - 40) / 100.0 * greatest(0, 4 - p_skill) / 3.0
$$;

create function game.ai_hostility(p_n text, p_x text) returns numeric
language plpgsql stable set search_path = game, pg_temp as $$
declare
  v numeric;
begin
  if game.allied(p_n, p_x) then return 0; end if;
  if game.at_war(p_n, p_x) then return 1; end if;
  if (game.treaty(p_n, p_x)).id is not null then return 0.05; end if;
  v := game.rel(p_n, p_x);
  return case when v < -30 then 0.6 when v < 0 then 0.35 else 0.15 end;
end $$;

-- Nations whose land touches ours.
create function game.ai_neighbours(p_n text) returns setof text
language sql stable set search_path = game, pg_temp as $$
  select distinct t2.controller_id from game.territories t
    join game.territory_links l on l.a = t.id join game.territories t2 on t2.id = l.b
   where t.controller_id = p_n and t2.controller_id <> p_n
$$;

-- How threatened is one of our territories: hostile troops next door.
create function game.ai_border_threat(p_n text, p_t text, p_skill int) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select coalesce(sum(g.qty * (u.atk + u.def) / 2.0 * game.ai_hostility(p_n, g.nation_id) * game.ai_noise(p_n, g.nation_id, p_skill)), 0)
    from game.territory_links l join game.garrisons g on g.territory_id = l.b join game.unit_types u on u.id = g.unit
   where l.a = p_t and g.nation_id <> p_n and g.qty > 0
$$;

-- What our army could throw at an enemy (attack values, technology, perks).
create function game.attack_strength(p_n text) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select coalesce(sum(g.qty * u.atk * game.unit_mult(p_n, g.unit, 'atk')), 0)
    from game.garrisons g join game.unit_types u on u.id = g.unit where g.nation_id = p_n and g.unit <> 'missile'
$$;

-- How hard x's front line facing us is to break, as n judges it.
create function game.ai_front_defence(p_n text, p_x text, p_skill int) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select coalesce(min(game.defence_power(t.id, null)), 0) * game.ai_noise(p_n, p_x, p_skill)
       + coalesce((select sum(g.qty * u.def) from game.garrisons g join game.unit_types u on u.id = g.unit where g.nation_id = p_x), 0) * 0.25
    from game.territories t
   where t.controller_id = p_x
     and exists (select 1 from game.territory_links l join game.territories m on m.id = l.a where l.b = t.id and m.controller_id = p_n)
$$;

create function game.ai_remember(p_n text, p_key text, p_val jsonb) returns void
language sql set search_path = game, pg_temp as $$
  update game.nations set ai = ai || jsonb_build_object(p_key, p_val) where id = p_n
$$;

-- ---------------------------------------------------------------------------
-- Research: what this government values, and how well it chooses.
-- ---------------------------------------------------------------------------
create function game.ai_pick_tech(p_n text, p_skill int, p_personality text, p_threatened boolean, p_landlocked boolean) returns text
language sql stable set search_path = game, pg_temp as $$
  select t.id from game.techs t
   where not game.has_tech(p_n, t.id)
     and not exists (select 1 from unnest(t.requires) r where not game.has_tech(p_n, r))
     and not (p_landlocked and t.branch = 'sea')
   order by
     case when p_skill <= 2 then t.cost::numeric
     else -(
       (case t.branch
          when 'land' then case p_personality when 'aggressive' then 3 when 'expansionist' then 2.5 when 'defensive' then 1.5 else 1.2 end
          when 'air' then case p_personality when 'aggressive' then 2 when 'expansionist' then 2 else 1 end
          when 'sea' then case p_personality when 'mercantile' then 1.5 when 'expansionist' then 1.5 else 0.8 end
          when 'defence' then case p_personality when 'defensive' then 3 when 'diplomatic' then 1.5 else 0.8 end
          when 'economy' then case p_personality when 'mercantile' then 3 when 'diplomatic' then 2.5 when 'balanced' then 1.6 else 0.9 end
          else case p_personality when 'diplomatic' then 2 when 'aggressive' then 1.8 else 1.4 end end
        + case when p_threatened and t.branch in ('land', 'defence') then 1.5 else 0 end)
       / case when p_skill >= 4 then sqrt(t.cost / 300.0) else 1 end) end,
     t.sort
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- Recruiting: fill the gap between the army it has and the one it needs.
-- ---------------------------------------------------------------------------
create function game.ai_recruit(p_n text, p_skill int, p_gap numeric, p_aggr numeric, p_attack boolean default false) returns int
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  v_budget numeric;
  u record;
  v_t text;
  v_qty int;
  v_lvl int;
  v_orders int := 0;
  v_gap numeric := p_gap;
  v_mix jsonb;
  v_avail text[];
begin
  select * into n from game.nations where id = p_n;
  v_budget := n.treasury * (0.35 + 0.3 * p_aggr) - 2 * n.upkeep_h;
  if v_budget < 300000 or v_gap <= 0 then return 0; end if;
  select coalesce(array_agg(ut.id), '{}') into v_avail from game.unit_types ut
   where ut.id <> 'missile' and game.has_tech(p_n, ut.tech)
     and exists (select 1 from game.territories t where t.owner_id = p_n and t.controller_id = p_n and game.blevel(t.id, ut.building) >= 1);
  -- The mix: weaker governments mass infantry; stronger ones combine arms.
  v_mix := case
    when p_skill <= 2 then jsonb_build_object('infantry', case when 'artillery' = any(v_avail) then 0.85 else 1 end, 'artillery', 0.15)
    when p_attack then jsonb_build_object('armor', 0.45, 'artillery', 0.3, 'infantry', 0.25, 'air', 0.2, 'naval', 0.1)
    else jsonb_build_object('infantry', 0.4, 'armor', 0.35, 'artillery', 0.25, 'air', 0.2, 'naval', 0.1) end;
  for u in select ut.*, (v_mix ->> ut.id)::numeric w from game.unit_types ut
            where ut.id = any(v_avail) and v_mix ? ut.id order by (v_mix ->> ut.id)::numeric desc loop
    exit when v_gap <= 0 or v_orders >= 2;
    -- Where: the most threatened place that can train it (skill 3+), else the capital.
    select t.id into v_t from game.territories t
     where t.owner_id = p_n and t.controller_id = p_n and game.blevel(t.id, u.building) >= 1
       and (u.id <> 'naval' or not t.landlocked)
     order by case when p_skill >= 3 then -game.ai_border_threat(p_n, t.id, p_skill) else 0 end, (t.id = p_n) desc
     limit 1;
    continue when v_t is null;
    v_lvl := game.blevel(v_t, u.building);
    v_qty := least(20 * v_lvl,
                   floor(v_budget * u.w / u.cost)::int,
                   floor(n.manpower / greatest(1, u.manpower))::int,
                   ceil(v_gap / case when p_attack then greatest(u.atk, 0.5) else (u.atk + u.def) / 2.0 end)::int);
    continue when v_qty < 1;
    begin
      perform game.do_recruit(p_n, v_t, u.id, v_qty);
      v_orders := v_orders + 1;
      v_gap := v_gap - v_qty * case when p_attack then greatest(u.atk, 0.5) else (u.atk + u.def) / 2.0 end;
      select * into n from game.nations where id = p_n;
    exception when others then
      null; -- queue full or can't afford: try the next unit
    end;
  end loop;
  return v_orders;
end $$;

-- ---------------------------------------------------------------------------
-- Building: one project per think, the most useful one it can afford.
-- ---------------------------------------------------------------------------
create function game.ai_build(p_n text, p_skill int, p_tr jsonb, p_threat numeric, p_power numeric, p_wars int) returns text
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  v_cap text;
  v_border text;
  c record;
  v_cost bigint;
  v_eco numeric := (p_tr ->> 'eco')::numeric;
  v_caution numeric := (p_tr ->> 'caution')::numeric;
  v_enemy_air boolean;
begin
  select * into n from game.nations where id = p_n;
  if n.treasury < greatest(3000000, 4 * n.upkeep_h) then return null; end if;
  select id into v_cap from game.territories where owner_id = p_n and controller_id = p_n order by (id = p_n) desc, value desc limit 1;
  if v_cap is null then return null; end if;
  select t.id into v_border from game.territories t where t.owner_id = p_n and t.controller_id = p_n
   order by game.ai_border_threat(p_n, t.id, p_skill) desc limit 1;
  v_enemy_air := exists (select 1 from game.garrisons g where g.unit = 'air' and g.qty > 0 and g.nation_id in (select game.ai_neighbours(p_n))
                          and game.ai_hostility(p_n, g.nation_id) >= 0.35);
  for c in
    select * from (values
      (1, v_cap, 'barracks', least(5, 1 + p_skill)),
      (2, v_cap, 'factory', case when game.has_tech(p_n, 'artillery') or game.has_tech(p_n, 'armor') then least(3, p_skill) else 0 end),
      (3, v_border, 'fort', case when p_threat > p_power * 0.5 and (v_caution >= 0.5 or p_skill >= 3) then least(5, 1 + p_skill) else 0 end),
      (4, v_cap, 'lab', case when v_eco >= 0.5 and p_wars = 0 then least(5, 1 + round(v_eco * 4)::int) else 0 end),
      (5, v_cap, 'airbase', case when game.has_tech(p_n, 'aviation') and p_skill >= 3 then least(3, p_skill - 1) else 0 end),
      (6, v_cap, 'naval_base', case when game.has_tech(p_n, 'navy') and p_skill >= 3 then 2 else 0 end),
      (7, v_border, 'air_defence', case when game.has_tech(p_n, 'air_defence') and v_enemy_air and p_skill >= 3 then 2 else 0 end),
      (8, v_cap, 'silo', case when game.has_tech(p_n, 'missiles') and p_skill >= 4 then 1 else 0 end)
    ) v(prio, territory, kind, want)
    order by prio
  loop
    continue when c.territory is null or game.blevel(c.territory, c.kind) >= c.want;
    continue when exists (select 1 from game.facilities where territory_id = c.territory and kind = c.kind and target is not null);
    v_cost := (select cost from game.facility_types where id = c.kind) * power(game.blevel(c.territory, c.kind) + 1, 2)::bigint;
    continue when v_cost > n.treasury * 0.45;
    begin
      perform game.do_build(p_n, c.territory, c.kind);
      return c.kind;
    exception when others then
      null;
    end;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Deployment (skill 3+): move spare troops to the most threatened border.
-- ---------------------------------------------------------------------------
create function game.ai_deploy(p_n text, p_skill int, p_caution numeric) returns boolean
language plpgsql set search_path = game, pg_temp as $$
declare
  v_hi text;
  v_lo text;
  v_units jsonb;
begin
  -- The neediest of our territories: threat minus what's defending it.
  select t.id into v_hi from game.territories t where t.controller_id = p_n
   order by game.ai_border_threat(p_n, t.id, p_skill) - game.defence_power(t.id, null) desc limit 1;
  if v_hi is null or game.ai_border_threat(p_n, v_hi, p_skill) <= game.defence_power(v_hi, null) * 0.8 then return false; end if;
  -- The safest neighbouring territory of ours with troops to spare.
  select l.b into v_lo from game.territory_links l join game.territories t on t.id = l.b
   where l.a = v_hi and t.controller_id = p_n
     and exists (select 1 from game.garrisons g where g.territory_id = t.id and g.nation_id = p_n and g.unit in ('infantry', 'armor', 'artillery') and g.qty >= 4)
   order by game.ai_border_threat(p_n, t.id, p_skill) - game.defence_power(t.id, null) limit 1;
  if v_lo is null then return false; end if;
  select jsonb_object_agg(unit, floor(qty * (0.6 - 0.3 * p_caution))::int) into v_units
    from game.garrisons where territory_id = v_lo and nation_id = p_n and unit in ('infantry', 'armor', 'artillery') and floor(qty * (0.6 - 0.3 * p_caution)) >= 1;
  if v_units is null then return false; end if;
  perform game.do_send(p_n, v_lo, v_hi, v_units);
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- Fighting: attack where the odds (as this government sees them) are good.
-- ---------------------------------------------------------------------------
create function game.ai_attack(p_n text, p_skill int, p_caution numeric) returns int
language plpgsql set search_path = game, pg_temp as $$
declare
  c record;
  v_units jsonb;
  v_keep numeric;
  v_need numeric := 1.05 + 0.4 * p_caution + 0.05 * (p_skill - 3);
  v_n int := 0;
  v_ratio numeric;
  v_sent text[] := '{}';
begin
  for c in
    select f.id as f, x.id as x, x.owner_id, x.value, l.kind,
           game.defence_power(x.id, p_n) * game.ai_noise(p_n, x.id, p_skill) as est
      from game.territories f
      join game.territory_links l on l.a = f.id
      join game.territories x on x.id = l.b
     where f.controller_id = p_n and game.at_war(p_n, x.controller_id)
       and exists (select 1 from game.garrisons g where g.territory_id = f.id and g.nation_id = p_n and g.unit in ('infantry', 'armor', 'artillery', 'naval') and g.qty > 0)
     order by (x.owner_id = p_n) desc, x.value / greatest(1, game.defence_power(x.id, p_n) * game.ai_noise(p_n, x.id, p_skill)) desc
     limit 12
  loop
    exit when v_n >= 2;
    continue when c.f = any(v_sent);
    -- Keep some at home: more on a capital or a second front, more if cautious.
    v_keep := case when c.f = p_n or game.ai_border_threat(p_n, c.f, p_skill) > 0 then 0.2 + 0.3 * p_caution else 0.1 end;
    select jsonb_object_agg(unit, floor(qty * (1 - v_keep))::int) into v_units
      from game.garrisons where territory_id = c.f and nation_id = p_n and unit in ('infantry', 'armor', 'artillery', 'naval', 'air')
       and floor(qty * (1 - v_keep)) >= 1 and (unit <> 'naval' or not (select landlocked from game.territories where id = c.x));
    continue when v_units is null or not (v_units ?| array['infantry', 'armor', 'artillery', 'naval']);
    v_ratio := game.attack_power(p_n, v_units, c.f, c.x) / greatest(1, c.est);
    continue when v_ratio < v_need;
    begin
      perform game.do_send(p_n, c.f, c.x, v_units);
      v_n := v_n + 1;
      v_sent := v_sent || c.f;
    exception when others then
      null;
    end;
  end loop;
  -- Missiles at the biggest enemy garrison in range.
  if p_skill >= 3 then
    for c in
      select s.territory_id f, x.id x from game.garrisons s
        join game.territories ft on ft.id = s.territory_id
        join game.territories x on game.at_war(p_n, x.controller_id) and game.dist_m(ft.lat, ft.lng, x.lat, x.lng) <= 3000000
       where s.nation_id = p_n and s.unit = 'missile' and s.qty > 0 and ft.controller_id = p_n
       order by game.defence_power(x.id, p_n, false) desc limit 1
    loop
      begin
        perform game.do_missiles(p_n, c.f, c.x, (select qty from game.garrisons where territory_id = c.f and nation_id = p_n and unit = 'missile'));
      exception when others then null;
      end;
    end loop;
  end if;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Peace: when exhaustion or the war score says so.
-- ---------------------------------------------------------------------------
create function game.ai_peace(p_n text, p_aggr numeric) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  w record;
  v_sc numeric;
  v_age interval;
  v_terms text;
  v_holds boolean;
begin
  select * into n from game.nations where id = p_n;
  for w in select x.* from game.wars x where x.status = 'active' and p_n in (x.attacker_id, x.defender_id) loop
    continue when (n.ai ->> ('peace_' || w.id)) is not null and (n.ai ->> ('peace_' || w.id))::timestamptz > now() - interval '1 hour';
    v_sc := case when game.side_of(w.id, p_n) = 'att' then w.score else -w.score end;
    v_age := now() - w.started_at;
    v_holds := exists (select 1 from game.territories t where t.controller_id = p_n and t.owner_id <> p_n
                        and game.side_of(w.id, t.owner_id) is distinct from game.side_of(w.id, p_n));
    v_terms := case
      when v_sc <= -60 and ((select count(*) from game.territories where controller_id = p_n) <= 1 or n.exhaustion >= 80) then 'surrender'
      when v_sc >= 35 and v_holds and v_age > interval '30 minutes' then 'annex'
      when n.exhaustion >= 50 + 40 * p_aggr then 'white'
      when v_sc < -25 and v_age > interval '1 hour' then 'white'
      when v_age > interval '6 hours' and abs(v_sc) < 15 then 'white'
      else null end;
    continue when v_terms is null;
    perform game.ai_remember(p_n, 'peace_' || w.id, to_jsonb(now()));
    begin
      perform game.do_propose_peace(p_n, w.id, v_terms, 0);
    exception when others then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Choosing a war: denounce first, declare later, only with good odds.
-- ---------------------------------------------------------------------------
create function game.ai_war_plans(p_n text, p_skill int, p_tr jsonb, p_power numeric, p_wars int) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  v_aggr numeric := (p_tr ->> 'aggr')::numeric;
  v_caution numeric := (p_tr ->> 'caution')::numeric;
  v_need numeric := 1.3 + 0.8 * v_caution;
  v_best text;
  v_best_score numeric := 0;
  x record;
  v_est numeric;
  v_ratio numeric;
  v_rel game.relations;
begin
  select * into n from game.nations where id = p_n;
  if v_aggr < 0.4 or n.stability < 55 or p_wars >= (case when v_aggr >= 0.7 then 2 else 1 end) then return; end if;
  if (select count(*) from game.wars w join game.nations a on a.id = w.attacker_id where w.status = 'active' and a.leader_id is null) >= 15 then return; end if;
  for x in select y.* from game.nations y where y.id in (select game.ai_neighbours(p_n)) and y.status = 'active' loop
    continue when game.allied(p_n, x.id) or game.at_war(p_n, x.id) or (game.treaty(p_n, x.id)).id is not null
               or x.protected_until > now();
    v_est := game.ai_front_defence(p_n, x.id, p_skill);
    -- Shrewd governments remember the target's allies will join in.
    if p_skill >= 3 then
      v_est := v_est + coalesce((select sum(g.qty * u.def) * 0.3 from game.alliance_members m
                                   join game.garrisons g on g.nation_id = m.nation_id join game.unit_types u on u.id = g.unit
                                  where m.alliance_id = game.alliance_of(x.id) and m.nation_id <> x.id), 0);
    end if;
    v_ratio := p_power * 0.75 / greatest(1, v_est);
    continue when v_ratio < v_need;
    if v_ratio * (select sum(value) from game.territories where controller_id = x.id) > v_best_score then
      v_best := x.id;
      v_best_score := v_ratio * (select sum(value) from game.territories where controller_id = x.id);
    end if;
  end loop;
  if v_best is null then
    if (n.ai ->> 'target') is not null then update game.nations set ai = ai - 'target' where id = p_n; end if;
    return;
  end if;
  select * into v_rel from game.relations where a = least(p_n, v_best) and b = greatest(p_n, v_best);
  if (n.ai ->> 'target') is distinct from v_best then
    -- Step one: a denunciation (at most every 6 hours).
    if (n.ai ->> 'denounce_at') is null or (n.ai ->> 'denounce_at')::timestamptz < now() - interval '6 hours' then
      perform game.do_denounce(p_n, v_best);
      perform game.ai_remember(p_n, 'target', to_jsonb(v_best));
      perform game.ai_remember(p_n, 'denounce_at', to_jsonb(now()));
    end if;
  elsif (n.ai ->> 'denounce_at')::timestamptz < now() - interval '1 hour' and game.rel(p_n, v_best) < -10 then
    -- Step two, an hour or more later, if the odds still hold.
    perform game.do_declare(p_n, v_best);
    update game.nations set ai = ai - 'target' where id = p_n;
  end if;
end $$;

-- 1 when two nations share an enemy (at war with, or deeply hostile to).
create function game.ai_common_enemy(p_a text, p_b text) returns int
language sql stable set search_path = game, pg_temp as $$
  select case when exists (
    select 1 from (
      select case when r.a = p_a then r.b else r.a end as z from game.relations r where (r.a = p_a or r.b = p_a) and r.score <= -20
      union
      select y.nation_id from game.war_sides x join game.war_sides y on y.war_id = x.war_id and y.side <> x.side
        join game.wars w on w.id = x.war_id and w.status = 'active' where x.nation_id = p_a
    ) e
    where e.z <> p_b and (game.at_war(p_b, e.z) or game.rel(p_b, e.z) <= -20)) then 1 else 0 end
$$;

-- ---------------------------------------------------------------------------
-- Diplomacy: allies against common threats, envoys to strong neighbours,
-- pacts when outmatched.
-- ---------------------------------------------------------------------------
create function game.ai_diplomacy(p_n text, p_skill int, p_tr jsonb, p_threat numeric, p_power numeric) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  v_dip numeric := (p_tr ->> 'dip')::numeric;
  v_caution numeric := (p_tr ->> 'caution')::numeric;
  v_y text;
begin
  select * into n from game.nations where id = p_n;
  if (n.ai ->> 'diplo_at') is not null and (n.ai ->> 'diplo_at')::timestamptz > now() - interval '20 minutes' then return; end if;
  perform game.ai_remember(p_n, 'diplo_at', to_jsonb(now()));
  -- Alliances.
  if (p_threat > p_power * 0.8 or v_dip >= 0.5) and coalesce((select count(*) from game.alliance_members where alliance_id = game.alliance_of(p_n)), 0) < 6 then
    select y.id into v_y from game.nations y
     where y.id <> p_n and y.status = 'active' and game.alliance_of(y.id) is null
       and not game.at_war(p_n, y.id) and game.rel(p_n, y.id) >= 15 * (1 - v_dip) - 10 * game.ai_common_enemy(p_n, y.id)
       and not exists (select 1 from game.alliance_members m where m.alliance_id = game.alliance_of(p_n) and game.at_war(m.nation_id, y.id))
       and not exists (select 1 from game.diplo_offers o where o.kind = 'alliance' and o.from_id = p_n and o.to_id = y.id and o.created_at > now() - interval '12 hours')
     order by game.ai_common_enemy(p_n, y.id) desc, (y.id in (select game.ai_neighbours(p_n))) desc, game.rel(p_n, y.id) desc, y.power desc
     limit 1;
    if v_y is not null then
      begin
        perform game.make_offer('alliance', p_n, v_y, null, jsonb_build_object('name', n.name || ' Pact'));
      exception when others then null;
      end;
    end if;
  end if;
  -- Envoys to the strongest neighbour we aren't friends with.
  if v_dip >= 0.5 or v_caution >= 0.8 then
    select y.id into v_y from game.nations y
     where y.id in (select game.ai_neighbours(p_n)) and not game.at_war(p_n, y.id) and game.rel(p_n, y.id) < 30
     order by y.power desc limit 1;
    if v_y is not null and n.treasury > 20000000 then
      begin
        perform game.do_envoy(p_n, v_y);
      exception when others then null;
      end;
    end if;
  end if;
  -- A pact with the strongest hostile-looking neighbour when outmatched.
  if v_caution >= 0.6 and p_threat > p_power then
    select y.id into v_y from game.nations y
     where y.id in (select game.ai_neighbours(p_n)) and not game.at_war(p_n, y.id) and (game.treaty(p_n, y.id)).id is null
       and game.rel(p_n, y.id) >= -10 and not game.allied(p_n, y.id)
     order by y.power desc limit 1;
    if v_y is not null then
      begin
        perform game.make_offer('nap', p_n, v_y, null, '{}');
      exception when others then null;
      end;
    end if;
  end if;
end $$;

-- How an AI answers an offer.
create function game.ai_accepts(o game.diplo_offers) returns boolean
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  tr jsonb;
  w game.wars;
  v_side text;
  v_sc numeric;
  v_rel numeric;
  v_threat numeric;
  v_terms text := o.terms ->> 'terms';
  v_enemy_ex numeric;
begin
  select * into n from game.nations where id = o.to_id;
  tr := game.ai_traits(n.personality);
  v_rel := game.rel(o.to_id, o.from_id);
  if o.kind = 'alliance' then
    if game.alliance_of(o.to_id) is not null then return false; end if;
    v_threat := coalesce((select sum(game.military_power(x) * game.ai_hostility(o.to_id, x)) from game.ai_neighbours(o.to_id) x), 0);
    return v_rel >= 5 + 20 * (1 - (tr ->> 'dip')::numeric)
                    - case when v_threat > game.military_power(o.to_id) * 0.8 then 15 else 0 end
                    - 10 * game.ai_common_enemy(o.to_id, o.from_id);
  elsif o.kind = 'nap' then
    return not game.at_war(o.to_id, o.from_id) and v_rel >= -15 and (n.ai ->> 'target') is distinct from o.from_id
       and (tr ->> 'aggr')::numeric < 0.8;
  elsif o.kind = 'peace' then
    select * into w from game.wars where id = o.war_id;
    if w.status <> 'active' then return false; end if;
    v_side := game.side_of(w.id, o.to_id);
    v_sc := game.war_score(w.id) * case when v_side = 'att' then 1 else -1 end;
    v_enemy_ex := (select exhaustion from game.nations where id = o.from_id);
    if v_terms = 'white' then
      -- A shrewd winner holds out if the enemy is crumbling.
      if n.ai_skill >= 4 and v_sc > 0 and v_enemy_ex > n.exhaustion + 30 then return false; end if;
      return v_sc < 20 or n.exhaustion > 60 or (now() - w.started_at > interval '6 hours' and v_sc < 40);
    elsif v_terms = 'annex' then
      return o.terms ->> 'winner' = v_side or v_sc <= -30 or n.exhaustion >= 75;
    elsif v_terms = 'reparations' then
      return o.terms ->> 'winner' = v_side
          or (v_sc <= -15 and coalesce((o.terms ->> 'amount')::bigint, 0) <= n.treasury * 0.3);
    end if;
    return true;
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------------------
-- One turn of thinking for one AI government.
-- ---------------------------------------------------------------------------
create function game.ai_think(p_id text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  s int;
  tr jsonb;
  v_aggr numeric;
  v_caution numeric;
  v_eco numeric;
  v_wars int;
  e jsonb;
  v_power numeric;
  v_threat numeric;
  v_floor numeric;
  v_desired numeric;
  v_tech text;
  v_target text;
  v_atk_need numeric;
begin
  select * into n from game.nations where id = p_id for update;
  if n.leader_id is not null or n.status <> 'active' then return; end if;
  if not exists (select 1 from game.territories where controller_id = p_id) then return; end if;
  s := n.ai_skill;
  tr := game.ai_traits(n.personality);
  v_aggr := (tr ->> 'aggr')::numeric;
  v_caution := (tr ->> 'caution')::numeric;
  v_eco := (tr ->> 'eco')::numeric;
  v_wars := game.active_wars(p_id);
  e := game.nation_income(p_id);
  v_power := game.military_power(p_id);
  select coalesce(sum(game.military_power(x) * game.ai_noise(p_id, x, s) * game.ai_hostility(p_id, x)), 0) into v_threat
    from game.ai_neighbours(p_id) x;

  -- 1. Taxes and budget.
  update game.nations set
    tax = case when stability < 45 then 'low'
               when v_wars > 0 and treasury < 3 * upkeep_h then 'high'
               when stability > 80 and v_aggr >= 0.7 then 'high'
               else 'normal' end,
    research_pct = case when (e ->> 'net')::numeric < 0 and treasury < 6 * upkeep_h then 5
                        when v_wars > 0 then 10 else 10 + round(15 * v_eco)::int end,
    infra_pct = case when (e ->> 'net')::numeric < 0 or v_wars > 0 then 0
                     when s >= 3 and v_threat > v_power * 1.5 then 5 else 5 + round(15 * v_eco)::int end
  where id = p_id;

  -- 2. Research.
  if n.researching is null then
    v_tech := game.ai_pick_tech(p_id, s, n.personality, v_threat > v_power,
                                (select landlocked from game.territories where id = p_id));
    if v_tech is not null then perform game.do_research(p_id, v_tech); end if;
  end if;

  -- 3. The army it needs: enough for its threats (scaled by caution), more
  --    at war, and enough to win the war it is planning.
  -- A standing army worth a share of income in upkeep (bigger for hawks).
  v_floor := greatest(10 + 3 * sqrt((select coalesce(sum(gdp_bn), 0) from game.territories where controller_id = p_id)),
                      n.income_h * (0.12 + 0.15 * v_aggr) / 5333.0);
  v_desired := greatest(v_floor, v_threat * (0.7 + 0.6 * v_caution));
  if v_wars > 0 then v_desired := v_desired * 1.3; end if;
  if v_power < v_desired then
    perform game.ai_recruit(p_id, s, v_desired - v_power, v_aggr);
  end if;
  -- Preparing an offensive (a denounced target, or a war on): enough attack
  -- to break the enemy front by this government's margin.
  v_target := coalesce(n.ai ->> 'target',
    (select case when w.attacker_id = p_id then w.defender_id else w.attacker_id end from game.wars w
      where w.status = 'active' and p_id in (w.attacker_id, w.defender_id) order by w.started_at limit 1));
  if v_target is not null and v_aggr >= 0.4 then
    v_atk_need := game.ai_front_defence(p_id, v_target, s) * (1.3 + 0.8 * v_caution) / 0.75;
    if game.attack_strength(p_id) < v_atk_need then
      perform game.ai_recruit(p_id, s, v_atk_need - game.attack_strength(p_id), v_aggr, true);
    end if;
  end if;

  -- 4. One building project.
  perform game.ai_build(p_id, s, tr, v_threat, v_power, v_wars);

  -- 5. Deployment (skill 3+).
  if s >= 3 then
    begin
      perform game.ai_deploy(p_id, s, v_caution);
    exception when others then null;
    end;
  end if;

  -- 6. War: fight, make peace, or plan the next one.
  if v_wars > 0 then
    perform game.ai_attack(p_id, s, v_caution);
    perform game.ai_peace(p_id, v_aggr);
  end if;
  perform game.ai_war_plans(p_id, s, tr, game.attack_strength(p_id), v_wars);

  -- 7. Diplomacy.
  perform game.ai_diplomacy(p_id, s, tr, v_threat, v_power);

  update game.nations set next_think_at = now() + make_interval(secs => (60 * (2 + 6 - s) + floor(random() * 60))::int) where id = p_id;
end $$;
