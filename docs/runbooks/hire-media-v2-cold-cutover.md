# Hire media and runtime-landmark v2 cold-cutover runbook

Status: **required for the first production release of Hire media object
protocol `v2-opaque-nonce-if-none-match-zero-seal` or runtime landmark object
protocol `v2-opaque-scope-digest-if-none-match-zero-seal`.**

This runbook overrides the rolling control-service deployment in
[`oracle-cutover.md`](./oracle-cutover.md) for this one protocol boundary.
Coolify rolling deployment starts the new container before stopping the old
one, so it cannot prove that v1 and v2 control workers never overlap. Schedule
a maintenance window and perform a cold cutover instead.

## Non-negotiable invariants

- The approved artifact is identified by one exact 40-character Git SHA, the
  authenticated Hire control marker
  `v2-opaque-nonce-if-none-match-zero-seal`, and the authenticated Hire engine
  marker `v2-opaque-scope-digest-if-none-match-zero-seal`.
- Old and new Hire control and Hire engine containers, HTTP writers, and
  Inngest lifecycle workers must never overlap. A successful response from one
  new container is not evidence that every old container is gone.
- Production v2 keys have shape `hire-media/v2/<64 lowercase hex characters>`.
  They contain a nonce-bound digest, not Mongo coordinate IDs, the candidate
  name, media kind, extension, or the nonce itself.
- Production runtime landmark keys have shape
  `landmarks/v2/<64 lowercase hex scope digest>`. Their 64-character random
  object-key nonce exists only in the temporary binding capability, runtime
  outbox, and signed bridge artifact; it is never embedded in the key and is
  erased with the raw-artifact authority after acknowledgement. Thus a
  permanent seal exposes no principal, session, candidate, workspace, or
  offline-verifiable nonce.
- Deleting either kind of v2 object means replacing it at the same key with a
  permanent zero-byte seal. Never delete that key afterwards. Never configure
  R2 expiration for all or any subset of `hire-media/v2/` or `landmarks/v2/`.
- Existing v1 media and coordinate-bearing landmark objects are not migrated.
  The v2-aware release continues to read them and deletes them with
  `DeleteObject`; it writes no new v1 objects.
- Once the first v2 database row or object exists, rollback to a build without
  this exact protocol is forbidden. Freeze and fix forward to a v2-aware
  build instead.

The permanent v2 seal does not retain clear candidate-linked coordinates. Its
opaque digest is nonce-bound and its body is empty. Media seal metadata is only
`hire-media-tombstone=v2`; runtime landmark seal metadata is only
`hire-runtime-landmark-tombstone=v2`. After the owning database graph is
deleted there is no retained coordinate-to-key mapping. A coordinate-bearing
permanent key would violate verified deletion and must never be introduced.

## 1. Pin the release and pass local conformance

From a clean approved checkout, record the exact commit in the release ticket:

```sh
RELEASE_SHA="$(git rev-parse --verify HEAD)"
git diff --exit-code
test "$(printf %s "$RELEASE_SHA" | wc -c | tr -d ' ')" = 40
```

Run the focused local suite from that same checkout:

```sh
npm run test:run -- \
  app/api/health/__tests__/route.test.ts \
  app/api/health/__tests__/hireMediaObjectProtocol.test.ts \
  scripts/__tests__/check-hire-media-r2-protocol.test.ts \
  shared/storage/__tests__/r2.test.ts \
  modules/hire-runtime/__tests__/runtimeMediaCleanup.test.ts \
  modules/hire-runtime/__tests__/runtimeMediaManifest.test.ts \
  modules/hire-runtime/__tests__/multimodalAnalysisCaptureService.test.ts \
  modules/hire-runtime/__tests__/multimodalAnalysisPublisherSnapshot.test.ts \
  modules/hire-runtime/__tests__/runtimePersonalDataPurge.test.ts \
  modules/hire/__tests__/hireMediaStorageProtocol.test.ts \
  modules/hire/__tests__/runtimeMediaPrivacyRace.test.ts \
  modules/hire/__tests__/identityMediaRetention.test.ts \
  modules/hire/__tests__/mediaLifecycleAndEvidence.test.ts \
  modules/hire/__tests__/mediaLifecycleTenantScope.test.ts \
  modules/hire/__tests__/workspacePurgeService.test.ts \
  modules/hire-onboarding/__tests__/testDriveLifecycleService.test.ts
```

This is a release gate, not an advisory test. It must prove both write/delete
orderings, v1 compatibility, and completion fencing for privacy deletion,
workspace hard purge, retention, and onboarding test-drive cleanup.

## 2. Audit the real production R2 bucket

Inject both exact production bucket credential sets through the approved
operator secret store. Do not paste or print them. `R2_*` must identify the
Hire control bucket; `HIRE_RUNTIME_R2_*` must identify the Hire engine runtime
bucket. Each token must be able to read its own bucket lifecycle configuration,
list objects, and read/write/delete objects only for the conformance check.
Also inject a read-only `MONGODB_URI` for the production runtime database and
its exact `HIRE_RUNTIME_DATABASE_NAME`; the checker selects that database
explicitly and reads it with primary/majority semantics.

