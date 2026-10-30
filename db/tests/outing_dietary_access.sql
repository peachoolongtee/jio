-- Rollback test for db/migrations/20261030000000_jio_outing_dietary.sql.
-- Run this whole file as the project owner. It installs the migration inside the transaction, checks that no browser (signed in or
-- not) can read or write either table, that the server can, and that the tables keep only real needs and follow the session and its
-- members away, then rolls everything back. Nothing is left on the project.

begin;

-- The migration, inside this transaction so the live schema is unchanged after rollback.
create table if not exists public.session_member_diet (
  session_id uuid not null,
  user_id uuid not null,
  needs text[] not null default '{}'
    check (needs <@ array['halal', 'vegetarian', 'vegan']::text[] and public.array_is_unique(needs)),
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id),
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);

create table if not exists public.session_diet_dropped (
  session_id uuid not null references public.sessions (id) on delete cascade,
  need text not null check (need in ('halal', 'vegetarian', 'vegan')),
  dropped_at timestamptz not null default now(),
  primary key (session_id, need)
);

create or replace trigger session_member_diet_set_updated_at before update on public.session_member_diet
  for each row execute function public.set_updated_at();

alter table public.session_member_diet enable row level security;
alter table public.session_diet_dropped enable row level security;
revoke all on public.session_member_diet, public.session_diet_dropped from anon, authenticated;
grant all on public.session_member_diet, public.session_diet_dropped to service_role;

create function pg_temp.new_user(u uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u, 'authenticated', 'authenticated', u || '@example.test',
          jsonb_build_object('username', 't' || substr(md5(u::text), 1, 12), 'dob', '2000-01-01'));
end;
$$;

create function pg_temp.try(stmt text, out code text, out msg text)
language plpgsql as $$
begin
  execute stmt;
  code := null;
  msg := null;
exception when others then
  code := sqlstate;
  msg := sqlerrm;
end;
$$;

-- Runs `stmt` as `who` ('anon', 'authenticated' as the user `sub`, or 'service_role') and expects the error `wanted`, or success
-- when `wanted` is null. The role and claims go back to the owner's afterwards.
create function pg_temp.expect_as(step int, who text, sub uuid, stmt text, wanted text) returns void
language plpgsql as $$
declare got record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', sub, 'role', who)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(sub::text, ''), true);
  execute format('set local role %I', who);
  select * into got from pg_temp.try(stmt);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  if got.code is distinct from wanted then
    raise exception 'FAIL step %: as % wanted %, got % %', step, who, coalesce(wanted, 'success'), coalesce(got.code, 'success'), coalesce(got.msg, '');
  end if;
  raise notice 'ok step %', step;
end;
$$;

do $test$
declare
  host uuid := gen_random_uuid();
  guest uuid := gen_random_uuid();
  stranger uuid := gen_random_uuid();
  sid uuid := gen_random_uuid();
  tomorrow date := (statement_timestamp() at time zone 'Asia/Singapore')::date + 1;
  n int;
