-- CranCapital content catalog: goods, menu items and products, business
-- types, fit-out items, factory recipes, deposits. All prices in mills
-- ($1 = 1000). Every number is a starting value to tune.

create table game.goods (
  id text primary key,
  name text not null,
  category text not null check (category in ('farm', 'raw', 'material', 'fuel', 'finished')),
  base_price bigint not null check (base_price > 0),
  depth bigint not null, -- units traded with market traders that move their price ~10%
  warm_only boolean not null default false,
  icon text not null,
  sort smallint not null default 0,
  description text
);

insert into game.goods (id, name, category, base_price, depth, warm_only, icon, sort, description) values
  ('lettuce', 'Lettuce', 'farm', 80, 120000, false, '🥬', 1, 'Leafy greens for salads and wraps.'),
  ('tomato', 'Tomato', 'farm', 120, 120000, false, '🍅', 2, 'Goes into salads, pasta and toast.'),
  ('banana', 'Banana', 'farm', 150, 100000, true, '🍌', 3, 'Grows only in warm cities.'),
  ('pumpkin', 'Pumpkins', 'farm', 330, 60000, false, '🎃', 4, 'Soup, risotto and lattes.'),
  ('wasabi', 'Wasabi', 'farm', 60, 150000, false, '🌱', 5, 'A sharp root for sushi and onigiri.'),
  ('wheat', 'Wheat', 'farm', 50, 200000, false, '🌾', 6, 'Milled into flour.'),
  ('potato', 'Potato', 'farm', 70, 150000, false, '🥔', 7, 'Chips and bakes.'),
  ('rice', 'Rice', 'farm', 90, 150000, false, '🍚', 8, 'Sushi, onigiri and risotto.'),
  ('coffee', 'Coffee beans', 'farm', 400, 40000, true, '🫘', 9, 'Grows only in warm cities.'),
  ('coal', 'Coal', 'raw', 7000, 4000, false, '⚫', 20, 'Fuel for steel, glass and cement.'),
  ('iron_ore', 'Iron Ore', 'raw', 8000, 4000, false, '🪨', 21, 'Smelted into steel.'),
  ('crude_oil', 'Crude Oil', 'raw', 8000, 4000, false, '🛢️', 22, 'Refined into diesel and plastic.'),
  ('limestone', 'Limestone', 'raw', 3000, 6000, false, '🧱', 23, 'The main ingredient of concrete.'),
  ('sand', 'Sand', 'raw', 1500, 8000, false, '⏳', 24, 'For glass and concrete.'),
  ('copper_ore', 'Copper Ore', 'raw', 9000, 3500, false, '🟠', 25, 'Smelted into copper.'),
  ('timber', 'Timber', 'raw', 5000, 5000, false, '🪵', 26, 'Cut into planks.'),
  ('flour', 'Flour', 'material', 200, 200000, false, '🥖', 40, 'Milled wheat for bread, pasta and wraps.'),
  ('concrete', 'Concrete', 'material', 12000, 3000, false, '🏗️', 41, 'Building material from cement works.'),
  ('steel', 'Steel', 'material', 30000, 2000, false, '🔩', 42, 'From iron ore and coal.'),
  ('glass', 'Glass', 'material', 9000, 3000, false, '🪟', 43, 'From sand and coal.'),
  ('copper', 'Copper', 'material', 32000, 1500, false, '🧲', 44, 'Wire for electronics.'),
  ('plastic', 'Plastic', 'material', 10000, 2500, false, '🧴', 45, 'Refined from crude oil.'),
  ('planks', 'Planks', 'material', 3500, 5000, false, '🪚', 46, 'Sawn timber for furniture.'),
  ('diesel', 'Diesel', 'fuel', 15000, 3000, false, '⛽', 50, 'Fuel that mines, factories and ports burn.'),
  ('ready_meal', 'Ready Meals', 'finished', 1800, 20000, false, '🍱', 60, 'Packaged meals for grocery shelves.'),
  ('furniture', 'Furniture', 'finished', 60000, 600, false, '🛋️', 61, 'Sold in furniture stores.'),
  ('electronics', 'Electronics', 'finished', 80000, 500, false, '📱', 62, 'Sold in electronics stores.');

-- Things businesses sell to the crowds: dishes, drinks and shop products.
-- ingredients: {good_id: units used per sale}, drawn from the owner's
-- storage in the business's city.
create table game.menu_items (
  id text primary key,
  name text not null,
  category text not null check (category in ('street', 'cafe', 'restaurant', 'grocery', 'furniture', 'electronics')),
  fair_price bigint not null,
  ingredients jsonb not null,
  icon text not null,
  sort smallint not null default 0
);

