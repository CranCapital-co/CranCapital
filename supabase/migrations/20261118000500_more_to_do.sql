-- Reasons to open the game today:
--   1. Daily goals: three small goals a day that pay loyalty points.
--   2. Contracts: orders from the city ("a hotel near Trafalgar Square wants
--      400 lettuce by 6 pm"). Accept with a deposit, deliver from storage for
--      a price above the market and your deposit back; miss it and the
--      deposit is lost.
--   3. City projects: everyone in a city gives goods toward something big (a
--      market hall). Givers get a thank-you payment; when it's finished a
--      landmark appears and foot traffic nearby rises for good.
--   4. Shop decorations: awnings, neon signs, flower boxes, lights, bought
--      with loyalty points. Looks only, never power.
-- Every change to cash goes through game.money() into the ledger; goods move
-- with game.stock_add().

insert into game.ledger_kinds (kind, label, flow) values
  ('contract_deposit', 'Contract deposits', 'world_out'),
  ('contract_refund', 'Contract deposits returned', 'world_in'),
  ('contract_pay', 'Contract payments', 'world_in'),
  ('project_reward', 'City project thank-yous', 'world_in')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Daily goals
-- ---------------------------------------------------------------------------
create table game.goal_templates (
  kind text primary key,
  title text not null, -- %s is the target
  target bigint not null, -- at tier 1; bigger at higher tiers
  reward int not null, -- loyalty points
  starter boolean not null default false,
  weight int not null default 1,
  money boolean not null default false -- the target is an amount (mills)
);
insert into game.goal_templates (kind, title, target, reward, starter, weight, money) values
  ('starter_sell', 'Sell %s meals', 10, 25, true, 1, false),
  ('starter_earn', 'Earn %s from sales', 500000, 25, true, 1, true),
  ('starter_price', 'Change a price on your menu', 1, 25, true, 1, false),
  ('sell', 'Sell %s things to customers', 50, 30, false, 3, false),
  ('earn', 'Earn %s from sales', 2000000, 30, false, 3, true),
  ('trade', 'Make %s trades on the exchange', 2, 20, false, 2, false),
  ('upgrade', 'Upgrade a business', 1, 40, false, 1, false),
  ('contract', 'Deliver a contract', 1, 40, false, 1, false),
  ('project', 'Give goods to a city project', 1, 30, false, 1, false);

create table game.goals (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id) on delete cascade,
  day date not null,
  kind text not null references game.goal_templates(kind),
  title text not null,
  target bigint not null,
  reward int not null,
  base bigint not null default 0, -- the counter's value when the goal was set
  created_at timestamptz not null default now(),
  claimed boolean not null default false,
  unique (player_id, day, kind)
);
create index goals_player_day_idx on game.goals (player_id, day);

-- The counter each goal kind watches, right now.
create function game.goal_counter(p_player uuid, p_kind text, p_since timestamptz) returns bigint
language plpgsql stable set search_path = game, pg_temp as $$
begin
  return case
    when p_kind in ('starter_sell', 'sell') then (select coalesce(sum(lifetime_sales), 0) from game.businesses where owner_id = p_player)
    when p_kind in ('starter_earn', 'earn') then (select coalesce(sum(lifetime_revenue), 0) from game.businesses where owner_id = p_player)
    when p_kind = 'trade' then (select count(*) from game.trades where (buyer_id = p_player or seller_id = p_player) and at >= p_since)
    when p_kind = 'upgrade' then (select count(*) from game.ledger where player_id = p_player and kind = 'upgrade' and at >= p_since)
    when p_kind = 'contract' then (select count(*) from game.contracts where taker_id = p_player and status = 'done' and done_at >= p_since)
    when p_kind = 'project' then (select count(*) from game.project_contributions where player_id = p_player and at >= p_since)
    -- A changed price: any menu item away from its fair price.
    when p_kind = 'starter_price' then (select count(*) from game.businesses b, jsonb_array_elements(coalesce(b.settings -> 'menu', '[]'::jsonb)) m
                                          join game.menu_items mi on mi.id = m ->> 'id'
                                         where b.owner_id = p_player and (m ->> 'price')::bigint <> mi.fair_price)
    else 0 end;
