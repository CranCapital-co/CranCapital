-- What the 3D map needs to draw each business: a farm's crop, a mine's ore,
-- and (for your own yards only) how full your storage is, so containers
-- stack up as it fills. Nothing private about other players is added.

create or replace function public.map_businesses(p_city text, p_w float8, p_s float8, p_e float8, p_n float8) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  v_fill numeric;
begin
  if v_uid is not null then
    v_fill := least(1, game.storage_used(v_uid, p_city)::numeric / nullif(game.storage_capacity(v_uid, p_city), 0));
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'name', b.name, 'lat', b.lat, 'lng', b.lng, 'level', b.level, 'status', b.status,
      'owner_no', pl.player_no, 'owner_name', pl.display_name, 'mine', b.owner_id = v_uid, 'building_id', b.building_id,
      'plot_x', b.plot_x, 'plot_y', b.plot_y,
      'crop', b.settings ->> 'crop',
      'resource', coalesce(d.resource, t.resource),
      'fill', case when b.kind = 'yard' and b.owner_id = v_uid then round(coalesce(v_fill, 0), 2) end))
    from (select * from game.businesses
           where city_id = p_city and status in ('open', 'closed', 'abandoned', 'depleted')
             and lat between p_s and p_n and lng between p_w and p_e
           order by (owner_id = v_uid) desc, lifetime_revenue desc limit 800) b
    join game.players pl on pl.id = b.owner_id
    join game.business_types t on t.id = b.kind
    left join game.deposits d on d.id = b.deposit_id), '[]'::jsonb);
end $$;
