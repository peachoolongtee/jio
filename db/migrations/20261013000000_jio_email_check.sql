-- Jio migration: the email check is for the server only.
--
-- public.email_registered(p_email) was added to the live project by hand with a grant to anon and authenticated, so
-- anyone holding the public key could ask whether any email has an account, as fast as they liked and in bulk. This
-- migration:
--   1. takes the function away from public, anon and authenticated, and grants it to service_role only. The sign-up
--      screen now asks the backend (POST /api/accounts/email-check), which calls it with the service key behind a limit
--      of 10 a minute for each caller;
--   2. compares the column as it is (email = lower(trim(p_email))) instead of wrapping it in lower(), so the index on
--      auth.users.email can be used. Auth stores addresses in lower case;
--   3. ignores accounts with deleted_at set. The live project was not asked whether auth.users has that column: the
--      Auth API's user object carries deleted_at (and @supabase/auth-js 2.117 types it), which mirrors the table. If
--      the column were missing, creating the function below fails and the transaction rolls back with nothing changed.
--
-- security definer and search_path = '' stay, as before.
--
-- Run it once as ONE transaction. Idempotent. db/schema.sql and db/policies.sql carry the same statements.

create or replace function public.email_registered(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.users
    where email = lower(trim(p_email))
      and deleted_at is null
  );
$$;

revoke execute on function public.email_registered(text) from public, anon, authenticated;
grant execute on function public.email_registered(text) to service_role;