The first-activation counts are release-authoritative, so credentials and
names alone are insufficient: a self-consistently wrong database/bucket tuple
could otherwise report an empty inventory. Before the first check, provision
the following immutable identity sentinel through a separate, change-controlled
bootstrap workflow. The checker contains no sentinel create, update, repair,
or delete path:

- collection: `__deployment_environment_identity` in the exact production
  runtime database;
- `_id`: `hire-media-r2-v2-production-activation-v1`;
- `environment`: `production`;
- `runtimeDatabaseName`: the exact production runtime database name;
- `schemaVersion`: `1` and `immutable`: `true`;
- `replicaSetName`: the exact committed replica-set config `_id`;
- `replicaSetId`: the 24-character lowercase hex value of committed
  `config.settings.replicaSetId`;
- `tokenSha256`: lowercase SHA-256 of an independently stored UTF-8 sentinel
  secret containing at least 32 bytes; and
- `bindingHmacSha256`: the token-keyed HMAC-SHA-256 below.

The bootstrap must query the production primary with
`admin.command({ replSetGetConfig: 1, commitmentStatus: true })`, require
`commitmentStatus === true`, and fail closed on a standalone, missing
privilege, malformed response, or uncommitted replica configuration. Build
`bindingHmacSha256` by feeding each field name and value as UTF-8, each
preceded by its own unsigned four-byte big-endian byte length, in this exact
order:

1. `domain` = `hire-media-r2-v2-production-activation-binding-v1`;
2. `environment` = `production`;
3. `runtimeDatabaseName`, `replicaSetName`, and `replicaSetId`;
4. `controlR2Jurisdiction` = `default`;
5. `controlR2Endpoint` =
   `https://<control-account-id>.r2.cloudflarestorage.com`;
6. `controlR2AccountId`, `controlR2Bucket`, and
   `controlR2ProtectedPrefix` = `hire-media/v2/`;
7. `runtimeR2Jurisdiction` = `default`;
8. `runtimeR2Endpoint` =
   `https://<runtime-account-id>.r2.cloudflarestorage.com`; and
9. `runtimeR2AccountId`, `runtimeR2Bucket`, and
   `runtimeR2ProtectedPrefix` = `landmarks/v2/`.

Insert the sentinel exactly once with majority plus journal acknowledgement,
independently verify it, then revoke the bootstrap principal's sentinel-write
authority. Never copy the sentinel into a clone or restore. A physical clone
that preserves the local replica configuration and `replicaSetId` must be
treated as the same deployment identity until its replica set is reinitialized.
The checker principal needs only `find` on this fixed collection, the inventory
collection reads below, and the exact cluster privilege for
`replSetGetConfig`; it must have no sentinel mutation authority.

Inject these independently reviewed expected values and the sentinel token
through the approved operator secret store for both `--first-activation` and
`--write`; never print them or record the token/digests in release evidence:

- `NODE_ENV=production` and
  `HIRE_MEDIA_R2_EXPECTED_ENVIRONMENT=production`;
- `HIRE_MEDIA_R2_EXPECTED_RUNTIME_DATABASE_NAME`;
- `HIRE_MEDIA_R2_EXPECTED_CONTROL_ACCOUNT_ID` and
  `HIRE_MEDIA_R2_EXPECTED_CONTROL_BUCKET_NAME`;
- `HIRE_MEDIA_R2_EXPECTED_RUNTIME_ACCOUNT_ID` and
  `HIRE_MEDIA_R2_EXPECTED_RUNTIME_BUCKET_NAME`; and
- `HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN`.

The expected values must match the live connection settings exactly. The
checker then recomputes and timing-safely verifies the sentinel against the
committed live replica identity and both R2 tuples before issuing any R2
inventory, lifecycle, conformance, or cleanup request. A missing or invalid
sentinel is a hard NO-GO, even when every supplied target reports zero state.

First run the read-only lifecycle audit:

```sh
npm run check:hire-media-r2-protocol -- --first-activation
```

It must report that the control bucket has no enabled expiration rule
overlapping `hire-media/v2/` and the runtime bucket has no enabled expiration
rule overlapping `landmarks/v2/`. It fully paginates count-only inventories in
the two separately authenticated buckets. Bucket-wide expiration, parent
prefixes such as `hire-media/` or `landmarks/`, and child prefixes below the
corresponding production v2 prefix are blockers. On first activation both v2
object counts and the runtime Mongo v2 reference count must be zero; a nonzero
count means that protocol has already crossed its irreversible boundary and
requires a v2-aware fix-forward review.