insert into game.menu_items (id, name, category, fair_price, ingredients, icon, sort) values
  ('salad', 'Garden Salad', 'street', 4000, '{"lettuce":3,"tomato":2}', '🥗', 1),
  ('wrap', 'Veggie Wrap', 'street', 5000, '{"flour":1,"lettuce":2,"tomato":1}', '🌯', 2),
  ('chips', 'Hot Chips', 'street', 3500, '{"potato":3}', '🍟', 3),
  ('smoothie', 'Banana Smoothie', 'street', 4500, '{"banana":3}', '🥤', 4),
  ('soup', 'Pumpkin Soup', 'street', 4500, '{"pumpkin":2}', '🍲', 5),
  ('onigiri', 'Onigiri', 'street', 3000, '{"rice":2,"wasabi":1}', '🍙', 6),
  ('coffee_to_go', 'Coffee to Go', 'street', 3000, '{"coffee":1}', '☕', 7),
  ('flat_white', 'Flat White', 'cafe', 3800, '{"coffee":1}', '☕', 10),
  ('banana_bread', 'Banana Bread', 'cafe', 4200, '{"flour":1,"banana":2}', '🍞', 11),
  ('pumpkin_latte', 'Pumpkin Spice Latte', 'cafe', 5000, '{"coffee":1,"pumpkin":1}', '🎃', 12),
  ('tomato_toast', 'Tomato Toast', 'cafe', 4000, '{"flour":1,"tomato":2}', '🥪', 13),
  ('side_salad', 'Side Salad', 'cafe', 3500, '{"lettuce":2,"tomato":1}', '🥗', 14),
  ('pasta', 'Pasta Pomodoro', 'restaurant', 14000, '{"flour":2,"tomato":4}', '🍝', 20),
  ('sushi', 'Sushi Plate', 'restaurant', 18000, '{"rice":4,"wasabi":2}', '🍣', 21),
  ('risotto', 'Pumpkin Risotto', 'restaurant', 16000, '{"rice":3,"pumpkin":2}', '🥘', 22),
  ('potato_bake', 'Potato Bake', 'restaurant', 12000, '{"potato":4,"tomato":1}', '🥔', 23),
  ('garden_bowl', 'Garden Bowl', 'restaurant', 11000, '{"lettuce":4,"tomato":3,"rice":1}', '🥙', 24),
  ('pancakes', 'Banana Pancakes', 'restaurant', 9000, '{"flour":1,"banana":2}', '🥞', 25),
  ('veg_box', 'Veg Box', 'grocery', 3500, '{"lettuce":4,"tomato":4,"potato":6}', '🧺', 30),
  ('fruit_bag', 'Fruit Bag', 'grocery', 2500, '{"banana":6}', '🍌', 31),
  ('whole_pumpkin', 'Whole Pumpkin', 'grocery', 1500, '{"pumpkin":1}', '🎃', 32),
  ('rice_sack', 'Rice Sack', 'grocery', 2500, '{"rice":10}', '🍚', 33),
  ('flour_bag', 'Bag of Flour', 'grocery', 2000, '{"flour":5}', '🥖', 34),
  ('meal_deal', 'Ready Meal', 'grocery', 4500, '{"ready_meal":1}', '🍱', 35),
  ('coffee_pack', 'Coffee Beans', 'grocery', 5000, '{"coffee":5}', '🫘', 36),
  ('chair', 'Chair', 'furniture', 110000, '{"furniture":1}', '🪑', 40),
  ('dining_set', 'Dining Set', 'furniture', 300000, '{"furniture":3}', '🍽️', 41),
  ('sofa', 'Sofa', 'furniture', 420000, '{"furniture":4}', '🛋️', 42),
  ('phone', 'Phone', 'electronics', 140000, '{"electronics":1}', '📱', 50),
  ('tv', 'Television', 'electronics', 280000, '{"electronics":2}', '📺', 51),
  ('laptop', 'Laptop', 'electronics', 400000, '{"electronics":3}', '💻', 52);

-- Factory recipes: inputs -> outputs per cycle.
create table game.recipes (
  id text primary key,
  name text not null,
  inputs jsonb not null,
  outputs jsonb not null,
  cycles_per_hour numeric not null,
  diesel_per_hour numeric not null default 0
);

