-- Where everyone's troops are, as you see it: your own and your allies'
-- exactly, and the enemies you're at war with as estimates. Plus the size
-- of every army on the move that's yours or heading for you.
create function public.troop_map() returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v_n text := game.player_nation(p.id);
begin
  if v_n is null then return jsonb_build_object('garrisons', '[]'::jsonb, 'moves', '[]'::jsonb); end if;
  return jsonb_build_object(
    'garrisons', (select coalesce(jsonb_agg(jsonb_build_object('t', x.territory_id, 'n', x.nation_id, 'rel', x.rel,
                     'total', case when x.rel = 'enemy' then game.intel(x.total) else x.total end,
                     'units', case when x.rel = 'enemy' then null else x.units end)), '[]'::jsonb)
                  from (select g.territory_id, g.nation_id, sum(g.qty)::int total, jsonb_object_agg(g.unit, g.qty) units,
                               case when g.nation_id = v_n then 'mine' when game.allied(v_n, g.nation_id) then 'ally'
                                    when game.at_war(v_n, g.nation_id) then 'enemy' end rel
                          from game.garrisons g where g.qty > 0 and g.unit <> 'missile'
                         group by g.territory_id, g.nation_id) x
                 where x.rel is not null),
    'moves', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id,
                 'size', case when m.nation_id = v_n or game.allied(v_n, m.nation_id) then s.total else game.intel(s.total) end,
                 'mine', m.nation_id = v_n)), '[]'::jsonb)
              from game.movements m
              cross join lateral (select sum(value::int)::int total from jsonb_each_text(m.units)) s
              join game.territories t on t.id = m.to_t
             where m.status = 'moving' and (m.nation_id = v_n or game.allied(v_n, m.nation_id) or game.allied(v_n, t.controller_id))));
end $$;
revoke all on function public.troop_map() from public, anon;
grant execute on function public.troop_map() to authenticated, service_role;

-- Your ships: at sea now, or arrived in the last ten minutes, with where
-- they sail from and to (for the world map and the arrival at the port).
create function public.my_ships() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'good', s.good_id, 'qty', s.qty,
           'from_city', s.from_city, 'to_city', s.to_city, 'port_id', s.port_id,
           'from', jsonb_build_array(a.hub_lng, a.hub_lat), 'to', jsonb_build_array(b.hub_lng, b.hub_lat),
           'depart_at', s.depart_at, 'arrive_at', s.arrive_at, 'status', s.status) order by s.arrive_at), '[]'::jsonb)
    from game.shipments s join game.cities a on a.id = s.from_city join game.cities b on b.id = s.to_city
   where s.owner_id = game.uid() and (s.status = 'in_transit' or s.arrive_at > now() - interval '10 minutes')
$$;
revoke all on function public.my_ships() from public, anon;
grant execute on function public.my_ships() to authenticated, service_role;
