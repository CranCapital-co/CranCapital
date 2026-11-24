-- Work in the country you lead.
--
-- Nine more cities (Rio de Janeiro, Mexico City, Toronto, Berlin, Moscow,
-- Mumbai, Shanghai, Sydney, Lagos; their map data is in
-- supabase/seed/cities/), and a home city for every country: a city in that
-- country if the game has one, otherwise the nearest. A new leader's
-- businesses start in their home city.

create or replace function game.seed_city_economy() returns void
language sql set search_path = game, pg_temp as $$
  update game.cities set price_factor = 1.4, wage_per_hour = 16000, sort = 1 where id = 'london';
  update game.cities set price_factor = 1.5, wage_per_hour = 18000, sort = 2 where id = 'new-york';
  update game.cities set price_factor = 1.3, wage_per_hour = 14000, sort = 3 where id = 'tokyo';
  update game.cities set price_factor = 1.2, wage_per_hour = 13000, sort = 4 where id = 'singapore';
  update game.cities set price_factor = 1.35, wage_per_hour = 15000, sort = 5 where id = 'paris';
  update game.cities set price_factor = 1.3, wage_per_hour = 14000, sort = 6 where id = 'berlin';
  update game.cities set price_factor = 1.35, wage_per_hour = 15000, sort = 7 where id = 'toronto';
  update game.cities set price_factor = 1.35, wage_per_hour = 15000, sort = 8 where id = 'sydney';
  update game.cities set price_factor = 1.15, wage_per_hour = 12000, sort = 9 where id = 'shanghai';
  update game.cities set price_factor = 1.1, wage_per_hour = 11000, sort = 10 where id = 'moscow';
  update game.cities set price_factor = 1.0, wage_per_hour = 10000, sort = 11 where id = 'rio';
  update game.cities set price_factor = 1.0, wage_per_hour = 10000, sort = 12 where id = 'mexico-city';
  update game.cities set price_factor = 0.95, wage_per_hour = 9000, sort = 13 where id = 'mumbai';
  update game.cities set price_factor = 0.95, wage_per_hour = 9000, sort = 14 where id = 'lagos';
$$;

insert into game.contract_clients (city_id, client) values
  ('rio', 'A hotel on Copacabana beach'), ('rio', 'A churrascaria in Lapa'), ('rio', 'A builder in Centro'), ('rio', 'A samba school'),
  ('mexico-city', 'A hotel by the Zócalo'), ('mexico-city', 'A taquería in Roma Norte'), ('mexico-city', 'A builder in Polanco'), ('mexico-city', 'A department store on Madero'),
  ('toronto', 'A hotel by Union Station'), ('toronto', 'A café in Kensington Market'), ('toronto', 'A condo builder on King Street'), ('toronto', 'An Eaton Centre store'),
  ('berlin', 'A hotel on Unter den Linden'), ('berlin', 'A bakery in Prenzlauer Berg'), ('berlin', 'A builder in Mitte'), ('berlin', 'A store on Kurfürstendamm'),
  ('moscow', 'A hotel by Red Square'), ('moscow', 'A restaurant on Tverskaya'), ('moscow', 'A builder in Zamoskvorechye'), ('moscow', 'A GUM department store'),
  ('mumbai', 'A hotel by the Gateway of India'), ('mumbai', 'A dabbawala collective'), ('mumbai', 'A builder in Lower Parel'), ('mumbai', 'A Colaba market stall'),
  ('shanghai', 'A hotel on the Bund'), ('shanghai', 'A dumpling house on Nanjing Road'), ('shanghai', 'A tower builder in Pudong'), ('shanghai', 'A Huaihai Road mall'),
  ('sydney', 'A hotel at Circular Quay'), ('sydney', 'A café in Surry Hills'), ('sydney', 'A builder in Barangaroo'), ('sydney', 'A Pitt Street store'),
  ('lagos', 'A hotel on Victoria Island'), ('lagos', 'A buka in Lagos Island'), ('lagos', 'A builder in Ikoyi'), ('lagos', 'A Balogun market trader');

-- A country's home city: its own, or the nearest one.
create function game.home_city(p_nation text) returns text
language sql stable set search_path = game, pg_temp as $$
  select c.id from game.cities c, game.territories t
   where t.id = p_nation and c.open
   order by (c.country = t.name) desc, game.dist_m(c.start_lat, c.start_lng, t.lat, t.lng)
   limit 1
$$;

-- The world map now says where each country's leader does business.
create or replace function public.world_map() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'territories', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'iso2', iso2, 'continent', continent, 'region', region,
                      'pop_m', pop_m, 'gdp_bn', gdp_bn, 'lat', lat, 'lng', lng, 'landlocked', landlocked, 'color', color,
                      'value', round(value * 1000, 2), 'income', income, 'manpower', manpower, 'militia', militia,
                      'home', game.home_city(id)) order by name)
                    from game.territories),
    'links', (select jsonb_agg(jsonb_build_array(a, b, kind, km)) from game.territory_links where a < b),
    'units', (select jsonb_agg(to_jsonb(u) order by sort) from game.unit_types u),
    'buildings', (select jsonb_agg(to_jsonb(b) order by sort) from game.facility_types b),
    'techs', (select jsonb_agg(to_jsonb(t) order by sort) from game.techs t))
$$;

-- Leading a country moves a new player (no city yet) to its home city.
create or replace function public.choose_home_city() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.cities;
  v_nation text := game.player_nation(p.id);
begin
  if v_nation is null then perform game.fail('Pick a country to lead first.'); end if;
  if p.city_id is not null or p.travel_to is not null then perform game.fail('You''re already in a city. Travel to move.'); end if;
  select * into c from game.cities where id = game.home_city(v_nation);
  update game.players set city_id = c.id, lat = c.start_lat, lng = c.start_lng, pos_at = now() where id = p.id returning * into p;
  return game.player_json(p);
end $$;
revoke all on function public.choose_home_city() from public, anon;
grant execute on function public.choose_home_city() to authenticated, service_role;
