-- Scheduled jobs and storage.
--
-- 1. The economy tick runs every minute with pg_cron.
-- 2. A public "screenshots" bucket for Bug Report attachments: signed-in
--    players may upload images only into a folder named after their user id.
-- 3. The very first player becomes an admin (the project owner signs in
--    first; Supabase's built-in email only reaches the project's own team
--    until a custom SMTP server is set up).

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'crancapital-tick';
  perform cron.schedule('crancapital-tick', '* * * * *', 'call game.tick()');
  -- Clear out old pg_cron run history once a day.
  perform cron.unschedule(jobid) from cron.job where jobname = 'crancapital-cron-cleanup';
  perform cron.schedule('crancapital-cron-cleanup', '17 3 * * *',
    $q$delete from cron.job_run_details where end_time < now() - interval '3 days'$q$);
end $$;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('screenshots', 'screenshots', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists "crancapital screenshots upload" on storage.objects';
    execute $p$
      create policy "crancapital screenshots upload" on storage.objects for insert to authenticated
      with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
    execute 'drop policy if exists "crancapital screenshots read" on storage.objects';
    execute $p$
      create policy "crancapital screenshots read" on storage.objects for select
      using (bucket_id = 'screenshots')
    $p$;
  end if;
end $$;

-- First player in a fresh world becomes admin.
create or replace function game.first_player_admin() returns trigger
language plpgsql set search_path = game, pg_temp as $$
begin
  if not exists (select 1 from game.players where id <> new.id) then
    new.role := 'admin';
  end if;
  return new;
end $$;

drop trigger if exists first_player_admin on game.players;
create trigger first_player_admin before insert on game.players
for each row execute function game.first_player_admin();