The same read-only run fully paginates runtime-bucket `landmarks/` and joins
every coordinate-bearing legacy object to exact majority-read runtime Mongo
references in `HireRuntimeMultimodalAnalysisOutbox`, `InterviewSession`, and
`HireRuntimeBinding.issuedObjectCapabilities`. It emits aggregate counts only.
For first activation, even a fully matched legacy object/reference count must
be zero: matched means discoverable, not reconciled or safe against a late old
write. The command fails its first-activation gate on any legacy object or
reference.
Malformed keys/references, crossed principal/session coordinates, an unmatched
legacy object, or a reference whose object is absent is a hard blocker. This
checker has no legacy mutation mode: a nonzero blocker requires a separately
reviewed exact-key reconciliation with production identity and late-write
evidence. Never replace it with `DeleteObject` by prefix or a manual sweep.

Also audit Cloudflare Dashboard rules and every external cleanup, inventory,
backup, restore, and operator script for both accounts/buckets. There must be
no policy that deletes v2 objects merely because they are zero bytes or old.

Then run the write conformance check:

```sh
HIRE_MEDIA_R2_CONFORMANCE_ACK=write-and-delete-random-canaries \
  npm run check:hire-media-r2-protocol -- --first-activation --write
```

The checker writes three random keys below
`hire-media-conformance/v2/<uuid>/` in each exact bucket. It verifies all of
the following through independent S3 clients against both storage identities:

1. the first `PutObject` with `If-None-Match: *` succeeds;
2. another conditional put returns `412 PreconditionFailed` without changing
   the bytes;
3. an unconditional zero-byte seal replaces existing media;
4. a conditional put after that seal returns 412 and the seal remains; and
5. a seal written first also rejects a later conditional media put; and
6. a conditional upload whose request body is deliberately held incomplete
   loses to a seal installed by another client, finishes specifically with
   `412 PreconditionFailed` after its body is released, and cannot change the
   independently observed seal. A 429 is retried where safe but never counted
   as proof of this in-flight race.

For the in-flight case, the SDK consumes and sends a known-length first chunk,
the checker holds the remaining body, waits briefly, obtains the seal ACK from
a separate client, and only then releases the remainder. No client-side probe
can inspect R2's internal header-parse instant, so retain this provider canary
together with R2's documented strong-consistency/last-completing-writer
semantics and the deterministic local delayed-body race tests as the evidence
set; do not describe any one probe as a formal proof of every network schedule.

The checker removes and independently verifies only the six exact random
canaries in `finally`. It refuses both production v2 prefixes. A cleanup
failure is a failed gate and must be resolved without broad prefix deletion.
Production `hire-media/v2/` and `landmarks/v2/` seals are intentionally
excluded and permanent. `DeleteObject`, a manual prefix sweep, lifecycle
expiration, or zero-byte cleanup against either prefix is prohibited.

Do not apply R2 bucket lock/Object Lock as a substitute for the seal. The
protocol must be able to overwrite live media with the zero-byte seal; the
protection comes from conditional media writes plus the permanent winning
object at the same key.

## 3. Run the count-only R2/Mongo legacy inventory

Use `reconcile:hire-media-v1`; do not replace it with a Mongo-only count. The
default invocation is read-only and loads no dotenv file:

```sh
npm run reconcile:hire-media-v1
```

That control-bucket tool does not own runtime landmarks. The read-only runtime
landmark join in section 2 is the separate release gate for that namespace.
It must be clean before continuing; this runbook authorizes no runtime-prefix
deletion.

Inject `MONGODB_URI`, the R2 credentials, and all values below through the
approved production operator secret store. Do not place their values in the
command line, terminal output, or release evidence:

- `NODE_ENV=production`, `IPG_SURFACE=hire-control`, and
  `HIRE_MEDIA_V1_EXPECTED_ENVIRONMENT=production`;
- `HIRE_CONTROL_DATABASE_NAME`, `HIRE_RUNTIME_DATABASE_NAME`, and
  `B2C_DATABASE_NAME`, which must be three distinct names;
- `HIRE_MEDIA_V1_EXPECTED_SURFACE=hire-control` and
  `HIRE_MEDIA_V1_EXPECTED_DATABASE_NAME`, which must exactly match the control
  database selected by both `MONGODB_URI` and `HIRE_CONTROL_DATABASE_NAME`;
- `R2_ACCOUNT_ID` and `HIRE_MEDIA_V1_EXPECTED_R2_ACCOUNT_ID`, which must match
  exactly; and
- `R2_BUCKET_NAME` and `HIRE_MEDIA_V1_EXPECTED_BUCKET_NAME`, which must match
  exactly. Bucket name alone is not an identity because names can repeat in
  different R2 accounts.

Explicit expectations alone can be self-consistently wrong. Destructive mode
also requires this immutable production identity sentinel, provisioned through
a separate, change-controlled bootstrap workflow. Define and review the
bootstrap now, but do not insert the marker until the freeze/drain is complete;
it is a one-time marker created immediately before destructive reconciliation:

