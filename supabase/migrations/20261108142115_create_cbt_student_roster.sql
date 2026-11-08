-- Schema-only record of the existing hosted migration. Roster data stays in the project.
create table if not exists public.cbt_students (
  id uuid primary key default gen_random_uuid(),
  nis text not null unique,
  full_name text not null,
  class_code text not null,
  grade_level smallint not null check (grade_level in (10,11,12)),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cbt_students enable row level security;
revoke all on public.cbt_students from public,anon,authenticated;
