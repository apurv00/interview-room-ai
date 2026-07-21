# Jobs source-control and retention rollout runbook

This runbook is the operational half of the source-authority protocol in
[INGESTION.md](./INGESTION.md). The order is a safety invariant: a legacy
revocation must not be adopted until its lookup and permanent-audit indexes are
known to exist. It also owns the ordered A04 retention activation because the
same posting rows and retained-corpus counter cross both policies.

## Non-negotiable invariants

- Mongo is a replica set or sharded cluster. Standalone Mongo cannot provide
  the transaction ordering A02 requires and must remain fail-closed.
- Enter a Jobs read-only maintenance window, pause source-sync, board/link
  lifecycle, and retention dispatch, then drain their old runs before
  migration. This includes `jobs-source-sync`, board probes/finalizers, link
  checks, and `jobs-retention-sweep`; user Save/Apply/Tailor/broken-link
  mutations must also be blocked at the application/edge during the destructive
  window. If that is not possible, require PITR/oplog recovery with an approved
  point-in-time target instead of assuming post-snapshot writes can be replayed
  manually. Old workers may lack the A02 authority fence or may still write
  historical TTL values.
- Index preparation uses only the five enumerated `createIndex` calls. Never
  use `syncIndexes`, `dropIndex`, or `dropIndexes` during this rollout. A
  key-identical partial, sparse, hidden, TTL, collated, or otherwise duplicate
  index is unsafe and fails verification. Runtime legal queries hint the one
  verified stable index name, never an ambiguous key pattern. The names are
  `sourceId_1`, `operationId_1`, `sourceId_1_revision_1`, `sourceIds_1`, and
  `provenance.sourceId_1`; changing one is a coordinated code, preparation,
  gate, and rollout change.
- `JobSourceControlAudit` is permanent. Any TTL index on it blocks promotion.
- `JobPosting.purgeAt` has exactly one whole-collection, non-unique absolute
  TTL index. The model never auto-creates it. Clear all historical `purgeAt`
  values and verify owner pins before first activation; index preparation
  refuses to create it while even one value remains.
- The retained posting corpus must remain at or below 25,000 rows, including
  owner-pinned archives and tombstones. `check:jobs-source-control` enforces
  the same bound as the production-shaped staging smoke and requires the
  serialized admission counter to equal the physical corpus. At 20,000 rows the
  read-only gate emits an operator/GitHub Actions warning and CMS shows low
  headroom; wire that warning into the deployment review process. It is not an
  automatic paging channel. Review retention or re-smoke a higher bound before
  legal control can be blocked.
- The application Mongo connection forces primary reads. Do not remove that
  invariant or introduce a separate secondary-read client into authority
  checks.
- A `restore` records legal clearance only. It keeps the source disabled and
  quarantined, clears cursors for later cold validation, and reopens no job.

## Staging access setup

Configure the GitHub Environment named exactly `jobs-staging` with required
reviewers and a deployment-branch rule limited to `main`. Its `MONGODB_URI`
must identify a dedicated staging database and a staging-only database user.
Never copy a production URI into this environment.

The workflow's first database step is a read-only, fail-closed identity gate.
Provision its two independent checks before the first dispatch:

1. Set the protected Environment variable
   `A02_STAGING_EXPECTED_DATABASE` to the exact database selected by
   `MONGODB_URI` (case-sensitive; do not rely on Mongo's default `test`
   database).
2. Generate one cryptographically random token of at least 32 bytes. Store the
   token only as the protected Environment secret
   `A02_STAGING_SENTINEL_TOKEN`; do not put it in source, tickets, workflow
   output, or the database.
3. In the dedicated staging database, using a separately approved bootstrap
   credential, insert this marker into `__deployment_environment_identity`.
   Replace the placeholders with the exact database name and the lowercase
   SHA-256 digest of the token (not the token itself):

   ```javascript
   {
     _id: 'jobs-source-control-promotion-v1',
     environment: 'jobs-staging',
     databaseName: '<A02_STAGING_EXPECTED_DATABASE>',
     schemaVersion: 1,
     immutable: true,
     tokenSha256: '<sha256(A02_STAGING_SENTINEL_TOKEN)>'
   }
   ```