- collection: `__deployment_environment_identity`;
- `_id`: `hire-media-v1-production-reconciliation-v1`;
- `environment`: `production`;
- `databaseName`: the exact production Hire control database name;
- `schemaVersion`: `1` and `immutable`: `true`;
- `replicaSetName`: the exact committed replica-set config `_id`;
- `replicaSetId`: the 24-character lowercase hex value of the committed
  `config.settings.replicaSetId`;
- `tokenSha256`: lowercase SHA-256 of a separately stored UTF-8 sentinel secret
  containing at least 32 bytes; and
- `bindingHmacSha256`: the token-keyed HMAC-SHA-256 described below.

The bootstrap must connect to the production primary and run
`admin.command({ replSetGetConfig: 1, commitmentStatus: true })`. Require
`commitmentStatus === true`, a nonempty exact `config._id`, and the immutable
ObjectId in `config.settings.replicaSetId`. Fail closed on a standalone,
unsupported topology, missing privilege, malformed response, or uncommitted
configuration.

Build `bindingHmacSha256` with the sentinel token as the HMAC key. Feed each
field name and value as UTF-8 bytes preceded by its own unsigned 4-byte
big-endian byte length. Use this exact ordered field sequence:

1. `domain` = `hire-media-v1-production-binding-v2`;
2. `environment` = `production`;
3. `surface` = `hire-control`;
4. `databaseName` = the exact control database;
5. `replicaSetName` and `replicaSetId` from the committed primary response;
6. `mongoScheme` = `mongodb` or `mongodb+srv` and `mongoAuthority` = either
   the lowercased SRV seed or the sorted, deduplicated, lowercased direct seed
   host:port set;
7. `mongoSrvServiceName` = the normalized SRV service name (default
   `mongodb`), `mongoReplicaSetOption` = the exact connection option or the
   empty string, and `mongoTls`, `mongoDirectConnection`, and
   `mongoLoadBalanced` = the exact lowercase UTF-8 strings `true` or `false`;
8. `r2Jurisdiction` = `default`;
9. `r2Endpoint` =
   `https://<exact-account-id>.r2.cloudflarestorage.com`;
10. `r2AccountId` and `r2Bucket` = their exact production values; and
11. `r2Prefix` = `hire-media/`.

The Mongo authority canonicalization must come from the connection actually
used by the reconciler. For SRV, lowercase the exact seed and normalized
service name. For direct seeds, use the driver's normalized HostAddress
host:port strings, lowercase, deduplicate, sort, and join them with commas.
Never include or persist username, password, raw URI, path, authentication
source, or unrelated/query-secret options in the marker or HMAC. The committed
replica-set name remains separately bound even when the connection URI omits a
`replicaSet` option; if that option is present, it must equal the live committed
name.

Insert the marker exactly once with majority plus journal acknowledgement. Do
not upsert, overwrite, repair, or automatically recreate it. After the insert
is independently verified, revoke the bootstrap principal's sentinel-write
authority. The reconciliation tool contains no sentinel creation or mutation
path.

Keep `HIRE_MEDIA_V1_SENTINEL_TOKEN` only in the approved operator secret store;
never put the secret or either digest in release evidence. Give the dedicated
reconciliation Mongo role only `find` on `hiremediaassets`, `find` on the fixed
sentinel collection, and the exact cluster privilege required for
`replSetGetConfig`. It must have no insert, update, replace, or delete authority
on the sentinel. The checker obtains the committed live replica-set identity
from the primary, reads the fixed sentinel ID using primary preference and
majority read concern, requires every fixed field, and compares both
64-character digests using timing-safe byte comparison. It repeats the live
replica/HMAC/sentinel verification after inventory immediately before its
first `DeleteObject`. If either check fails, it stops before deletion.

Never copy this marker into a clone or restore. A reinitialized clone gets a
different `replicaSetId`, so a copied marker fails closed. A physical clone
that preserves Mongo's local replica configuration and `replicaSetId` must be
treated as the same destructive identity; reinitialize the replica set and
provision a new token-bound marker before treating it as a separate target.

The checker also validates the URI-selected database, all three surface
database boundaries, R2 account, and bucket against explicit operator
expectations. Record an independent review of the exact
account/bucket/database binding in the release ticket; destructive mode
requires both that assertion and the immutable sentinel.

The checker fully paginates `ListObjectsV2` below `hire-media/`. It explicitly
excludes and separately counts every object below `hire-media/v2/`; its
conformance namespace is also excluded. It recognizes only the exact
lowercase canonical v1 coordinate path and the fixed kind/extension mapping.
Every canonical object is joined to `hiremediaassets` on the complete asset,
workspace, application, round, and attempt ObjectIds, the mapped kind, and the
exact object key. Independently of R2 inventory, it scans every
`hiremediaassets` row using primary preference and majority read concern. Thus
a v1 row whose R2 object is absent is still validated against the coordinates
encoded in its key, its exact kind mapping, and the requirement that legacy v1
rows have no `objectKeyNonce`. It reports only aggregate counts:

- `matched_live`: exact row exists and is not logically purged;
- `matched_purged`: exact row is `purged`, so the legacy object should be gone;
- `unmatched_canonical_orphan`: canonical legacy object has no exact row;
- `malformed_or_unrecognized`: anything else below the production prefix;
- `production_v2_excluded`: every R2 object below the v2 prefix; and
- Mongo v1, inconsistent Mongo v1, Mongo v2, malformed/unrecognized protocol,
  `staging`, and `purge_claimed` row counts.

The checker never prints or returns object keys, coordinate IDs, nonces,
database URIs, account or bucket names, or credentials. Preserve only its
aggregate counts and status. Any malformed/unrecognized object is a hard
blocker and is never auto-deleted. Any v1 Mongo coordinate/kind mismatch or
unexpected nonce is also a hard blocker, including when no corresponding R2
object exists.

For the first activation, both `production_v2_excluded` and Mongo v2 rows must
be zero. A nonzero value means the irreversible boundary may already have been
crossed and the release must be handled as a v2 fix-forward. `matched_purged`
or `unmatched_canonical_orphan` requires the frozen reconciliation below.
This first-activation tool intentionally refuses destructive v1 cleanup once
any v2 R2 object or Mongo row exists. Its read-only counts remain useful, but a
post-boundary cleanup requires a separately reviewed fix-forward procedure
that preserves every v2 seal and cannot issue `DeleteObject` for a v2 key.

## 4. Freeze and drain every old writer and deleter

1. Put both the Hire control and Hire engine origins behind an explicit
   maintenance/write freeze.
   Block new interview starts, identity capture, recording ingestion, privacy
   requests, workspace deletion, and onboarding test-drive mutations. Keep an
   operator-only path to authenticated `/api/health`.
2. Pause these Inngest functions and prevent new invocations of their endpoint:
   `hire-media-retention`, `hire-lifecycle-retention`,
   `hire-onboarding-test-drive-cleanup-requested`,
   `hire-onboarding-test-drive-cleanup-recovery`,
   `hire-runtime-result-publisher`, and
   `hire-runtime-multimodal-analysis-publisher`. Also pause any manually
   triggered privacy or workspace purge run.
3. Stop and drain every Hire engine replica and explicitly block the runtime
   landmark capture route. Inventory every credentialed process, service
   principal, operator token,
   lifecycle rule, external cleanup, backup, restore, or migration that can
   write or delete in the control bucket. Freeze or revoke every old writer
   and cleanup principal and record its identity and disposition in the
   release ticket. Application container inventory alone is insufficient.
4. Wait until the proxies report zero active Hire control and Hire engine
   requests and Inngest reports zero active runs that can upload, copy, purge,
   or delete Hire media or runtime landmarks.
5. Complete any final approved database restore/clone action, wait for the
   primary and replicas to become fully synchronized, and prohibit any further
   restore. Then rerun the read-only reconciliation checker. **Every** `staging` row and every
   `purge_claimed` row must be zero—not only rows with a future lease. A legacy
   v1 staging row without a lease represents an old unconditional write whose
   remote outcome can be ambiguous; it cannot cross the cutover. Resolve it
   under the freeze after proving that no old request owns it, or stop the
   release. A settled `purge_failed` row may remain for the new release's
   token-fenced recovery, but no old worker may still own it.
6. Freeze Mongo DNS/seed authority changes, replica-set reconfiguration,
   database clone/restore operations, R2 account/bucket changes, and relevant
   credential rotation for the entire reconciliation window. After this
   freeze/drain—not earlier—perform the one-time **control v1 destructive
   reconciliation** sentinel bootstrap described in section 3. Verify its
   majority+journal insert and revoke the bootstrap writer. (The separate
   runtime/database and dual-bucket activation sentinel required by section 2
   must already exist and remains read-only throughout the window.)
7. Record every old control and engine container ID, its exact image/source
   SHA, the drain completion time, and both bucket inventory counts. Keep the
   freeze in place.

Do not infer drain completion from the 240-second storage timeout alone. The
database lease and the worker/request state are the authority. Do not accept
new deletion requests into an unobserved queue during the freeze; fail them
closed so callers can retry after service restoration.

### The external late-write barrier is a production NO-GO gate

R2 strong consistency describes completed operations. It does not provide a
documented upper bound after which a previously accepted unconditional v1 PUT
is guaranteed unable to complete. Stopping workers, revoking credentials, a
client-side timeout, waiting an arbitrary interval, and one or many clean
rescans therefore do **not** prove that a late v1 object cannot appear.

This gate applies independently to unconditional legacy control-media writes
in the control bucket and unconditional legacy landmark writes below
`landmarks/` in the runtime bucket. A barrier for one account, bucket, or
writer population is not evidence for the other. The default release decision
is **NO-GO** until the release ticket contains
independently reviewed evidence of one of these external conditions:

