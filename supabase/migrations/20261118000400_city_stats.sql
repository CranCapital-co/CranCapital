-- Per-city numbers for the city picker: players online in each city right
-- now and businesses open there. Public, like the landing page's stats.
create function public.city_stats() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'city_id', c.id,
    'online', (select count(*) from game.players p where p.status = 'active' and p.city_id = c.id and p.last_seen_at > now() - interval '5 minutes'),
    'businesses', (select count(*) from game.businesses b where b.city_id = c.id and b.status = 'open')) order by c.sort), '[]'::jsonb)
  from game.cities c
$$;
revoke all on function public.city_stats() from public, anon, authenticated;
grant execute on function public.city_stats() to anon, authenticated, service_role;

-- The landing page's live street shows real businesses to visitors too
-- (names and owners are already public on the map to every player).
grant execute on function public.map_businesses(text, float8, float8, float8, float8) to anon;
