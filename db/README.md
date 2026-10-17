# db

- `schema.sql` then `policies.sql` describe a fresh build; run them together as one transaction. A change to a table that already exists on the live project needs a file in `migrations/` with the same statements added to both files.
- `migrations/` holds five migrations, one per build slice. Apply them in this order, each once and as one transaction (the dashboard SQL editor, or `apply_migration` with the name in brackets); running one again does nothing.
  - `20261011000000_jio_invites.sql` (`jio_invites`), slice a: invite links and invitations by username.
  - `20261011000100_jio_meeting_spots.sql` (`jio_meeting_spots`), slice b: meeting spots, suggestions, "Works for me", `sessions.plan_version` and the two new meeting methods.
  - `20261011000200_jio_slot_details.sql` (`jio_slot_details`), slice c: `slots.details`.
  - `20261011000300_jio_session_plan.sql` (`jio_session_plan`), slice d: the suggested order, a stop's earliest start, Roam proposals and `session_travel_debt()`.
  - `20261017000000_jio_completed_session_stops.sql` (`jio_completed_session_stops`), slice e: the backend-only transaction that records completed itinerary stops and completes the session.
- `tests/` holds one access test per migration: `invites_access.sql`, `meeting_spots_access.sql`, `slot_details_access.sql`, `session_plan_access.sql`. Run each after its migration (and before the next slice) as one batch, as the project owner (`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/invites_access.sql`, or paste it into the SQL editor). A test needs the slices before it: b and d invite a person by username.
- Each test acts as each kind of user, ends with `rollback`, and so leaves no rows, passing or not. Each step prints `ok step N`; a broken rule stops the run with `FAIL step N`, and a run that passes prints `ALL STEPS PASSED`.
- Run a test on a new migration before applying it to the shared project; `seed/` holds the demo and venue data scripts and is unrelated.
