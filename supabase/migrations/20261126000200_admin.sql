-- Admin panel: cheats for players with role 'admin' (More, then Admin).
-- Everything goes through one function that checks the role on the server
-- and writes an audit row, so the client can't do any of this by itself.
-- Money moves through the ledger as 'admin' (Staff adjustment), so every
-- player's cash still equals the sum of their ledger.

create table if not exists game.admin_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  admin_id uuid not null references game.players(id),
  target_id uuid references game.players(id),
  action text not null,
  args jsonb not null default '{}'::jsonb,
  result text
);
alter table game.admin_log enable row level security;
revoke all on game.admin_log from public, anon, authenticated;

create or replace function public.admin_cheat(p_action text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  me game.players := game.me();
  t game.players;
  v_nation text;
  v_home text;
  v_n bigint;
  v_txt text;
  v_level int;
  r record;
begin
  perform game.require_staff(me, true);
  p_args := coalesce(p_args, '{}'::jsonb);
  -- Most cheats can target another player by name (default: yourself).
  if nullif(trim(p_args ->> 'player'), '') is not null then
    select * into t from game.players where lower(display_name) = lower(trim(p_args ->> 'player')) and status <> 'deleted';
    if not found then perform game.fail('No player called ' || (p_args ->> 'player') || '.'); end if;
  else
    t := me;
  end if;
  v_nation := (select id from game.nations where leader_id = t.id and status = 'active');

  if p_action = 'money' then
    v_n := least(greatest(coalesce((p_args ->> 'dollars')::numeric, 0), -1e12), 1e12)::bigint * 1000;
    if v_n = 0 then perform game.fail('Enter an amount.'); end if;
    if v_n < 0 then v_n := -least(-v_n, t.cash); end if;
    perform game.money(t.id, v_n, 'admin', 'Admin: ' || case when v_n > 0 then 'money added' else 'money removed' end);
    perform game.refresh_worth(t.id);
    v_txt := format('%s %s %s.', case when v_n > 0 then 'Gave' else 'Took' end, t.display_name, game.fmt(abs(v_n)));

  elsif p_action = 'levels' then
    perform game.renown_row(t.id);
    select level into v_level from game.renown where player_id = t.id;
    v_level := least(1999, v_level + greatest(1, least(500, coalesce((p_args ->> 'n')::int, 1))));
    v_n := (select total from game.level_xp where level = v_level) - (select xp from game.renown where player_id = t.id);
    while v_n > 0 loop
      perform game.grant_xp(t.id, least(v_n, 2000000000)::int, 'Admin');
      v_n := (select total from game.level_xp where level = v_level) - (select xp from game.renown where player_id = t.id);
    end loop;
    v_txt := format('%s is now level %s.', t.display_name, (select level from game.renown where player_id = t.id));

  elsif p_action = 'perk_points' then
    perform game.renown_row(t.id);
    update game.renown set perk_points = perk_points + greatest(1, least(1000, coalesce((p_args ->> 'n')::int, 5))) where player_id = t.id;
    v_txt := 'Perk points added.';

  elsif p_action = 'crates' then
    if coalesce(p_args ->> 'kind', '') not in ('supply', 'gold', 'war') then perform game.fail('Pick supply, gold or war.'); end if;
    perform game.renown_row(t.id);
    perform game.add_crate(t.id, p_args ->> 'kind', greatest(1, least(100, coalesce((p_args ->> 'n')::int, 5))));
    v_txt := 'Crates added: open them from the Renown window.';

  elsif p_action = 'goods' then
    if not exists (select 1 from game.goods where id = p_args ->> 'good') then perform game.fail('Unknown good.'); end if;
    perform game.stock_add(t.id, coalesce(p_args ->> 'city', t.city_id), p_args ->> 'good',
      greatest(1, least(100000000, coalesce((p_args ->> 'qty')::bigint, 1000))), false);
    v_txt := 'Goods added to storage in ' || (select name from game.cities where id = coalesce(p_args ->> 'city', t.city_id)) || '.';

  elsif p_action = 'tier' then
    update game.players set tier = greatest(1, least(6, coalesce((p_args ->> 'tier')::int, 6))) where id = t.id;
    v_txt := 'Tier set.';

  elsif p_action = 'finish' then
    -- Everything under way finishes now: bases, recruits, research, armies, ships.
    if v_nation is not null then
      update game.facilities set ready_at = now() - interval '1 second'
       where target is not null and territory_id in (select id from game.territories where controller_id = v_nation);
      update game.recruit_queue set ready_at = now() - interval '1 second' where nation_id = v_nation;
      for r in select researching from game.nations where id = v_nation and researching is not null loop
        insert into game.nation_techs (nation_id, tech) values (v_nation, r.researching) on conflict do nothing;
        update game.nations set researching = null, research_progress = 0 where id = v_nation;
      end loop;
      update game.movements set arrive_at = now() - interval '1 second' where nation_id = v_nation and status = 'moving';
      perform game.world_stage('training');
      perform game.world_stage('construction');
      perform game.world_stage('arrivals');
    end if;
    update game.shipments set arrive_at = now() - interval '1 second' where owner_id = t.id and status = 'in_transit';
    perform game.deliver_shipments();
    v_txt := 'Everything under way is finished.';

  elsif p_action in ('all_tech', 'troops', 'manpower', 'stability', 'peace', 'annex', 'relations', 'unprotect') then
    if v_nation is null then perform game.fail(t.display_name || ' doesn''t lead a country.'); end if;
    v_home := (select id from game.territories where controller_id = v_nation order by (id = v_nation) desc, value desc limit 1);
    if p_action = 'all_tech' then
      insert into game.nation_techs (nation_id, tech) select v_nation, id from game.techs on conflict do nothing;
      update game.nations set researching = null, research_progress = 0 where id = v_nation;
      v_txt := 'Every technology researched.';
    elsif p_action = 'troops' then
      if not exists (select 1 from game.unit_types where id = p_args ->> 'unit') then perform game.fail('Unknown unit.'); end if;
      if v_home is null then perform game.fail('No territory to put them in.'); end if;
      perform game.garrison_add(coalesce(p_args ->> 'territory', v_home), v_nation, p_args ->> 'unit',
        greatest(1, least(1000000, coalesce((p_args ->> 'qty')::int, 100))));
      v_txt := 'Troops added.';
    elsif p_action = 'manpower' then
      update game.nations set manpower = manpower + greatest(1, least(100000000, coalesce((p_args ->> 'n')::bigint, 100000))) where id = v_nation;
      v_txt := 'Manpower added.';
    elsif p_action = 'stability' then
      update game.nations set stability = 100, exhaustion = 0 where id = v_nation;
      v_txt := 'Stability 100, no war exhaustion.';
    elsif p_action = 'peace' then
      for r in select distinct s.war_id from game.war_sides s join game.wars w on w.id = s.war_id
                where s.nation_id = v_nation and w.status = 'active' loop
        perform game.end_war(r.war_id, 'white', null, 'Peace by decree');
      end loop;
      v_txt := 'At peace with everyone.';
    elsif p_action = 'unprotect' then
      update game.nations set protected_until = null where id = v_nation;
      v_txt := 'Protection removed.';
    elsif p_action = 'relations' then
      if not exists (select 1 from game.nations where id = p_args ->> 'nation') then perform game.fail('Pick a country.'); end if;
      insert into game.relations (a, b, score) values (least(v_nation, p_args ->> 'nation'), greatest(v_nation, p_args ->> 'nation'),
        greatest(-100, least(100, coalesce((p_args ->> 'score')::numeric, 100))))
      on conflict (a, b) do update set score = excluded.score;
      v_txt := 'Relations set.';
    elsif p_action = 'annex' then
      select * into r from game.territories where id = p_args ->> 'territory';
      if not found then perform game.fail('Pick a territory.'); end if;
      if r.controller_id = v_nation and r.owner_id = v_nation then perform game.fail('You already hold it.'); end if;
      delete from game.garrisons where territory_id = r.id and nation_id <> v_nation;
      update game.territories set owner_id = v_nation, controller_id = v_nation, occupied_at = null where id = r.id;
      if r.owner_id <> v_nation then perform game.check_fallen(r.owner_id); end if;
      if r.controller_id <> v_nation and r.controller_id <> r.owner_id then perform game.check_fallen(r.controller_id); end if;
      perform game.news('annex', format('%s takes %s', game.nation_name(v_nation), r.name), null, array[v_nation, r.owner_id]);
      v_txt := r.name || ' is yours.';
    end if;

  elsif p_action = 'role' then
    if t.id = me.id then perform game.fail('Pick another player.'); end if;
    if coalesce(p_args ->> 'role', '') not in ('player', 'mod', 'admin') then perform game.fail('Role is player, mod or admin.'); end if;
    update game.players set role = p_args ->> 'role' where id = t.id;
    v_txt := format('%s is now %s.', t.display_name, p_args ->> 'role');

  else
    perform game.fail('Unknown cheat.');
  end if;

  insert into game.admin_log (admin_id, target_id, action, args, result) values (me.id, t.id, p_action, p_args, v_txt);
  return jsonb_build_object('ok', true, 'message', v_txt);
end $$;
revoke all on function public.admin_cheat(text, jsonb) from public, anon;
grant execute on function public.admin_cheat(text, jsonb) to authenticated;

-- Small amounts printed with a stray '#' ("$5.00#"): the format had a
-- literal '#' in it.
create or replace function game.fmt(p_mills bigint) returns text
language sql immutable as $$
  select case when p_mills < 0 then '-' else '' end || '$' ||
    case when abs(p_mills) >= 1000000000000 then to_char(abs(p_mills) / 1000.0, 'FM999,999,999,999,999')
         when abs(p_mills) >= 10000 then to_char(abs(p_mills) / 1000.0, 'FM999,999,999,990.00')
         else to_char(abs(p_mills) / 1000.0, 'FM990.00') end
$$;