begin
  perform pg_temp.new_user(host);
  perform pg_temp.new_user(guest);
  perform pg_temp.new_user(stranger);
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status)
    values (sid, host, 'Dinner', tomorrow, '18:00', '21:00', 'voting');
  insert into public.session_members (session_id, user_id, role, state) values (sid, host, 'host', 'joined') on conflict do nothing;
  insert into public.session_members (session_id, user_id, role, state) values (sid, guest, 'guest', 'joined') on conflict do nothing;

  -- The server writes a member's needs for the outing and a dropped need.
  perform pg_temp.expect_as(1, 'service_role', null, format('insert into public.session_member_diet (session_id, user_id, needs) values (%L, %L, %L)', sid, guest, '{halal}'), null);
  perform pg_temp.expect_as(2, 'service_role', null, format('insert into public.session_diet_dropped (session_id, need) values (%L, %L)', sid, 'halal'), null);
  perform pg_temp.expect_as(3, 'service_role', null, format('update public.session_member_diet set needs = %L where session_id = %L and user_id = %L', '{vegan,halal}', sid, guest), null);

  -- No signed-in person reads either table: not the member whose needs they are, not the host, not a stranger.
  perform pg_temp.expect_as(4, 'authenticated', guest, 'select * from public.session_member_diet', '42501');
  perform pg_temp.expect_as(5, 'authenticated', host, 'select * from public.session_member_diet', '42501');
  perform pg_temp.expect_as(6, 'authenticated', host, 'select * from public.session_diet_dropped', '42501');
  perform pg_temp.expect_as(7, 'authenticated', stranger, 'select * from public.session_diet_dropped', '42501');
  -- Nor writes one: not their own needs, not the host's dropped need.
  perform pg_temp.expect_as(8, 'authenticated', host, format('insert into public.session_member_diet (session_id, user_id, needs) values (%L, %L, %L)', sid, host, '{vegan}'), '42501');
  perform pg_temp.expect_as(9, 'authenticated', guest, format('update public.session_member_diet set needs = %L where user_id = %L', '{}', guest), '42501');
  perform pg_temp.expect_as(10, 'authenticated', host, format('delete from public.session_diet_dropped where session_id = %L', sid), '42501');
  perform pg_temp.expect_as(11, 'authenticated', host, format('insert into public.session_diet_dropped (session_id, need) values (%L, %L)', sid, 'vegan'), '42501');
  -- A visitor who is not signed in gets nothing either.
  perform pg_temp.expect_as(12, 'anon', null, 'select * from public.session_member_diet', '42501');
  perform pg_temp.expect_as(13, 'anon', null, 'select * from public.session_diet_dropped', '42501');

  -- Only real needs, each once.
  perform pg_temp.expect_as(14, 'service_role', null, format('update public.session_member_diet set needs = %L where user_id = %L', '{durian-free}', guest), '23514');
  perform pg_temp.expect_as(15, 'service_role', null, format('update public.session_member_diet set needs = %L where user_id = %L', '{halal,halal}', guest), '23514');
  perform pg_temp.expect_as(16, 'service_role', null, format('insert into public.session_diet_dropped (session_id, need) values (%L, %L)', sid, 'kosher'), '23514');
  perform pg_temp.expect_as(17, 'service_role', null, format('insert into public.session_diet_dropped (session_id, need) values (%L, %L)', sid, 'halal'), '23505');
  -- Only a member of the session has needs in it.
  perform pg_temp.expect_as(18, 'service_role', null, format('insert into public.session_member_diet (session_id, user_id, needs) values (%L, %L, %L)', sid, stranger, '{vegan}'), '23503');
  -- No needs at all is a confirmed answer too.
  perform pg_temp.expect_as(19, 'service_role', null, format('insert into public.session_member_diet (session_id, user_id) values (%L, %L)', sid, host), null);
  select count(*) into n from public.session_member_diet where session_id = sid and user_id = host and needs = '{}';
  if n <> 1 then raise exception 'FAIL step 20: the host''s empty answer was not kept'; end if;
  raise notice 'ok step 20';

  -- The member's needs go with their row (leaving, being removed), and everything goes with the session.
  delete from public.session_members where session_id = sid and user_id = guest;
  select count(*) into n from public.session_member_diet where session_id = sid and user_id = guest;
  if n <> 0 then raise exception 'FAIL step 21: the guest''s needs stayed after they left'; end if;
  raise notice 'ok step 21';
  delete from public.sessions where id = sid;
  select (select count(*) from public.session_member_diet where session_id = sid) + (select count(*) from public.session_diet_dropped where session_id = sid) into n;
  if n <> 0 then raise exception 'FAIL step 22: rows stayed after the session went'; end if;
  raise notice 'ok step 22';

  -- Neither table is in the live-updates publication: nothing about a need is ever pushed to a browser.
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('session_member_diet', 'session_diet_dropped')) then
    raise exception 'FAIL step 23: a dietary table is in the live-updates publication';
  end if;
  raise notice 'ok step 23';
  raise notice 'ALL STEPS PASSED';
end;
$test$;

rollback;
