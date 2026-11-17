-- Error reports from players' browsers, so problems on a device nobody on
-- the team owns (a blank map on an iPad, say) can be diagnosed. Signed-in
-- players only, rate limited, short text, kept for 14 days. Only staff read
-- them, through the SQL editor.

create table game.client_errors (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now(),
  kind text not null,
  message text not null,
  user_agent text,
  path text
);
create index client_errors_at on game.client_errors (at);

alter table game.client_errors enable row level security;
revoke all on game.client_errors from public, anon, authenticated;

create function public.report_client_error(p_kind text, p_message text, p_user_agent text, p_path text)
returns void language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
begin
  if v_uid is null or coalesce(p_message, '') = '' then return; end if;
  perform game.rate_limit(v_uid::text, 'client_error', 10, 0.5);
  insert into game.client_errors (user_id, kind, message, user_agent, path)
  values (v_uid, left(coalesce(p_kind, 'error'), 40), left(p_message, 1000), left(p_user_agent, 300), left(p_path, 200));
  delete from game.client_errors where at < now() - interval '14 days';
end $$;

revoke all on function public.report_client_error(text, text, text, text) from public, anon, authenticated;
grant execute on function public.report_client_error(text, text, text, text) to authenticated, service_role;
