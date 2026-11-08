-- Schema-only record of the existing hosted migration. Question text and keys stay in the project.
create table if not exists public.cbt_subjects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.cbt_question_bank (
  id uuid primary key default gen_random_uuid(),
  question_code text not null unique,
  subject_id uuid not null references public.cbt_subjects(id),
  question_number smallint not null check (question_number > 0),
  grade_scope text not null,
  prompt text not null,
  options jsonb not null check (jsonb_typeof(options)='object'),
  correct_option text not null check (correct_option in ('A','B','C','D')),
  review_status text not null default 'draft' check (review_status in ('draft','approved','archived')),
  source_label text not null default 'CBT pilot sample',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subject_id,question_number)
);
create index if not exists cbt_question_bank_subject_status_idx on public.cbt_question_bank(subject_id,review_status);
alter table public.cbt_subjects enable row level security;
alter table public.cbt_question_bank enable row level security;
revoke all on public.cbt_subjects,public.cbt_question_bank from public,anon,authenticated;
