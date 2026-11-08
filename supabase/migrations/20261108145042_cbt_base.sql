create schema if not exists cbt_private;
revoke all on schema cbt_private from public, anon, authenticated;
alter default privileges in schema cbt_private revoke execute on functions from public;

revoke all on public.cbt_students, public.cbt_subjects, public.cbt_question_bank from public, anon, authenticated;
alter table public.cbt_students enable row level security;
alter table public.cbt_subjects enable row level security;
alter table public.cbt_question_bank enable row level security;

alter table public.cbt_question_bank
  add column if not exists weight numeric(8,2) not null default 1 check (weight between 0.01 and 100),
  add column if not exists image_url text check (image_url like 'https://%' and length(image_url) <= 2048);

create table if not exists cbt_private.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 120),
  role text not null check (role in ('admin','teacher')),
  classes text[] not null default '{}',
  is_active boolean not null default true
);
create table if not exists cbt_private.slots (
  id smallint primary key check (id between 1 and 3),
  label text not null check (length(label) between 1 and 50),
  start_time time not null,
  end_time time not null check (end_time > start_time and end_time < '24:00'),
  is_active boolean not null default true
);
insert into cbt_private.slots (id,label,start_time,end_time)
values (1,'Sesi 1','07:30','09:00'),(2,'Sesi 2','09:30','11:00'),(3,'Sesi 3','11:30','13:00')
on conflict (id) do nothing;

