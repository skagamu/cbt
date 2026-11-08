-- Keep access tied to a live Supabase Auth session after a JWT has been issued.
do $$
begin
  if to_regprocedure('cbt_private.staff_dispatch(text,jsonb)') is null then
    alter function cbt_private.staff_api(text,jsonb) rename to staff_dispatch;
  end if;
end;
$$;

revoke all on function cbt_private.staff_dispatch(text,jsonb) from public,anon,authenticated;

create or replace function cbt_private.staff_api(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_session text := auth.jwt()->>'session_id';
begin
  if v_user is null or v_session is null or v_session !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    raise exception 'FORBIDDEN';
  end if;
  if not exists (
    select 1 from auth.sessions s join auth.users u on u.id=s.user_id
    where s.id=v_session::uuid and s.user_id=v_user
      and (s.not_after is null or s.not_after>statement_timestamp())
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=statement_timestamp())
  ) then raise exception 'FORBIDDEN'; end if;
  return cbt_private.staff_dispatch(p_action,p_data);
end;
$$;

create or replace function public.cbt_staff(p_action text,p_data jsonb default '{}')
returns jsonb language sql security invoker set search_path = '' as $$
  select cbt_private.staff_api(p_action,p_data);
$$;
revoke all on function cbt_private.staff_api(text,jsonb),public.cbt_staff(text,jsonb) from public,anon,authenticated;
grant execute on function cbt_private.staff_api(text,jsonb),public.cbt_staff(text,jsonb) to authenticated;
