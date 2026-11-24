-- World settings that depend on the cities being loaded (run after
-- supabase/seed/cities/*.sql).
select game.seed_city_economy();

-- What overseas buyers pay for imports, relative to base price.
-- Temperate cities pay more for tropical crops; Singapore imports food;
-- Tokyo imports raw materials; each city has a taste for something.
insert into game.import_prices (city_id, good_id, mult)
select c.id, g.id,
  case
    when g.warm_only and c.climate <> 'warm' then 1.65
    when c.id = 'singapore' and g.category = 'farm' then 1.45
    when c.id = 'tokyo' and g.category in ('raw', 'fuel') then 1.4
    when c.id = 'tokyo' and g.id = 'wasabi' then 0.95
    when c.id = 'new-york' and g.id in ('electronics', 'furniture') then 1.35
    when c.id = 'london' and g.id in ('coffee', 'banana', 'furniture') then 1.7
    when c.id = 'london' and g.category = 'material' then 1.3
    when c.id = 'singapore' and g.category = 'material' then 1.3
    when c.id = 'paris' and g.id in ('flour', 'wheat', 'pumpkin') then 1.35
    when c.id = 'berlin' and g.id in ('wheat', 'flour', 'potato') then 1.35
    when c.id = 'moscow' and g.category in ('farm') then 1.4
    when c.id = 'toronto' and g.category = 'material' then 1.3
    when c.id = 'sydney' and g.category in ('raw', 'fuel') then 0.95
    when c.id = 'shanghai' and g.category in ('raw', 'fuel') then 1.45
    when c.id = 'mumbai' and g.id in ('rice', 'wheat') then 1.35
    when c.id = 'rio' and g.id in ('coffee', 'banana') then 0.9
    when c.id = 'mexico-city' and g.id in ('electronics', 'furniture') then 1.3
    when c.id = 'lagos' and g.category in ('material', 'fuel') then 1.35
    else 1.2
  end
from game.cities c cross join game.goods g
on conflict (city_id, good_id) do update set mult = excluded.mult;

insert into game.import_markets (city_id, good_id)
select c.id, g.id from game.cities c cross join game.goods g
on conflict do nothing;

-- A chat room for every city.
select game.ensure_city_channels();
