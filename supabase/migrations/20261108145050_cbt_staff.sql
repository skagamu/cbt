create or replace function cbt_private.assert_schedule(
  p_open timestamptz, p_close timestamptz, p_duration integer, p_slot smallint
) returns void language plpgsql set search_path = '' as $$
declare
  v_slot cbt_private.slots%rowtype;
  v_open timestamp := p_open at time zone 'Asia/Jakarta';
  v_close timestamp := p_close at time zone 'Asia/Jakarta';
begin
  if p_open is null or p_close is null or not isfinite(p_open) or not isfinite(p_close)
     or p_duration is null or p_duration not between 1 and 240
     or p_close-p_open < make_interval(mins => p_duration)
     or v_open::date <> v_close::date then raise exception 'INVALID_SCHEDULE'; end if;
  if p_slot is not null then
    select * into v_slot from cbt_private.slots where id=p_slot;
    if not found or not v_slot.is_active or v_open::time < v_slot.start_time or v_close::time > v_slot.end_time
      then raise exception 'INVALID_SCHEDULE'; end if;
  end if;
end;
$$;

create or replace function cbt_private.valid_options(p_options jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_options)='object' then
    p_options ?& array['A','B','C','D'] and p_options-array['A','B','C','D']='{}' and not exists (
      select 1 from jsonb_each(p_options) x where jsonb_typeof(x.value)<>'string' or
        length(btrim(x.value #>> '{}')) not between 1 and 1500
    ) else false end;
$$;

create or replace function cbt_private.new_token()
returns text language sql volatile set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(24),'base64'),'+/','-_');
$$;

