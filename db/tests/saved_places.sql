-- Rollback test for db/migrations/20261104000000_jio_saved_places.sql.
-- Run this whole file as the project owner. It temporarily installs the migration (a copy, kept identical to the file), checks the table as
-- two signed-in people, as someone logged out and as the server, and rolls back both the DDL and the throwaway data at the end. Nothing is
-- left on the project. A broken rule stops the run with `FAIL step N`, and a run that passes ends with a result row.

begin;

-- The migration, installed inside this transaction so the live schema is unchanged after the rollback.
-- A person's saved places: the places they ticked on "Places from a post", to suggest in a session later. Each person reads and changes only
-- their own, directly from the browser. Nothing else reads them: a saved place reaches a session only when its owner adds it.
--
-- Google's terms allow keeping a place's id and nothing else of its data, so `name`, `name_english`, `tip` and `location_hint` are what the
-- post itself said, and `google_place_id` is the only value from Google. A place's address and rating are asked for by id when shown, never
-- stored. `location_hint` is where the post says the place is, such as "Katong"; it may be empty.
--
-- No existing table, function or trigger changes. Idempotent; the fresh-build equivalent is in db/schema.sql and db/policies.sql.
-- Test: db/tests/saved_places.sql

create table if not exists public.saved_places (
  id uuid primary key default gen_random_uuid(),
  -- The signed-in person, always: the browser may not send this column.
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null constraint saved_places_name_length check (char_length(trim(name)) between 1 and 120),
  name_english text constraint saved_places_name_english_length check (char_length(name_english) <= 120),
  -- What kinds of place the person says it is, one or more: a cafe may be somewhere to eat and to drink.
  categories text[] not null
    constraint saved_places_categories check (
      categories <@ array['eat', 'drink', 'shop', 'activity']::text[]
      and coalesce(array_ndims(categories), 1) = 1
      and cardinality(categories) between 1 and 4
      and public.array_is_unique(categories)
    ),
  tip text constraint saved_places_tip_length check (char_length(tip) <= 500),
  location_hint text constraint saved_places_location_hint_length check (char_length(location_hint) <= 120),
  google_place_id text constraint saved_places_google_place_id_length check (char_length(google_place_id) <= 300),
  -- The post it came from. A web link only, because a screen opens it.
  post_key text constraint saved_places_post_key_length check (char_length(post_key) <= 200),
  post_url text constraint saved_places_post_url_shape check (char_length(post_url) <= 2000 and post_url ~* '^https?://'),
  created_at timestamptz not null default now()
);

create index if not exists saved_places_user_idx on public.saved_places (user_id, created_at desc);
-- A person keeps a place once: by its Google id, or by its name when it has none.
create unique index if not exists saved_places_one_by_google_idx on public.saved_places (user_id, google_place_id) where google_place_id is not null;
create unique index if not exists saved_places_one_by_name_idx on public.saved_places (user_id, lower(trim(name))) where google_place_id is null;

alter table public.saved_places enable row level security;

drop policy if exists saved_places_select_own on public.saved_places;
create policy saved_places_select_own on public.saved_places for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists saved_places_insert_own on public.saved_places;
create policy saved_places_insert_own on public.saved_places for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists saved_places_update_own on public.saved_places;
create policy saved_places_update_own on public.saved_places for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists saved_places_delete_own on public.saved_places;
create policy saved_places_delete_own on public.saved_places for delete to authenticated
  using (user_id = (select auth.uid()));

-- A person sends what the post said and picks its categories, and later may change only those. A logged-out visitor has nothing.
revoke all on public.saved_places from anon, authenticated;
grant select, delete on public.saved_places to authenticated;
grant insert (name, name_english, categories, tip, location_hint, google_place_id, post_key, post_url) on public.saved_places to authenticated;
grant update (categories) on public.saved_places to authenticated;
grant all on public.saved_places to service_role;

-- Acts as the project owner (no signed-in person, no claims), as a signed-in person, as someone logged out, or as the server.
--   select pg_temp.as_owner();  select pg_temp.as_user('<id>'::uuid);  select pg_temp.as_anon();  select pg_temp.as_server();
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
create function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
end;
$$;
create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
end;
$$;
create function pg_temp.as_server() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
end;
$$;

