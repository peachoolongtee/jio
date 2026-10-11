# db

- `schema.sql` then `policies.sql` describe a fresh build; run them together as one transaction. A change to a table that already exists on the live project needs a file in `migrations/` with the same statements added to both files.
- `migrations/20261011000000_jio_session_spots.sql` adds meeting spots, approvals, Roam proposals and the suggested order. Apply it once as one transaction (the dashboard SQL editor, or `apply_migration` named `jio_session_spots`); running it again does nothing.
- `tests/session_spots_access.sql` is its access test. Run it after the migration as one batch, as the project owner (`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/session_spots_access.sql`, or paste it into the SQL editor).
- The test acts as each kind of user, ends with `rollback`, and so leaves no rows, passing or not. Each step prints `ok step N`; a broken rule stops the run with `FAIL step N`.
- Run it on a new migration before applying it to the shared project, and check the printed `ALL STEPS PASSED`; `seed/` holds the demo and venue data scripts and is unrelated.