insert into game.recipes (id, name, inputs, outputs, cycles_per_hour, diesel_per_hour) values
  ('flour', 'Mill wheat into flour', '{"wheat":2}', '{"flour":1}', 6000, 0),
  ('ready_meal', 'Cook ready meals', '{"flour":2,"tomato":3,"pumpkin":1}', '{"ready_meal":1}', 1000, 1),
  ('steel', 'Make steel', '{"iron_ore":2,"coal":1}', '{"steel":1}', 200, 2),
  ('refine', 'Refine crude oil', '{"crude_oil":2}', '{"diesel":1,"plastic":1}', 150, 0),
  ('concrete', 'Make concrete', '{"limestone":2,"sand":1,"coal":1}', '{"concrete":2}', 100, 2),
  ('glass', 'Make glass', '{"sand":3,"coal":1}', '{"glass":2}', 120, 2),
  ('copper', 'Smelt copper', '{"copper_ore":2,"coal":1}', '{"copper":1}', 150, 2),
  ('planks', 'Saw planks', '{"timber":1}', '{"planks":2}', 400, 1),
  ('furniture', 'Build furniture', '{"planks":4,"steel":1}', '{"furniture":1}', 60, 1),
  ('electronics', 'Assemble electronics', '{"copper":1,"plastic":1,"glass":1}', '{"electronics":1}', 40, 1);

