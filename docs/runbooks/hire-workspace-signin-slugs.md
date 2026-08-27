# Hire workspace sign-in slug rollout

This migration replaces the member-facing Mongo ObjectId with an immutable
company workspace name such as `acme`. It does **not** change setup credentials,
session cookies, member indexes, or downstream workspace tenancy keys.

## Application compatibility

The compatible application:

- writes a slug and active hashed reservation for every new workspace;
- accepts preferred `{ workspace, email, password }` slug login requests;
- temporarily accepts legacy `{ workspaceId, email, password }` requests;
- resolves either coordinate to the internal ObjectId before member lookup;
- returns the canonical slug after sign-in/setup and migrates browser storage;
- keeps setup/session credentials in `<workspaceId>.<secret>` format; and
- never performs a global member-email lookup.

## Plan

The default command is disconnected and only describes the operation:

```sh
npm run prepare:hire-workspace-signin-slugs
```

Slug rules are lowercase ASCII, 2–48 characters, with internal hyphens only.
Reserved route words, `xn--` prefixes, and exact 24-hex values are excluded.
Duplicate display names receive a deterministic ObjectId suffix; display names
themselves remain unchanged and non-unique.

## Production apply gate

Use the isolated Hire-control database environment. `IPG_SURFACE` must be
`hire-control`, and `HIRE_CONTROL_DATABASE_NAME` must match the connected DB.

1. Before the rolling deploy, pause hard purge and verify zero active purge
   executions. Deploy the compatibility application and verify it on every
   process that can create or hard-purge a workspace. Legacy IDs and setup links
   still work before backfill, while this version writes and retires
   reservations. Keep hard purge paused until every create/purge process runs
   the compatible version. The older worker does not know how to retire a newly
   written reservation and could leave a plaintext active row after deleting
   its workspace root.
2. Run the read-only check. A non-zero result before first apply is expected:

   ```sh
   npm run check:hire-workspace-signin-slugs
   ```

3. Review the target DB and take the ordinary pre-migration backup/snapshot.
4. Apply the deterministic backfill and additive indexes:

   ```sh
   npm run prepare:hire-workspace-signin-slugs -- --apply
   ```

5. Run the exact check again:

   ```sh
   npm run check:hire-workspace-signin-slugs
   ```

6. If no separate release gate requires the pause, resume hard purge (including
   its lifecycle-retention worker), verify it is healthy, and confirm the purge
   backlog remains zero.

The final check must report zero missing/invalid/duplicate workspaces, an exact
active reservation for every workspace, and both unique partial indexes:

- `uniq_hire_workspace_sign_in_slug`
- `uniq_hire_workspace_sign_in_reservation_workspace`

The command fails before writes on invalid slugs, duplicate live values,
orphan active reservations, retained fields on retired reservations, or an
incompatible same-name/same-key index. It never calls `dropIndex` or
`syncIndexes`.

## Failure and rollback

- The backfill rows are written in one Mongo transaction. Retry the same apply;
  planning is deterministic and the completed state is idempotent.
- Index creation is additive and occurs after data backfill. If one index build
  fails, investigate and rerun apply; do not drop a successfully created index.
- Before rolling application code back, query the reservation collection. A
  pre-apply rollback is safe only when it is empty; the compatibility version
  can already have created reservations for new workspaces.
- After any reservation exists, do not roll back to a version that predates
  reservation-aware hard purge while purge jobs or manual purge endpoints can
  run. Pause hard purge before such an emergency rollback and keep it paused
  until the compatible version is restored. Leave both indexes and every
  active/retired reservation in place.
- Never delete retired reservation hashes. They prevent an old saved login from
  being routed to another company after hard purge.

## Acceptance checks

- Sign in with an assigned slug and with one legacy ObjectId.
- Confirm the same email can sign in to two workspaces only with each exact
  workspace coordinate.
- Confirm wrong slug, wrong email, and wrong password return the same response.
- Complete a pre-migration setup link. If the response has no slug, verify the
  browser temporarily retains its embedded ObjectId without rendering it; after
  backfill, the next successful sign-in must replace it with the canonical slug.
- Verify Company settings displays the immutable sign-in name.
- Verify a hard-purged workspace leaves only a retired hash reservation with no
  slug or workspace ID.