Treat the token and marker as immutable environment identity, not deployment
configuration: the workflow never creates or repairs the marker, and routine
operators must not update it. Grant the promotion user `find` on this
collection but no marker update/delete permission where the staging role model
permits collection-level separation. Any intentional rotation requires an
approved bootstrap change to both the Environment secret and marker followed
by a fresh identity-gate run. A missing variable, short/whitespace-mutated
token, URI database-name mismatch, missing marker, or marker/token mismatch
blocks the workflow before `createIndex` can run. Do not bypass this gate to
recover a failed rollout.

Prefer a self-hosted runner or private-network runner with stable egress and
allowlist only that address in Atlas. If GitHub-hosted runners are unavoidable,
maintain the published GitHub Actions IP ranges as a short-lived Atlas
allowlist for the approved window; do not leave `0.0.0.0/0` enabled.

The staging database role needs only:

- `find` on `__deployment_environment_identity` (the promotion command never
  writes this marker);
- `find`, `aggregate`, and `listIndexes` on the Jobs application collections;
- `createIndex` on `jobpostings`, `jobsourceconfigs`, and
  `jobsourcecontrolaudits`;
- `find`/`distinct` on `jobapplications`, plus `find` and `update` on
  `jobpostings`, for the retention repair and lifecycle sweep;
- create/index/read/write/drop rights in the staging database for UUID-named
  `__a02_smoke_*` collections; and
- permission to run transactions and the topology `hello` command.

Scope those rights to the staging database. The promotion workflow exposes the
secret only to database steps, never checkout, dependency installation, or
package lifecycle scripts.

Production application credentials are part of the trust boundary: deny
delete/update on `jobsourcecontrolaudits` to routine application/analyst roles
where Atlas role separation permits it. “Append-only” is enforced by code and
least privilege, not by MongoDB collection immutability.

## Staging execution order

1. Enter the Jobs read-only window described above; pause all Jobs lifecycle
   schedules/manual dispatch, wait for the Inngest dashboard to show zero
   running or queued runs, and record the final run IDs. Take a restorable
   staging snapshot before the first apply. Deploy the code from
   `main` while dispatch remains paused. The workflow is intentionally
   main-only and therefore post-merge promotion evidence, not a pre-merge CI
   signal.
2. Dispatch **Jobs Data-Lifecycle Promotion Gate** with phase
   `prepare-indexes`. The hard-coded `jobs-staging` job first verifies the URI's
   exact database name and immutable staging sentinel, then runs:

   ```text
   npm run prepare:jobs-source-control-indexes -- --apply
   ```

   It builds serially, reads the indexes back, and exits non-zero on an exact
   shape/uniqueness mismatch or an audit TTL. Do not begin repair or adoption
   unless this phase is green.
3. From an approved staging operator session, repair owner retention:

   ```text
   npm run repair:jobs-retention
   npm run repair:jobs-retention -- --apply
   npm run check:jobs-retention
   ```

4. Repair durable lineage and stamp the readiness marker only after its final
   all-corpus verification:

   ```text
   npm run repair:jobs-source-lineage
   npm run repair:jobs-source-lineage -- --apply
   npm run check:jobs-source-lineage
   ```

   The repair copies known provenance IDs. Missing provenance, malformed
   durable IDs, malformed provenance, or old cap-reached rows receive
   `__legacy_unknown__`, and malformed detailed provenance entries are removed
   before the readiness marker is stamped. A later revoke therefore hides
   ambiguous history conservatively instead of guessing ownership.
