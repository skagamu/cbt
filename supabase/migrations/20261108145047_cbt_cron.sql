create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule('cbt-finalize-due', '* * * * *',
  'select cbt_private.finalize_due();');

select cron.schedule('cbt-clear-expired-student-sessions', '17 * * * *', $job$
  delete from cbt_private.student_sessions where expires_at <= now();
  delete from cbt_private.student_login_limits where reset_at <= now();
  delete from cron.job_run_details
  where start_time < now() - interval '7 days'
    and jobid in (
      select jobid from cron.job
      where jobname in ('cbt-finalize-due','cbt-clear-expired-student-sessions')
    );
$job$);