end $$;

create function game.goal_progress(g game.goals) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select greatest(0, game.goal_counter(g.player_id, g.kind, g.created_at) - g.base)
$$;

create function game.ensure_goals(p game.players) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_starter boolean := p.days_played <= 1 and p.tier = 1;
  t record;
  v_mult bigint := greatest(1, p.tier);
  v_target bigint;
begin
  if exists (select 1 from game.goals where player_id = p.id and day = v_day) then return; end if;
  for t in
    select * from game.goal_templates
     where starter = v_starter
       and (kind <> 'contract' or p.tier >= 2) and (kind <> 'project' or p.tier >= 3)
     order by case when v_starter then 0 else -ln(random()) / weight end
     limit 3
  loop
    v_target := case when t.starter or t.kind in ('upgrade', 'contract', 'project') then t.target else t.target * v_mult end;
    insert into game.goals (player_id, day, kind, title, target, reward, base)
    values (p.id, v_day, t.kind,
            case when t.money then format(t.title, '$' || to_char(v_target / 1000.0, 'FM999,999,990')) else format(t.title, v_target) end,
            v_target, t.reward,
            case when t.kind = 'starter_price' then 0 else game.goal_counter(p.id, t.kind, now()) end)
    on conflict do nothing;
  end loop;
end $$;

create function public.my_goals() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  perform game.ensure_goals(p);
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'kind', g.kind, 'title', g.title, 'target', g.target,
      'progress', least(g.target, game.goal_progress(g)), 'reward_points', g.reward, 'claimed', g.claimed, 'day', g.day) order by g.id)
    from game.goals g where g.player_id = p.id and g.day = (now() at time zone 'utc')::date), '[]'::jsonb);
end $$;

create function public.claim_goal(p_id bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  g game.goals;
begin
  perform game.rate_limit(p.id::text, 'claim_goal', 10, 10);
  select * into g from game.goals where id = p_id and player_id = p.id for update;
  if not found then perform game.fail('That goal isn''t yours.'); end if;
  if g.day <> (now() at time zone 'utc')::date then perform game.fail('That goal has ended. New goals start each day.'); end if;
  if g.claimed then perform game.fail('You''ve already collected this one.'); end if;
  if game.goal_progress(g) < g.target then perform game.fail('Not done yet: keep going!'); end if;
  update game.goals set claimed = true where id = g.id;
  update game.players set loyalty_points = loyalty_points + g.reward where id = p.id;
  return jsonb_build_object('reward_points', g.reward);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Contracts
-- ---------------------------------------------------------------------------
create table game.contracts (
  id bigint generated always as identity primary key,
  city_id text not null references game.cities(id),
  client text not null,
  good_id text not null references game.goods(id),
  qty bigint not null check (qty > 0),
  pay_per_unit bigint not null check (pay_per_unit > 0),
  deposit bigint not null check (deposit >= 0),
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'taken', 'done', 'failed', 'expired')),
  taker_id uuid references game.players(id),
  taken_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index contracts_city_status_idx on game.contracts (city_id, status);
create index contracts_taker_idx on game.contracts (taker_id) where status = 'taken';

create table game.contract_clients (city_id text not null, client text not null);
insert into game.contract_clients (city_id, client) values
  ('london', 'A hotel near Trafalgar Square'), ('london', 'A Covent Garden caterer'), ('london', 'A builder in Southwark'), ('london', 'A department store on Oxford Street'),
  ('new-york', 'A Midtown hotel'), ('new-york', 'A deli on 8th Avenue'), ('new-york', 'A contractor in Brooklyn'), ('new-york', 'A Fifth Avenue store'),
  ('tokyo', 'A hotel by Tokyo Station'), ('tokyo', 'A ramen chain in Shinjuku'), ('tokyo', 'A builder in Shibuya'), ('tokyo', 'A Ginza department store'),
  ('singapore', 'A Marina Bay hotel'), ('singapore', 'A hawker centre in Chinatown'), ('singapore', 'A shipyard in Jurong'), ('singapore', 'An Orchard Road mall'),
  ('paris', 'A hotel near the Louvre'), ('paris', 'A bistro in the Marais'), ('paris', 'A builder in La Défense'), ('paris', 'A grand magasin on Boulevard Haussmann');

