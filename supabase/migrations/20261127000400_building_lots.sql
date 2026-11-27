-- One building, not a whole block.
--
-- The street tiles merge buildings that touch into one feature, so in a
-- dense city a whole block arrived as a single "building", and tapping any
-- building selected the block. The city data now cuts those blocks into
-- lots about the size of one building (tools/citydata/lots.mjs): each lot
-- is its own building with its own id, and the street tiles draw the lots
-- instead of the block.
--
-- The block stays as a hidden record (split = true) so anything that
-- referred to it can be moved: each city's seed ends by calling
-- remap_split_buildings, which moves businesses (and their rooms) to the
-- lot they stand in, gives an owner of the whole block every lot in it, and
-- leaves the block itself unowned.

alter table game.buildings
  add column if not exists parent_id bigint,
  add column if not exists split boolean not null default false;
create index if not exists buildings_parent_idx on game.buildings (parent_id) where parent_id is not null;

create or replace function game.remap_split_buildings(p_city text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  r record;
  v_lot bigint;
begin
  -- Businesses (and their rooms) move to the lot nearest them.
  for r in select b.id, b.lat, b.lng, b.building_id from game.businesses b join game.buildings p on p.id = b.building_id
            where p.split and p.city_id = p_city loop
    select id into v_lot from game.buildings
     where parent_id = r.building_id
     order by (lat - r.lat) ^ 2 + ((lng - r.lng) * cos(radians(r.lat))) ^ 2 limit 1;
    if v_lot is null then continue; end if;
    update game.businesses set building_id = v_lot where id = r.id;
    update game.leases set building_id = v_lot where business_id = r.id and building_id = r.building_id;
  end loop;
  -- Any other room on a split block: its biggest lot.
  update game.leases l set building_id = (select x.id from game.buildings x where x.parent_id = l.building_id order by x.rooms_total desc, x.id limit 1)
   where l.building_id in (select id from game.buildings where split and city_id = p_city)
     and exists (select 1 from game.buildings x where x.parent_id = l.building_id);
  -- Whoever owned the whole block owns every lot in it (each lot's share of
  -- the price paid, by floor space).
  update game.buildings lot
     set owner_id = p.owner_id,
         bought_price = round(p.bought_price::numeric * lot.footprint_m2 / greatest(1, p.footprint_m2))::bigint,
         bought_at = p.bought_at, rent_pct = p.rent_pct, for_sale_price = null
    from game.buildings p
   where lot.parent_id = p.id and p.split and p.owner_id is not null and p.city_id = p_city and lot.owner_id is null;
  update game.buildings set owner_id = null, bought_price = null, bought_at = null, for_sale_price = null, custom_name = null
   where split and owner_id is not null and city_id = p_city;
end $$;
