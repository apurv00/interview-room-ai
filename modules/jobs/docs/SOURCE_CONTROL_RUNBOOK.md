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
- Index preparation uses only the seven enumerated `createIndex` calls: five
  legal/lineage indexes and two permanent operational-audit indexes. Never
  use `syncIndexes`, `dropIndex`, or `dropIndexes` during this rollout. A
  key-identical partial, sparse, hidden, TTL, collated, or otherwise duplicate
  index is unsafe and fails verification. Runtime legal queries hint the one
  verified stable index name, never an ambiguous key pattern. The exact
  collection/name/key contract is:

  | Collection | Index name | Key | Purpose |
  | --- | --- | --- | --- |
  | `jobsourceconfigs` | `sourceId_1` | `{sourceId:1}` unique | One config/authority epoch per reviewed source. |
  | `jobsourcecontrolaudits` | `operationId_1` | `{operationId:1}` unique | Idempotent legal commands. |
  | `jobsourcecontrolaudits` | `sourceId_1_revision_1` | `{sourceId:1,revision:1}` unique | One legal record per source revision. |
  | `jobpostings` | `sourceIds_1` | `{sourceIds:1}` | Durable legal-lineage lookup. |
  | `jobpostings` | `provenance.sourceId_1` | `{'provenance.sourceId':1}` | Legacy-lineage and lifecycle lookup. |
  | `jobsourceoperationaudits` | `operationId_1` | `{operationId:1}` unique | Idempotent operational commands. |
  | `jobsourceoperationaudits` | `sourceId_1_occurredAt_-1` | `{sourceId:1,occurredAt:-1}` | Permanent per-source operations timeline. |

  The duplicate `operationId_1` name is intentional because it belongs to two
  different collections. Changing any name, key, or option is a coordinated
  code, preparation, gate, permission, and rollout change.
- `JobSourceControlAudit` and `JobSourceOperationAudit` are permanent. Any TTL
  index on either collection blocks promotion. An operational audit is not an
  immutable/append-only row: command evidence is committed once, then
  `dispatchedAt` and terminal `outcome`/`completedAt`/`errorCode` are written as
  one-way markers. Neither history may be deleted or expired.
- `JobPosting.purgeAt` has exactly one whole-collection, non-unique absolute
  TTL index. The model never auto-creates it. Clear all historical `purgeAt`
  values and verify owner pins before first activation; index preparation
  refuses to create it while even one value remains.
- The A09 crowd-request lane has exactly one key-identical
  `jobpostings.linkCheckRequestedAt_1` index: key
  `{linkCheckRequestedAt:1}`, non-unique, non-sparse, non-hidden, no TTL or
  collation, with the exact partial filter
  `{linkCheckRequestedAt:{$type:'date'}}`. It is schema-owned, unlike the
  retention TTL index, but schema declaration is not evidence that the
  deployed database built it. Verify it read-only before unpausing
  `jobs-link-check`; never use `syncIndexes` or drop an existing index as an
  activation shortcut.
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

## A08 CMS source-operations workflow

`/cms/jobs-ingest` is the standard operator surface. Use it for bootstrap,
deployment/runtime status, settings, credentials-by-status, budgets, cold validation, manual
dispatch, pause/enable, and legal revoke/restore. It is platform-admin only;
every accepted command is idempotent, every source-specific command binds the
expected legal **and** operational revisions, and every mutation creates
permanent operator evidence. Never update
`JobSourceConfig`, `JobSourceControlAudit`, or `JobSourceOperationAudit`
directly.

### Bootstrap and normal activation

1. Satisfy the database/index promotion gates in this runbook and configure
   Inngest, Redis, and required provider secrets in the deployed environment.
   The CMS shows configuration/health indicators and credential **status**,
   never secret values. An Inngest indicator proves only that the event and
   signing variables are present; it is not worker-registration or event-delivery
   evidence. Complete the deployment smoke below before calling workers ready.
2. If the dashboard reports an uninitialized or incomplete catalog, choose
   **Initialize sources** once. Bootstrap creates only missing entries from the
   deploy-reviewed `JOB_SOURCE_CATALOG`. Every created entry is disabled and
   appears paused; bootstrap does not dispatch ingestion and cannot invent an
   adapter, endpoint, source ID, or credential name. It may safely initialize an
   empty database or complete a catalog whose existing rows match reviewed
   routing identity; reviewed display labels and safe catalog-default budgets
   can be repaired from code. Unknown sources or drift in `kind`/`atsKind`/
   `slug`, existing Jobs data without the lineage metadata, a revoked epoch
   without legal evidence, or an explicitly malformed/negative operational
   revision require the protected migration; Bootstrap must not guess or coerce
   them. A missing legacy operational revision may be initialized to epoch zero.
   If bootstrap encounters an enabled legacy source without current permanent
   operational authorization, it adopts that row by recording an audited Pause;
   the source stays off until the operator completes Validate → Enable.
