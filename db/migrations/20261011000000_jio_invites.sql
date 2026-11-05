-- Jio migration, slice a: invites by link and by username.
--
-- What it changes, in the order it appears. Everything here already exists on the live project (the
-- invites table, invite_preview(), join_session() and their rules), so each item is an alteration:
--   1. invites gets invitee_id (a personal invitation) and declined_at.
--   2. expires_at becomes required, defaulting to 7 days and at most 30 days after the link was made.
--      Existing rows are mended first (see the two updates).
--   3. One live link per session, one invitation per person per session, and an index on invitee_id.
--      If a session already has two live links, the older ones are revoked first.
--   4. A trigger on insert: the session is open; a personal invitation is not for the host or for someone
--      already in, and a session has at most 30 open ones.
--   5. invite_preview() is dropped and made again with fewer columns (title, date, times, host name):
--      no session id and no member count. Dropping a function drops its grants, so they are given again.
--   6. join_session() locks the session row, refuses at 30 joined members, refuses a personal invitation
--      that is not the caller's or was declined, and stays idempotent for someone already in.
--   7. New functions my_invitations() and decline_invite().
--   8. Rules: the host's update right narrows to "revoked" and may only set it to true (a revoke cannot be
--      undone); an invitee reads their own rows; members read their session's pending personal rows.
--   9. invites joins the supabase_realtime publication.
--
-- The design's recommendation, awaiting the lead's yes: a pending username invitation lives in invites,
-- not as an 'invited' row in session_members (design question 3). If the answer is no, this migration is
-- replaced by one that adds 'invited' to session_members.state and rewrites my_session_ids() and
-- my_slot_ids() (every read policy hangs on them), and invitee_id, declined_at, the invitee policies,
-- my_invitations() and the personal part of the trigger are not built. Items 2, 3 (one live link), 5, 6
-- (the lock and the cap) and 8 (the narrowed update right) stand either way.
--
-- Run it once as ONE transaction (apply_migration, or one paste into the SQL editor). Every statement is
-- idempotent or guarded, so running it again does nothing. db/schema.sql and db/policies.sql carry the
-- same statements, so a fresh build equals the live project plus this migration. Test it first with
-- db/tests/invites_access.sql inside a transaction that rolls back.

-- ── Columns, data and constraints on invites ────────────────────────────

-- invitee_id is set on an invitation to one named person; a link made for anyone leaves it null.
-- declined_at is set when the invitee says no. Only the server's functions write it.
alter table public.invites
  add column if not exists invitee_id uuid references public.profiles (id) on delete cascade,
  add column if not exists declined_at timestamptz;

-- Mend existing rows so the new rules can be added. A fresh build has no rows and these do nothing.
-- A link that never expired now expires 7 days after it was made; one that lasted longer than 30 days is
-- cut to 30; and where a session has several live links only the newest stays live.
update public.invites set expires_at = created_at + interval '7 days' where expires_at is null;
update public.invites set expires_at = created_at + interval '30 days'
  where expires_at > created_at + interval '30 days';
update public.invites i set revoked = true
where not i.revoked and i.invitee_id is null
  and exists (
    select 1 from public.invites n
    where n.session_id = i.session_id and n.invitee_id is null and not n.revoked
      and (n.created_at, n.token) > (i.created_at, i.token)
  );

alter table public.invites
  alter column expires_at set default now() + interval '7 days',
  alter column expires_at set not null;

do $invites_checks$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invites_expiry_limit' and conrelid = 'public.invites'::regclass
  ) then
    alter table public.invites add constraint invites_expiry_limit
      check (expires_at <= created_at + interval '30 days');
  end if;
  -- Only an invitation to a named person can be declined, and it is accepted at most once.
  if not exists (
    select 1 from pg_constraint where conname = 'invites_decline_needs_invitee' and conrelid = 'public.invites'::regclass
  ) then
    alter table public.invites add constraint invites_decline_needs_invitee
      check (declined_at is null or invitee_id is not null);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'invites_personal_single_use' and conrelid = 'public.invites'::regclass
  ) then
    alter table public.invites add constraint invites_personal_single_use
      check (invitee_id is null or uses <= 1);
  end if;
end;
$invites_checks$;

-- One live link per session: to replace a link, revoke it and make another. An expired link that was never
-- revoked still counts as live here, because an index cannot ask what time it is.
create unique index if not exists invites_one_live_link_idx
  on public.invites (session_id) where invitee_id is null and not revoked;