-- Open new orders and close old ones. Runs every hour (and on demand).
create function game.contracts_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  c record;
  g record;
  v_need int;
  v_value numeric;
  v_qty bigint;
  r record;
begin
  -- Missed deadlines: the deposit stays with the city.
  for r in update game.contracts set status = 'failed' where status = 'taken' and due_at < now() returning * loop
    perform game.notify(r.taker_id, 'contract', 'Contract missed', format('%s didn''t get their %s in time. Your deposit is lost.', r.client, (select lower(name) from game.goods where id = r.good_id)), jsonb_build_object('contract', r.id));
  end loop;
  update game.contracts set status = 'expired' where status = 'open' and due_at < now() + interval '1 hour';
  for c in select id from game.cities where open loop
    v_need := 4 - (select count(*) from game.contracts where city_id = c.id and status = 'open');
    while v_need > 0 loop
      select gd.id, gd.name, m.ref_price into g
        from game.goods gd join game.markets m on m.good_id = gd.id
       where not gd.warm_only or (select climate from game.cities where id = c.id) = 'warm'
       order by random() limit 1;
      -- $1,000 to $15,000 of goods, in a round amount someone can store:
      -- between 50 and 20,000 units.
      v_value := 1000000 + random() * 14000000;
      v_qty := least(20000, greatest(50, round(v_value / greatest(1, g.ref_price) / 50) * 50));
      insert into game.contracts (city_id, client, good_id, qty, pay_per_unit, deposit, due_at)
      values (c.id, (select client from game.contract_clients where city_id = c.id order by random() limit 1), g.id, v_qty,
              greatest(1, round(g.ref_price * 1.3)), round(v_qty * g.ref_price * 0.1),
              date_trunc('hour', now()) + make_interval(hours => 3 + floor(random() * 6)::int));
      v_need := v_need - 1;
    end loop;
  end loop;
end $$;

create function public.city_contracts(p_city text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  if not exists (select 1 from game.contracts where city_id = p_city and status = 'open') then perform game.contracts_tick(); end if;
  return jsonb_build_object(
    'open', coalesce((select jsonb_agg(to_jsonb(x) order by x.due_at) from (
      select c.id, c.city_id, c.client, c.good_id, c.qty, c.pay_per_unit, c.deposit, c.due_at, c.qty * c.pay_per_unit as total
        from game.contracts c where c.city_id = p_city and c.status = 'open') x), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(to_jsonb(x) order by x.due_at) from (
      select c.id, c.city_id, c.client, c.good_id, c.qty, c.pay_per_unit, c.deposit, c.due_at, c.status, c.qty * c.pay_per_unit as total,
             coalesce((select qty from game.storage s where s.owner_id = p.id and s.city_id = c.city_id and s.good_id = c.good_id), 0) as have
        from game.contracts c where c.taker_id = p.id and (c.status = 'taken' or c.done_at > now() - interval '1 day')) x), '[]'::jsonb));
end $$;