3. Review each source's cadence, per-run/daily/monthly request caps,
   India-supply floor, LLM opt-out, and credential state. Save a bounded
   settings change with a non-sensitive reason. Saving settings on an active
   source also pauses it. The operational revision advances and old validation
   evidence is cleared, so every settings change requires Validate → Enable.
4. Choose **Validate**. This is a cold provider/credential check at the current
   legal and operational revisions: it may spend bounded request quota but
   stores and reopens no posting. “Queued” is not “passed”. Use **Refresh
   state** until the matching operation ID shows a terminal succeeded/failed
   marker and the source shows the corresponding validation result; do not mint
   a new operation ID merely because delivery is still pending.
5. Enable only after current-revision validation passes and all blockers are
   clear. Then use **Run now** if an immediate first sync is needed. Run now
   only queues work and never bypasses credential, revision, health, quota,
   transaction, or retained-corpus gates. Refresh until the matching command
   reaches a terminal outcome, then confirm its resulting sync cycle and audit
   evidence in CMS.

The operator-facing states have distinct meanings:

| State | Meaning and safe next action |
| --- | --- |
| `paused` | Operationally disabled; no new source sync writes. Existing postings stay available. Validate, then Enable when intended. |
| `validating` | Cold validation is pending; it is not permission to ingest. Refresh until the matching operation reaches a terminal outcome. |
| `active` | Scheduled/manual sync may run within all hard gates and request caps. |
| `quarantined` | Health or restored-legal state blocks ingestion. Diagnose, repair credentials/settings/provider behavior, then Validate. |
| `dead` | Provider/board health has failed terminal thresholds. Keep disabled and investigate before any recovery workflow. |
| `revoked` | Legal authority is withdrawn; ingestion is disabled and every row carrying the source lineage is restricted. Only an approved legal Restore may advance this state. |

### Pause is not revoke

| Operator intent | Action | Existing corpus | Recovery |
| --- | --- | --- | --- |
| Maintenance, cost control, bad settings, provider incident, or temporary credential work | **Pause** | Unchanged; already-served postings remain governed by normal lifecycle. | Repair/configure → Validate → Enable. |
| Legal objection, ToS withdrawal, source authority loss, or a requirement to stop serving source-derived rows | **Revoke** | All matching canonical rows become restricted `source-revoked`; no TTL deletion is implied. | Legal approval → Restore → Validate → Enable. Existing restricted rows do not reopen. |

Pause increments the operational epoch so queued/stale work fails its fence,
but it does not make a legal claim and must never be used as a substitute for
Revoke. Revoke increments the independent legal authority revision and requires
typed source confirmation plus a non-sensitive case reference.

### Restore, credentials, and quota operations

Restore means “legal clearance recorded,” not “source trusted and running.”
After Restore, verify the source is disabled and quarantined and the historical
corpus remains restricted. Repair credentials/settings, run a cold Validate at
the current revisions, inspect the completed result, and only then Enable.
Skipping directly from Restore to Enable is a control failure.

Provider credentials are deployment secrets. For the current catalog,
`RAPIDAPI_KEY` is required by JSearch; sources without a declared credential
show “not required.” Provision or rotate secrets through the deployment secret
manager, restart/redeploy the affected workers, refresh CMS, and Validate. A
historical rejected/failed result does not prevent revalidation after rotation;
the current secret presence plus a new current-revision provider check decides
the new result. Because validation is paused-only, rotate an active source by
Pause → rotate/redeploy → Validate → Enable. Never paste a
secret into CMS notes, command reasons, tickets, shell history, or audit
evidence. `missing`, `invalid`, and `unknown` are blockers to enablement, not
prompts to store the value in Mongo.

