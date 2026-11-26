-- No character. You run your empire from above: tap where to build, and
-- switch cities instantly. There is no walking, no taxi and no flight time.
--
-- Positions are still stored (the last place you looked at in a city, and
-- where you build), but any spot in the city is in reach straight away.

create or replace function game.set_position(p game.players, p_city text, p_lat float8, p_lng float8, p_inside bigint default null)
returns game.players
language plpgsql set search_path = game, pg_temp as $$
declare
  c game.cities;
begin
  if p.city_id is null or p.city_id <> p_city then
    perform game.fail('Switch to that city first.');
  end if;
  select * into c from game.cities where id = p_city;
  if not game.in_city(c, p_lat, p_lng) then
    perform game.fail('That spot is outside the playable part of ' || c.name || '.');
  end if;
  update game.players
     set lat = p_lat, lng = p_lng, pos_at = now(), inside_building = p_inside, last_seen_at = now(),
         travel_to = null, travel_from = null, travel_arrive_at = null
   where id = p.id
  returning * into p;
  return p;
end $$;

-- Everything in the city is in reach.
create or replace function game.require_near(p game.players, p_lat float8, p_lng float8, p_range float8 default null)
returns void language plpgsql set search_path = game, pg_temp as $$
begin
  return;
end $$;

-- Switching city: instant and free.
create or replace function public.travel(p_city text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.cities;
begin
  if p.city_id is null then perform game.fail('Pick your first city instead.'); end if;
  if p.city_id = p_city then perform game.fail('You''re already here.'); end if;
  select * into c from game.cities where id = p_city and open;
  if not found then perform game.fail('That city isn''t open.'); end if;
  perform game.rate_limit(p.id::text, 'travel', 10, 20);
  update game.players set city_id = c.id, lat = c.start_lat, lng = c.start_lng, pos_at = now(), inside_building = null,
         travel_from = null, travel_to = null, travel_arrive_at = null
   where id = p.id returning * into p;
  return game.player_json(p);
end $$;

create or replace function public.travel_quote(p_city text) returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object('price', 0, 'minutes', 0)
$$;

create or replace function public.taxi(p_lat float8, p_lng float8) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin
  perform game.fail('There are no taxis any more: just tap where you want to look.');
  return null;
end $$;

-- Anyone mid-flight lands now.
update game.players set city_id = coalesce(travel_to, city_id), travel_from = null, travel_to = null, travel_arrive_at = null
 where travel_to is not null;