5. For each pre-A02 config already at `health:'revoked'`, revision `0`, and no
   `lastControl`, submit an authenticated `POST /api/jobs/admin/source-control`
   revoke with `expectedRevision:0`, a fresh UUID `Idempotency-Key`, and a
   non-sensitive migration case reference. This is adoption, not a new legal
   decision: it advances the epoch, re-closes the corpus, and creates permanent
   audit evidence.

   The CMS Sources table shows the current authority revision. Submit from an
   authenticated platform-admin session; replace the placeholders but reuse
   the **same** key and byte-for-byte payload after an ambiguous timeout:

   ```bash
   curl --fail-with-body -X POST "$APP_URL/api/jobs/admin/source-control" \
     -H 'Content-Type: application/json' \
     -H 'Cookie: __Secure-next-auth.session-token=<approved-session>' \
     -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
     --data '{"sourceId":"gh:phonepe","action":"revoke","expectedRevision":0,"reason":"Legal case LEG-1042"}'
   ```

   The `__Secure-` cookie name is the HTTPS production default. A non-HTTPS
   local environment may use `next-auth.session-token`; inspect the approved
   session's actual cookie name. Prefer a protected cookie jar over placing a
   live session value directly in shared shell history.

   `200` is committed/replayed success; `401`/`403` means the current session
   is not an authorized platform admin; `409` means stale revision, invalid
   action ordering, or key/payload conflict and requires operator review;
   `503` means the authorization lookup/database, topology, capacity,
   migration, or integrity invariant is unavailable. Keep dispatch paused,
   alert on-call/legal ops, and retry only
   after the named invariant is restored. Never mint a new key merely because
   the first response timed out.
6. Dispatch the same workflow with phase `verify-promotion`. It idempotently
   re-prepares the source indexes; previews/applies/verifies the historical TTL
   clear and owner repair; creates and verifies the exact retention TTL index;
   verifies lineage and source-control invariants; runs the isolated replica-
   set smoke; then previews/applies the lifecycle sweep and requires a second
   dry-run to report zero pending mutations. Lifecycle runs last because Mongo
   may asynchronously delete past-due archives and leave the serialized
   admission counter safely stale-high until the next source preflight.
7. Re-enable dispatch only after the verify phase is green. After TTL deletion
   metrics and the physical posting count are stable across two TTL-monitor
   intervals, run one serialized source preflight to reconcile the safely
   stale-high admission counter, then immediately re-run
   `check:jobs-retention`, `check:jobs-source-lineage`,
   `check:jobs-source-control`, and `check:jobs-retention-sweep`.

The smoke is a raw Mongo-driver proof of the target Atlas topology and tier. It
uses isolated UUID collections to exercise page-first/revoke-first commit
orders plus the production transaction shape at the enforced 25,000 retained-
row bound: the common global-meta→source-config lock order, a cross-source
insert contender rejected at capacity, retained-count admission, indexed
source and provenance closures, the disjoint malformed-lineage fallback, and
permanent audit insertion. Focused unit/race tests cover the service
implementation. A
green unit suite cannot replace the staging topology smoke, and a green smoke
cannot replace the unit suite.

## Production execution order

The staging workflow and its smoke are forbidden against production. Use an
approved production operator session and retain command output in the change
record.

1. Enter an approved Jobs read-only maintenance window; pause source-sync,
   board/link lifecycle, and retention dispatch; verify and record zero running
   or queued Jobs lifecycle functions before continuing.
2. Take a PITR-capable production backup/snapshot and record its identifier and
   recovery point in the change. Deploy the code while Jobs writes remain
   blocked. The new cron is fail-closed until the exact TTL index exists.
3. Review the exact index plan, then explicitly build and self-verify it:

   ```text
   npm run prepare:jobs-source-control-indexes
   npm run prepare:jobs-source-control-indexes -- --apply
   ```

   The first command is local-plan-only and makes no database connection. The
   second is the authorized database mutation. It creates no other schema and
   never removes an existing index.
4. Preview, repair, and verify owner retention. This clears every historical
   TTL as its first mutation:

   ```text
   npm run repair:jobs-retention
   npm run repair:jobs-retention -- --apply
   npm run check:jobs-retention
   ```