Per-run, UTC-day, and UTC-month request caps are atomic Redis hard controls and
count physical attempts, including retries. There is no 80%-cadence or
95%-source-stop policy: a warning is observability only, while an exact cap
rejects the next physical request. Run now and validation obey the same claim
path. A cap change requires a reason, pauses an active source, advances the
operational revision, invalidates older validation, and must be followed by
Validate → Enable. Staging and production require a shared reachable Redis
(`REDIS_URL`) so meters are consistent across processes and retries; missing,
malformed, exhausted, or unavailable meter state fails closed.
The quota store is authority data, not a disposable cache: deploy Redis with
durable persistence/replication, a persistent volume, and a no-eviction policy
for these keys. A restart, failover, restore, flush, or eviction that loses a
current run/day/month counter can reset usage and invalidate the hard-cap
claim; keep sources paused until counter continuity is proven or the affected
windows expire.

### Raw API break-glass rule

Routine operators use CMS. Direct calls to
`POST /api/cms/jobs-ingest/sources` or
`POST /api/jobs/admin/source-control`, and the compatibility
`POST /api/jobs/admin/sync` route are reserved for this runbook's automated
promotion/adoption steps or an incident where CMS is unavailable and the
incident/change owner authorizes break-glass use. Record the exact endpoint,
actor, source, both expected revisions where operational work is involved, UUID
idempotency key, byte-identical payload, response, and resulting CMS audit row.
The compatibility sync route delegates to the same audited Run-now command; it
is not an authority bypass. Retry an ambiguous timeout with the same key and
payload; on a revision conflict, refresh authority and reassess rather than
editing Mongo or guessing a revision. Never use raw API access to bypass a CMS
blocker, validation, credential status, quota cap, or typed legal confirmation.

## A08 staging and production activation gates

These gates are mandatory before enabling any source in either environment:

1. **Transactional database:** the deployed Mongo target must report a replica
   set or sharded topology, the seven exact indexes must pass, and lineage/meta
   counters must match the physical corpus. A standalone `mongod` is not a
   degraded mode; source operations and ingestion remain blocked.
2. **Shared request meter:** `REDIS_URL` must resolve to the shared deployed
   Redis and a real read/atomic-claim smoke must pass. Verify persistent
   storage, restart/failover continuity, and a no-eviction policy for quota
   keys; environment-variable presence or a successful `PING` alone is not
   sufficient.
3. **Inngest registration and delivery:** `INNGEST_EVENT_KEY` and
   `INNGEST_SIGNING_KEY` prove configuration only. In the deployed Inngest
   environment, verify `/api/inngest` registration lists both
   `jobs-source-validate` (`jobs/source.validate`) and `jobs-source-sync`
   (`jobs/source.sync`). From CMS, Validate a paused canary and match its
   operation ID to a terminal validation run; after every other gate passes,
   Enable it, choose Run now, and match that operation ID to a terminal sync
   run plus `JobIngestCycle`. A queued event, successful send response, or
   registered function without delivered work does not satisfy this gate.
4. **Provider-egress verification:** ingestion now uses the shared HTTPS-only
   provider transport, which resolves once, rejects any private/mixed/malformed
   answer set, pins Host/SNI/certificate-checked sockets to vetted answers,
   verifies the connected remote address, keeps redirects terminal, bounds DNS,
   connection/response time, response bytes, and address attempts, and makes a
   Redis quota/authority claim immediately before every physical socket. Before
   source activation, retain evidence from the deployed staging **and**
   production environments against controlled endpoints for DNS-answer change,
   direct private/mixed answers, redirect-to-private (with credential headers
   proven not forwarded), timeout/body/address-attempt limits, and per-run/day/
   month cap exhaustion. Unit tests and the separate link-check transport smoke
   are necessary but do not replace this deployment evidence. Unknown or failed
   evidence blocks enablement.

Keep all sources paused if any gate is unknown or failed. The CMS runtime cards
are useful status inputs, not a replacement for the registration, delivery, or
egress evidence above.

## A09 link-check index and observability

The hourly `jobs-link-check` run starts at minute `:40`, retries once, selects
at most 150 postings, and reserves at most 50 first-lane slots for eligible
crowd requests. The remaining lanes are machine restrikes/recovery, unchecked
open rows, stale unverifiable rows, then stale alive rows. The crowd marker is
a scheduling hint only: reports can soft-demote an apply option but cannot
close a posting. Machine evidence remains the only close/reopen authority.

### Non-dropping index gate

Run the following **read-only** check from an approved operator shell against
the exact staging database, retain its output, then repeat it against the exact
production database. The URI must name the intended database. The command
calls only `getIndexes()`; it neither creates nor drops anything and exits 42
unless exactly one key-identical index has the complete A09 contract:

```bash
mongosh "$MONGODB_URI" --quiet --eval '
const indexes = db.getCollection("jobpostings").getIndexes()
const sameKey = indexes.filter((index) => {
  const keys = Object.keys(index.key || {})
  return keys.length === 1 &&
    keys[0] === "linkCheckRequestedAt" &&
    index.key.linkCheckRequestedAt === 1
})
const valid = sameKey.filter((index) => {
  const partial = index.partialFilterExpression
  const partialKeys = partial ? Object.keys(partial) : []
  const predicate = partial?.linkCheckRequestedAt
  return index.name === "linkCheckRequestedAt_1" &&
    index.unique !== true &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.expireAfterSeconds === undefined &&
    index.collation === undefined &&
    partialKeys.length === 1 &&
    predicate?.$type === "date" &&
    Object.keys(predicate).length === 1
})
print(EJSON.stringify({ database: db.getName(), sameKey, validCount: valid.length }, null, 2))
if (sameKey.length !== 1 || valid.length !== 1) quit(42)
'
```

Checklist for each environment:

1. Keep `jobs-link-check` paused and confirm no run is active before index
   work. Record the database identity and a current index inventory.
2. Run the read-only check above. A green result must show the intended
   database, one `sameKey` entry, and `validCount:1`.
3. If the index is absent and an approved database change grants `createIndex`,
   create only the exact index below. This is additive and non-dropping:

   ```bash
   mongosh "$MONGODB_URI" --quiet --eval '
   print(db.getCollection("jobpostings").createIndex(
     { linkCheckRequestedAt: 1 },
     {
       name: "linkCheckRequestedAt_1",
       partialFilterExpression: { linkCheckRequestedAt: { $type: "date" } }
     }
   ))
   '
   ```

4. If a key-identical index exists with a different name or any different
   option, do **not** drop or replace it during rollout. Keep the worker paused,
   capture `getIndexes()` output, and open an explicit reviewed migration.
5. Re-run the read-only check after an authorized create and before unpausing.
   Confirm the deployed Inngest registration contains `jobs-link-check`, then
   retain one terminal successful run and its `JobIngestCycle` row. A schema
   test, successful deployment, or `createIndex` acknowledgement alone is not
   completion evidence.

### Cycle counters and alert contract

Every terminally successful run writes one 30-day `jobingestcycles` row with
`kind:'link-check'`, `sourceId:'link-check'`, `startedAt`, `finishedAt`, and the
following `linkCheck` counters. The structured completion log emits the same
counters.

| Counter | Operator meaning |
| --- | --- |
| `checked` | Postings whose current lifecycle/provenance/apply-check snapshot won its final CAS and was persisted. Picks, URL attempts, and CAS losers are excluded. |
| `dead` / `alive` / `unverifiable` | Posting-level persisted outcomes. Their sum must equal `checked`; these are not per-URL counts. |
| `requestedProcessed` | Successful writes for postings picked with an eligible crowd-request marker; the same write clears the marker. Compare with live queue depth, not with all reports received. |
| `casMisses` | Work discarded because authority changed during DNS/HTTP checking or the final lifecycle/provenance/request-marker/apply-check CAS lost. Non-zero can be a healthy race; sustained/high ratios mean churn or contention. |
| `crowdDispositionChanged` | Current URL subject/generation transitions into or out of crowd soft-demotion. This is per link group and may exceed posting counts. |
| `machineDispositionChanged` | Current URL subject/generation transitions into or out of single-check machine soft-demotion. This is per link group and may exceed posting counts. |
| `incidentsCleared` | Current URL incidents advanced/cleared by authoritative machine evidence after reports or demotion state existed. Per link group. |
| `closedNow` | Open postings closed as `dead-apply-link` after every current checkable URL met the two-dead, at-least-20-hour policy. Must not exceed `dead`. |
| `reopenedNow` | `dead-apply-link` closures reopened after the same current URL generation accumulated two alive observations at least 20 hours apart. Must not exceed `alive`. |

Read the latest cycles and the live eligible queue without mutating data:

```javascript
db.jobingestcycles.find(
  { kind: 'link-check' },
  { createdAt: 1, startedAt: 1, finishedAt: 1, linkCheck: 1 }
).sort({ createdAt: -1 }).limit(24)

const eligible = {
  linkCheckRequestedAt: { $type: 'date' },
  $or: [
    { status: 'open' },
    { status: 'closed', closedReason: 'dead-apply-link' }
  ]
}
db.jobpostings.countDocuments(eligible, { hint: 'linkCheckRequestedAt_1' })
db.jobpostings.find(
  eligible,
  { _id: 1, status: 1, closedReason: 1, linkCheckRequestedAt: 1 }
).sort({ linkCheckRequestedAt: 1 }).hint('linkCheckRequestedAt_1').limit(1)

db.jobpostings.countDocuments({
  linkCheckRequestedAt: { $type: 'date' },
  $nor: [
    { status: 'open' },
    { status: 'closed', closedReason: 'dead-apply-link' }
  ]
}, { hint: 'linkCheckRequestedAt_1' })
```

The third query inventories stale markers on ineligible restricted/other
closures. They do not enter the worker queue, but growth wastes partial-index
space and indicates a closure path is not clearing scheduling hints. Do not
repair them with an ad-hoc bulk update; retain samples and fix the responsible
lifecycle writer in a reviewed follow-up.

Wire the following expectations into Inngest/log/database monitoring. Until a
measured baseline justifies tighter thresholds:

| Signal | Expected action |
| --- | --- |
| Inngest terminal failure, or no finished cycle | Alert on a terminal failure; page if no finished `link-check` cycle exists for two schedule intervals. Check worker registration, deployment/runtime errors, Mongo reachability, and outbound DNS/HTTP health. |
| Eligible request queue | A non-zero queue is normal. Warn when its oldest marker is over 2 hours old; page at 6 hours. Compare arrivals with `requestedProcessed` and the 50-request first-lane cap before changing capacity. |
| Counter integrity | Alert on `dead + alive + unverifiable != checked`, `closedNow > dead`, `reopenedNow > alive`, or `requestedProcessed > checked`; these indicate telemetry/transition drift. |
| CAS contention | Investigate when `casMisses / (checked + casMisses) > 10%` for two consecutive cycles. Correlate with ingestion URL replacement, source revoke, Save/Apply activity, and overlapping link-check retries; never retry stale observations by bypassing the CAS. |
| Network ambiguity | Investigate when `unverifiable / checked >= 50%` for two consecutive cycles with at least 20 checked rows. Correlate DNS, egress, WAF/bot blocks, 5xx, and timeouts; unverifiable evidence must not be promoted to dead. |
| Close spike | Page and pause subsequent link-check dispatch when `closedNow >= 10` or `closedNow / checked >= 10%` in one cycle. Sample every affected host/source and confirm both spaced dead observations before resuming. |
| Demotion/incident signals | Individual changes are expected. Investigate a crowd-demotion spike as possible coordinated abuse; investigate a machine-demotion spike with dead/unverifiable growth as possible provider or egress failure. `incidentsCleared` should rise when authoritative alive observations recover affected links. |
| Reopens | Individual `reopenedNow` events are expected recovery, not pages. Investigate a reopen spike following a close spike as a likely transient provider/network incident or an overly broad dead classifier. |
| Ineligible markers | Review any sustained increase weekly. This is index hygiene, not closure authority, and must not be “fixed” by deleting posting/governance evidence. |

The A09 quorum/freshness values are suppression-safety policy and remain
code-owned. There is intentionally no CMS control or manual close/reopen panel
in this phase. Operators observe and pause the Inngest function during an
incident; they do not edit report counts, incident versions, apply-check
streaks, closure reasons, or provenance governance directly.

## Tracker-status sweep cursor

The bounded A06 tracker sweep creates one global continuation document whenever
it has a safe boundary worth checkpointing. It requires no data migration or
cursor index. A rollback can leave the singleton in place; older code does not
read it.

Use the structured daily report as follows:

| Field | Operator meaning |
| --- | --- |
| `examined` / `scanLimit` | Raw due rows read versus the hard 2,000-row read cap. |
| `scanned` / `limit` | Active-owner rows attempted versus the 500-row write cap. |
| `prefilterInactive` | Rows whose owner is missing or does not match the active/legacy-active predicate. |
| `accountInactive` | Rows whose owner became inactive after prefiltering but before the transaction fence. |
| `capped` | A read window was full or the write window overflowed; work may remain. |
| `cursorAdvanced` / `wrapped` | Progress was checkpointed, or the tail was reached and the next run restarts at the oldest tuple. |
| `cursorBlockedByRace` | A snapshot CAS lost; the cursor stopped before that row so it can be retried. |
| `cursorMalformed` | Stored BSON types were unsafe; the worker restarted from the oldest tuple and repaired or removed the cursor. |

Inspect progress when the daily report repeatedly shows `capped`,
`cursorBlockedByRace`, or `cursorMalformed`:

