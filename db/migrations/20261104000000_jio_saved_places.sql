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
