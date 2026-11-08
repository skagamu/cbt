-- A second device receives status until it explicitly acquires the write lease.
create or replace function public.cbt_student_login(p_identity text,p_token text,p_device uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select case when response->>'status'='active' and response->>'writable'='false'
    then response - 'questions' - 'answers' else response end
  from cbt_private.student_login(p_identity,p_token,p_device) as response;
$$;

create or replace function public.cbt_student(p_session text,p_action text,p_data jsonb default '{}')
returns jsonb language sql security invoker set search_path = '' as $$
  select case when response->>'status'='active' and response->>'writable'='false'
    then response - 'questions' - 'answers' else response end
  from cbt_private.student_action(p_session,p_action,p_data) as response;
$$;