-- Business types. placement: street (a cart on a walkable street), room
-- (rented room in a building), plot (bought land), coastal (land by open
-- water), deposit (a surveyed mineral deposit's plot).
create table game.business_types (
  id text primary key,
  name text not null,
  tier smallint not null,
  placement text not null check (placement in ('street', 'room', 'plot', 'coastal', 'deposit')),
  menu_category text,
  cost bigint not null,
  upkeep_per_hour bigint not null default 0,
  staff_fixed int not null default 0,
  per_staff numeric not null default 0,
  base_cph numeric not null default 0,
  max_level smallint not null default 5,
  produces text, -- 'crop' | good id | 'recipe' | 'storage' | 'rent' | 'export' | 'bank'
  resource text,
  recipe text references game.recipes(id),
  rate_per_hour numeric not null default 0,
  storage_capacity bigint not null default 0,
  icon text not null,
  sort smallint not null default 0,
  description text not null
);

insert into game.business_types
  (id, name, tier, placement, menu_category, cost, upkeep_per_hour, staff_fixed, per_staff, base_cph, max_level, produces, resource, recipe, rate_per_hour, storage_capacity, icon, sort, description) values
  ('cart', 'Food cart', 1, 'street', 'street', 5000000, 2000, 0, 0, 60, 3, null, null, null, 0, 0, '🛒', 1,
   'Park it where crowds pass, pick up to 3 dishes, set prices and keep your storage stocked.'),
  ('cafe', 'Café', 2, 'room', 'cafe', 8000000, 1000, 0, 18, 70, 5, null, null, null, 0, 0, '☕', 10,
   'Coffee and light bites. Busiest in the morning.'),
  ('restaurant', 'Restaurant', 2, 'room', 'restaurant', 15000000, 2000, 0, 10, 45, 5, null, null, null, 0, 0, '🍽️', 11,
   'Sit-down dining. Busiest at lunch and in the evening.'),
  ('grocery', 'Grocery', 2, 'room', 'grocery', 10000000, 1500, 0, 25, 55, 5, null, null, null, 0, 0, '🧺', 12,
   'Sells fresh produce and ready meals by the bag.'),
  ('furniture_store', 'Furniture store', 2, 'room', 'furniture', 25000000, 3000, 0, 6, 14, 5, null, null, null, 0, 0, '🛋️', 13,
   'Few customers, big tickets. Stock it with furniture from the exchange or your own factory.'),
  ('electronics_store', 'Electronics store', 2, 'room', 'electronics', 30000000, 3000, 0, 6, 16, 5, null, null, null, 0, 0, '📱', 14,
   'Phones, TVs and laptops. Stock it with electronics.'),
  ('farm', 'Farm', 3, 'plot', null, 40000000, 8000, 1, 0, 0, 5, 'crop', null, null, 0, 0, '🚜', 20,
   'Grows one crop on your plot, straight into your storage.'),
  ('tree_farm', 'Tree farm', 3, 'plot', null, 35000000, 6000, 1, 0, 0, 5, 'timber', null, null, 36, 0, '🌲', 21,
   'Grows timber for sawmills.'),
  ('yard', 'Storage yard', 3, 'plot', null, 25000000, 3000, 0, 0, 0, 5, 'storage', null, null, 0, 250000, '📦', 22,
   'Adds 250,000 units of storage in this city per level.'),
  ('apartments', 'Apartment block', 3, 'plot', null, 80000000, 5000, 1, 0, 0, 5, 'rent', null, null, 40, 0, '🏢', 23,
   'Homes for local tenants who pay rent every day.'),
  ('coal_mine', 'Coal mine', 4, 'deposit', null, 150000000, 10000, 3, 0, 0, 5, 'coal', 'coal', null, 240, 0, '⛏️', 30,
   'Digs out a surveyed coal seam.'),
  ('iron_mine', 'Iron mine', 4, 'deposit', null, 150000000, 10000, 3, 0, 0, 5, 'iron_ore', 'iron_ore', null, 200, 0, '⛏️', 31,
   'Digs out a surveyed iron ore deposit.'),
  ('copper_mine', 'Copper mine', 4, 'deposit', null, 160000000, 10000, 3, 0, 0, 5, 'copper_ore', 'copper_ore', null, 180, 0, '⛏️', 32,
   'Digs out a surveyed copper deposit.'),
  ('limestone_quarry', 'Limestone quarry', 4, 'deposit', null, 120000000, 8000, 3, 0, 0, 5, 'limestone', 'limestone', null, 540, 0, '🪨', 33,
   'Cuts limestone from a surveyed deposit.'),
  ('sand_pit', 'Sand pit', 4, 'deposit', null, 100000000, 6000, 2, 0, 0, 5, 'sand', 'sand', null, 1100, 0, '⏳', 34,
   'Digs sand from a surveyed deposit.'),
  ('oil_well', 'Oil well', 4, 'deposit', null, 180000000, 12000, 3, 0, 0, 5, 'crude_oil', 'crude_oil', null, 200, 0, '🛢️', 35,
   'Pumps crude oil from a surveyed field.'),
  ('mill', 'Flour mill', 5, 'plot', null, 150000000, 10000, 3, 0, 0, 5, 'recipe', null, 'flour', 0, 0, '🏭', 40,
   'Mills wheat into flour.'),
  ('food_factory', 'Food factory', 5, 'plot', null, 250000000, 20000, 6, 0, 0, 5, 'recipe', null, 'ready_meal', 0, 0, '🏭', 41,
   'Cooks flour, tomatoes and pumpkins into ready meals.'),
  ('steel_mill', 'Steel mill', 5, 'plot', null, 500000000, 40000, 8, 0, 0, 5, 'recipe', null, 'steel', 0, 0, '🏭', 42,
   'Turns iron ore and coal into steel.'),
  ('refinery', 'Refinery', 5, 'plot', null, 600000000, 40000, 8, 0, 0, 5, 'recipe', null, 'refine', 0, 0, '🏭', 43,
   'Refines crude oil into diesel and plastic.'),
  ('cement_works', 'Cement works', 5, 'plot', null, 400000000, 25000, 6, 0, 0, 5, 'recipe', null, 'concrete', 0, 0, '🏭', 44,
   'Makes concrete.'),
  ('glassworks', 'Glassworks', 5, 'plot', null, 350000000, 20000, 6, 0, 0, 5, 'recipe', null, 'glass', 0, 0, '🏭', 45,
   'Melts sand into glass.'),
  ('smelter', 'Copper smelter', 5, 'plot', null, 500000000, 35000, 8, 0, 0, 5, 'recipe', null, 'copper', 0, 0, '🏭', 46,
   'Smelts copper ore.'),
  ('sawmill', 'Sawmill', 5, 'plot', null, 300000000, 15000, 4, 0, 0, 5, 'recipe', null, 'planks', 0, 0, '🏭', 47,
   'Saws timber into planks.'),
  ('furniture_factory', 'Furniture factory', 5, 'plot', null, 450000000, 30000, 8, 0, 0, 5, 'recipe', null, 'furniture', 0, 0, '🏭', 48,
   'Builds furniture from planks and steel.'),
  ('electronics_plant', 'Electronics plant', 5, 'plot', null, 700000000, 50000, 10, 0, 0, 5, 'recipe', null, 'electronics', 0, 0, '🏭', 49,
   'Assembles electronics from copper, plastic and glass.'),
  ('port', 'Port', 5, 'coastal', null, 750000000, 30000, 10, 0, 0, 5, 'export', null, null, 20000, 0, '⚓', 60,
   'Ships your goods to other cities and sells exports to overseas buyers.'),
  ('bank', 'Bank', 6, 'room', null, 2000000000, 20000, 5, 0, 0, 5, 'bank', null, null, 0, 0, '🏦', 70,
   'Lend your capital to other players at the interest rate you set.');

-- Crop yields per farm per hour at level 1.
create table game.crops (
  good_id text primary key references game.goods(id),
  per_hour numeric not null
);
insert into game.crops (good_id, per_hour) values
  ('lettuce', 2250), ('tomato', 1500), ('banana', 1200), ('pumpkin', 550), ('wasabi', 3000),
  ('wheat', 3600), ('potato', 2600), ('rice', 2000), ('coffee', 450);

-- Fit-out items for rooms. cap: customers per hour this item lets the room
-- serve, by business category. decor: attractiveness points.
create table game.fitout_items (
  id text primary key,
  name text not null,
  cost bigint not null,
  cap jsonb not null default '{}'::jsonb,
  decor numeric not null default 0,
  required_for text[] not null default '{}',
  icon text not null,
  sort smallint not null default 0
);

insert into game.fitout_items (id, name, cost, cap, decor, required_for, icon, sort) values
  ('counter', 'Service counter', 2000000, '{"cafe":15,"restaurant":6,"grocery":15,"furniture":3,"electronics":3,"bank":0}', 0,
     '{cafe,restaurant,grocery,furniture,electronics,bank}', '🧾', 1),
  ('table2', 'Table for two', 600000, '{"cafe":4,"restaurant":3}', 0, '{}', '🪑', 2),
  ('table4', 'Table for four', 1000000, '{"cafe":7,"restaurant":6}', 0, '{}', '🍽️', 3),
  ('booth', 'Booth', 1800000, '{"restaurant":10,"cafe":8}', 0.5, '{}', '🛋️', 4),
  ('kitchen', 'Kitchen station', 6000000, '{"restaurant":18,"cafe":10}', 0, '{restaurant}', '🍳', 5),
  ('coffee_machine', 'Espresso machine', 3500000, '{"cafe":30}', 0, '{cafe}', '☕', 6),
  ('shelf', 'Shelving', 800000, '{"grocery":10,"furniture":2,"electronics":2}', 0, '{grocery}', '🗄️', 7),
  ('fridge', 'Chiller cabinet', 1500000, '{"grocery":16}', 0, '{}', '🧊', 8),
  ('display', 'Display stand', 1200000, '{"furniture":4,"electronics":4,"grocery":4}', 1, '{furniture,electronics}', '🖼️', 9),
  ('plant', 'Plants', 300000, '{}', 1, '{}', '🪴', 10),
  ('art', 'Artwork', 1500000, '{}', 2, '{}', '🎨', 11),
  ('lighting', 'Feature lighting', 2500000, '{}', 3, '{}', '💡', 12),
  ('safe', 'Vault', 8000000, '{"bank":0}', 0, '{bank}', '🔐', 13);

-- Import price multipliers: how much each city's overseas buyers pay
-- relative to base when goods arrive by port.
create table game.import_prices (
  city_id text not null,
  good_id text not null references game.goods(id),
  mult numeric not null,
  primary key (city_id, good_id)
);

-- Deposit generation per resource: chance per surveyed block and size range.
create table game.deposit_types (
  resource text primary key references game.goods(id),
  business_type text not null references game.business_types(id),
  weight numeric not null,
  min_units bigint not null,
  max_units bigint not null
);
insert into game.deposit_types (resource, business_type, weight, min_units, max_units) values
  ('coal', 'coal_mine', 20, 40000, 160000),
  ('iron_ore', 'iron_mine', 18, 35000, 140000),
  ('copper_ore', 'copper_mine', 10, 25000, 110000),
  ('limestone', 'limestone_quarry', 20, 90000, 350000),
  ('sand', 'sand_pit', 20, 150000, 600000),
  ('crude_oil', 'oil_well', 12, 35000, 150000);

-- Tiers: what each one adds, and the net worth that unlocks it.
create table game.tiers (
  tier smallint primary key,
  name text not null,
  idea text not null,
  config_key text
);
insert into game.tiers (tier, name, idea, config_key) values
  (1, 'Food carts', 'Location and pricing', null),
  (2, 'Shops and restaurants', 'Rent, staff wages, fit-out, selling while offline', 'tier2_net_worth'),
  (3, 'Land and buildings', 'Owning property, landlord income', 'tier3_net_worth'),
  (4, 'Mining and surveys', 'Raw materials, private information', 'tier4_net_worth'),
  (5, 'Industry: factories and ports', 'Supply chains, shipping time and cost', 'tier5_net_worth'),
  (6, 'Finance', 'Credit, risk and investment', 'tier6_net_worth');

create function game.tier_threshold(p_tier int) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select game.cfg(config_key) from game.tiers where tier = p_tier), 0)::bigint
$$;
