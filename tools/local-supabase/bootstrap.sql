-- Recreates the parts of a hosted Supabase database that CranCapital relies
-- on, so the game can be tested end to end on a plain Postgres:
-- the API roles, the auth/storage/realtime schemas, default privileges that
-- match Supabase's, and pg_cron. GoTrue and Realtime then run their own
-- migrations on top. Local development only: every password is "postgres".

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin login superuser createdb createrole replication bypassrls password 'postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login noinherit createrole password 'postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then
    create role supabase_storage_admin login noinherit createrole password 'postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_realtime_admin') then
    create role supabase_realtime_admin nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dashboard_user') then
    create role dashboard_user nologin createrole createdb replication;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;
grant supabase_auth_admin, supabase_storage_admin to postgres;
alter role postgres with password 'postgres';

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_cron;

create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role, postgres;
grant all on schema auth to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;

create schema if not exists storage authorization supabase_storage_admin;
grant usage on schema storage to anon, authenticated, service_role, postgres;

create schema if not exists _realtime authorization supabase_admin;
create schema if not exists realtime authorization supabase_admin;
grant usage on schema realtime to anon, authenticated, service_role, postgres;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Supabase grants the API roles broad default privileges in public; the
-- game's migrations must revoke what they don't want exposed, so mirror that.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

alter database postgres set "app.settings.jwt_exp" to '3600';
