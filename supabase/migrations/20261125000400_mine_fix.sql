-- Mines could never be built: "by" is an SQL keyword, so the deposit's
-- block column has to be quoted when read from a PL/pgSQL record
-- (d."by"). Unquoted, every attempt to dig a surveyed deposit failed with
-- 'record "d" has no field "by"'. Same function, one fix.
create or replace function game.build_on_plot(p game.players, p_city text, p_px int, p_py int, p_kind text, p_name text, p_option text) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  c game.cities;
  pl game.plots;
  t game.business_types;
  d game.deposits;
  pc record;
  v_id bigint;
  v_settings jsonb := '{}'::jsonb;
  g game.goods;
begin
  perform game.rate_limit(p.id::text, 'build', 10, 6);
  select * into c from game.cities where id = p_city;
  select * into pl from game.plots where city_id = p_city and px = p_px and py = p_py and owner_id = p.id for update;
  if not found then perform game.fail('You don''t own that plot.'); end if;
  if pl.business_id is not null and exists (select 1 from game.businesses where id = pl.business_id and status in ('open', 'closed', 'depleted')) then
    perform game.fail('Something is already built here. Sell it first.');
  end if;
  select * into t from game.business_types where id = p_kind;
  if not found or t.placement not in ('plot', 'coastal', 'deposit') then perform game.fail('That can''t be built on a plot.'); end if;
  perform game.require_tier(p, t.tier);
  if t.placement = 'coastal' and not game.plot_coastal(c, p_px, p_py) then
    perform game.fail('Ports need a plot right by open water.');
  end if;
  if t.placement = 'deposit' then
    select * into d from game.deposits where city_id = p_city and px = p_px and py = p_py;
    if not found or d.resource <> t.resource then
      perform game.fail(format('There''s no %s deposit under this plot. Survey first.', lower((select name from game.goods where id = t.resource))));
    end if;
    if not exists (select 1 from game.surveys where player_id = p.id and city_id = p_city and bx = d.bx and "by" = d."by") then
      perform game.fail('Survey this area before you dig.');
    end if;
    if exists (select 1 from game.businesses where deposit_id = d.id and status in ('open', 'closed')) then
      perform game.fail('This deposit is already being mined.');
    end if;
    if d.units_left <= 0 then perform game.fail('This deposit is used up.'); end if;
  end if;
  if t.produces = 'crop' then
    select * into g from game.goods where id = coalesce(p_option, case when c.climate = 'warm' then 'banana' else 'lettuce' end);
    if not found or not exists (select 1 from game.crops where good_id = g.id) then perform game.fail('Choose a crop.'); end if;
    if g.warm_only and c.climate <> 'warm' then perform game.fail(format('%s only grows in warm cities.', g.name)); end if;
    v_settings := jsonb_build_object('crop', g.id, 'auto_sell', false);
  elsif t.produces in ('timber', 'recipe') or t.placement = 'deposit' then
    v_settings := jsonb_build_object('auto_sell', false);
  end if;
  select * into pc from game.plot_center(c, p_px, p_py);
  perform game.money(p.id, -t.cost, 'purchase', format('Built a %s', lower(t.name)), jsonb_build_object('kind', t.id, 'px', p_px, 'py', p_py));
  insert into game.businesses (owner_id, city_id, kind, name, lat, lng, traffic, plot_x, plot_y, deposit_id, book_value, settings, open_hour, close_hour)
  values (p.id, c.id, t.id, game.clean_name(p_name, p.display_name || '''s ' || t.name), pc.lat, pc.lng,
          game.traffic_at(c, pc.lat, pc.lng), p_px, p_py, d.id, t.cost, v_settings, 0, 24)
  returning id into v_id;
  update game.plots set business_id = v_id, for_sale_price = null where city_id = p_city and px = p_px and py = p_py;
  perform game.recompute_business(v_id);
  if t.placement = 'deposit' then perform game.award(p.id, 'first_mine'); end if;
  if t.produces = 'recipe' then perform game.award(p.id, 'first_factory'); end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('business_id', v_id);
end $$;