create or replace function cbt_private.staff_api(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_profile cbt_private.staff%rowtype;
  v_admin boolean;
  v_exam cbt_private.exams%rowtype;
  v_regular_exam cbt_private.exams%rowtype;
  v_right cbt_private.rights%rowtype;
  v_id uuid;
  v_subject uuid;
  v_ids uuid[];
  v_classes text[];
  v_grade smallint;
  v_slot smallint;
  v_open timestamptz;
  v_close timestamptz;
  v_duration integer;
  v_count integer;
  v_total integer;
  v_position integer;
  v_version integer;
  v_text text;
  v_key text;
  v_mode text;
  v_reason text;
  v_image text;
  v_weight numeric;
  v_enabled boolean;
  v_makeup boolean;
  v_output jsonb := '[]';
  v_item record;
  v_token text;
  v_now timestamptz;
begin
  select * into v_profile from cbt_private.staff where user_id=v_user and is_active;
  if not found then raise exception 'FORBIDDEN'; end if;
  v_admin := v_profile.role='admin';
  if coalesce(jsonb_typeof(p_data),'')<>'object' or pg_column_size(p_data)>65536
    then raise exception 'INVALID_INPUT'; end if;

  if p_action='dashboard' then
    return jsonb_build_object(
      'profile',jsonb_build_object('display_name',v_profile.display_name,'role',v_profile.role,'classes',v_profile.classes),
      'subjects',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'slug',slug) order by name)
        from public.cbt_subjects where is_active),'[]'),
      'classes',coalesce((select jsonb_agg(to_jsonb(c) order by grade_level,class_code) from (
        select class_code,grade_level,count(*)::integer as count from public.cbt_students
        where is_active and (v_admin or class_code=any(v_profile.classes)) group by class_code,grade_level) c),'[]'),
      'slots',coalesce((select jsonb_agg(to_jsonb(s) order by id) from cbt_private.slots s),'[]'),
      'exams',coalesce((select jsonb_agg(to_jsonb(e)-'created_by' order by opens_at desc,id)
        from cbt_private.exams e where v_admin or e.classes <@ v_profile.classes),'[]'),
      'staff',case when v_admin then coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('email',u.email) order by s.display_name)
        from cbt_private.staff s join auth.users u on u.id=s.user_id),'[]') else '[]' end);
  end if;

  if p_action='staff_save' then
    if not v_admin then raise exception 'FORBIDDEN'; end if;
    perform pg_advisory_xact_lock(3711,1);
    -- A second check prevents a concurrent administrator from restoring their own access.
    if not exists (select 1 from cbt_private.staff where user_id=v_user and is_active and role='admin')
      then raise exception 'FORBIDDEN'; end if;
    select id into v_id from auth.users where lower(email)=lower(btrim(p_data->>'email'));
    if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
    v_text := btrim(p_data->>'display_name');
    v_mode := p_data->>'role';
    v_enabled := (p_data->>'is_active')::boolean;
    select coalesce(array_agg(distinct x order by x),'{}') into v_classes from jsonb_array_elements_text(p_data->'classes') x;
    if v_text is null or length(v_text) not between 1 and 120 or v_mode is null or v_mode not in ('teacher','admin')
      or v_enabled is null or (v_mode='teacher' and cardinality(v_classes)=0)
      or exists (select 1 from unnest(v_classes) x where x is null or not exists
        (select 1 from public.cbt_students where class_code=x and is_active))
      then raise exception 'INVALID_INPUT'; end if;
    if (not v_enabled or v_mode<>'admin') and (v_id=v_user or not exists
      (select 1 from cbt_private.staff where is_active and role='admin' and user_id<>v_id))
      then raise exception 'LAST_ADMIN'; end if;
    insert into cbt_private.staff(user_id,display_name,role,classes,is_active)
      values (v_id,v_text,v_mode,case when v_mode='admin' then '{}' else v_classes end,v_enabled)
      on conflict (user_id) do update set display_name=excluded.display_name,role=excluded.role,
        classes=excluded.classes,is_active=excluded.is_active;
    insert into cbt_private.audit(actor,action,detail) values
      (v_user,p_action,jsonb_build_object('user_id',v_id,'role',v_mode,'is_active',v_enabled));
    return jsonb_build_object('user_id',v_id);
  end if;

  if p_action='slot_save' then
    if not v_admin then raise exception 'FORBIDDEN'; end if;
    perform pg_advisory_xact_lock(3711,2);
    v_slot := (p_data->>'id')::smallint;
    v_text := btrim(p_data->>'label');
    v_enabled := (p_data->>'is_active')::boolean;
    if v_slot is null or v_slot not between 1 and 3 or v_text is null or length(v_text) not between 1 and 50
      or v_enabled is null or p_data->>'start_time' is null or p_data->>'end_time' is null
      or (p_data->>'start_time')::time >= (p_data->>'end_time')::time or (p_data->>'end_time')::time >= '24:00'
      then raise exception 'INVALID_SCHEDULE'; end if;
    if v_enabled and exists (select 1 from cbt_private.slots s where s.id<>v_slot and s.is_active
      and s.start_time < (p_data->>'end_time')::time and s.end_time > (p_data->>'start_time')::time)
      then raise exception 'SCHEDULE_OVERLAP'; end if;
    update cbt_private.slots set label=v_text, start_time=(p_data->>'start_time')::time,
      end_time=(p_data->>'end_time')::time,is_active=v_enabled where id=v_slot;
    insert into cbt_private.audit(actor,action,detail) values (v_user,p_action,jsonb_build_object('slot_id',v_slot));
    return jsonb_build_object('id',v_slot);
  end if;

  if p_action in ('bank','question_save','exam_save') then
    v_subject := (p_data->>'subject_id')::uuid;
    if not exists (select 1 from public.cbt_subjects where id=v_subject and is_active)
      then raise exception 'INVALID_INPUT'; end if;
  end if;
  if p_action='bank' then
    return coalesce((select jsonb_agg(to_jsonb(q) order by question_number) from public.cbt_question_bank q where subject_id=v_subject),'[]');
  end if;
  if p_action='question_save' then
    v_id := (p_data->>'id')::uuid;
    v_text := btrim(p_data->>'prompt');
    v_key := p_data->>'correct_option';
    v_image := nullif(btrim(p_data->>'image_url'),'');
    v_mode := p_data->>'review_status';
    v_reason := btrim(p_data->>'grade_scope');
    v_weight := coalesce((p_data->>'weight')::numeric,1);
    if v_text is null or length(v_text) not between 1 and 10000
      or not cbt_private.valid_options(p_data->'options')
      or v_key is null or v_key not in ('A','B','C','D')
      or v_mode is null or v_mode not in ('draft','approved','archived')
      or v_reason is null or length(v_reason) not between 1 and 80 or v_weight not between .01 and 100
      or (v_image is not null and (v_image !~ '^https://[^ /@?#]+([/?#]|$)' or length(v_image)>2048))
      then raise exception 'INVALID_QUESTIONS'; end if;
    perform 1 from public.cbt_subjects where id=v_subject for update;
    if v_id is null then
      select coalesce(max(question_number),0)+1 into v_position from public.cbt_question_bank where subject_id=v_subject;
      if v_position>32767 then raise exception 'INVALID_QUESTIONS'; end if;
      insert into public.cbt_question_bank
        (question_code,subject_id,question_number,grade_scope,prompt,options,correct_option,review_status,weight,image_url,source_label)
        values ('CBT-'||gen_random_uuid(),v_subject,v_position,v_reason,v_text,p_data->'options',v_key,v_mode,v_weight,v_image,'CBT')
        returning id into v_id;
    else
      update public.cbt_question_bank set grade_scope=v_reason,prompt=v_text,options=p_data->'options',
        correct_option=v_key,review_status=v_mode,weight=v_weight,image_url=v_image,updated_at=clock_timestamp()
        where id=v_id and subject_id=v_subject;
      if not found then raise exception 'INVALID_QUESTIONS'; end if;
    end if;
    insert into cbt_private.audit(actor,action,detail) values
      (v_user,p_action,jsonb_build_object('question_id',v_id,'review_status',v_mode));
    return jsonb_build_object('id',v_id);
  end if;

  if p_action in ('exam_save','publish','makeup','extend') then
    perform pg_advisory_xact_lock(3711,2);
  end if;
  if p_action='exam_save' then
    v_id := (p_data->>'id')::uuid;
  else
    v_id := (p_data->>'exam_id')::uuid;
  end if;
  if v_id is not null then
    if p_action='exam_detail' then
      select * into v_exam from cbt_private.exams where id=v_id;
    else
      select * into v_exam from cbt_private.exams where id=v_id for update;
    end if;
    if not found or (not v_admin and not (v_exam.classes <@ v_profile.classes))
      then raise exception 'FORBIDDEN'; end if;
  elsif p_action<>'exam_save' then
    raise exception 'INVALID_INPUT';
  end if;
  v_now := clock_timestamp();

  if p_action='exam_save' then
    v_text := btrim(p_data->>'title');
    v_grade := (p_data->>'grade_level')::smallint;
    v_slot := (p_data->>'slot_id')::smallint;
    v_open := (p_data->>'opens_at')::timestamptz;
    v_close := (p_data->>'closes_at')::timestamptz;
    v_duration := (p_data->>'duration_minutes')::integer;
    v_count := (p_data->>'question_count')::integer;
    v_makeup := coalesce((p_data->>'makeup_only')::boolean,false);
    select coalesce(array_agg(distinct x order by x),'{}') into v_classes from jsonb_array_elements_text(p_data->'classes') x;
    if v_text is null or length(v_text) not between 1 and 160 or v_grade is null or v_grade not between 10 and 12
      or v_count is null or v_count not between 1 and 40 or cardinality(v_classes) not between 1 and 7
      or (not v_admin and not (v_classes <@ v_profile.classes)) then raise exception 'INVALID_INPUT'; end if;
    if exists (select 1 from unnest(v_classes) x where x is null or (select count(*) from public.cbt_students s
        where s.grade_level=v_grade and s.class_code=x and s.is_active) not between 1 and 40)
      then raise exception 'INVALID_PARTICIPANTS'; end if;
    perform cbt_private.assert_schedule(v_open,v_close,v_duration,v_slot);
    if v_exam.status='closed' or (v_exam.status='published' and
        (v_now>=v_exam.opens_at or v_now>=v_open or v_subject<>v_exam.subject_id or v_grade<>v_exam.grade_level
         or v_classes<>v_exam.classes or v_makeup<>v_exam.makeup_only or v_count<>v_exam.question_count
         or exists (select 1 from cbt_private.rights r where r.exam_id=v_id and r.regular_id is not null)))
      then raise exception 'EXAM_STATE'; end if;
    if v_exam.status='published' and not v_makeup and exists (
      select 1 from cbt_private.exams e where e.id<>v_id and e.status='published' and not e.makeup_only
      and e.grade_level=v_grade and e.classes && v_classes and e.opens_at<v_close and e.closes_at>v_open
    ) then raise exception 'SCHEDULE_OVERLAP'; end if;
    if v_exam.status='published' and not v_makeup and exists (
      select 1 from cbt_private.rights r join public.cbt_students s on s.id=r.student_id
      join cbt_private.exams e on e.id=r.exam_id where r.regular_id is not null and e.status='published'
      and s.grade_level=v_grade and s.class_code=any(v_classes) and r.opens_at<v_close and r.closes_at>v_open
    ) then raise exception 'SCHEDULE_OVERLAP'; end if;
    if v_id is null then
      insert into cbt_private.exams(subject_id,title,grade_level,classes,opens_at,closes_at,duration_minutes,
        slot_id,question_count,makeup_only,created_by)
      values (v_subject,v_text,v_grade,v_classes,v_open,v_close,v_duration,v_slot,v_count,v_makeup,v_user)
      returning id into v_id;
    else
      update cbt_private.exams set subject_id=v_subject,title=v_text,grade_level=v_grade,classes=v_classes,opens_at=v_open,
        closes_at=v_close,duration_minutes=v_duration,slot_id=v_slot,question_count=v_count,makeup_only=v_makeup where id=v_id;
      -- Expiry only needs adjustment when the exam moves later.
      update cbt_private.rights set token_expires_at=greatest(token_expires_at,v_close+interval '30 days')
        where exam_id=v_id and token_hash is not null;
    end if;
    insert into cbt_private.audit(actor,exam_id,action,detail) values (v_user,v_id,p_action,
      jsonb_build_object('opens_at',v_open,'closes_at',v_close,'duration_minutes',v_duration));
    return jsonb_build_object('id',v_id);
  end if;

  if p_action='exam_detail' then
    return jsonb_build_object(
      'exam',to_jsonb(v_exam)-'created_by',
      'questions',coalesce((select jsonb_agg(to_jsonb(q)-'exam_id' order by position)
        from cbt_private.exam_questions q where exam_id=v_id),'[]'),
      'participants',coalesce((select jsonb_agg(to_jsonb(p) order by class_code,full_name,nis) from (
        select r.id as right_id,s.id as student_id,s.nis,s.full_name,s.class_code,
          r.token_hash is not null as has_token,r.regular_id,r.reason,r.opens_at,r.closes_at,r.duration_minutes,
          a.started_at,a.deadline,a.saved_at,a.submitted_at,a.receipt,a.submit_reason,
          f.score,f.correct_count,f.wrong_count,f.blank_count,
          case when r.official_makeup then 'susulan' when r.regular_id is null and a.submitted_at is not null
            and not exists (select 1 from cbt_private.rights m where m.regular_id=r.id and m.official_makeup)
            then 'reguler' end as official_result,
          case when a.submitted_at is not null then 'final'
            when a.started_at is null then 'pending'
            when least(a.deadline,coalesce(v_exam.closed_at,a.deadline))<=v_now then 'finalizing'
            else 'active' end as attempt_status
        from cbt_private.rights r join public.cbt_students s on s.id=r.student_id
        left join cbt_private.attempts a on a.right_id=r.id
        left join cbt_private.results f on f.right_id=r.id and f.version=v_exam.grading_version
        where r.exam_id=v_id and (v_admin or s.class_code=any(v_profile.classes))) p),'[]'),
      'candidates',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'nis',s.nis,'full_name',s.full_name,
        'class_code',s.class_code) order by s.class_code,s.full_name)
        from public.cbt_students s where s.is_active and s.grade_level=v_exam.grade_level and s.class_code=any(v_exam.classes)
        and not v_exam.makeup_only),'[]'),
      'audit',coalesce((select jsonb_agg(to_jsonb(l) order by id desc) from
        (select id,action,created_at,detail from cbt_private.audit where exam_id=v_id order by id desc limit 100) l),'[]'));
  end if;

  if p_action='publish' then
    if v_exam.status='published' and v_now<v_exam.opens_at and
       p_data->'question_ids'=(select jsonb_agg(q.question_id order by q.position) from cbt_private.exam_questions q where exam_id=v_id)
       then return jsonb_build_object('id',v_id); end if;
    if v_exam.status<>'draft' or v_now>=v_exam.opens_at then raise exception 'EXAM_STATE'; end if;
    perform cbt_private.assert_schedule(v_exam.opens_at,v_exam.closes_at,v_exam.duration_minutes,v_exam.slot_id);
    if not v_exam.makeup_only and (
      exists (select 1 from cbt_private.exams e where e.id<>v_id and e.status='published' and not e.makeup_only
        and e.grade_level=v_exam.grade_level and e.classes && v_exam.classes
        and e.opens_at<v_exam.closes_at and e.closes_at>v_exam.opens_at)
      or exists (select 1 from cbt_private.rights r join public.cbt_students s on s.id=r.student_id
        join cbt_private.exams e on e.id=r.exam_id where r.regular_id is not null and e.status='published'
        and s.grade_level=v_exam.grade_level and s.class_code=any(v_exam.classes)
        and r.opens_at<v_exam.closes_at and r.closes_at>v_exam.opens_at)
    ) then raise exception 'SCHEDULE_OVERLAP'; end if;
    select array_agg(x::uuid order by n),count(distinct x::uuid) into v_ids,v_count
      from jsonb_array_elements_text(p_data->'question_ids') with ordinality as t(x,n);
    if coalesce(cardinality(v_ids),0)<>v_exam.question_count or v_count<>v_exam.question_count
      then raise exception 'INVALID_QUESTIONS'; end if;
    insert into cbt_private.exam_questions(exam_id,position,question_id,prompt,options,correct_option,weight,image_url)
      select v_id,t.n,q.id,q.prompt,q.options,q.correct_option,q.weight,q.image_url
      from unnest(v_ids) with ordinality as t(id,n) join public.cbt_question_bank q on q.id=t.id
      where q.subject_id=v_exam.subject_id and q.review_status='approved' and cbt_private.valid_options(q.options);
    get diagnostics v_count=row_count;
    if v_count<>v_exam.question_count then raise exception 'INVALID_QUESTIONS'; end if;
    insert into cbt_private.grading_keys(exam_id,version,position,correct_option)
      select exam_id,1,position,correct_option from cbt_private.exam_questions where exam_id=v_id;
    if not v_exam.makeup_only then
      insert into cbt_private.rights(exam_id,student_id)
        select v_id,id from public.cbt_students where grade_level=v_exam.grade_level
        and class_code=any(v_exam.classes) and is_active on conflict (exam_id,student_id) do nothing;
      if not exists (select 1 from cbt_private.rights where exam_id=v_id)
        then raise exception 'INVALID_PARTICIPANTS'; end if;
    end if;
    update cbt_private.exams set status='published' where id=v_id;
    insert into cbt_private.audit(actor,exam_id,action,detail) values
      (v_user,v_id,p_action,jsonb_build_object('question_count',v_count));
    return jsonb_build_object('id',v_id);
  end if;

  if p_action='participants' then
    if v_exam.status<>'published' or v_exam.makeup_only or v_now>=v_exam.opens_at then raise exception 'EXAM_STATE'; end if;
    v_enabled := (p_data->>'enabled')::boolean;
    select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(p_data->'student_ids') x;
    if coalesce(cardinality(v_ids),0) not between 1 and 280 or v_enabled is null
      or (select count(*) from public.cbt_students where id=any(v_ids) and grade_level=v_exam.grade_level
        and class_code=any(v_exam.classes) and (is_active or not v_enabled))<>cardinality(v_ids)
      then raise exception 'INVALID_PARTICIPANTS'; end if;
    if v_enabled then
      insert into cbt_private.rights(exam_id,student_id)
        select v_id,x from unnest(v_ids) x on conflict (exam_id,student_id) do nothing;
    else
      if exists (select 1 from cbt_private.rights r where r.exam_id=v_id and r.student_id=any(v_ids)
        and (exists (select 1 from cbt_private.attempts where right_id=r.id)
         or exists (select 1 from cbt_private.rights m where m.regular_id=r.id)))
        then raise exception 'EXAM_STATE'; end if;
      delete from cbt_private.rights where exam_id=v_id and student_id=any(v_ids);
    end if;
    get diagnostics v_count=row_count;
    insert into cbt_private.audit(actor,exam_id,action,detail) values
      (v_user,v_id,p_action,jsonb_build_object('count',v_count,'enabled',v_enabled));
    return jsonb_build_object('count',v_count);
  end if;

  if p_action='tokens' then
    if v_exam.status='draft' then raise exception 'EXAM_STATE'; end if;
    v_mode := p_data->>'mode';
    select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(p_data->'right_ids') x;
    if v_mode is null or v_mode not in ('issue','rotate','revoke') or coalesce(cardinality(v_ids),0) not between 1 and 280
      then raise exception 'INVALID_INPUT'; end if;
    select count(*) into v_count from cbt_private.rights r join public.cbt_students s on s.id=r.student_id
      where r.exam_id=v_id and r.id=any(v_ids) and (s.is_active or v_mode='revoke')
      and (v_admin or s.class_code=any(v_profile.classes));
    if v_count<>cardinality(v_ids) then raise exception 'INVALID_PARTICIPANTS'; end if;
    v_total := 0;
    for v_item in select r.id,r.token_hash,r.closes_at,s.nis,s.full_name,s.class_code
      from cbt_private.rights r join public.cbt_students s on s.id=r.student_id where r.exam_id=v_id and r.id=any(v_ids)
      order by s.class_code,s.full_name
    loop
      if (v_mode='issue' and v_item.token_hash is not null) or (v_mode='revoke' and v_item.token_hash is null)
        then continue; end if;
      v_token := case when v_mode<>'revoke' then cbt_private.new_token() end;
      update cbt_private.rights set token_hash=extensions.digest(v_token,'sha256'),token_version=token_version+1,
        token_expires_at=case when v_token is not null then greatest(v_now,coalesce(v_item.closes_at,v_exam.closes_at))+interval '30 days' end
        where id=v_item.id;
      v_total := v_total+1;
      if v_token is not null then v_output := v_output||jsonb_build_array(jsonb_build_object('right_id',v_item.id,
        'nis',v_item.nis,'full_name',v_item.full_name,'class_code',v_item.class_code,'token',v_token)); end if;
    end loop;
    insert into cbt_private.audit(actor,exam_id,action,detail) values
      (v_user,v_id,p_action,jsonb_build_object('mode',v_mode,'count',v_total,'rights',v_ids));
    return v_output;
  end if;

  if p_action='makeup' then
    v_reason := btrim(p_data->>'reason');
    v_open := (p_data->>'opens_at')::timestamptz;
    v_close := (p_data->>'closes_at')::timestamptz;
    v_duration := (p_data->>'duration_minutes')::integer;
    select * into v_right from cbt_private.rights where id=(p_data->>'regular_id')::uuid and regular_id is null;
    if not found then raise exception 'FORBIDDEN'; end if;
    select * into v_regular_exam from cbt_private.exams where id=v_right.exam_id for update;
    if not v_admin and not (v_regular_exam.classes <@ v_profile.classes) then raise exception 'FORBIDDEN'; end if;
    select s.class_code,s.grade_level into v_item from public.cbt_students s where s.id=v_right.student_id and s.is_active;
    if not found or (not v_admin and not v_item.class_code=any(v_profile.classes))
      then raise exception 'FORBIDDEN'; end if;
    if v_exam.status<>'published' or not v_exam.makeup_only or v_regular_exam.status='draft' or v_exam.id=v_regular_exam.id
      or v_exam.subject_id<>v_regular_exam.subject_id or v_exam.grade_level<>v_regular_exam.grade_level
      or v_exam.grade_level<>v_item.grade_level or not v_item.class_code=any(v_exam.classes)
      or exists (select 1 from cbt_private.exam_questions a join cbt_private.exam_questions b on a.question_id=b.question_id
        where a.exam_id=v_exam.id and b.exam_id=v_regular_exam.id)
      then raise exception 'MAKEUP_PACKAGE'; end if;
    if v_reason is null or length(v_reason) not between 3 and 500 then raise exception 'INVALID_INPUT'; end if;
    select r.id into v_subject from cbt_private.rights r where r.regular_id=v_right.id;
    if found then
      if exists (select 1 from cbt_private.rights where id=v_subject and exam_id=v_id and reason=v_reason
        and opens_at=v_open and closes_at=v_close and duration_minutes=v_duration)
        then return jsonb_build_object('right_id',v_subject,'token',null); end if;
      raise exception 'MAKEUP_EXISTS';
    end if;
    perform cbt_private.assert_schedule(v_open,v_close,v_duration,v_exam.slot_id);
    if v_open<=v_now or v_open<least(v_regular_exam.closes_at,coalesce(v_regular_exam.closed_at,v_regular_exam.closes_at))
      or v_open<v_exam.opens_at or v_close>v_exam.closes_at then raise exception 'INVALID_SCHEDULE'; end if;
    if exists (select 1 from cbt_private.rights r join cbt_private.exams e on e.id=r.exam_id
      where r.student_id=v_right.student_id and e.status='published' and coalesce(r.opens_at,e.opens_at)<v_close
      and coalesce(r.closes_at,e.closes_at)>v_open)
      then raise exception 'SCHEDULE_OVERLAP'; end if;
    v_token := cbt_private.new_token();
    insert into cbt_private.rights(exam_id,student_id,regular_id,reason,opens_at,closes_at,duration_minutes,
      token_hash,token_version,token_expires_at)
    values(v_id,v_right.student_id,v_right.id,v_reason,v_open,v_close,v_duration,extensions.digest(v_token,'sha256'),1,
      v_close+interval '30 days') returning id into v_subject;
    insert into cbt_private.audit(actor,exam_id,action,detail) values (v_user,v_id,p_action,
      jsonb_build_object('right_id',v_subject,'regular_id',v_right.id,'reason',v_reason,'opens_at',v_open,'closes_at',v_close));
    return jsonb_build_object('right_id',v_subject,'token',v_token);
  end if;

  if p_action='close' then
    if v_exam.status='closed' then return jsonb_build_object('id',v_id); end if;
    if v_exam.status<>'published' then raise exception 'EXAM_STATE'; end if;
    update cbt_private.exams set status='closed',closed_at=v_now where id=v_id;
    insert into cbt_private.audit(actor,exam_id,action) values (v_user,v_id,p_action);
    return jsonb_build_object('id',v_id);
  end if;

  if p_action='extend' then
    v_duration := (p_data->>'extra_minutes')::integer;
    v_reason := btrim(p_data->>'reason');
    v_subject := (p_data->>'right_id')::uuid;
    if v_duration is null or v_duration not between 1 and 120 or v_reason is null or length(v_reason) not between 3 and 500
      then raise exception 'INVALID_INPUT'; end if;
    select r.* into v_right from cbt_private.rights r join public.cbt_students s on s.id=r.student_id
      where r.id=v_subject and r.exam_id=v_id and (v_admin or s.class_code=any(v_profile.classes));
    if not found then raise exception 'FORBIDDEN'; end if;
    v_close := coalesce(v_right.closes_at,v_exam.closes_at);
    if v_exam.status<>'published' then raise exception 'EXAM_STATE'; end if;
    update cbt_private.attempts set deadline=least(deadline+make_interval(mins=>v_duration),v_close)
      where right_id=v_subject and submitted_at is null and deadline>clock_timestamp() and deadline<v_close
      returning deadline into v_open;
    if not found then raise exception 'EXAM_STATE'; end if;
    insert into cbt_private.audit(actor,exam_id,action,detail) values (v_user,v_id,p_action,
      jsonb_build_object('right_id',v_subject,'reason',v_reason,'deadline',v_open));
    return jsonb_build_object('deadline',v_open);
  end if;

  if p_action='official' then
    v_subject := (p_data->>'right_id')::uuid;
    v_enabled := (p_data->>'is_makeup_official')::boolean;
    v_reason := btrim(p_data->>'reason');
    if v_enabled is null or v_reason is null or length(v_reason) not between 3 and 500 then raise exception 'INVALID_INPUT'; end if;
    select r.* into v_right from cbt_private.rights r join public.cbt_students s on s.id=r.student_id
      join cbt_private.attempts a on a.right_id=r.id and a.submitted_at is not null
      where r.id=v_subject and r.exam_id=v_id and r.regular_id is not null and (v_admin or s.class_code=any(v_profile.classes));
    if not found then raise exception 'INVALID_PARTICIPANTS'; end if;
    select e.* into v_regular_exam from cbt_private.rights r join cbt_private.exams e on e.id=r.exam_id where r.id=v_right.regular_id;
    if not v_admin and not (v_regular_exam.classes <@ v_profile.classes) then raise exception 'FORBIDDEN'; end if;
    update cbt_private.rights set official_makeup=v_enabled where id=v_subject;
    insert into cbt_private.audit(actor,exam_id,action,detail) values (v_user,v_id,p_action,
      jsonb_build_object('right_id',v_subject,'is_makeup_official',v_enabled,'reason',v_reason));
    return jsonb_build_object('right_id',v_subject);
  end if;

  if p_action='finalize' then
    v_count := 0;
    for v_item in select a.right_id,a.deadline from cbt_private.attempts a join cbt_private.rights r on r.id=a.right_id
      where r.exam_id=v_id and a.submitted_at is null and least(a.deadline,coalesce(v_exam.closed_at,a.deadline))<=v_now
      order by a.deadline limit 280 for update of a
    loop
      perform cbt_private.finalize_attempt(v_item.right_id,least(v_item.deadline,v_exam.closed_at),
        case when v_exam.closed_at<v_item.deadline then 'closed' else 'timeout' end,v_exam.grading_version);
      v_count := v_count+1;
    end loop;
    return jsonb_build_object('count',v_count);
  end if;

  if p_action in ('correct','correction_preview','release') then
    if v_exam.status='draft' or (v_exam.status='published' and v_now<v_exam.closes_at) then raise exception 'EXAM_STATE'; end if;
    if exists (select 1 from cbt_private.attempts a join cbt_private.rights r on r.id=a.right_id
      where r.exam_id=v_id and a.submitted_at is null) then raise exception 'RESULTS_PENDING'; end if;
    if p_action='release' then
      if exists (select 1 from cbt_private.rights r join cbt_private.rights m on m.regular_id=r.id
        join cbt_private.exams e on e.id=m.exam_id left join cbt_private.attempts a on a.right_id=m.id
        where r.exam_id=v_id and (a.started_at is not null and a.submitted_at is null
          or e.status='published' and m.closes_at>v_now)) then raise exception 'RESULTS_PENDING'; end if;
      if v_exam.released_at is not null then return jsonb_build_object('released_at',v_exam.released_at); end if;
      update cbt_private.exams set released_at=v_now where id=v_id;
      insert into cbt_private.audit(actor,exam_id,action) values (v_user,v_id,p_action);
      return jsonb_build_object('released_at',v_now);
    end if;
    v_position := (p_data->>'position')::integer;
    v_key := p_data->>'correct_option';
    v_reason := btrim(p_data->>'reason');
    v_version := (p_data->>'expected_version')::integer;
    if not (p_data ? 'correct_option') or (v_key is not null and v_key not in ('A','B','C','D'))
      or not exists (select 1 from cbt_private.grading_keys where exam_id=v_id and version=v_exam.grading_version and position=v_position)
      then raise exception 'INVALID_QUESTIONS'; end if;
    if v_version is distinct from v_exam.grading_version then
      if p_action='correct' and v_version=v_exam.grading_version-1 and exists (
        select 1 from cbt_private.audit where exam_id=v_id and action='correct'
        and detail->>'version'=v_exam.grading_version::text and detail->>'position'=v_position::text
        and (detail->>'correct_option') is not distinct from v_key and detail->>'reason'=v_reason
      ) then return jsonb_build_object('version',v_exam.grading_version); end if;
      raise exception 'STALE_VERSION';
    end if;
    if p_action='correction_preview' then
      return (select jsonb_build_object('affected',count(*) filter (where before_score is distinct from after_score),
        'finalized',count(*),'review',count(*) filter (where after_score is null))
      from (
        select f.score as before_score, round(100*coalesce(sum(q.weight) filter (
          where (a.answers->q.position::text->>'option')=k.key),0)
          /nullif(sum(q.weight) filter (where k.key is not null),0),2) as after_score
        from cbt_private.rights r join cbt_private.attempts a on a.right_id=r.id and a.submitted_at is not null
        join cbt_private.results f on f.right_id=a.right_id and f.version=v_version
        join cbt_private.exam_questions q on q.exam_id=r.exam_id
        join lateral (select case when g.position=v_position then v_key else g.correct_option end as key
          from cbt_private.grading_keys g where g.exam_id=q.exam_id and g.position=q.position and g.version=v_version) k on true
        where r.exam_id=v_id group by a.right_id,f.score
      ) preview);
    end if;
    if v_reason is null or length(v_reason) not between 3 and 500 then raise exception 'INVALID_INPUT'; end if;
    if exists (select 1 from cbt_private.grading_keys where exam_id=v_id and version=v_version and position=v_position
      and correct_option is not distinct from v_key) then return jsonb_build_object('version',v_version); end if;
    v_version := v_version+1;
    insert into cbt_private.grading_keys(exam_id,version,position,correct_option)
      select exam_id,v_version,position,case when position=v_position then v_key else correct_option end
      from cbt_private.grading_keys where exam_id=v_id and version=v_version-1;
    perform cbt_private.grade(a.right_id,v_version)
      from cbt_private.attempts a join cbt_private.rights r on r.id=a.right_id
      where r.exam_id=v_id and a.submitted_at is not null;
    update cbt_private.exams set grading_version=v_version,released_at=null where id=v_id;
    insert into cbt_private.audit(actor,exam_id,action,detail) values (v_user,v_id,p_action,
      jsonb_build_object('version',v_version,'position',v_position,'correct_option',v_key,'reason',v_reason));
    return jsonb_build_object('version',v_version);
  end if;

  raise exception 'INVALID_INPUT';
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format
  or datetime_field_overflow or invalid_parameter_value or check_violation then
  raise exception 'INVALID_INPUT';
end;
$$;

create or replace function public.cbt_staff(p_action text,p_data jsonb default '{}')
returns jsonb language sql security invoker set search_path = '' as $$
  select cbt_private.staff_api(p_action,p_data);
$$;

revoke all on function cbt_private.assert_schedule(timestamptz,timestamptz,integer,smallint),
  cbt_private.valid_options(jsonb),cbt_private.new_token(),cbt_private.staff_api(text,jsonb),
  public.cbt_staff(text,jsonb) from public,anon,authenticated;
grant usage on schema cbt_private to authenticated;
grant execute on function cbt_private.staff_api(text,jsonb),public.cbt_staff(text,jsonb) to authenticated;
