-- Empty local equivalent of the observed Supabase CBT tables and Auth roles.
-- No roster, real question, account, or credential data is copied.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  deleted_at timestamptz,
  banned_until timestamptz
);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  not_after timestamptz
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'
  )::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE public.cbt_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nis text NOT NULL UNIQUE,
  full_name text NOT NULL,
  class_code text NOT NULL,
  grade_level smallint NOT NULL CHECK (grade_level IN (10, 11, 12)),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.cbt_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.cbt_question_bank (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_code text NOT NULL UNIQUE,
  subject_id uuid NOT NULL REFERENCES public.cbt_subjects(id),
  question_number smallint NOT NULL CHECK (question_number > 0),
  grade_scope text NOT NULL,
  prompt text NOT NULL,
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'),
  correct_option text NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
  review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'approved', 'archived')),
  source_label text NOT NULL DEFAULT 'CBT pilot sample',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, question_number)
);
ALTER TABLE public.cbt_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cbt_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cbt_question_bank ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cbt_students, public.cbt_subjects, public.cbt_question_bank TO service_role;