-- The statement must fail with this error code (and, when given, a message containing this text).
--   select pg_temp.expect_error(5, 'select ...', '42501');
create function pg_temp.expect_error(step int, stmt text, wanted text, msg_part text default null) returns void
language plpgsql as $$
declare
  got_code text;
  got_msg text;
begin
  begin
    execute stmt;
  exception when others then
    got_code := sqlstate;
    got_msg := sqlerrm;
  end;
  if got_code is distinct from wanted or (msg_part is not null and got_msg not ilike '%' || msg_part || '%') then
    raise exception 'FAIL step %: wanted error % mentioning %, got % %', step, wanted, msg_part,
      coalesce(got_code, 'success'), coalesce(got_msg, '');
  end if;
  raise notice 'ok step %', step;
end;
$$;

create function pg_temp.new_user(u uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u, 'authenticated', 'authenticated', u || '@example.test',
          jsonb_build_object('username', 't' || substr(md5(u::text), 1, 12), 'dob', '2000-01-01'));
end;
$$;

do $test$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  row_a uuid;
  owner_id uuid;
  n int;
  got text;
begin
  perform pg_temp.new_user(a);
  perform pg_temp.new_user(b);

  -- 1. A person saves a place, and it is theirs without sending who they are.
  perform pg_temp.as_user(a);
  insert into public.saved_places (name, name_english, categories, tip, location_hint, google_place_id, post_key, post_url)
  values ('Next Door Cafe', 'Next Door Cafe', '{eat,drink}', 'Try the paella', 'Katong', 'g_one', 'tiktok:1', 'https://www.tiktok.com/@x/video/1')
  returning id, user_id into row_a, owner_id;
  if owner_id is distinct from a then raise exception 'FAIL step 1: the row belongs to %', owner_id; end if;
  raise notice 'ok step 1';

  -- 2. They read it, and someone else does not.
  select count(*) into n from public.saved_places;
  if n <> 1 then raise exception 'FAIL step 2: the owner read % rows', n; end if;
  perform pg_temp.as_user(b);
  select count(*) into n from public.saved_places;
  if n <> 0 then raise exception 'FAIL step 2: someone else read % rows', n; end if;
  raise notice 'ok step 2';

  -- 3. Nobody saves a place as someone else: the column is not theirs to send.
  perform pg_temp.expect_error(3, format($$insert into public.saved_places (user_id, name, categories) values (%L, 'Forged', '{eat}')$$, a), '42501');

  -- 4. Someone else's row cannot be changed or deleted: it is not even found.
  update public.saved_places set categories = '{shop}' where id = row_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL step 4: changed % rows of someone else', n; end if;
  delete from public.saved_places where id = row_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL step 4: deleted % rows of someone else', n; end if;
  raise notice 'ok step 4';

  -- 5. The owner may change the categories, and nothing else.
  perform pg_temp.as_user(a);
  update public.saved_places set categories = '{drink}' where id = row_a;
  select array_to_string(categories, ',') into got from public.saved_places where id = row_a;
  if got <> 'drink' then raise exception 'FAIL step 5: the categories are %', got; end if;
  raise notice 'ok step 5';
  perform pg_temp.expect_error(6, format($$update public.saved_places set name = 'Other' where id = %L$$, row_a), '42501');
  perform pg_temp.expect_error(7, format($$update public.saved_places set google_place_id = 'g_other' where id = %L$$, row_a), '42501');
  perform pg_temp.expect_error(8, format($$update public.saved_places set user_id = %L where id = %L$$, b, row_a), '42501');

  -- 9 to 11. Someone logged out has nothing.
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(9, 'select * from public.saved_places', '42501');
  perform pg_temp.expect_error(10, $$insert into public.saved_places (name, categories) values ('Anon', '{eat}')$$, '42501');
  perform pg_temp.expect_error(11, 'delete from public.saved_places', '42501');

  -- 12 to 17. The shape of a row.
  perform pg_temp.as_user(a);
  perform pg_temp.expect_error(12, $$insert into public.saved_places (name, categories) values ('Bad', '{nightclub}')$$, '23514', 'saved_places_categories');
  perform pg_temp.expect_error(13, $$insert into public.saved_places (name, categories) values ('   ', '{eat}')$$, '23514', 'saved_places_name_length');
  perform pg_temp.expect_error(14, format($$insert into public.saved_places (name, categories) values (%L, '{eat}')$$, repeat('x', 121)), '23514', 'saved_places_name_length');
  perform pg_temp.expect_error(15, format($$insert into public.saved_places (name, categories, tip) values ('Long tip', '{eat}', %L)$$, repeat('x', 501)), '23514', 'saved_places_tip_length');
  perform pg_temp.expect_error(16, $$insert into public.saved_places (name, categories, post_url) values ('Link', '{eat}', 'javascript:alert(1)')$$, '23514', 'saved_places_post_url_shape');
  perform pg_temp.expect_error(17, format($$insert into public.saved_places (name, categories, location_hint) values ('Hint', '{eat}', %L)$$, repeat('x', 121)), '23514', 'saved_places_location_hint_length');

  -- 18 to 19. A person keeps a place once, by its Google id or, with none, by its name in any case.
  perform pg_temp.expect_error(18, $$insert into public.saved_places (name, categories, google_place_id) values ('Same place', '{eat}', 'g_one')$$, '23505');
  insert into public.saved_places (name, categories) values ('Goliath Outdoor', '{shop}');
  perform pg_temp.expect_error(19, $$insert into public.saved_places (name, categories) values (' goliath OUTDOOR ', '{shop}')$$, '23505');

  -- 20. Two people may keep the same place.
  perform pg_temp.as_user(b);
  insert into public.saved_places (name, categories, google_place_id) values ('Next Door Cafe', '{eat}', 'g_one');
  insert into public.saved_places (name, categories) values ('Goliath Outdoor', '{shop}');
  select count(*) into n from public.saved_places;
  if n <> 2 then raise exception 'FAIL step 20: the second person has % rows', n; end if;
  raise notice 'ok step 20';

  -- 21. The owner deletes their own.
  perform pg_temp.as_user(a);
  delete from public.saved_places where id = row_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL step 21: deleted % rows', n; end if;
  raise notice 'ok step 21';

  -- 22. The server reads everyone's.
  perform pg_temp.as_server();
  select count(*) into n from public.saved_places where user_id in (a, b);
  if n <> 3 then raise exception 'FAIL step 22: the server read % rows', n; end if;
  raise notice 'ok step 22';

  -- 23. Row-level security is on, and the privileges are the ones meant.
  perform pg_temp.as_owner();
  if not (select relrowsecurity from pg_class where oid = 'public.saved_places'::regclass) then raise exception 'FAIL step 23: row-level security is off'; end if;
  if has_table_privilege('anon', 'public.saved_places', 'select') or has_table_privilege('anon', 'public.saved_places', 'insert')
     or has_table_privilege('authenticated', 'public.saved_places', 'truncate') or has_table_privilege('authenticated', 'public.saved_places', 'update')
     or not has_column_privilege('authenticated', 'public.saved_places', 'categories', 'update')
     or has_column_privilege('authenticated', 'public.saved_places', 'user_id', 'insert') then
    raise exception 'FAIL step 23: the privileges are wrong';
  end if;
  raise notice 'ok step 23';

  -- 24. A person's saved places go with their account.
  delete from auth.users where id = b;
  select count(*) into n from public.saved_places where user_id = b;
  if n <> 0 then raise exception 'FAIL step 24: % rows were left after the account went', n; end if;
  raise notice 'ok step 24';

  -- 25 to 27. At least one category, no repeats, and a flat list.
  perform pg_temp.as_user(a);
  perform pg_temp.expect_error(25, $$insert into public.saved_places (name, categories) values ('None', '{}')$$, '23514', 'saved_places_categories');
  perform pg_temp.expect_error(26, $$insert into public.saved_places (name, categories) values ('Twice', '{eat,eat}')$$, '23514', 'saved_places_categories');
  perform pg_temp.expect_error(27, $$insert into public.saved_places (name, categories) values ('Nested', '{{eat},{drink}}')$$, '23514', 'saved_places_categories');

  raise notice 'ALL STEPS PASSED';
end;
$test$;

rollback;

-- Readable result: this row appears only when every step above passed (a failed step stops the run with FAIL step N).
select 'all 27 steps passed; nothing was left on the project' as result;
