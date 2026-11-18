-- Real weather for each city, from Open-Meteo (free for non-commercial use,
-- no key; data CC BY 4.0). Fetched on the server, never in players'
-- browsers: a job every 10 minutes collects finished requests and, when a
-- city's weather is more than ~28 minutes old, asks again. Five cities every
-- 30 minutes is about 240 calls a day. Uses pg_net where it's installed (it
-- is on Supabase); without it the table simply stays empty.
--
-- The weather job never touches money or the ledger. Players read it with
-- public.city_weather().
--
-- Also: the Graphics setting joins the player prefs the server keeps.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

create table game.city_weather (
  city_id text primary key references game.cities(id),
  temp_c numeric,
  code int, -- WMO weather code
  wind_kmh numeric,
  is_day boolean,
  rain_mm numeric,
  snow_cm numeric,
  cloud_pct int,
  updated_at timestamptz not null default now()
);

create table game.weather_requests (
  id bigint primary key, -- pg_net request id
  city_id text not null references game.cities(id),
  asked_at timestamptz not null default now()
);

alter table game.city_weather enable row level security;
alter table game.weather_requests enable row level security;
revoke all on game.city_weather, game.weather_requests from public, anon, authenticated;

-- Save one city's weather from an Open-Meteo response body.
create function game.weather_store(p_city text, p_body jsonb) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  c jsonb := p_body -> 'current';
begin
  if c is null then return; end if;
  insert into game.city_weather as w (city_id, temp_c, code, wind_kmh, is_day, rain_mm, snow_cm, cloud_pct, updated_at)
  values (p_city, (c ->> 'temperature_2m')::numeric, (c ->> 'weather_code')::int, (c ->> 'wind_speed_10m')::numeric,
          (c ->> 'is_day')::int = 1, coalesce((c ->> 'rain')::numeric, (c ->> 'precipitation')::numeric, 0),
          coalesce((c ->> 'snowfall')::numeric, 0), (c ->> 'cloud_cover')::int, now())
  on conflict (city_id) do update set temp_c = excluded.temp_c, code = excluded.code, wind_kmh = excluded.wind_kmh,
    is_day = excluded.is_day, rain_mm = excluded.rain_mm, snow_cm = excluded.snow_cm, cloud_pct = excluded.cloud_pct,
    updated_at = excluded.updated_at;
end $$;

-- Collect finished requests, then ask again for cities whose weather is stale.
create function game.weather_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  r record;
  v_id bigint;
begin
  if to_regnamespace('net') is null then return; end if;
  for r in
    execute 'select q.id, q.city_id, x.status_code, x.content
               from game.weather_requests q join net._http_response x on x.id = q.id'
  loop
    if r.status_code = 200 then
      begin
        perform game.weather_store(r.city_id, r.content::jsonb);
      exception when others then
        null; -- a bad reply is skipped; the next one will do
      end;
    end if;
    delete from game.weather_requests where id = r.id;
  end loop;
  delete from game.weather_requests where asked_at < now() - interval '20 minutes';
  for r in
    select c.id, c.start_lat, c.start_lng from game.cities c
     where not exists (select 1 from game.city_weather w where w.city_id = c.id and w.updated_at > now() - interval '28 minutes')
       and not exists (select 1 from game.weather_requests q where q.city_id = c.id)
  loop
    execute 'select net.http_get($1)' into v_id using format(
      'https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s&current=temperature_2m,weather_code,wind_speed_10m,is_day,rain,snowfall,cloud_cover',
      round(r.start_lat::numeric, 3), round(r.start_lng::numeric, 3));
    insert into game.weather_requests (id, city_id) values (v_id, r.id);
  end loop;
end $$;

create function public.city_weather() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('city_id', city_id, 'temp_c', temp_c, 'code', code, 'wind_kmh', wind_kmh,
    'is_day', is_day, 'rain_mm', rain_mm, 'snow_cm', snow_cm, 'cloud_pct', cloud_pct, 'updated_at', updated_at) order by city_id), '[]'::jsonb)
  from game.city_weather
  where updated_at > now() - interval '6 hours'
$$;

revoke all on function public.city_weather() from public, anon, authenticated;
grant execute on function public.city_weather() to anon, authenticated, service_role;
revoke all on function game.weather_store(text, jsonb), game.weather_tick() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'crancapital-weather';
  perform cron.schedule('crancapital-weather', '*/10 * * * *', 'select game.weather_tick()');
end $$;

-- The Graphics setting (auto, high, medium, saver) is kept with the other prefs.
create or replace function public.set_prefs(p_prefs jsonb) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v jsonb := '{}'::jsonb;
  k text;
begin
  for k in select jsonb_object_keys(p_prefs) loop
    if k in ('notify_launch', 'notify_digest', 'notify_events', 'analytics', 'hide_crowds', 'reduce_motion', 'sound', 'units', 'graphics') then
      if k = 'graphics' and coalesce(p_prefs ->> k, '') not in ('auto', 'high', 'medium', 'saver') then continue; end if;
      v := v || jsonb_build_object(k, p_prefs -> k);
    end if;
  end loop;
  update game.players set prefs = prefs || v where id = p.id returning * into p;
  return p.prefs;
end $$;