create table if not exists cbt_private.exams (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.cbt_subjects(id),
  title text not null check (length(title) between 1 and 160),
  grade_level smallint not null check (grade_level between 10 and 12),
  classes text[] not null check (cardinality(classes) between 1 and 7),
  opens_at timestamptz not null,
  closes_at timestamptz not null check (isfinite(opens_at) and isfinite(closes_at) and closes_at > opens_at),
  duration_minutes integer not null check (duration_minutes between 1 and 240),
  slot_id smallint references cbt_private.slots(id),
  status text not null default 'draft' check (status in ('draft','published','closed')),
  closed_at timestamptz,
  makeup_only boolean not null default false,
  question_count integer not null default 40 check (question_count between 1 and 40),
  grading_version integer not null default 1 check (grading_version > 0),
  released_at timestamptz,
  created_by uuid references auth.users(id) on delete set null
);
create index if not exists cbt_exams_subject_idx on cbt_private.exams(subject_id);
create index if not exists cbt_exams_slot_idx on cbt_private.exams(slot_id);
create index if not exists cbt_exams_creator_idx on cbt_private.exams(created_by);
create table if not exists cbt_private.exam_questions (
  exam_id uuid not null references cbt_private.exams(id),
  position integer not null check (position between 1 and 40),
  question_id uuid not null references public.cbt_question_bank(id),
  prompt text not null,
  options jsonb not null,
  correct_option text not null check (correct_option in ('A','B','C','D')),
  weight numeric(8,2) not null default 1 check (weight between 0.01 and 100),
  image_url text,
  primary key (exam_id,position),
  unique (exam_id,question_id)
);
create index if not exists cbt_exam_questions_bank_idx on cbt_private.exam_questions(question_id);
create table if not exists cbt_private.grading_keys (
  exam_id uuid not null,
  version integer not null check (version > 0),
  position integer not null,
  correct_option text check (correct_option in ('A','B','C','D')),
  primary key (exam_id,version,position),
  foreign key (exam_id,position) references cbt_private.exam_questions(exam_id,position)
);
create index if not exists cbt_grading_keys_question_idx on cbt_private.grading_keys(exam_id,position);
create table if not exists cbt_private.rights (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references cbt_private.exams(id),
  student_id uuid not null references public.cbt_students(id),
  regular_id uuid unique references cbt_private.rights(id),
  official_makeup boolean not null default false,
  reason text,
  token_hash bytea,
  token_version integer not null default 0,
  token_expires_at timestamptz,
  opens_at timestamptz,
  closes_at timestamptz,
  duration_minutes integer,
  created_at timestamptz not null default now(),
  check ((token_hash is null) = (token_expires_at is null)),
  check (opens_at is null or (isfinite(opens_at) and isfinite(closes_at) and closes_at > opens_at)),
  check (duration_minutes between 1 and 240),
  check (regular_id is null or (reason is not null and opens_at is not null and closes_at is not null and duration_minutes is not null)),
  unique (exam_id,student_id)
);
create index if not exists cbt_rights_student_idx on cbt_private.rights(student_id);
create unique index if not exists cbt_rights_token_idx on cbt_private.rights(token_hash) where token_hash is not null;
create table if not exists cbt_private.attempts (
  right_id uuid primary key references cbt_private.rights(id),
  started_at timestamptz not null,
  deadline timestamptz not null check (deadline > started_at),
  write_device uuid not null,
  write_epoch integer not null default 1 check (write_epoch > 0),
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  revision integer not null default 0 check (revision >= 0),
  saved_at timestamptz,
  submitted_at timestamptz,
  receipt uuid unique,
  submit_reason text check (submit_reason in ('manual','timeout','closed')),
  initial_version integer not null check (initial_version > 0),
  check ((submitted_at is null) = (receipt is null) and (submitted_at is null) = (submit_reason is null))
);
create index if not exists cbt_attempts_due_idx on cbt_private.attempts(deadline) where submitted_at is null;
create table if not exists cbt_private.results (
  right_id uuid not null references cbt_private.attempts(right_id),
  version integer not null check (version > 0),
  score numeric(5,2) check (score between 0 and 100),
  correct_count integer not null,
  wrong_count integer not null,
  blank_count integer not null,
  created_at timestamptz not null default now(),
  primary key (right_id,version)
);
create table if not exists cbt_private.audit (
  id bigint generated always as identity primary key,
  actor uuid references auth.users(id) on delete set null,
  exam_id uuid references cbt_private.exams(id),
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists cbt_audit_exam_idx on cbt_private.audit(exam_id,id desc);
create index if not exists cbt_audit_actor_idx on cbt_private.audit(actor);

alter table cbt_private.staff enable row level security;
alter table cbt_private.slots enable row level security;
alter table cbt_private.exams enable row level security;
alter table cbt_private.exam_questions enable row level security;
alter table cbt_private.grading_keys enable row level security;
alter table cbt_private.rights enable row level security;
alter table cbt_private.attempts enable row level security;
alter table cbt_private.results enable row level security;
alter table cbt_private.audit enable row level security;
revoke all on all tables in schema cbt_private from public, anon, authenticated;

create or replace function cbt_private.grade(p_right uuid,p_version integer)
returns void language sql set search_path = '' as $$
  insert into cbt_private.results (right_id,version,score,correct_count,wrong_count,blank_count)
  select a.right_id,p_version,
    round(100 * coalesce(sum(q.weight) filter (where (a.answers->q.position::text->>'option')=k.correct_option),0)
      / nullif(sum(q.weight) filter (where k.correct_option is not null),0),2),
    count(*) filter (where k.correct_option is not null and (a.answers->q.position::text->>'option')=k.correct_option),
    count(*) filter (where k.correct_option is not null and (a.answers->q.position::text->>'option')<>k.correct_option),
    count(*) filter (where k.correct_option is not null and (a.answers->q.position::text->>'option') is null)
  from cbt_private.attempts a
  join cbt_private.rights r on r.id=a.right_id
  join cbt_private.exam_questions q on q.exam_id=r.exam_id
  join cbt_private.grading_keys k on k.exam_id=q.exam_id and k.position=q.position and k.version=p_version
  where a.right_id=p_right and a.submitted_at is not null
  group by a.right_id
  on conflict (right_id,version) do nothing;
$$;
revoke all on function cbt_private.grade(uuid,integer) from public, anon, authenticated;