1. a provider-enforced write barrier has completed;
2. a provider-documented settlement/cancellation bound has fully elapsed; or
3. the old v1 write namespace or bucket has been retired so a late old write
   cannot enter the activated production namespace.

Do not select one of these modes merely because all known workers are gone.
The reconciliation tool can validate the operator assertion, but it cannot
create or independently prove the provider barrier. If governance explicitly
accepts the remaining unbounded risk instead, record that exception, its
privacy owner, continuous/perpetual count-only reconciliation, alerting, and
exact-key cleanup procedure. Neither a risk exception nor repeated clean scans
may be described as equivalent to the external barrier or as a safe proof.

### Delete exact legacy orphans only under the completed gate

After the freeze, zero-row checks, immutable sentinel provisioning,
account/bucket/database review, and external late-write gate are recorded, run
destructive reconciliation with these exact operator assertions. The base
production environment above, including `HIRE_MEDIA_V1_SENTINEL_TOKEN` injected
through the secret store, must remain set:

```sh
HIRE_MEDIA_V1_DESTRUCTIVE_ACK=delete-exact-canonical-v1-orphans-and-logically-purged-objects \
HIRE_MEDIA_V1_ENVIRONMENT_BINDING_ACK=exact-production-control-bucket-and-database-pair-reviewed \
HIRE_MEDIA_V1_FREEZE_ACK=hire-control-write-freeze-active \
HIRE_MEDIA_V1_OLD_WORKERS_ACK=zero-old-hire-media-writers-and-deleters \
HIRE_MEDIA_V1_EXTERNAL_PRINCIPALS_ACK=all-credentialed-r2-writer-and-cleanup-principals-inventoried-and-frozen \
HIRE_MEDIA_V1_STAGING_ACK=zero-staging-asserted \
HIRE_MEDIA_V1_PURGE_CLAIMED_ACK=zero-purge-claimed-asserted \
HIRE_MEDIA_V1_LATE_WRITE_EVIDENCE_ACK=provider-barrier-or-old-write-namespace-retirement-evidence-recorded \
HIRE_MEDIA_V1_LATE_WRITE_SAFETY_MODE=provider-enforced-write-barrier-completed \
npm run reconcile:hire-media-v1 -- --delete
```

For `HIRE_MEDIA_V1_LATE_WRITE_SAFETY_MODE`, the other accepted literals are
`provider-documented-settlement-bound-completed` and
`old-v1-write-namespace-or-bucket-retired`. Select exactly the evidenced mode.

Before any R2 operation, the command verifies the immutable sentinel. It then
completes the entire R2 inventory and Mongo row scan and refuses all deletion
on malformed keys or rows, inconsistent v1 coordinates/kinds, an unexpected v1
nonce, any production v2 object/row, nonzero `staging` or `purge_claimed`, or an
identity/assertion mismatch. For each eligible object it reparses the exact
lowercase v1 key, repeats the complete Mongo ownership join, and issues
`DeleteObject` only when the object is still unmatched or its exact row is
still `purged`. It deletes sequentially, verifies each exact key is absent, and
then performs another fully paginated R2 scan and full Mongo row scan. It never
deletes v2 or conformance objects. The final clean status is a point-in-time
reconciliation observation; the external barrier remains the authority for
activation.

After both independent external late-write barriers are complete and the
control destructive reconciliation has finished its clean rescan, rerun the
separate identity-bound activation checker while every old writer remains
frozen:

```sh
npm run check:hire-media-r2-protocol -- --first-activation
```

This final run is mandatory immediately before starting any new container. It
must reverify the committed runtime replica identity and immutable activation
sentinel, both exact R2 account/bucket tuples, both lifecycle configurations,
zero control and runtime v2 objects, zero runtime v2 Mongo references, and
zero legacy runtime landmark objects/references. Preserve its aggregate output
and completion timestamp in the release ticket. The earlier section 2 scan is
pre-freeze reconnaissance and cannot substitute for this post-barrier scan.
Any nonzero count, identity mismatch, lifecycle blocker, or new malformed
runtime landmark state is a hard NO-GO; return to reconciliation without
starting the new services.

After destructive reconciliation, revoke every destructive lease and remove
`HIRE_MEDIA_V1_SENTINEL_TOKEN` from the reconciler process. Retain that token
only in the approved operator secret store through the per-control-container
live identity attestation in section 5; never persist it in an application
container. Permanently destroy it together with the activation token after the
irreversible-boundary evidence is accepted. The immutable marker then becomes
deliberately unusable. Any future destructive workflow requires a separately
reviewed, versioned fix-forward identity protocol; never copy, regenerate, or
update this marker as a shortcut.

## 5. Perform the no-overlap Coolify deployment