-- One invitation per person per session, so a decline cannot be nagged. It is final even if the host
-- later revokes the invitation.
create unique index if not exists invites_one_per_invitee_idx on public.invites (session_id, invitee_id);
create index if not exists invites_invitee_id_idx on public.invites (invitee_id);

-- ── Trigger: what an invitation may be ──────────────────────────────────

-- Runs before every insert into invites, whoever inserts. The session must be open. A personal invitation
-- must not be for the host or for someone already in the session, and a session has at most 30 open ones
-- (not revoked, declined, accepted or expired). The session row is locked, so two inserts at once cannot
-- both take the last place.
create or replace function public.check_invite_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sessions%rowtype;
begin
  select * into s from public.sessions where id = new.session_id for update;
  if not found or s.status not in ('inviting', 'locating', 'voting') then
    raise exception 'Invitations can only be made while a session is open.' using errcode = '42501';
  end if;
  if new.invitee_id is null then
    return new;
  end if;
  if new.invitee_id = s.host_id then
    raise exception 'The host is already in the session.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.session_members m where m.session_id = new.session_id and m.user_id = new.invitee_id
  ) then
    raise exception 'That person is already in the session.' using errcode = '42501';
  end if;
  if (
    select count(*) from public.invites i
    where i.session_id = new.session_id and i.invitee_id is not null
      and not i.revoked and i.declined_at is null and i.uses = 0 and i.expires_at > now()
  ) >= 30 then
    raise exception 'A session can have at most 30 open invitations.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger invites_check_insert before insert on public.invites
  for each row execute function public.check_invite_insert();

-- ── Functions the app calls ─────────────────────────────────────────────

-- invite_preview() used to return the session id and the member count as well. A function cannot change
-- its columns in place, so the old one is dropped (only when it still has them) and made again below.
do $invite_preview$
begin
  if exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'invite_preview'
      and pg_get_function_result(p.oid) like '%member_count%'
  ) then
    drop function public.invite_preview(text);
  end if;
end;
$invite_preview$;

-- What an invite link leads to, for the join page. Callable when logged out.
-- Returns no row when the link is revoked, expired or unknown, or the session can no longer be joined.
-- Gives the title, date, times and host's name and nothing else. An invitation to a named person
-- previews only for that person.
--   const { data } = await supabase.rpc('invite_preview', { invite_token: token })
create or replace function public.invite_preview(invite_token text)
returns table (title text, date date, start_time time, end_time time, host_name text)
language sql stable security definer set search_path = ''
as $$
  select s.title, s.date, s.start_time, s.end_time, coalesce(p.display_name, p.username)
  from public.invites i
  join public.sessions s on s.id = i.session_id
  join public.profiles p on p.id = s.host_id
  where i.token = invite_token
    and not i.revoked
    and i.expires_at > now()
    and i.declined_at is null
    and (i.invitee_id is null or (i.invitee_id = (select auth.uid()) and i.uses = 0))
    and s.status in ('inviting', 'locating', 'voting');
$$;

-- Join a session with an invite link or a personal invitation. Returns the session id.
-- Raises an error when the link is revoked, expired or unknown, when it is a personal invitation that is not
-- the caller's, was declined or was used, or when the session is already confirmed or over (all the same
-- error, so a token tells a stranger nothing), and when the session already has 30 joined members.
-- Someone already in the session, opted out or not, is left exactly as they are.
--   const { data: sessionId, error } = await supabase.rpc('join_session', { invite_token: token })
create or replace function public.join_session(invite_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  target uuid;
  added integer;
begin
  if me is null then
    raise exception 'Sign in to join a session.' using errcode = '28000';
  end if;

  -- The session row is locked until the join is done, so two people cannot take the last place together.
  select i.session_id into target
  from public.invites i
  join public.sessions s on s.id = i.session_id
  where i.token = invite_token
    and not i.revoked
    and i.expires_at > now()
    and i.declined_at is null
    and (i.invitee_id is null or (i.invitee_id = me and i.uses = 0))
    and s.status in ('inviting', 'locating', 'voting')
  for update of s;

  if target is null then
    raise exception 'This invite link is no longer valid.' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.session_members m where m.session_id = target and m.user_id = me) then
    return target;
  end if;

  if (select count(*) from public.session_members m where m.session_id = target and m.state = 'joined') >= 30 then
    raise exception 'This session is full.' using errcode = 'P0001', hint = 'session_full';
  end if;

  insert into public.session_members (session_id, user_id, role, state)
  values (target, me, 'guest', 'joined')
  on conflict (session_id, user_id) do nothing;
  get diagnostics added = row_count;

  if added = 1 then
    update public.invites set uses = uses + 1 where token = invite_token;
  end if;
  return target;
