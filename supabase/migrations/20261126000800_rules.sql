-- Rule changes.
--   * Surveying for minerals has no cooldown.
--   * No automatic truces: only a peace both sides agreed to brings a truce.

create or replace function game.survey(p game.players, p_lat float8, p_lng float8) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  c game.cities;
  pp record;
  v_bx int;
  v_by int;
  v_cost bigint := game.cfg('survey_cost')::bigint;
begin
  perform game.require_tier(p, 4);
  -- No cooldown: survey as fast as you like (a generous limit only stops
  -- runaway scripts). Each block can still be surveyed once, and each costs.
  perform game.rate_limit(p.id::text, 'survey', 60, 120);
  if p.city_id is null then perform game.fail('Pick a city first.'); end if;
  select * into c from game.cities where id = p.city_id;
  p := game.set_position(p, c.id, p_lat, p_lng);
  select * into pp from game.plot_of(c, p.lat, p.lng);
  v_bx := floor(pp.px / 8.0);
  v_by := floor(pp.py / 8.0);
  if exists (select 1 from game.surveys where player_id = p.id and city_id = c.id and bx = v_bx and by = v_by) then
    perform game.fail('You''ve already surveyed this block. Its results are on your map.');
  end if;
  perform game.money(p.id, -v_cost, 'survey', format('Mineral survey in %s', c.name), jsonb_build_object('city', c.id, 'bx', v_bx, 'by', v_by));
  perform game.generate_block(c, v_bx, v_by);
  insert into game.surveys (player_id, city_id, bx, by) values (p.id, c.id, v_bx, v_by);
  perform game.award(p.id, 'first_survey');
  return jsonb_build_object('bx', v_bx, 'by', v_by, 'deposits', coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'px', d.px, 'py', d.py, 'resource', d.resource,
      'units_left', d.units_left, 'units_total', d.units_total,
      'lat', (game.plot_center(c, d.px, d.py)).lat, 'lng', (game.plot_center(c, d.px, d.py)).lng,
      'claimed', exists (select 1 from game.businesses b where b.deposit_id = d.id and b.status in ('open', 'closed')),
      'plot_owner', (select pl.owner_id = p.id from game.plots pl where pl.city_id = d.city_id and pl.px = d.px and pl.py = d.py)))
      from game.deposits d where d.city_id = c.id and d.bx = v_bx and d.by = v_by), '[]'::jsonb));
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
  -- A truce only when both sides agreed to the peace (an accepted offer).
  -- A conquest, a surrender, a war that burns out or a new government
  -- brings no automatic truce, so the fighting can carry on next door.
  if p_outcome is null and p_terms <> 'surrender' then
    for a, b in select x.nation_id, y.nation_id from game.war_sides x join game.war_sides y on y.war_id = x.war_id and x.side = 'att' and y.side = 'def'
                 where x.war_id = p_war loop
      perform game.add_treaty('truce', a, b, 24);
      perform game.rel_add(a, b, 15);
    end loop;
  end if;
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
