create table if not exists cbt_private.student_sessions (
  session_hash bytea primary key,
  right_id uuid not null references cbt_private.rights(id) on delete cascade,
  token_version integer not null,
  device uuid not null,
  expires_at timestamptz not null,
  unique (right_id, device)
);

create table if not exists cbt_private.student_login_limits (
  bucket text primary key,
  reset_at timestamptz not null,
  tries integer not null check (tries > 0)
);

alter table cbt_private.student_sessions enable row level security;
alter table cbt_private.student_login_limits enable row level security;

revoke all on table cbt_private.student_sessions, cbt_private.student_login_limits
  from public, anon, authenticated;

create index if not exists cbt_student_sessions_expiry
  on cbt_private.student_sessions (expires_at);
create index if not exists cbt_student_login_limits_expiry
  on cbt_private.student_login_limits (reset_at);

create or replace function cbt_private.student_identity(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select lower(btrim(regexp_replace(p_value, '[[:space:]]+', ' ', 'g')));
$$;

create index if not exists cbt_students_active_normalized_nis
  on public.cbt_students (cbt_private.student_identity(nis)) where is_active;
create index if not exists cbt_students_active_normalized_name
  on public.cbt_students (cbt_private.student_identity(full_name)) where is_active;

create or replace function cbt_private.finalize_attempt(
  p_right uuid, p_submitted timestamptz, p_reason text, p_version integer
)
returns cbt_private.attempts
language plpgsql
set search_path = ''
as $$
declare
  v_attempt cbt_private.attempts;
begin
  update cbt_private.attempts
  set submitted_at = p_submitted, receipt = gen_random_uuid(),
      submit_reason = p_reason
  where right_id = p_right and submitted_at is null
  returning * into v_attempt;

  if found then
    perform cbt_private.grade(p_right, p_version);
  else
    select * into strict v_attempt from cbt_private.attempts where right_id = p_right;
  end if;
  return v_attempt;
end;
$$;

create or replace function cbt_private.finalize_due(p_limit integer default 1000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_now timestamptz := clock_timestamp();
  v_row record;
begin
  for v_row in
    with exam_locks as materialized (
      select e.id, e.closed_at, e.grading_version
      from cbt_private.exams e
      where exists (
        select 1 from cbt_private.rights r
        join cbt_private.attempts a on a.right_id = r.id
        where r.exam_id = e.id and a.submitted_at is null
          and (a.deadline <= v_now or e.closed_at <= v_now)
      )
      order by e.id
      for share of e skip locked
    )
    select a.right_id, least(a.deadline, e.closed_at) as cutoff, e.grading_version,
           case when e.closed_at < a.deadline then 'closed' else 'timeout' end as reason
    from exam_locks e
    join cbt_private.rights r on r.exam_id = e.id
    join cbt_private.attempts a on a.right_id = r.id
    where a.submitted_at is null and (a.deadline <= v_now or e.closed_at <= v_now)
    order by a.right_id
    limit greatest(0, least(1000, p_limit))
    for update of a skip locked
  loop
    perform cbt_private.finalize_attempt(
      v_row.right_id, v_row.cutoff, v_row.reason, v_row.grading_version
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function cbt_private.student_action(
  p_session text, p_action text, p_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session cbt_private.student_sessions;
  v_right cbt_private.rights;
  v_exam cbt_private.exams;
  v_attempt cbt_private.attempts;
  v_student public.cbt_students;
  v_device uuid;
  v_hash bytea;
  v_exam_id uuid;
  v_now timestamptz;
  v_opens timestamptz;
  v_closes timestamptz;
  v_deadline timestamptz;
  v_duration integer;
  v_epoch integer;
  v_status text;
  v_score numeric;
  v_questions jsonb;
  v_answers jsonb;
  v_incoming jsonb;
  v_current jsonb;
  v_pair record;
  v_revision integer;
  v_invalid constant jsonb := '{"ok":false,"code":"invalid_request"}';
  v_login_required constant jsonb := '{"ok":false,"code":"login_required"}';
begin
  if p_session is null or length(p_session) <> 64 or p_session !~ '^[0-9a-f]+$' then
    return v_login_required;
  end if;

  if p_action is null or p_action not in ('state','start','claim','save','submit','revoke')
    or jsonb_typeof(p_data) is distinct from 'object' or pg_column_size(p_data) > 32768 then
    return v_invalid;
  end if;
  if coalesce(p_data->>'device', '') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    return v_invalid;
  end if;
  v_device := (p_data->>'device')::uuid;
  v_hash := extensions.digest(p_session, 'sha256');

  if p_action = 'revoke' then
    delete from cbt_private.student_sessions where session_hash = v_hash and device = v_device;
    return '{"ok":true}'::jsonb;
  end if;

  select * into v_session
  from cbt_private.student_sessions
  where session_hash = v_hash and device = v_device and expires_at > clock_timestamp();
  if not found then
    return v_login_required;
  end if;

  -- Match staff's lock order so rotation and closing cannot race with a save.
  select exam_id into v_exam_id from cbt_private.rights where id = v_session.right_id;
  select * into v_exam from cbt_private.exams where id = v_exam_id for share;
  select * into v_right from cbt_private.rights where id = v_session.right_id for share;
  select * into v_session from cbt_private.student_sessions
  where session_hash = v_hash and device = v_device and right_id = v_right.id
  for share;
  if not found or v_exam.id is null or v_right.token_hash is null
    or v_right.token_version <> v_session.token_version then
    return v_login_required;
  end if;

  select * into v_student from public.cbt_students
  where id = v_right.student_id and is_active;
  if not found then
    return v_login_required;
  end if;

  select * into v_attempt from cbt_private.attempts where right_id = v_right.id for update;
  v_now := clock_timestamp();
  if v_session.expires_at <= v_now or v_right.token_expires_at is null
    or v_right.token_expires_at <= v_now then
    return v_login_required;
  end if;

  v_opens := coalesce(v_right.opens_at, v_exam.opens_at);
  v_closes := least(coalesce(v_right.closes_at, v_exam.closes_at), v_exam.closed_at);
  v_duration := coalesce(v_right.duration_minutes, v_exam.duration_minutes);
  v_deadline := least(v_attempt.deadline, v_exam.closed_at);

  if v_attempt.right_id is not null and v_attempt.submitted_at is null
    and v_now >= v_deadline then
    v_attempt := cbt_private.finalize_attempt(
      v_right.id, v_deadline,
      case when v_exam.closed_at < v_attempt.deadline then 'closed' else 'timeout' end,
      v_exam.grading_version
    );
  end if;

  if v_attempt.submitted_at is not null then
    v_status := 'final';
  elsif v_attempt.right_id is not null then
    v_status := 'active';
  elsif v_exam.status <> 'published' or v_now >= v_closes then
    v_status := 'closed';
  elsif v_now < v_opens then
    v_status := 'waiting';
  else
    v_status := 'ready';
  end if;

  if p_action = 'start' and v_status = 'ready' then
    v_deadline := least(v_closes, v_now + make_interval(mins => v_duration));
    insert into cbt_private.attempts (
      right_id, started_at, deadline, write_device, write_epoch, initial_version
    )
    values (v_right.id, v_now, v_deadline, v_device, 1, v_exam.grading_version)
    on conflict (right_id) do nothing;

    select * into strict v_attempt
    from cbt_private.attempts where right_id = v_right.id for update;
    v_deadline := least(v_attempt.deadline, v_exam.closed_at);
    if v_attempt.submitted_at is null and clock_timestamp() >= v_deadline then
      v_attempt := cbt_private.finalize_attempt(
        v_right.id, v_deadline, 'timeout', v_exam.grading_version
      );
    end if;
    v_status := case when v_attempt.submitted_at is null then 'active' else 'final' end;
  end if;

  if p_action in ('claim','save','submit') and v_status <> 'final' then
    if v_status <> 'active' then
      return jsonb_build_object('ok', false, 'code', 'not_active', 'status', v_status);
    end if;

    if jsonb_typeof(p_data->'epoch') is distinct from 'number'
      or coalesce(p_data->>'epoch','') !~ '^[0-9]{1,9}$' then
      return v_invalid;
    end if;
    v_epoch := (p_data->>'epoch')::integer;

    if p_action = 'claim' and v_attempt.write_device is distinct from v_device then
      if v_epoch <> v_attempt.write_epoch then
        return jsonb_build_object('ok',false,'code','lease_conflict','write_epoch',v_attempt.write_epoch);
      end if;

      update cbt_private.attempts
      set write_device = v_device, write_epoch = write_epoch + 1
      where right_id = v_right.id
      returning * into v_attempt;
    elsif p_action in ('save','submit') then
      if v_attempt.write_device is distinct from v_device or v_attempt.write_epoch <> v_epoch then
        return jsonb_build_object('ok',false,'code','lease_conflict','write_epoch',v_attempt.write_epoch);
      end if;
      v_incoming := p_data->'answers';
      if jsonb_typeof(v_incoming) is distinct from 'object' then
        return v_invalid;
      end if;
      v_answers := v_attempt.answers;
      for v_pair in select key, value from jsonb_each(v_incoming)
      loop
        if v_pair.key !~ '^[1-9][0-9]?$' then
          return v_invalid;
        end if;
        if v_pair.key::integer > v_exam.question_count
          or jsonb_typeof(v_pair.value) is distinct from 'object'
          or jsonb_typeof(v_pair.value->'flagged') is distinct from 'boolean'
          or jsonb_typeof(v_pair.value->'revision') is distinct from 'number'
          or coalesce(v_pair.value->>'revision','') !~ '^[1-9][0-9]{0,8}$'
          or not (
            coalesce(v_pair.value->'option' = 'null'::jsonb, false)
            or coalesce(v_pair.value->>'option' in ('A','B','C','D'), false)
          ) then
          return v_invalid;
        end if;

        v_current := v_answers->v_pair.key;
        v_revision := (v_pair.value->>'revision')::integer;
        if v_revision > coalesce((v_current->>'revision')::integer, 0) then
          v_answers := jsonb_set(v_answers, array[v_pair.key], jsonb_build_object(
            'option', v_pair.value->'option', 'flagged', v_pair.value->'flagged', 'revision', v_revision
          ));
        elsif v_revision = (v_current->>'revision')::integer and (
          v_current->'option' is distinct from v_pair.value->'option'
          or v_current->'flagged' is distinct from v_pair.value->'flagged'
        ) then
          return jsonb_build_object('ok',false,'code','stale_revision','revision',v_attempt.revision);
        end if;
      end loop;

      v_now := clock_timestamp();
      if v_now >= v_deadline then
        v_attempt := cbt_private.finalize_attempt(
          v_right.id, v_deadline,
          case when v_exam.closed_at < v_attempt.deadline then 'closed' else 'timeout' end,
          v_exam.grading_version
        );
        v_status := 'final';
      else
        if v_answers is distinct from v_attempt.answers then
          update cbt_private.attempts
          set answers = v_answers, revision = revision + 1, saved_at = v_now
          where right_id = v_right.id
          returning * into v_attempt;
        end if;
        if p_action = 'submit' then
          v_attempt := cbt_private.finalize_attempt(v_right.id, v_now, 'manual', v_exam.grading_version);
          v_status := 'final';
        end if;
      end if;
    end if;
  end if;

  if v_status = 'active' and p_action <> 'save' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'position', q.position, 'prompt', q.prompt, 'options', jsonb_build_object(
        'A', q.options->>'A', 'B', q.options->>'B', 'C', q.options->>'C', 'D', q.options->>'D'
      ),
      'weight', q.weight, 'image_url', q.image_url
    ) order by q.position), '[]'::jsonb)
    into v_questions from cbt_private.exam_questions q where q.exam_id = v_exam.id;
  elsif v_status = 'final' and v_exam.released_at is not null then
    select score into v_score from cbt_private.results
    where right_id = v_right.id and version = v_exam.grading_version;
  end if;

  return jsonb_build_object(
    'ok', true, 'status', v_status, 'server_now', clock_timestamp(),
    'right_id', v_right.id, 'title', v_exam.title, 'student_name', v_student.full_name,
    'class_code', v_student.class_code, 'opens_at', v_opens, 'closes_at', v_closes,
    'duration_minutes', v_duration, 'deadline', v_deadline,
    'write_epoch', v_attempt.write_epoch,
    'writable', v_status = 'active' and v_attempt.write_device is not distinct from v_device,
    'revision', v_attempt.revision, 'saved_at', v_attempt.saved_at,
    'answers', case when v_status = 'active' then v_attempt.answers end,
    'receipt', v_attempt.receipt, 'submitted_at', v_attempt.submitted_at,
    'submit_reason', v_attempt.submit_reason, 'score', v_score
  ) || case when v_questions is not null then jsonb_build_object('questions', v_questions)
           else '{}'::jsonb end;
end;
$$;

create or replace function cbt_private.student_login(
  p_identity text, p_token text, p_device uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_identity text;
  v_token text;
  v_right cbt_private.rights;
  v_token_hash bytea;
  v_session text;
  v_state jsonb;
  v_bucket text;
  v_now timestamptz := clock_timestamp();
  v_failed constant jsonb := '{"ok":false}';
begin
  if p_identity is null or length(p_identity) > 160 or p_token is null
    or length(p_token) > 160 or p_device is null then
    return v_failed;
  end if;
  v_identity := cbt_private.student_identity(p_identity);
  v_token := btrim(p_token);
  if v_identity = '' or v_token !~ '^[A-Za-z0-9_-]{20,128}$' then
    return v_failed;
  end if;

  v_bucket := encode(extensions.digest(v_identity, 'sha256'), 'hex');
  if not exists (
    select 1 from public.cbt_students s
    where s.is_active and (
      cbt_private.student_identity(s.nis) = v_identity
      or cbt_private.student_identity(s.full_name) = v_identity
    )
  ) then
    -- Bound storage for arbitrary identities without sharing a bucket with a real student.
    v_bucket := left(v_bucket, 4);
  end if;

  insert into cbt_private.student_login_limits as l (bucket, reset_at, tries)
  values (v_bucket, v_now + interval '5 minutes', 1)
  on conflict (bucket) do update
  set tries = case when l.reset_at <= v_now then 1 else l.tries + 1 end,
      reset_at = case when l.reset_at <= v_now then excluded.reset_at else l.reset_at end
  where l.reset_at <= v_now or l.tries < 8;
  if not found then
    return v_failed;
  end if;

  v_token_hash := extensions.digest(v_token, 'sha256');
  select r.* into v_right
  from cbt_private.rights r
  join public.cbt_students s on s.id = r.student_id
  where r.token_hash = v_token_hash
    and r.token_expires_at > v_now and s.is_active and (
      cbt_private.student_identity(s.nis) = v_identity
      or cbt_private.student_identity(s.full_name) = v_identity
    );
  if not found then
    return v_failed;
  end if;

  perform 1 from cbt_private.exams where id = v_right.exam_id for share;
  select * into v_right from cbt_private.rights where id = v_right.id for share;
  if not found or v_right.token_hash is distinct from v_token_hash
    or v_right.token_expires_at <= clock_timestamp() then
    return v_failed;
  end if;

  v_session := encode(extensions.gen_random_bytes(32), 'hex');
  insert into cbt_private.student_sessions (session_hash, right_id, token_version, device, expires_at)
  values (extensions.digest(v_session, 'sha256'), v_right.id, v_right.token_version, p_device,
          least(v_now + interval '12 hours', v_right.token_expires_at))
  on conflict (right_id, device) do update
  set session_hash = excluded.session_hash, token_version = excluded.token_version,
      expires_at = excluded.expires_at;

  v_state := cbt_private.student_action(v_session, 'state', jsonb_build_object('device', p_device));
  if v_state->>'ok' <> 'true' then
    return v_failed;
  end if;
  delete from cbt_private.student_login_limits where bucket = v_bucket;
  return v_state || jsonb_build_object('session', v_session);
end;
$$;

create or replace function public.cbt_student_login(p_identity text, p_token text, p_device uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select cbt_private.student_login(p_identity, p_token, p_device);
$$;

create or replace function public.cbt_student(p_session text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select cbt_private.student_action(p_session, p_action, p_data);
$$;

revoke all on function
  cbt_private.student_identity(text),
  cbt_private.finalize_attempt(uuid,timestamptz,text,integer),
  cbt_private.finalize_due(integer),
  cbt_private.student_action(text,text,jsonb),
  cbt_private.student_login(text,text,uuid),
  public.cbt_student_login(text,text,uuid),
  public.cbt_student(text,text,jsonb)
from public, anon, authenticated;

grant usage on schema cbt_private to anon;
grant execute on function
  cbt_private.student_action(text,text,jsonb),
  cbt_private.student_login(text,text,uuid),
  public.cbt_student_login(text,text,uuid),
  public.cbt_student(text,text,jsonb)
to anon;