An ordinary Coolify rolling redeploy is prohibited for this boundary.
Do not enter this section unless the external late-write gate and destructive
control reconciliation above are complete with zero blockers and the final
post-barrier identity-bound `--first-activation` scan reports zero across both
buckets and runtime Mongo. This repository does not provide a destructive
runtime-landmark reconciler; a nonzero runtime join must stop activation until
a separately reviewed identity-bound exact-key tool and late-write barrier are
available.

1. Stop every old Hire control replica and every old Hire engine replica, and
   disable any automation that could recreate either population. Verify from
   the host/container inventory that zero old control and zero old engine
   containers remain running. Wait through one normal health-check interval
   and verify both inventories again.
2. With both old populations still at zero, deploy the approved artifact at
   `RELEASE_SHA` to both surfaces. Starting multiple replicas is allowed only
   if every control and engine replica is the same new artifact.
3. Before any health probe or synthetic write, bind **every running new
   container's effective configuration** to the same identities accepted by
   the sentinels and final activation scan. Use the Coolify/host operator
   plane to inspect the resolved per-container environment and secret revision
   metadata in a non-logged secure session; checking only the service template,
   deployment manifest, or one replica is insufficient.

   For every control container, require its effective `R2_ACCOUNT_ID` and
   `R2_BUCKET_NAME` to equal the exact sentinel-bound expected control tuple.
   Its effective `HIRE_RUNTIME_R2_ACCOUNT_ID` and
   `HIRE_RUNTIME_R2_BUCKET_NAME` must equal the exact sentinel-bound runtime
   tuple used for source landmark copies. Its selected control database must
   equal the control-v1 identity sentinel expectation. For every engine
   container, require effective
   `R2_ACCOUNT_ID`/`R2_BUCKET_NAME` and
   `HIRE_RUNTIME_R2_ACCOUNT_ID`/`HIRE_RUNTIME_R2_BUCKET_NAME` to equal the exact
   sentinel-bound expected runtime tuple; require both runtime aliases to be
   identical. Its effective `HIRE_RUNTIME_DATABASE_NAME` must equal
   `HIRE_MEDIA_R2_EXPECTED_RUNTIME_DATABASE_NAME`.

   From each control container, use its effective Mongo connection in a
   read-only operator command to obtain the committed live
   `replicaSetName`/`replicaSetId`, majority-read the fixed control-v1
   sentinel, canonicalize the effective Mongo authority/options, and recompute
   the control-v1 HMAC with the effective control tuple and selected database
   using the exact section 3 algorithm. It must match the same immutable
   control sentinel that authorized destructive reconciliation. From each
   engine container, use its effective Mongo connection in a separate
   read-only operator command to obtain the committed live
   `replicaSetName`/`replicaSetId` and majority-read the fixed activation
   sentinel. Recompute the token HMAC with the exact effective runtime tuple
   and selected database using the section 2 algorithm. It must match the same
   sentinel already accepted by the final checker. The command must contain no
   sentinel mutation path and must not print the URI, credentials, token,
   digests, account IDs, bucket names, or database names.

   Supply `HIRE_MEDIA_V1_SENTINEL_TOKEN` and
   `HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN` only as ephemeral operator-command
   secrets; never add either token to an application container's persistent
   environment or image.

   Record only container ID, `RELEASE_SHA`, immutable secret/config revision
   identifiers, and pass/fail booleans for the control tuple, runtime tuple,
   selected database, committed replica identity, and sentinel HMAC. Keep the
   expected values and secrets out of release evidence. Any replica whose
   effective values cannot be inspected and compared is a NO-GO; implement an
   authenticated token-bound identity attestation before proceeding rather
   than trusting health/configuration status alone.
4. Probe each new control container directly through the internal operator
   path; do not rely on one load-balanced response. Then probe the external
   control origin. Every authenticated response must satisfy this predicate:

```sh
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${HEALTH_CHECK_TOKEN}" \
  https://hire.example.invalid/api/health |
  jq --exit-status --arg sha "$RELEASE_SHA" '
    .status == "healthy" and
    .checks.configuration == "ok" and
    .checks.mongodb == "ok" and
    .checks.redis == "ok" and
    .configurationIssues == [] and
    .releaseGateAuthenticated == true and
    .surface == "hire-control" and
    .deploymentCommit == $sha and
    .hireMediaObjectProtocol == "v2-opaque-nonce-if-none-match-zero-seal" and
    .hireIngestionRevisionProtocol.protocolVersion == "2" and
    .hireIngestionRevisionProtocol.mode == "required" and
    .hireIngestionRevisionProtocol.releaseReady == true
  '
```

Replace the placeholder origin with the approved control origin. The marker
is intentionally absent from the unauthenticated health body; `hire-engine`
and `b2c` authenticated health report the control marker as `not-applicable`.

5. Probe every new Hire engine container directly, followed by the external
   engine origin. Each authenticated engine response must be bound to the same
   `RELEASE_SHA`, identify the engine surface and browser build, and expose
   only the runtime-landmark marker:

```sh
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${HEALTH_CHECK_TOKEN}" \
  https://engine.hire.example.invalid/api/health |
  jq --exit-status --arg sha "$RELEASE_SHA" '
    .status == "healthy" and
    .checks.configuration == "ok" and
    .checks.mongodb == "ok" and
    .checks.redis == "ok" and
    .checks.hireBrowserBuild == "ok" and
    .configurationIssues == [] and
    .releaseGateAuthenticated == true and
    .surface == "hire-engine" and
    .deploymentCommit == $sha and
    .hireInterviewBuild.multimodal == true and
    .hireMediaObjectProtocol == "not-applicable" and
    .hireRuntimeLandmarkObjectProtocol ==
      "v2-opaque-scope-digest-if-none-match-zero-seal" and
    .hireIngestionRevisionProtocol == "not-applicable"
  '
```

Replace the placeholder with the approved engine origin. The runtime marker
is absent from the unauthenticated body and is `not-applicable` on control and
B2C; a control probe cannot stand in for an engine probe.

6. Recheck both host inventories after the probes. If any old control or
   engine container exists, stop the rollout and keep writes frozen even if
   every sampled HTTP response came from the new artifact.

## 6. Activate and record the irreversible boundary

Before restoring general traffic, use the approved internal maintenance bypass
to complete both synthetic flows in an isolated QA workspace:

1. Complete one Hire control media upload and verify with count-only database
   predicates that its media row has both the exact `hire-media/v2/` key shape
   and a 64-character lowercase-hex `objectKeyNonce`.
2. Complete one browser-to-engine landmark capture, resume the exact runtime
   analysis publisher, and require the control service to checksum-copy and
   acknowledge it. Verify count-only that the control artifact digest and size
   equal the runtime outbox snapshot, the control object is durable, the
   runtime outbox is settled with its raw-artifact pointer removed, and an
   internal `HEAD` of the exact runtime source observes a permanent zero-byte
   seal with metadata `hire-runtime-landmark-tombstone=v2`.

The synthetic landmark must exercise capture, publish, control ingestion and
copy, acknowledgement, and source sealing end to end; a direct storage canary
or isolated API call is not a substitute. Do not put either key, nonce,
coordinates, artifact bytes, or candidate data in release evidence.

The earliest creation time of either production v2 row or object is the
irreversible rollback boundary. Record its timestamp and boolean/count-only
proof. After the boundary evidence is independently accepted, remove
`HIRE_MEDIA_V1_SENTINEL_TOKEN` and
`HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN` from every operator process and
destroy both secret-store values so neither one-time attestation can be
replayed.
Resume the paused Inngest functions, remove the write freeze, and
monitor both surfaces and buckets for:

- conditional-write 412s and same-key 429 retries/failures;
- staging leases and `purge_claimed` recovery;
- v1 read/delete completion;
- runtime landmark staging/cleanup leases, publisher retries, and source-seal
  acknowledgements; and
- the first completed privacy, workspace hard-purge, retention, and test-drive
  cleanup paths on the v2-aware release.

For every v2 deletion path, database graph removal may complete only after the
zero-byte seal write is acknowledged. A failed seal write must retain the row
and claim for retry. A later `HEAD` of the key must show content length zero,
content type `application/octet-stream`, cache control `private, no-store`, and
the owning protocol metadata: `hire-media-tombstone=v2` for control media or
`hire-runtime-landmark-tombstone=v2` for runtime landmarks. Do not turn this
verification into a tool that deletes either seal.

## 7. Rollback boundary and incident handling

- **Before any v2 row/object exists in either bucket or database:** keep the
  write freeze, stop all new control and engine containers, verify zero new
  containers on both surfaces, and then start the prior builds. Do not overlap
  versions in the reverse direction either. Repeat both health and inventory
  gates before reopening traffic.
- **After any v2 row/object exists:** never start a non-v2-aware build. Keep or
  reinstate the freeze and deploy a fix-forward or validated backport that
  exposes both exact surface-owned health markers. Do not rewrite v2 keys to
  v1, remove their nonces, or delete their seals.

The old parser recognizes only coordinate-bearing v1 keys. It rejects v2 keys
before issuing `GetObject`, signed-download, or `DeleteObject`, so an old
deletion worker cannot erase a v2 seal. That fail-closed behavior protects the
object but does **not** make mixed deployment or rollback safe: old workers
cannot finish v2 access, purge, privacy, workspace, or test-drive work.

## Provider behavior used by this gate

- [Cloudflare R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
  documents `If-None-Match` support for `PutObject`.
- [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
  documents strongly consistent object operations.
- [Cloudflare R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/)
  documents 412 precondition failures and same-key rate limiting.
- [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
  describes expiration rules that must exclude the v2 prefix.
- [Coolify rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates)
  explains why a normal rolling release creates an overlap window.