end;
$$;

-- The open invitations addressed to the signed-in user, newest first, for Home: enough to show the invitation
-- and to answer it, and nothing about the session beyond that. An invitation drops out once it is accepted,
-- declined, revoked or expired, or when the session is no longer open.
--   const { data } = await supabase.rpc('my_invitations')
create or replace function public.my_invitations()
returns table (token text, title text, date date, start_time time, end_time time, host_name text, invited_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select i.token, s.title, s.date, s.start_time, s.end_time, coalesce(p.display_name, p.username), i.created_at
  from public.invites i
  join public.sessions s on s.id = i.session_id
  join public.profiles p on p.id = s.host_id
  where i.invitee_id = (select auth.uid())
    and not i.revoked
    and i.declined_at is null
    and i.uses = 0
    and i.expires_at > now()
    and s.status in ('inviting', 'locating', 'voting')
    and not exists (
      select 1 from public.session_members m where m.session_id = s.id and m.user_id = i.invitee_id
    )
  order by i.created_at desc;
$$;

-- The invitee says no. The host sees the decline; the other members do not. Raises the same error as an
-- unknown token when the invitation is not the caller's, or is revoked or already accepted. Declining twice
-- does nothing the second time.
--   await supabase.rpc('decline_invite', { invite_token: token })
create or replace function public.decline_invite(invite_token text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'Sign in to answer an invitation.' using errcode = '28000';
  end if;
  update public.invites set declined_at = coalesce(declined_at, now())
  where token = invite_token and invitee_id = me and not revoked and uses = 0;
  if not found then
    raise exception 'This invitation is no longer valid.' using errcode = 'P0002';
  end if;
end;
$$;

-- ── Access rules ────────────────────────────────────────────────────────

-- A host makes personal invitations as well as links. Only the host's right to change a link narrows:
-- it can be revoked, and nothing else about it changes (token, expiry and owner are fixed once made).
grant insert (session_id, created_by, expires_at, invitee_id) on public.invites to authenticated;
revoke update (expires_at) on public.invites from authenticated;

-- The host sees every link and invitation of the session, including declined ones.
-- An invitee reads their own invitations, so a live update can reach them. Members read their session's
-- pending personal invitations, to show the person as invited; a declined, revoked, used or expired one is
-- not theirs to see. A personal token is useless to anyone but its invitee (join_session, decline_invite and
-- invite_preview all check), so showing the row to members hands over nothing.
drop policy if exists invites_select_invitee on public.invites;
create policy invites_select_invitee on public.invites for select to authenticated
  using (invitee_id = (select auth.uid()));
drop policy if exists invites_select_members on public.invites;
create policy invites_select_members on public.invites for select to authenticated
  using (
    invitee_id is not null and not revoked and declined_at is null and uses = 0 and expires_at > now()
    and session_id in (select public.my_session_ids())
  );

-- A revoke cannot be undone: the row must be revoked after the update.
drop policy if exists invites_update_host on public.invites;
create policy invites_update_host on public.invites for update to authenticated
  using (public.is_session_host(session_id))
  with check (public.is_session_host(session_id) and revoked);

-- Who may call the functions. The join page works before login; joining and answering need an account.
revoke execute on function
  public.check_invite_insert(), public.invite_preview(text), public.join_session(text),
  public.my_invitations(), public.decline_invite(text)
  from public, anon, authenticated;
grant execute on function public.invite_preview(text) to anon, authenticated;
grant execute on function public.join_session(text), public.my_invitations(), public.decline_invite(text)
  to authenticated;

-- ── Live updates ────────────────────────────────────────────────────────
-- An invitee subscribes to their own invitations (invitee_id = their id). Row-level security filters inserts
-- and updates to the rows a client may read; the invitee's own policy above lets theirs through.

do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'invites'
    ) then
      alter publication supabase_realtime add table public.invites;
    end if;
  end if;
end;
$realtime$;
