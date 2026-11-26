-- The world never resets, and it fights back.
--
-- No more eras: nobody "wins" and the world is never wiped. Instead the AI
-- governments keep the biggest powers in check:
--   * Every five minutes each country gets a world rank. The top five are
--     everyone's preferred war targets: AI governments look at them first,
--     need slightly better odds to try (they count on others joining in),
--     won't sign pacts or alliances with a big one, and won't settle for an
--     easy peace.
--   * A country that has grown to 12% of the world (and at least 8 points
--     more than its own homeland is worth, so big countries aren't punished
--     for being big) faces a coalition: its AI neighbours band together
--     against it. At 25% (15 points of conquest) every AI joins. Members
--     stop fighting each other, join each other's wars against the target,
--     declare on it together, count each other's armies, refuse its
--     alliances and pacts, and run a war economy (+15% income). The
--     coalition disbands when the target falls back under 8% (or 4 points
--     above its homeland).
-- Conquering the world stays possible, but very hard.

-- Ends the current era (if any) without a reset; the table stays as history.
update game.eras set ended_at = now() where ended_at is null;

alter table game.nations add column if not exists world_rank int;

create table if not exists game.coalitions (
  id bigint generated always as identity primary key,
  target_id text not null references game.nations(id),
  formed_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists coalitions_active_idx on game.coalitions (target_id) where ended_at is null;
create table if not exists game.coalition_members (
  coalition_id bigint not null references game.coalitions(id) on delete cascade,
  nation_id text not null references game.nations(id),
  joined_at timestamptz not null default now(),
  primary key (coalition_id, nation_id)
);
create index if not exists coalition_members_nation_idx on game.coalition_members (nation_id);
alter table game.coalitions enable row level security;
alter table game.coalition_members enable row level security;
revoke all on game.coalitions, game.coalition_members from public, anon, authenticated;

-- The country p_n is in a coalition against (if any; the biggest target first).
create or replace function game.coalition_target(p_n text) returns text
language sql stable as $$
  select c.target_id from game.coalition_members m join game.coalitions c on c.id = m.coalition_id and c.ended_at is null
    join game.nations t on t.id = c.target_id
   where m.nation_id = p_n order by t.share desc limit 1
$$;

create or replace function game.in_coalition_against(p_n text, p_target text) returns boolean
language sql stable as $$
  select exists (select 1 from game.coalition_members m join game.coalitions c on c.id = m.coalition_id and c.ended_at is null
                  where m.nation_id = p_n and c.target_id = p_target)
$$;

-- Two countries in the same coalition don't fight each other.
create or replace function game.coalition_partners(p_a text, p_b text) returns boolean
language sql stable as $$
  select exists (select 1 from game.coalition_members x join game.coalition_members y on y.coalition_id = x.coalition_id
                  join game.coalitions c on c.id = x.coalition_id and c.ended_at is null
                  where x.nation_id = p_a and y.nation_id = p_b)
$$;

-- Join a war that is already being fought against the target, on the side
-- opposite it. Returns true if it joined one.
create or replace function game.coalition_join_war(p_n text, p_target text) returns boolean
language plpgsql set search_path = game, pg_temp as $$
declare
  w record;
begin
  if game.at_war(p_n, p_target) or game.allied(p_n, p_target) or (game.treaty(p_n, p_target)).id is not null
     or (select protected_until from game.nations where id = p_target) > now() then
    return false;
  end if;
  select s.war_id, case when s.side = 'att' then 'def' else 'att' end as other into w
    from game.war_sides s join game.wars x on x.id = s.war_id and x.status = 'active'
   where s.nation_id = p_target
   order by x.started_at limit 1;
  if not found then return false; end if;
  insert into game.war_sides (war_id, nation_id, side) values (w.war_id, p_n, w.other) on conflict do nothing;
  perform game.rel_add(p_n, p_target, -20);
  perform game.tell(p_target, 'war', format('%s joins the war against you', game.nation_name(p_n)), 'The coalition against you is closing in.');
  return true;
end $$;

-- How much of the world a country's own homeland is worth.
create or replace function game.home_share(p_id text) returns numeric
language sql stable as $$
  select coalesce((select value from game.territories where id = p_id), 0) / greatest(1, (select sum(value) from game.territories))
$$;

-- Form, grow and disband coalitions (every five minutes, from world_scores).
create or replace function game.world_coalitions() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  c record;
  t record;
  v_id bigint;
  m record;
  v_names text;
begin
  -- Disband the ones whose target has shrunk or fallen.
  for c in select co.id, co.target_id, n.name, n.share, n.status from game.coalitions co join game.nations n on n.id = co.target_id
            where co.ended_at is null and (n.share < greatest(0.08, game.home_share(n.id) + 0.04) or n.status <> 'active') loop
    update game.coalitions set ended_at = now() where id = c.id;
    perform game.news('coalition', format('The coalition against %s disbands', c.name),
      'Its members go back to their own business.', array[c.target_id]);
  end loop;
  -- Up to three of the biggest powers can each face one.
  for t in select n.*, n.share - game.home_share(n.id) as grown from game.nations n
            where n.status = 'active' and n.share >= greatest(0.12, game.home_share(n.id) + 0.08)
            order by n.share desc limit 3 loop
    select id into v_id from game.coalitions where target_id = t.id and ended_at is null;
    if v_id is null then
      insert into game.coalitions (target_id) values (t.id) returning id into v_id;
      perform game.news('coalition', format('The world unites against %s', t.name),
        format('Holding %s%% of the world, %s has frightened its neighbours into a coalition.', round(t.share * 100, 1), t.name),
        array[t.id]);
      perform game.tell(t.id, 'war', 'A coalition has formed against you',
        'Your neighbours are banding together to stop you. Expect wars on several fronts.');
    end if;
    -- Who joins: AI countries (not the target's allies, not other big powers).
    -- Neighbours first; their neighbours from 18%; everyone from 25%.
    v_names := null;
    for m in
      select n.id, n.name from game.nations n
       where n.status = 'active' and n.leader_id is null and n.id <> t.id and n.share < t.share * 0.6
         and not game.allied(n.id, t.id)
         and not exists (select 1 from game.coalition_members x where x.coalition_id = v_id and x.nation_id = n.id)
         and ((t.share >= 0.25 and t.grown >= 0.15)
              or n.id in (select game.ai_neighbours(t.id))
              or (t.share >= 0.18 and t.grown >= 0.11 and exists (select 1 from game.ai_neighbours(n.id) y where y in (select game.ai_neighbours(t.id)))))
       order by (n.id in (select game.ai_neighbours(t.id))) desc, n.power desc
       limit 25
    loop
      insert into game.coalition_members (coalition_id, nation_id) values (v_id, m.id) on conflict do nothing;
      perform game.rel_add(m.id, t.id, -15);
      perform game.ai_remember(m.id, 'coalition_at', to_jsonb(now()));
      v_names := coalesce(v_names || ', ', '') || m.name;
    end loop;
    if v_names is not null then
      perform game.news('coalition', format('More countries join the coalition against %s', t.name), v_names || '.', array[t.id]);
    end if;
  end loop;
end $$;

-- Rankings (no eras, no resets).
create or replace function game.world_scores() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  w record;
begin
  update game.nations n set
    share = coalesce((select sum(value) from game.territories t where t.controller_id = n.id), 0),
    power = round(game.military_power(n.id) + n.income_h / 20000.0
                  + 15 * (select count(*) from game.nation_techs where nation_id = n.id)
                  + 25 * (select count(*) from game.territories t where t.controller_id = n.id))
  where n.status = 'active';
  update game.nations set share = 0, power = 0, world_rank = null where status = 'fallen';
  update game.nations n set world_rank = r.rk
    from (select id, row_number() over (order by share desc, power desc) rk from game.nations where status = 'active') r
   where r.id = n.id and n.world_rank is distinct from r.rk;
  for w in select leader_id, share from game.nations where leader_id is not null loop
    perform game.count_max(w.leader_id, 'domination', floor(w.share * 1000)::bigint);
  end loop;
  perform game.world_coalitions();
end $$;

-- Choosing a war: coalition duty first, then the best target with the top
-- five weighted up.
create or replace function game.ai_war_plans(p_n text, p_skill int, p_tr jsonb, p_power numeric, p_wars int) returns void
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
  v_ct text;
  v_help numeric;
  v_score numeric;
begin
  select * into n from game.nations where id = p_n;

  -- 1. Coalition duty: join the war against the target, or start one with the others' help.
  v_ct := game.coalition_target(p_n);
  if v_ct is not null and not game.at_war(p_n, v_ct) and n.stability >= 30 then
    if not game.coalition_join_war(p_n, v_ct) and v_ct in (select game.ai_neighbours(p_n))
       and (n.ai ->> 'coalition_at') is not null and (n.ai ->> 'coalition_at')::timestamptz < now() - interval '30 minutes' then
      -- Declare when the coalition's armies together would break the front.
      v_help := coalesce((select sum(game.attack_strength(m.nation_id)) * 0.5 from game.coalition_members m
                           join game.coalitions c on c.id = m.coalition_id and c.ended_at is null and c.target_id = v_ct
                          where m.nation_id <> p_n), 0);
      if (p_power + v_help) * 0.75 / greatest(1, game.ai_front_defence(p_n, v_ct, p_skill)) >= 1.1 + 0.3 * v_caution then
        begin
          perform game.do_declare(p_n, v_ct);
        exception when others then null;
        end;
      end if;
    end if;
    if game.at_war(p_n, v_ct) then return; end if;
  end if;

  -- 2. Ordinary ambitions.
  if v_aggr < 0.4 or n.stability < 55 or p_wars >= (case when v_aggr >= 0.7 then 2 else 1 end) then return; end if;
  if (select count(*) from game.wars w join game.nations a on a.id = w.attacker_id where w.status = 'active' and a.leader_id is null) >= 15 then return; end if;
  for x in select y.* from game.nations y where y.id in (select game.ai_neighbours(p_n)) and y.status = 'active' loop
    continue when game.allied(p_n, x.id) or game.at_war(p_n, x.id) or (game.treaty(p_n, x.id)).id is not null
               or x.protected_until > now() or game.coalition_partners(p_n, x.id);
    v_est := game.ai_front_defence(p_n, x.id, p_skill);
    if p_skill >= 3 then
      v_est := v_est + coalesce((select sum(g.qty * u.def) * 0.3 from game.alliance_members m
                                   join game.garrisons g on g.nation_id = m.nation_id join game.unit_types u on u.id = g.unit
                                  where m.alliance_id = game.alliance_of(x.id) and m.nation_id <> x.id), 0);
    end if;
    v_ratio := p_power * 0.75 / greatest(1, v_est);
    -- The top five: others will pile in, so slightly worse odds will do.
    continue when v_ratio < v_need - case when x.world_rank <= 5 then 0.2 else 0 end;
    v_score := v_ratio * (select sum(value) from game.territories where controller_id = x.id)
             * case when x.world_rank <= 5 then 2.2 - 0.2 * x.world_rank else 1 end;
    if v_score > v_best_score then
      v_best := x.id;
      v_best_score := v_score;
    end if;
  end loop;
  if v_best is null then
    if (n.ai ->> 'target') is not null then update game.nations set ai = ai - 'target' where id = p_n; end if;
    return;
  end if;
  select * into v_rel from game.relations where a = least(p_n, v_best) and b = greatest(p_n, v_best);
  if (n.ai ->> 'target') is distinct from v_best then
    if (n.ai ->> 'denounce_at') is null or (n.ai ->> 'denounce_at')::timestamptz < now() - interval '6 hours' then
      perform game.do_denounce(p_n, v_best);
      perform game.ai_remember(p_n, 'target', to_jsonb(v_best));
      perform game.ai_remember(p_n, 'denounce_at', to_jsonb(now()));
    end if;
  elsif (n.ai ->> 'denounce_at')::timestamptz < now() - interval '1 hour' and game.rel(p_n, v_best) < -10 then
    perform game.do_declare(p_n, v_best);
    update game.nations set ai = ai - 'target' where id = p_n;
  end if;
end $$;

-- Peace: a coalition member doesn't let a big power off lightly.
create or replace function game.ai_peace(p_n text, p_aggr numeric) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  w record;
  v_sc numeric;
  v_age interval;
  v_terms text;
  v_holds boolean;
  v_vs_big boolean;
begin
  select * into n from game.nations where id = p_n;
  for w in select x.* from game.wars x where x.status = 'active' and p_n in (x.attacker_id, x.defender_id) loop
    continue when (n.ai ->> ('peace_' || w.id)) is not null and (n.ai ->> ('peace_' || w.id))::timestamptz > now() - interval '1 hour';
    v_sc := case when game.side_of(w.id, p_n) = 'att' then w.score else -w.score end;
    v_age := now() - w.started_at;
    v_holds := exists (select 1 from game.territories t where t.controller_id = p_n and t.owner_id <> p_n
                        and game.side_of(w.id, t.owner_id) is distinct from game.side_of(w.id, p_n));
    v_vs_big := game.in_coalition_against(p_n, case when w.attacker_id = p_n then w.defender_id else w.attacker_id end);
    v_terms := case
      when v_sc <= -60 and ((select count(*) from game.territories where controller_id = p_n) <= 1 or n.exhaustion >= 80) then 'surrender'
      when v_sc >= 35 and v_holds and v_age > interval '30 minutes' then 'annex'
      when v_vs_big then case when n.exhaustion >= 85 then 'white' else null end
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

-- AI answers to offers: no deals with the power the world is against.
create or replace function game.ai_accepts(o game.diplo_offers) returns boolean
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
  -- No alliances or pacts with a power the world is ganging up on, and
  -- no peace for it unless this country is worn out or losing badly.
  if game.in_coalition_against(o.to_id, o.from_id) or (select share >= greatest(0.12, game.home_share(id) + 0.08) from game.nations where id = o.from_id) then
    if o.kind in ('alliance', 'nap') then return false; end if;
    if o.kind = 'peace' and n.exhaustion < 70
       and coalesce((select score * case when game.side_of(id, o.to_id) = 'att' then 1 else -1 end from game.wars where id = o.war_id), 0) > -40 then
      return false;
    end if;
  end if;
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

-- Attacks: retake your own land, then hit the coalition target.
create or replace function game.ai_attack(p_n text, p_skill int, p_caution numeric) returns int
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
     order by (x.owner_id = p_n) desc, (x.controller_id = game.coalition_target(p_n)) desc nulls last, x.value / greatest(1, game.defence_power(x.id, p_n) * game.ai_noise(p_n, x.id, p_skill)) desc
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

-- Diplomacy: allies against the big powers, never with them.
create or replace function game.ai_diplomacy(p_n text, p_skill int, p_tr jsonb, p_threat numeric, p_power numeric) returns void
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
     where y.id <> p_n and y.status = 'active' and game.alliance_of(y.id) is null and y.share < greatest(0.12, game.home_share(y.id) + 0.08)
       and not game.at_war(p_n, y.id) and game.rel(p_n, y.id) >= 15 * (1 - v_dip) - 10 * game.ai_common_enemy(p_n, y.id)
       and not exists (select 1 from game.alliance_members m where m.alliance_id = game.alliance_of(p_n) and game.at_war(m.nation_id, y.id))
       and not exists (select 1 from game.diplo_offers o where o.kind = 'alliance' and o.from_id = p_n and o.to_id = y.id and o.created_at > now() - interval '12 hours')
     order by game.coalition_partners(p_n, y.id) desc, game.ai_common_enemy(p_n, y.id) desc, (y.id in (select game.ai_neighbours(p_n))) desc, game.rel(p_n, y.id) desc, y.power desc
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

-- One turn of thinking (every 6-14 minutes, so the world tick stays light).
create or replace function game.ai_think(p_id text) returns void
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

  update game.nations set next_think_at = now() + make_interval(secs => (60 * (4 + 2 * (6 - s)) + floor(random() * 120))::int) where id = p_id;
end $$;

-- National income: AI coalition members run a war economy (+15%).
create or replace function game.nation_income(p_id text) returns jsonb
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
          * (1 - least(0.25, 0.05 * v_wars))
          * (case when n.leader_id is null and game.coalition_target(p_id) is not null then 1.15 else 1 end);
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

-- The world as everyone sees it: with ranks and coalitions.
create or replace function public.world_state() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'at', now(),
    'era', (select jsonb_build_object('number', number, 'started_at', started_at, 'ends_at', ends_at) from game.eras where ended_at is null order by id desc limit 1),
    'territories', (select jsonb_agg(jsonb_build_array(id, owner_id, controller_id)) from game.territories),
    'nations', (select jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'color', n.color, 'status', n.status,
                  'leader', case when p.id is not null then jsonb_build_object('no', p.player_no, 'name', p.display_name, 'skin', p.skin) end,
                  'skill', n.ai_skill, 'skill_name', game.skill_name(n.ai_skill), 'personality', n.personality,
                  'power', n.power, 'share', round(n.share * 100, 2), 'alliance', m.alliance_id, 'rank', n.world_rank,
                  'protected', n.protected_until > now(), 'stability', round(n.stability)) order by n.power desc)
                from game.nations n left join game.players p on p.id = n.leader_id left join game.alliance_members m on m.nation_id = n.id),
    'coalitions', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'target', c.target_id, 'formed_at', c.formed_at,
                     'members', (select jsonb_agg(nation_id order by joined_at) from game.coalition_members where coalition_id = c.id))), '[]'::jsonb)
                   from game.coalitions c where c.ended_at is null),
    'alliances', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'founder', a.founder_id,
                    'members', (select jsonb_agg(nation_id order by joined_at) from game.alliance_members where alliance_id = a.id))), '[]'::jsonb)
                  from game.alliances a),
    'wars', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'attacker', w.attacker_id, 'defender', w.defender_id,
               'score', round(w.score), 'started_at', w.started_at,
               'att', (select jsonb_agg(nation_id) from game.war_sides where war_id = w.id and side = 'att'),
               'def', (select jsonb_agg(nation_id) from game.war_sides where war_id = w.id and side = 'def'))), '[]'::jsonb)
             from game.wars w where w.status = 'active'),
    'moves', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nation', nation_id, 'from', from_t, 'to', to_t, 'kind', kind,
               'depart_at', depart_at, 'arrive_at', arrive_at)), '[]'::jsonb)
              from game.movements where status = 'moving'),
    'battles', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', at, 'territory', territory_id, 'winner', winner, 'captured', captured)
                  order by at desc), '[]'::jsonb)
                from game.battles where at > now() - interval '10 minutes'))
$$;

-- A manual reset (tests, admins) no longer starts an era.
create or replace function game.world_reset() returns void
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
  -- No eras any more: a reset (only ever done by hand) just clears the board.
  update game.eras set ended_at = coalesce(ended_at, now()) where ended_at is null;
  update game.coalitions set ended_at = now() where ended_at is null;
  update game.nations set income_h = (game.nation_income(id) ->> 'gross')::bigint where status = 'active';
  perform game.world_scores();
end $$;
