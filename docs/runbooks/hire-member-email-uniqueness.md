# Hire member workspace-scoping rollout

Phase 1 requires every member, setup credential, and session operation to carry
`workspaceId`. A member email resolves to one pending or active row inside one
workspace; the same HR email may belong to another company without becoming a
global discovery key. Removed memberships remain immutable actor history and do
not reserve the address inside that workspace.

## Deployment gate

Run this against the isolated Hire control database before deploying code that
accepts workspace-bearing member credentials:

```sh
npm run prepare:hire-member-email-uniqueness
npm run prepare:hire-member-email-uniqueness -- --apply
npm run check:hire-member-email-uniqueness
```

The environment must set `IPG_SURFACE=hire-control`,
`HIRE_CONTROL_DATABASE_NAME`, `HIRE_RUNTIME_DATABASE_NAME`, and
`B2C_DATABASE_NAME` to three distinct database names. The Mongo principal must
be scoped to the Hire control database; this migration never reads or writes a
B2C collection.

The apply command, which must run before the new application image starts:

1. validates that every member, setup, and session row has an ObjectId
   `workspaceId`, and stops on a pending/active normalized-email duplicate
   within one workspace;
2. backfills `normalizedEmail` without changing membership state;
3. creates replacement unique indexes on `(workspaceId, normalizedEmail)` and
   `(workspaceId, tokenHash)` before removing any predecessor;
4. removes global email/token indexes and the legacy non-partial workspace
   email index; and
5. normalizes display email and verifies that no cross-workspace identity index
   remains.

Duplicate memberships inside one workspace are not auto-merged or removed. The
command reports their workspace and member IDs and exits non-zero. Duplicate
emails or token hashes in different workspaces are valid and remain isolated by
the compound indexes. Run the read-only check again as the release gate.

Setup and session cookie values use `<workspaceId>.<random-secret>`. Only the
secret hash is stored. Setup links place that credential in the URL fragment,
which is removed from browser history before the first form render; it is never
sent in an HTTP request URL or referrer. Existing pre-rollout raw-token links
and cookies do not parse under the new format and therefore fail closed.

## B2C deletion bridge

The B2C deployment needs `HIRE_CONTROL_INTERNAL_URL`,
`HIRE_ACCOUNT_BRIDGE_KEY_ID`, and a 32-byte-or-longer
`HIRE_ACCOUNT_BRIDGE_SECRET`. The Hire control deployment receives the same
key ID and secret. Production account deletion fails closed when the bridge is
missing, unreachable, replayed, or returns a malformed response.

The call is HMAC-signed and carries only an opaque B2C user ID, an operation
ID, and (for a sole admin) the explicitly typed workspace name. It never sends
or queries a candidate email and introduces no B2C table or schema change.