create function public.accept_contract(p_id bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.contracts;
begin
  perform game.rate_limit(p.id::text, 'contract', 10, 6);
  if p.tier < 2 then perform game.fail('Contracts open at tier 2.'); end if;
  select * into c from game.contracts where id = p_id for update;
  if not found then perform game.fail('That contract doesn''t exist.'); end if;
  if c.status <> 'open' then perform game.fail('Someone else took that contract.'); end if;
  if c.due_at < now() + interval '30 minutes' then perform game.fail('Too late to take that one.'); end if;
  if (select count(*) from game.contracts where taker_id = p.id and status = 'taken') >= 3 then
    perform game.fail('You can hold three contracts at a time. Deliver one first.');
  end if;
  if p.cash < c.deposit then perform game.fail('You need the deposit in cash.'); end if;
  perform game.money(p.id, -c.deposit, 'contract_deposit', format('Deposit: %s, %s %s', c.client, c.qty, (select lower(name) from game.goods where id = c.good_id)), jsonb_build_object('contract', c.id));
  update game.contracts set status = 'taken', taker_id = p.id, taken_at = now() where id = c.id;
  return jsonb_build_object('id', c.id, 'deposit', c.deposit, 'due_at', c.due_at);
end $$;

create function public.deliver_contract(p_id bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.contracts;
  v_pay bigint;
begin
  perform game.rate_limit(p.id::text, 'contract', 10, 6);
  select * into c from game.contracts where id = p_id for update;
  if not found or c.taker_id is distinct from p.id then perform game.fail('That isn''t your contract.'); end if;
  if c.status <> 'taken' then perform game.fail('That contract is already closed.'); end if;
  if c.due_at < now() then perform game.fail('Too late: the deadline has passed.'); end if;
  perform game.stock_add(p.id, c.city_id, c.good_id, -c.qty); -- fails if you don't have it all
  v_pay := c.qty * c.pay_per_unit;
  perform game.money(p.id, v_pay, 'contract_pay', format('Delivered to %s', c.client), jsonb_build_object('contract', c.id));
  if c.deposit > 0 then
    perform game.money(p.id, c.deposit, 'contract_refund', format('Deposit back from %s', c.client), jsonb_build_object('contract', c.id));
  end if;
  update game.contracts set status = 'done', done_at = now() where id = c.id;
  return jsonb_build_object('paid', v_pay, 'deposit', c.deposit);
end $$;

-- ---------------------------------------------------------------------------
-- 3. City projects
-- ---------------------------------------------------------------------------
create table game.city_projects (
  id bigint generated always as identity primary key,
  city_id text not null references game.cities(id),
  kind text not null,
  name text not null,
  description text not null,
  lat float8 not null,
  lng float8 not null,
  needs jsonb not null, -- good -> qty
  given jsonb not null default '{}'::jsonb,
  traffic_bonus numeric not null default 0.15,
  status text not null default 'open' check (status in ('open', 'done')),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table game.project_contributions (
  id bigint generated always as identity primary key,
  project_id bigint not null references game.city_projects(id),
  player_id uuid not null references game.players(id) on delete cascade,
  good_id text not null references game.goods(id),
  qty bigint not null,
  value bigint not null,
  at timestamptz not null default now()
);
create index project_contrib_idx on game.project_contributions (project_id, player_id);

-- One project per city to start: a market hall near the start point.
-- Seeded for any city that has none (cities can arrive after this runs).
create function game.seed_city_projects() returns void
language sql set search_path = game, pg_temp as $$
  insert into game.city_projects (city_id, kind, name, description, lat, lng, needs)
  select c.id, 'market_hall', c.name || ' Market Hall',
         'A covered market for the whole city. When it''s built, foot traffic within 400 m rises by 15% for good.',
         c.start_lat + 0.0012, c.start_lng + 0.0016,
         (select jsonb_object_agg(g.id, greatest(100, round(400000000 / g.base_price / 100) * 100)) from game.goods g where g.id in ('concrete', 'steel', 'glass', 'planks'))
    from game.cities c
   where not exists (select 1 from game.city_projects p where p.city_id = c.id);
$$;
select game.seed_city_projects();

create function public.city_projects(p_city text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
begin
  if not exists (select 1 from game.city_projects where city_id = p_city) then perform game.seed_city_projects(); end if;
  return coalesce((
    select jsonb_agg(x.j order by x.id)
      from (
        select pr.id, jsonb_build_object('id', pr.id, 'city_id', pr.city_id, 'kind', pr.kind, 'name', pr.name, 'description', pr.description,
          'lat', pr.lat, 'lng', pr.lng, 'needs', pr.needs, 'given', pr.given, 'status', pr.status, 'completed_at', pr.completed_at,
          'progress', (select coalesce(sum(least(coalesce((pr.given ->> k)::numeric, 0), (pr.needs ->> k)::numeric)), 0) / nullif(sum((pr.needs ->> k)::numeric), 0)
                         from jsonb_object_keys(pr.needs) k),
          'mine', (select coalesce(sum(value), 0) from game.project_contributions where project_id = pr.id and player_id = v_uid),
          'top', (select coalesce(jsonb_agg(jsonb_build_object('name', t.display_name, 'player_no', t.player_no, 'value', t.v) order by t.v desc), '[]'::jsonb)
                    from (select pl.display_name, pl.player_no, sum(pc.value) v
                            from game.project_contributions pc join game.players pl on pl.id = pc.player_id
                           where pc.project_id = pr.id group by pl.display_name, pl.player_no order by v desc limit 5) t)) as j
          from game.city_projects pr where pr.city_id = p_city
      ) x), '[]'::jsonb);
end $$;

create function public.contribute_project(p_project bigint, p_good text, p_qty bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  pr game.city_projects;
  v_need bigint;
  v_given bigint;
  v_qty bigint;
  v_value bigint;
  v_reward bigint;
  v_done boolean;
begin
  perform game.rate_limit(p.id::text, 'project', 20, 12);
  if p_qty is null or p_qty <= 0 then perform game.fail('Give at least one.'); end if;
  select * into pr from game.city_projects where id = p_project for update;
  if not found then perform game.fail('That project doesn''t exist.'); end if;
  if pr.status <> 'open' then perform game.fail('That project is finished. Thank you!'); end if;
  if not (pr.needs ? p_good) then perform game.fail('This project doesn''t need that.'); end if;
  v_need := (pr.needs ->> p_good)::bigint;
  v_given := coalesce((pr.given ->> p_good)::bigint, 0);
  v_qty := least(p_qty, v_need - v_given);
  if v_qty <= 0 then perform game.fail('It has all the ' || (select lower(name) from game.goods where id = p_good) || ' it needs.'); end if;
  perform game.stock_add(p.id, pr.city_id, p_good, -v_qty); -- from your storage in that city
  v_value := round(v_qty * (select ref_price from game.markets where good_id = p_good));
  v_reward := round(v_value * 0.6); -- the city pays 60% of market value as thanks
  perform game.money(p.id, v_reward, 'project_reward', format('Thanks for the %s', pr.name), jsonb_build_object('project', pr.id));
  update game.players set loyalty_points = loyalty_points + greatest(1, (v_value / 100000)::int) where id = p.id;
  insert into game.project_contributions (project_id, player_id, good_id, qty, value) values (pr.id, p.id, p_good, v_qty, v_value);
  update game.city_projects set given = given || jsonb_build_object(p_good, v_given + v_qty) where id = pr.id returning * into pr;
  select bool_and(coalesce((pr.given ->> k)::bigint, 0) >= (pr.needs ->> k)::bigint) into v_done from jsonb_object_keys(pr.needs) k;
  if v_done then
    update game.city_projects set status = 'done', completed_at = now() where id = pr.id;
    -- Foot traffic nearby rises for good.
    update game.businesses set traffic = traffic * (1 + pr.traffic_bonus)
     where city_id = pr.city_id and status in ('open', 'closed') and game.dist_m(lat, lng, pr.lat, pr.lng) < 400;
    perform game.notify(x.player_id, 'project', pr.name || ' is finished!', 'Thank you for helping build it. Foot traffic nearby is up for good.', jsonb_build_object('project', pr.id))
      from (select distinct player_id from game.project_contributions where project_id = pr.id) x;
  end if;
  return jsonb_build_object('given', v_qty, 'reward', v_reward, 'done', coalesce(v_done, false));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Shop decorations (looks only)
-- ---------------------------------------------------------------------------
create table game.decor_items (
  id text primary key,
  name text not null,
  kind text not null, -- awning, sign, flowers, lights
  cost_points int not null,
  sort int not null default 0
);
insert into game.decor_items (id, name, kind, cost_points, sort) values
  ('flower_boxes', 'Flower boxes', 'flowers', 30, 1),
  ('bunting', 'Bunting', 'lights', 35, 2),
  ('gold_awning', 'Gold striped awning', 'awning', 40, 3),
  ('potted_trees', 'Potted trees', 'flowers', 45, 4),
  ('string_lights', 'String lights', 'lights', 50, 5),
  ('neon_sign', 'Neon sign', 'sign', 60, 6),
  ('red_carpet', 'Red carpet', 'flowers', 80, 7);

create table game.business_decor (
  business_id bigint not null references game.businesses(id) on delete cascade,
  item_id text not null references game.decor_items(id),
  bought_at timestamptz not null default now(),
  primary key (business_id, item_id)
);

create function public.decor_catalog() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(d) order by d.sort), '[]'::jsonb) from game.decor_items d
$$;

create function public.buy_decor(p_business bigint, p_item text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  d game.decor_items;
begin
  perform game.rate_limit(p.id::text, 'decor', 10, 6);
  if not exists (select 1 from game.businesses where id = p_business and owner_id = p.id and status in ('open', 'closed')) then
    perform game.fail('You can only decorate your own businesses.');
  end if;
  select * into d from game.decor_items where id = p_item;
  if not found then perform game.fail('That decoration doesn''t exist.'); end if;
  if exists (select 1 from game.business_decor where business_id = p_business and item_id = p_item) then
    perform game.fail('It already has that.');
  end if;
  update game.players set loyalty_points = loyalty_points - d.cost_points where id = p.id and loyalty_points >= d.cost_points;
  if not found then perform game.fail(format('That costs %s loyalty points.', d.cost_points)); end if;
  insert into game.business_decor (business_id, item_id) values (p_business, p_item);
  return jsonb_build_object('item', p_item, 'points_left', (select loyalty_points from game.players where id = p.id));
end $$;

create function public.remove_decor(p_business bigint, p_item text) returns void
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
begin
  delete from game.business_decor d using game.businesses b
   where d.business_id = b.id and b.id = p_business and b.owner_id = p.id and d.item_id = p_item;
end $$;

-- The map also shows each business's decorations.
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
      'fill', case when b.kind = 'yard' and b.owner_id = v_uid then round(coalesce(v_fill, 0), 2) end,
      'decor', (select jsonb_agg(item_id order by item_id) from game.business_decor bd where bd.business_id = b.id)))
    from (select * from game.businesses
           where city_id = p_city and status in ('open', 'closed', 'abandoned', 'depleted')
             and lat between p_s and p_n and lng between p_w and p_e
           order by (owner_id = v_uid) desc, lifetime_revenue desc limit 800) b
    join game.players pl on pl.id = b.owner_id
    join game.business_types t on t.id = b.kind
    left join game.deposits d on d.id = b.deposit_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Security and jobs
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['goal_templates', 'goals', 'contracts', 'contract_clients', 'city_projects', 'project_contributions', 'decor_items', 'business_decor'] loop
    execute format('alter table game.%I enable row level security', t);
    execute format('revoke all on game.%I from public, anon, authenticated', t);
  end loop;
end $$;

revoke all on function public.my_goals(), public.claim_goal(bigint), public.city_contracts(text), public.accept_contract(bigint), public.deliver_contract(bigint),
  public.city_projects(text), public.contribute_project(bigint, text, bigint), public.decor_catalog(), public.buy_decor(bigint, text), public.remove_decor(bigint, text)
  from public, anon, authenticated;
grant execute on function public.my_goals(), public.claim_goal(bigint), public.city_contracts(text), public.accept_contract(bigint), public.deliver_contract(bigint),
  public.city_projects(text), public.contribute_project(bigint, text, bigint), public.decor_catalog(), public.buy_decor(bigint, text), public.remove_decor(bigint, text)
  to authenticated, service_role;
grant execute on function public.decor_catalog(), public.city_projects(text) to anon;
revoke all on function game.goal_counter(uuid, text, timestamptz), game.goal_progress(game.goals), game.ensure_goals(game.players), game.contracts_tick(), game.seed_city_projects()
  from public, anon, authenticated;

select game.contracts_tick();

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'crancapital-contracts';
  perform cron.schedule('crancapital-contracts', '23 * * * *', 'select game.contracts_tick()');
end $$;