5. Verify zero TTL values remain, then activate the exact index:

   ```text
   npm run prepare:jobs-retention-index
   npm run prepare:jobs-retention-index -- --apply
   npm run check:jobs-retention-index
   ```

   Do not continue if the dry run reports a non-zero `purgeAt` row count.
6. Repair and verify source lineage:

   ```text
   npm run repair:jobs-source-lineage
   npm run repair:jobs-source-lineage -- --apply
   npm run check:jobs-source-lineage
   ```

7. Adopt every legacy revision-0 revoked source through the authenticated API
   exactly as in staging. Never edit config revisions or audit rows directly.
8. Run the production read-only authority gates before scheduling any TTL:

   ```text
   npm run check:jobs-retention
   npm run check:jobs-source-lineage
   npm run check:jobs-source-control
   ```

9. Preview the lifecycle counts and obtain approval for the exact closure and
   purge-scheduling totals, then apply and prove convergence:

   ```text
   npm run sweep:jobs-retention
   npm run sweep:jobs-retention -- --apply
   npm run check:jobs-retention-sweep
   ```

   Run the first apply off-peak and monitor Mongo TTL-deleted documents,
   replication lag, query latency, CPU, and I/O until quiescent. WiredTiger may
   reuse freed space without shrinking Oracle filesystem files; OS disk-size
   reduction is not the success criterion.

10. After physical count and TTL-deletion metrics stabilize across two monitor
    intervals, run one source preflight and `check:jobs-source-control` to
    reconcile the safely stale-high admission counter. Then leave maintenance,
    re-enable scheduled dispatch, and verify one deliberately triggered healthy
   source sync completes at its current revision. Within five minutes, confirm
   revoked sources have no normally accessible postings and no stale-revision
   sync is succeeding.

If any step fails, leave both dispatch channels paused. Index preparation is
intentionally non-dropping, so do not improvise with `dropIndex` or rewrite TTL
dates. Before lifecycle apply, correct the data and rerun the idempotent gates.
After lifecycle apply, a past-due row may already have been deleted by Mongo;
the only rollback for unexpected deletion is the recorded PITR recovery point.
Escalate restoration rather than attempting an in-place partial reconstruction.
Preserve dry-run, apply, gate, snapshot/PITR, adoption operation IDs, and
affected row counts with deployment evidence.

## Propagation and external-system boundary

Evaluator, X-ray, and ATS paths re-read exact primary authority before every
router provider-adapter attempt, including fallbacks and explicit repair or
truncation retries. Gated OpenAI-, Anthropic-, Groq-, and OpenRouter-SDK calls
set `maxRetries:0`, so an SDK cannot silently retry after that read. Email
delivery similarly rechecks account, recipient, consent, tracker, and posting
authority after asynchronous preparation and before each application-level
provider attempt.

The pinned Google Generative AI SDK has no internal retry loop: each
`generateContent` invocation performs one physical fetch. Google fallback
attempts are still separate model-router attempts and therefore repeat the
same authority read. Re-audit this assumption before upgrading
`@google/generative-ai` or replacing that adapter.

A Mongo commit and an external HTTP request/response cannot share one
transaction. A revoke can still commit in the micro-gap after the last primary
read but before a job board, model, email provider, or browser response accepts
the request; an accepted request cannot be recalled. The five-minute SLA means
all **server requests whose final authority read begins after the revoke
commit** fail closed. It cannot retract a JD/apply URL already rendered in an
open browser tab or content already accepted by a provider. Active-tab
invalidation and server-mediated apply redirects are explicit A08 follow-ups.
Eliminating the provider gap requires a future source-scoped egress lease that
every external call acquires and revocation can synchronously drain.

## Legal restore procedure

Only submit `action:'restore'` after the legal case explicitly clears the
source. Use its current revision and a new UUID idempotency key. Success means
the clearance was recorded and the authority epoch advanced; it does **not**
mean ingestion resumed. Verify the source remains `enabled:false`,
`health:'quarantined'`, and that previously restricted postings remain closed.
Cold validation and any later enable decision are separate A08-controlled
actions.