```javascript
db.jobs_tracker_status_sweep_cursors.findOne({ _id: 'jobs-tracker-status-sweep' })
```

The worker automatically discards a malformed cursor and safely restarts its
bounded scan. If an operator confirms there is no active tracker-status run and
must reset a stale but well-formed cursor, delete only this singleton:

```javascript
db.jobs_tracker_status_sweep_cursors.deleteOne({ _id: 'jobs-tracker-status-sweep' })
```

Resetting restarts from the oldest due tuple. Exact snapshot compare-and-set
writes keep already-transitioned applications idempotent; never delete the
whole collection or reset the cursor while a run is active.

A non-zero inactive count can be normal while account deletion is in flight.
If it persists for two daily runs or through one complete cursor wrap, inspect
the deletion failure/retry path and sample the backlog:

```javascript
const cutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
db.jobapplications.aggregate([
  { $match: { status: 'applied', appliedAt: { $type: 'date', $lte: cutoff } } },
  { $lookup: {
    from: 'users', localField: 'userId', foreignField: '_id',
    pipeline: [
      { $match: { $or: [
        { accountState: 'active' },
        { accountState: { $exists: false } }
      ] } },
      { $project: { _id: 1 } }
    ], as: 'activeOwner'
  } },
  { $match: { 'activeOwner.0': { $exists: false } } },
  { $count: 'inactiveOwnerDueRows' }
])
```

Repair account-deletion cleanup rather than resetting the sweep cursor; a
cursor reset only makes the same orphan prefix recur sooner.

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
- `createIndex` on `jobpostings`, `jobsourceconfigs`,
  `jobsourcecontrolaudits`, and `jobsourceoperationaudits`;
- `find`/`distinct` on `jobapplications`, plus `find` and `update` on
  `jobpostings`, for the retention repair and lifecycle sweep;
- create/index/read/write/drop rights in the staging database for UUID-named
  `__a02_smoke_*` collections; and
- permission to run transactions and the topology `hello` command.

Scope those rights to the staging database. The promotion workflow exposes the
secret only to database steps, never checkout, dependency installation, or
package lifecycle scripts.

Staging and production application credentials are part of the trust boundary.
The Jobs service needs `find`/`insert` on `jobsourcecontrolaudits`, but no
update/delete; it needs `find`/`insert` plus bounded update capability on
`jobsourceoperationaudits` because dispatch and terminal markers are written
after the command transaction, but no delete or TTL-index capability. It also
needs the existing bounded `find`/`insert`/`update` rights on
`jobsourceconfigs` and affected Jobs collections. Analyst/read-only identities
must not mutate either audit collection. Mongo roles are normally
collection-scoped rather than field-scoped, so one-way operational-marker
semantics are enforced by conditional application updates and tests while
least privilege prevents deletion; do not describe that collection as
immutable or append-only.

CMS Bootstrap explicitly calls the same seven non-dropping `createIndex`
operations before its logical transaction. If Bootstrap is required, use an
approved temporary deployment identity/grant with `createIndex` on exactly
`jobpostings`, `jobsourceconfigs`, `jobsourcecontrolaudits`, and
`jobsourceoperationaudits`; remove that grant after Bootstrap and the read-only
index check pass. Never grant `dropIndex`/`dropIndexes` to make Bootstrap work.
If the application identity has no approved index grant, prepare the indexes
with the operator command first; Bootstrap must fail rather than weaken the
contract.

The deployed application Mongo identity also needs `find`, `insert`, `update`,
and `remove` on `jobs_tracker_status_sweep_cursors`. If collection-scoped
authorization cannot implicitly create a pre-authorized namespace, pre-create
that empty collection. With tracker dispatch paused and zero active runs, use
the deployed identity in staging and production to prove create, resume, and
cleanup permissions before enabling the cron:

```javascript
(() => {
  const cursors = db.jobs_tracker_status_sweep_cursors
  const id = 'jobs-tracker-status-sweep-permission-smoke'
  let sentinelWritten = false
  try {
    const created = cursors.updateOne(
      { _id: id },
      { $set: {
        appliedAt: new Date(0), applicationId: ObjectId(), lastRunAt: new Date()
      } },
      { upsert: true }
    )
    sentinelWritten = created.acknowledged === true
    if (!sentinelWritten || !cursors.findOne({ _id: id })) {
      throw new Error('tracker cursor create/read smoke failed')
    }
    const resumed = cursors.updateOne(
      { _id: id }, { $set: { lastRunAt: new Date() } }
    )
    if (!resumed.acknowledged || resumed.matchedCount !== 1) {
      throw new Error('tracker cursor resume smoke failed')
    }
  } finally {
    const removed = cursors.deleteOne({ _id: id })
    if (!removed.acknowledged || (sentinelWritten && removed.deletedCount !== 1)) {
      throw new Error('tracker cursor cleanup smoke failed')
    }
  }
})()
```

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

   Build and verify the non-dropping A06 due-work index, then repair the
   historical tracker-status contradiction before enabling the daily sweep:

   ```text
   npm run prepare:jobs-tracker-status-index
   npm run prepare:jobs-tracker-status-index -- --apply
   npm run check:jobs-tracker-status-index
   npm run repair:jobs-tracker-status
   npm run repair:jobs-tracker-status -- --apply
   npm run check:jobs-tracker-status
   ```

   Before the link-check schedule is allowed to resume, run the
   [A09 non-dropping index gate](#non-dropping-index-gate) against this exact
   staging database and retain its read-only output. If the index is absent,
   use only the reviewed additive `createIndex` path in that section and then
   re-run the check; any incompatible key-identical index blocks rollout.

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

   This migration adoption is an approved raw-API exception under the A08
   break-glass rule above. The CMS Sources table shows the current authority
   revision. Submit from an authenticated platform-admin session; replace the
   placeholders but reuse
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
7. Keep dispatch paused after the verify phase turns green. After TTL deletion
   metrics and the physical posting count are stable across two TTL-monitor
   intervals, run one serialized source preflight to reconcile the safely
   stale-high admission counter, then immediately re-run
   `check:jobs-retention`, `check:jobs-source-lineage`,
   `check:jobs-source-control`, and `check:jobs-retention-sweep`.
8. Open `/cms/jobs-ingest` and use **Initialize sources** if the reviewed
   catalog is empty or incomplete. Confirm every new entry is paused. If
   bootstrap adopts an enabled source that lacks current operational audit
   authority, confirm its generated Pause evidence and leave it paused. An
   unknown/routing-drift row, protected-migration blocker, or invalid revision
   is not CMS-repairable; stop and use the approved migration path. Apply any
   settings while sources remain paused.
9. Execute all four [A08 activation gates](#a08-staging-and-production-activation-gates).
   Retain the deployed pinned-provider egress results before allowing provider
   validation. Then use one paused canary for the Inngest Validate-delivery
   smoke, followed by Enable → Run now for the sync-delivery smoke. Refresh
   CMS until both operation IDs have terminal outcomes; retain the Inngest run
   links and resulting validation/cycle IDs.
10. Re-enable scheduled dispatch only after every gate and canary is green.
    Within five minutes, confirm revoked sources have no normally accessible
    postings and no stale legal or operational revision is succeeding.

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
   blocked. The retention cron is fail-closed until the exact TTL index exists;
   the tracker-status cron separately requires its exact partial due-work index.
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

   Prepare its non-dropping due-work index, then repair and verify tracker
   status truth before background schedules resume:

   ```text
   npm run prepare:jobs-tracker-status-index
   npm run prepare:jobs-tracker-status-index -- --apply
   npm run check:jobs-tracker-status-index
   npm run repair:jobs-tracker-status
   npm run repair:jobs-tracker-status -- --apply
   npm run check:jobs-tracker-status
   ```

   Run the [A09 non-dropping index gate](#non-dropping-index-gate) against the
   exact production database while link-check dispatch remains paused. Retain
   both the pre-check and, if an authorized additive create was required, the
   final green verification. A key-identical incompatible index is a stop
   condition, not permission to drop it.

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
    reconcile the safely stale-high admission counter. Keep maintenance and
    dispatch pauses in place.
11. In CMS, initialize an empty/incomplete safe catalog, confirm all inserted or
    adopted legacy sources are paused, and make any settings changes. Bootstrap
    is not permission to repair unknown identities, protected-migration state,
    or malformed revisions; stop on any such blocker.
12. Execute all four [A08 activation gates](#a08-staging-and-production-activation-gates)
    with production evidence, including the pinned-provider transport smoke.
    Then prove actual Inngest delivery with a paused canary Validate, followed
    by Enable → Run now; refresh CMS until both matching operation IDs are
    terminal and retain their run/validation/cycle evidence.
13. Leave maintenance and re-enable scheduled dispatch only after every gate is
    green. Within five minutes, confirm revoked sources have no normally
    accessible postings and no sync at a stale legal or operational revision is
    succeeding.

If any step fails, leave both dispatch channels paused. Index preparation is
intentionally non-dropping, so do not improvise with `dropIndex` or rewrite TTL
dates. Before lifecycle apply, correct the data and rerun the idempotent gates.
After lifecycle apply, a past-due row may already have been deleted by Mongo;
the only rollback for unexpected deletion is the recorded PITR recovery point.
Escalate restoration rather than attempting an in-place partial reconstruction.
Preserve dry-run, apply, gate, snapshot/PITR, adoption operation IDs, and
affected row counts with deployment evidence.

## A14 evidence-provenance rollout gate

The normal merge pipeline remains authoritative: merging `main` triggers the
Vercel deployment and the Coolify staging rollout at
`staging.interviewprep.guru`. Do not SSH or start a second manual deployment.
Before using this gate, configure Coolify runtime variable
`DEPLOYMENT_COMMIT_SHA=$SOURCE_COMMIT`, keep `HEALTH_CHECK_TOKEN` on the app,
and store the same token in the protected GitHub `jobs-staging` environment.
The authenticated health response must expose the full deployed SHA; a missing,
malformed, unhealthy, or different revision fails before any database command.
After staging reports the new revision healthy, let pre-revision
`jobs-evidence-attribution` work drain. This is an observable gate, not a timed
guess: record the deployed commit, then confirm in Inngest that the function has
zero running/retrying executions that began before that revision and zero queued
pre-revision runs. Preserve that dashboard/API evidence with the release record.
Only then run these as environment-scoped one-off release commands:

```text
npm run repair:jobs-evidence-provenance
npm run repair:jobs-evidence-provenance -- --apply
npm run check:jobs-evidence-provenance
```

For staging, dispatch **Jobs Evidence Provenance Gate** on `main`, enter the
commit already healthy on `staging.interviewprep.guru`, and confirm the observed
old-worker drain. The workflow checks that the commit belongs to `main`, applies
the existing `jobs-staging` database-identity sentinel before any write, then
runs the same preview/apply/check sequence. It does not deploy application code.

The first command is read-only. All modes also fail closed when the current CMS
model allowlist cannot be resolved authoritatively. Apply refuses malformed or
future declared provenance and unsafe revision fences before writing, removes
only legacy or valid-but-stale readiness snapshots first in bounded batches,
advances their revision fences, and quarantines provenance-missing evidence
without inventing an evaluator or replaying a model. `check` is mandatory after
apply; it validates the exact current epoch/execution membership and fails while
any unclassified row or invalid readiness snapshot remains.
An explicit `legacy-unverifiable` total is expected historical state and does
not fail the gate. Preserve all three outputs with rollout evidence, repeat the
same sequence in production, and keep readiness surfaces dark regardless—the
founder-approved calibration and AI-data-disclosure gates remain separate.

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
commit** fail closed.

A08 closes the controllable browser gap. Apply and View Source open only the
authenticated, identity-rate-limited
`GET /api/jobs/{postingId}/open?optionId={opaqueId}` boundary. It reads the live
posting explicitly from the Mongo primary, resolves the current safe canonical
option, and brackets that resolution with active-account reads immediately
before returning a private/no-store redirect. A revoked posting, replaced
option, inactive account, malformed identity, or internal failure returns a
generic response with no destination URL. The server mediates authorization and
never exposes a destination through its JSON/error contract; the candidate's
browser still performs the external destination's final DNS/connect and cannot
inherit the liveness worker's pin. Apply-click telemetry and the return sheet
remain separate from navigation authority. A visible Jobs detail tab
revalidates on visibility return and on a four-minute interval, so a committed
revoke removes its stale Apply/View Source controls within the five-minute SLA
even if the tab never backgrounds.

This still cannot retract content accepted by a model/email provider or close
an external board page that already opened. Eliminating the final provider
read→send micro-gap requires a future source-scoped egress lease that every
external call acquires and revocation can synchronously drain.

## Legal restore procedure

Only submit `action:'restore'` after the legal case explicitly clears the
source. Use its current revision and a new UUID idempotency key. Success means
the clearance was recorded and the authority epoch advanced; it does **not**
mean ingestion resumed. Verify the source remains `enabled:false`,
`health:'quarantined'`, and that previously restricted postings remain closed.
Cold validation and the later explicit Enable are separate A08 CMS actions.
Use the ordered Restore → Validate → Enable procedure above.
