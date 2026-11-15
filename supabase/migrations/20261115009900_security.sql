-- CranCapital security: runs last.
--
-- 1. Row level security on every game table, with no policies: even if the
--    game schema were ever exposed, the API roles could read and write
--    nothing directly. All access goes through the API functions.
-- 2. API functions: nobody may call anything in public by default; signed-in
--    players may call the API; anonymous visitors only a short list
--    (landing page stats, the catalog, public profiles and boards, the
--    illegal-content report form).
-- 3. Realtime: private channels. Players can listen to their own "user:<id>"
--    channel and to chat channels, but can't send on them; only the
--    database broadcasts there, so nobody can fake a chat message or a
--    notification. City presence ("world:<city>") is public.

do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'game' loop
    execute format('alter table game.%I enable row level security', r.tablename);
    execute format('revoke all on game.%I from public, anon, authenticated', r.tablename);
  end loop;
end $$;

revoke all on schema game from public, anon, authenticated;
revoke all on all routines in schema game from public, anon, authenticated;
alter default privileges in schema game revoke all on routines from public;
revoke all on all sequences in schema game from public, anon, authenticated;
alter default privileges in schema game revoke all on functions from public;

do $$
declare
  r record;
  v_anon text[] := array[
    'get_catalog', 'world_stats', 'leaderboard', 'public_profile', 'board_list', 'board_post',
    'discord_directory', 'report_illegal_content', 'market_overview', 'market_good', 'market_quote', 'get_me',
    'legal_info'
  ];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
    if r.proname = any (v_anon) then
      execute format('grant execute on function %s to anon', r.sig);
    end if;
  end loop;
end $$;

-- Who may listen to a private Realtime topic: their own user channel, open
-- chat (global, cities), and private chats (DMs, player channels) they're in.
create or replace function public.realtime_can_listen(p_topic text) returns boolean
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  v_id bigint;
begin
  if v_uid is null or p_topic is null then return false; end if;
  if p_topic = 'user:' || v_uid::text then return true; end if;
  if p_topic like 'chat:%' then
    begin
      v_id := substr(p_topic, 6)::bigint;
    exception when others then
      return false;
    end;
    return exists (select 1 from game.chat_channels ch where ch.id = v_id
                     and (ch.kind in ('global', 'city')
                          or exists (select 1 from game.chat_members m where m.channel_id = ch.id and m.player_id = v_uid)));
  end if;
  return false;
end $$;
revoke all on function public.realtime_can_listen(text) from public, anon;
grant execute on function public.realtime_can_listen(text) to authenticated;

-- Realtime authorization (private channels).
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'alter table realtime.messages enable row level security';
    execute 'drop policy if exists "crancapital receive own and chat" on realtime.messages';
    execute $p$
      create policy "crancapital receive own and chat" on realtime.messages
      for select to authenticated
      using (public.realtime_can_listen(realtime.topic()))
    $p$;
  end if;
end $$;
