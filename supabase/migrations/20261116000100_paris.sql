-- Paris joins as the fifth launch city: its price and wage levels.
create or replace function game.seed_city_economy() returns void
language sql set search_path = game, pg_temp as $$
  update game.cities set price_factor = 1.4, wage_per_hour = 16000, sort = 1 where id = 'london';
  update game.cities set price_factor = 1.5, wage_per_hour = 18000, sort = 2 where id = 'new-york';
  update game.cities set price_factor = 1.3, wage_per_hour = 14000, sort = 3 where id = 'tokyo';
  update game.cities set price_factor = 1.2, wage_per_hour = 13000, sort = 4 where id = 'singapore';
  update game.cities set price_factor = 1.35, wage_per_hour = 15000, sort = 5 where id = 'paris';
$$;
