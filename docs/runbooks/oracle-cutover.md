# Oracle cutover runbook

Status: **production deployments run on Oracle Cloud through Coolify; Vercel is not a deployment target.**

Current release procedure updated: 2026-08-27.

This is the operational source of truth for releases to the existing Oracle
Cloud Mumbai A1 VM managed by Coolify. Cloudflare DNS/R2, Inngest Cloud,
Razorpay, OAuth, Resend, and the AI providers remain external services.

The current Hire-native multimodal and job-candidate workspace release
procedure is below. The remaining Vercel-to-Oracle cutover record is retained
for audit history only and is explicitly superseded as live deployment
guidance.

The first release of Hire media object protocol
`v2-opaque-nonce-if-none-match-zero-seal` must use the dedicated
[`Hire media v2 cold-cutover runbook`](./hire-media-v2-cold-cutover.md). Its
pause/drain/no-overlap procedure overrides the rolling deployment step below.

## Current Hire release procedure

Use this procedure only from an approved, merged `main` commit. Record the
exact 40-character source commit and deployment timestamps for both services.
All release actions are manual Coolify actions; do not use Vercel or infer a
release from a source push.

### 1. Scope the release and configure both Hire surfaces

- Deploy the Hire runtime/engine service first, then the Hire control service.
  Both must use the same approved source commit. The old control cannot issue a
  v6 validation handoff, so this prevents a candidate from receiving
  the new consent/flow before the engine is capable of serving it.
- Set `IPG_SURFACE=hire-engine` on runtime and `IPG_SURFACE=hire-control` on
  control. A missing or unknown value on any environment carrying Hire
  configuration is a hard 503 and performs no Inngest registration;
  never bypass that failure by treating the image as B2C.
- Set `IPG_SURFACE=b2c` explicitly on every B2C deployment that retains any
  `HIRE_*` environment variable. Before this release, inventory and update
  those manifests; blank is supported only for legacy B2C environments with
  no Hire configuration at all. Values are exact and case-sensitive—leading
  or trailing whitespace is invalid.
- Set `DEPLOYMENT_COMMIT_SHA` to the exact 40-character release commit on both
  Hire services. Short SHAs and non-hex placeholders keep health and Inngest
  fail closed.
- On the engine, set browser-facing `HIRE_CONTROL_URL` and internal
  `HIRE_CONTROL_INTERNAL_URL` to valid HTTPS control origins; neither may
  share the engine origin. Do not rely on the completion page's production
  fallback in staging or custom-origin deployments.
- On control, configure `HIRE_ACCOUNT_BRIDGE_KEY_ID` and a distinct
  `HIRE_ACCOUNT_BRIDGE_SECRET` of at least 32 characters. Missing bridge
  authority keeps readiness closed because account deletion would otherwise
  be unavailable.
- Configure `NEXT_PUBLIC_FEATURE_MULTIMODAL=true` as both a **Coolify build
  variable** and a runtime variable on the Hire engine only. It is inlined into
  the browser bundle during `next build`, so a runtime restart alone cannot
  enable it; rebuild the image from the approved commit.
- Immediately after the engine build, run `npm run check:hire-browser-build`.
  This inspects the emitted artifact, requires the compile-defined marker to
  be `true`, and rejects a health bundle that still reads either marker from
  runtime environment variables.
- Do not set that public flag to `true` on Hire control or the B2C application.
  Keep `FEATURE_FLAG_MULTIMODAL_ANALYSIS=false`; the Hire-native pipeline is
  separate from the generic consumer analysis path.
- Confirm the required server-side provider configuration exists through the
  approved secret store. Never paste, print, or retain secret values in this
  runbook, shell history, CI output, Coolify notes, or release evidence.

### 2. Prepare the isolated MongoDB indexes from a source/builder runner

The Coolify application runtime container is a standalone runtime artifact and
is not the place to run repository maintenance scripts. From an approved
source/builder runner checked out at the exact release commit, with its
environment injected securely for the target surface, run `--check`, then
`--apply` only if needed, then `--check` again:

```sh
# Candidate-workspace indexes exist only in the Hire control database. Retain
# the read-only plan and initial check output before any apply.
IPG_SURFACE=hire-control npm run prepare:hire-candidate-workspace-indexes
IPG_SURFACE=hire-control npm run check:hire-candidate-workspace-indexes

# Run only when the initial check reports missing exact indexes, then retain
# the final successful check output.
IPG_SURFACE=hire-control npm run prepare:hire-candidate-workspace-indexes -- --apply
IPG_SURFACE=hire-control npm run check:hire-candidate-workspace-indexes

IPG_SURFACE=hire-control npm run check:hire-multimodal-observation-indexes
IPG_SURFACE=hire-control npm run prepare:hire-multimodal-observation-indexes -- --apply
IPG_SURFACE=hire-control npm run check:hire-multimodal-observation-indexes

IPG_SURFACE=hire-engine npm run check:hire-multimodal-observation-indexes
IPG_SURFACE=hire-engine npm run prepare:hire-multimodal-observation-indexes -- --apply
IPG_SURFACE=hire-engine npm run check:hire-multimodal-observation-indexes
```

Run the control commands against the control database and the engine commands
against the isolated runtime database. `--apply` creates only missing exact
indexes; it must not be substituted with `syncIndexes`, `dropIndex`, or a bulk
schema migration. Retain the approved source commit, redacted target database
identity, candidate-workspace plan, initial check, any conditional apply, and
the final successful check as one release record. The CI MongoDB gate proves
the scripts against an empty ephemeral database; it does not replace this
target-control-database evidence.

### 3. Manually deploy the Hire engine first, then control

The browser-bound handoff request is a strict wire change: an old handoff page
cannot call the new exchange route, and a new page cannot call the old route.
An overlapping Coolify rollout is forbidden. The control service has an
executable runtime gate, `HIRE_HANDOFF_ISSUANCE_MODE`, with these exact states:

- `open`: ordinary candidate starts may issue handoffs.
- `draining`: every start returns `503 HANDOFF_ISSUANCE_PAUSED` before guest,
  attempt, or handoff mutation.
- `smoke`: ordinary starts remain blocked; only a request carrying the exact
  server-only `x-hire-handoff-smoke-token` may proceed. The configured token
  must contain at least 32 bytes and must never be exposed to browser code.

Authenticated `GET /api/health` reports only the redacted mode,
`publicIssuanceOpen`, and `smokeReady`; it never returns the token. A missing or
invalid production mode fails closed as `draining` and also makes deployment
configuration readiness fail.

For the first deployment of this gate and strict wire, use the zero-overlap
sequence below. If this is also the first media-object-v2 release, first
complete every pre-start freeze, legacy reconciliation, storage conformance,
and activation gate in the dedicated media-v2 cold-cutover runbook. Apply both
runbooks together and let the stricter pause/drain condition win; neither a
clean handoff drain nor a clean media scan substitutes for the other. Do not
reorder or combine these stop/start actions:

1. Configure the new control image with
   `HIRE_HANDOFF_ISSUANCE_MODE=smoke` and a newly generated
   `HIRE_HANDOFF_SMOKE_TOKEN`, but do not start it yet.
2. Stop **all** old control containers. Retain Coolify replica/process evidence
   and a timestamped probe showing the public candidate start endpoint cannot
   return `2xx`. This full stop is the initial release's fail-closed issuance
   fence because the old revision does not contain the new switch.
3. From that stop timestamp, wait at least 75 seconds: the complete 60-second
   code lifetime plus the 15-second runtime-to-control exchange timeout. Do not
   infer the interval from a build or image-pull timestamp.
4. Stop **all** old engine containers and retain zero-replica/process evidence.
   Only after zero old engines is proved may the new exact-commit engine start.
5. Start the new engine, then require authenticated health to report `healthy`,
   MongoDB/Redis `ok`, `surface:"hire-engine"`,
   `hireInterviewBuild.multimodal:true`, and the approved exact commit.
6. Start the new exact-commit control in `smoke` mode. Require authenticated
   health to report MongoDB/Redis `ok`, `surface:"hire-control"`, the same
   commit, `hireMediaObjectProtocol:
   "v2-opaque-nonce-if-none-match-zero-seal"`,
   `hireIngestionRevisionProtocol={protocolVersion:"2",mode:"required",releaseReady:true}`,
   and
   `handoffIssuance={mode:"smoke",publicIssuanceOpen:false,smokeReady:true}`.
   Also prove a normal start request still returns `503`. Do not open issuance
   if any marker is missing, stale, or `not-applicable` on the wrong surface.
7. Run the operator smoke below while public issuance remains closed. After the
   entire handoff, sign-in, lobby, and canonical interview checks pass, change
   only the control mode to `open`, restart it, and retain authenticated health
   showing `publicIssuanceOpen:true` plus a normal candidate-start success.

For later compatible releases, an already deployed control can first be moved
to `draining`; retain its authenticated health evidence and the public `503`,
then begin the same 75-second interval. For any future strict-wire change,
still require zero old engine containers before a new engine starts.

The smoke bypass does not replace normal guest authorization or CSRF. Use a
dedicated non-production candidate/round whose valid production guest cookie
and CSRF value were obtained through the ordinary consent flow. Load secrets
from the approved secret runner without printing them, then execute:

```sh
SMOKE_RESPONSE_FILE="$(mktemp)"
curl --silent --show-error --fail-with-body --request POST \
  "${HIRE_PUBLIC_URL}/api/candidate/${SMOKE_ROUND_ID}/start" \
  --header "Cookie: __Host-hire_guest=${SMOKE_GUEST_COOKIE}" \
  --header "x-hire-csrf: ${SMOKE_GUEST_CSRF}" \
  --header "x-hire-handoff-smoke-token: ${HIRE_HANDOFF_SMOKE_TOKEN}" \
  --output "${SMOKE_RESPONSE_FILE}" \
  --write-out 'status=%{http_code}\n'
```

Open the returned handoff only inside the controlled smoke browser, then
securely delete `SMOKE_RESPONSE_FILE`; it contains a one-time capability and
must not enter release logs or evidence. Retain only the status, timestamps,
redacted health result, and final flow outcome. If the smoke fails, keep
`smoke` mode in place. Once any new-wire
handoff has been issued, rollback to a pre-contract engine is forbidden; fix
forward or repeat the full fence with a compatible image. Do not replace a
failed Oracle deployment with a Vercel deployment.

### 4. Sync and prove the Hire Inngest surfaces

After the runtime deployment is healthy, trigger/confirm Inngest sync against
the runtime `/api/inngest` route. Its registered functions must include exactly
these four Hire-runtime jobs:

- `hire-runtime-feedback-recovery`
- `hire-runtime-result-publisher`
- `hire-runtime-multimodal-observation-publisher`
- `hire-runtime-multimodal-analysis-publisher`

After the control deployment is healthy, sync its `/api/inngest` route too and
confirm it includes the native full-analysis jobs alongside the existing
control jobs:

- `hire-multimodal-analysis`
- `hire-multimodal-analysis-recovery`
- `hire-candidate-bulk-operation`
- `hire-candidate-bulk-operation-recovery`

Registration alone is not delivery proof. Retain evidence of successful
runtime analysis publishing and control analysis/recovery execution in Inngest
before treating the release as live. Before allowing real recruiter bulk
actions, use a dedicated non-production job and candidates to prove both new
control jobs without retaining candidate PII:

1. Create an 11-candidate, same-stage selection and an `advance` operation
   with communication explicitly disabled. Retain only the opaque operation
   ID, timestamps, counts, and controlled outcome codes.
2. Prove one `hire-candidate-bulk-operation` run processes no more than its
   ten-row page, emits the continuation, and a later run settles the remaining
   row. The terminal operation total must equal succeeded + conflict + failed.
3. For a separate small smoke operation, pause only the requested-operation
   function before submission. Because the durable operation is immediately
   recovery-due, prove the next
   `hire-candidate-bulk-operation-recovery` cron finds and dispatches it; then
   resume the requested-operation function and prove terminal settlement.
4. Unpause both functions, confirm no smoke operation remains queued or
   processing, and retain the redacted Inngest run links plus terminal counts.

Never sync an unhealthy Hire `/api/inngest` endpoint. Static readiness
failures return 503 without invoking the Inngest serving adapter, preventing a
missing or mismatched app ID from replacing another deployment's registration.

### 5. Run the authenticated Hire smoke

- Authenticate to both Coolify services' health endpoints and retain the
  healthy dependency state and exact deployed commit.
- Complete a canonical Hire candidate flow using the current v6 consent. Prove
  the camera/microphone gate, full-screen entry, entire-display selection,
  camera and screen recording transfer, and timestamped validation events in
  the HR detail view. Check that live coaching is absent, the Indian
  interviewer voice is selected, and the native multimodal path is active only
  after that consent.
- Run an authenticated Hire TTS turn and verify the response header
  `X-TTS-Provider: sarvam`. A Deepgram fallback, a missing header, or an
  unauthenticated health result is a release failure until corrected.
- In the Hire control browser, open a dedicated job and prove Overview,
  Candidates, Screening, Decisions, and Performance are distinct routes.
  On Candidates, prove the server never returns more than 50 rows, next/back
  cursor navigation preserves filters/sort/view in the URL, a candidate detail
  opens and returns to the exact list state, and the table/mobile presentations
  expose rank, human recommendation/scorecard state, stage, and selection
  state. Repeat the critical flow at desktop, mobile, keyboard-only, and 200%
  zoom with no console errors.
- On Screening, use a job large enough to cross the 50-row preview boundary.
  Prove Selected, All evaluated, Score attention, and Known knockouts navigate
  through replace-in-place server pages; an out-of-page cut line still names
  the correct candidate; and rapid rule/page changes never show an older
  response. Search for an exception candidate without loading the cohort.
  Confirm that gate history, older invitation waves, and each delivery ledger
  have independent next/back navigation and never mount more than their page
  limits (50 preview rows, 25 history/waves, 50 recipients).

### 6. Candidate-workspace failure and rollback

The candidate-workspace indexes are additive and its operation ledgers are
durable. There is no database rollback switch, and dropping indexes or deleting
operation rows during an incident is forbidden.

- If no candidate bulk operation has ever been created, the Hire control image
  may be rolled back to the prior approved commit and re-synced in Inngest.
  Leave the additive indexes in place; they are inert for the older image.
- If any operation is queued, processing, or partially settled, pause both new
  Inngest functions and prevent recruiter access to the candidate-workspace
  mutation routes. If a route-scoped ingress rule is unavailable, put the Hire
  control service into maintenance rather than allowing new operations.
- Retain each affected opaque operation ID and terminal counters. Never replay
  individual stage writes manually or change ledger rows. Reconcile partial
  results through the operation status API, then fix forward with the same
  commit or a compatible newer control image and let the recovery job resume
  idempotently.
- A control-only candidate-workspace incident does not justify rolling back the
  Hire engine. After recovery, repeat the exact index check, sync both function
  IDs, prove requested-page and recovery delivery, re-run the authenticated
  browser smoke, and only then restore recruiter access.

## Historical Vercel-to-Oracle cutover record (superseded)

The sections below preserve the 2026-08 pre-cutover plan and evidence. They do
not describe the current production origin, deployment method, or rollback
target.

## Historical cutover invariants (superseded)

- Do not cancel Vercel, Atlas, or the managed Redis service before every
  cutover gate below has retained evidence.
- Never let Vercel and Oracle act as independent writable production origins.
- A DNS rollback after Oracle has accepted writes requires a write freeze and
  data reconciliation back to the rollback database first.
- Never place credentials in this runbook, chat, shell history, Docker build
  context, Git, CMS notes, or deployment evidence.
- Preserve apex-to-`www` behavior and route all current production hosts
  (`www`, `cms`, `hire`, `learn`, `resume`, and `saas`) through the
  same application with their original Host headers.
- Production MongoDB must be a replica set or sharded cluster. Current billing,
  entitlement, deletion, financial-ledger, and Jobs code uses Mongo
  transactions and cannot run correctly on standalone MongoDB.
- Redis contains rate-limit and quota authority, not disposable cache data. It
  must have a persistent volume, AOF persistence, restart continuity, and a
  `noeviction` policy.

## Historical pre-cutover evidence (superseded)

The entries in this table were captured before production moved to Oracle and
must not be used as live deployment status.

| Area | Current evidence | State |
| --- | --- | --- |
| Oracle app | `staging.interviewprep.guru` serves the app through Cloudflare | Partial |
| Oracle CMS | `cms.staging.interviewprep.guru` reaches the Oracle origin and redirects unauthenticated users to sign-in | Partial |
| Inngest route | Staging `GET /api/inngest` reports cloud mode, both keys present, and 26 functions | Registration only; delivery unproven |
| Oracle health | Public `GET /api/health` returns 200 but intentionally hides dependency state | Insufficient |
| Public app parity | The 2026-08-05 anonymous Playwright baseline passed 48 checks on Oracle staging; the seven failures reproduced identically on Vercel production and one test was skipped | No Oracle-specific public-page regression found; not a full acceptance gate |
| Staging hostname parity | `staging` and `cms.staging` have working TLS; `hire.staging`, `learn.staging`, `resume.staging`, and `saas.staging` have no public DNS and return Traefik 503 when forced to the Oracle origin | Blocker |
| Oracle network boundary | External probes find only SSH, HTTP, and HTTPS reachable; app `3000`, MongoDB `27017`, Redis `6379`, and common admin ports are closed or filtered | Pass from public Internet |
| Production origin | `www.interviewprep.guru` still returns Vercel headers | Not cut over |
| Mongo topology | Earlier Oracle worksheet records standalone MongoDB | Blocker |
| Redis durability | Reachability was previously claimed; AOF/no-eviction/restart continuity is not retained | Blocker |
| Data | An Atlas-to-Oracle copy and restore drill were recorded on 2026-07-17 | Stale; final sync required |
| Deployment identity | Main supports authenticated health plus exact commit identity; no completed protected staging gate exists | Blocker |
| Monitoring/backup | Mongo logical backup was tested; OCI alarms and Coolify control-plane restore are unproven | Blocker |
| Local environment recovery | Razorpay accepted both locally stored Test and Live key pairs through a read-only plans API request; webhook secrets remain unverified | Partial |
| Razorpay plans | Test and Live each contain exactly one INR monthly plan at ₹599 and exactly one at ₹999 | Pass |
| Staging billing catalog | `GET /api/billing/catalog` returns 503 with `Retry-After: 5`; that header identifies the fail-closed billing rate-limit precheck, before catalog lookup. The local rate-limit HMAC is valid, leaving deployed-variable absence/mismatch or Redis `EVAL` failure | Blocker |
| Staging environment manifest | The local `.env.staging` contains placeholder Mongo/Redis and six other configuration values, reuses the Vercel Production NextAuth secret, and lacks `HEALTH_CHECK_TOKEN`, `DEPLOYMENT_COMMIT_SHA`, and `INNGEST_APP_ID` | Not deployable as-is |
| Release artifact | Node 24 production build succeeds; the standalone server returns public liveness 200 and dependency readiness 503 when Mongo/Redis are absent | Application artifact pass; Docker image build still unverified |
| Combined release candidate | PR #601 head `5286a4beda417e2d2431b232f90b5c841d59b6ee` accepts all Oracle-readiness commits without conflict; 45 focused health/coupon tests and the Node 24 production build pass | Local-only pass; not pushed or deployed |

The full Playwright workflow is not read-only. Its Jobs flow inserts anonymous
`ProductEvent` rows, consumes Redis rate-limit counters, and rendered pages may
emit GA/PostHog events. Do not dispatch it again until the deployed staging
MongoDB, Redis, and analytics destinations are proven isolated. Use the
GET-only `e2e/auth-api.spec.ts` subset for low-side-effect reachability checks.

## Oracle environment manifest

Export values from their original password-manager/provider source. A Vercel
variable marked Sensitive is write-only and cannot be used to visually confirm
the original value; overwrite from the known source or rotate it.

Change for Oracle:

- `MONGODB_URI`: Oracle internal replica-set URI with the correct database,
  auth source, and `replicaSet=rs0`.
- `REDIS_URL`: Oracle internal durable Redis URI.
- `NEXTAUTH_URL`, `APP_URL`, `NEXT_PUBLIC_ROOT_DOMAIN`, and
  `NEXT_PUBLIC_SITE_URL`: canonical production hostnames.
- `INNGEST_APP_ID`: explicit and distinct for staging and production.
- `HEALTH_CHECK_TOKEN`: newly generated independently per environment.
- `DEPLOYMENT_COMMIT_SHA=$SOURCE_COMMIT`,
  `BILLING_ROLLOUT_COMMIT_SHA=$SOURCE_COMMIT`, and a stable
  `BILLING_ROLLOUT_DEPLOYMENT_ID`: self-hosted deployment identity.
- On Hire control, `HIRE_HANDOFF_ISSUANCE_MODE`: explicit `open`, `draining`,
  or `smoke`; absence is a production readiness failure and request-path
  issuance fails closed. Configure `HIRE_HANDOFF_SMOKE_TOKEN` from the secret
  store before using `smoke` mode; never expose it as a `NEXT_PUBLIC_*` value.

Copy and verify from the provider/source of truth:

- Core authentication: `NEXTAUTH_SECRET`. Do not infer it from a masked or
  write-only deployment value; recover the approved source value or rotate it
  as a coordinated session-invalidating change.
- AI/speech: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `GROQ_API_KEY`, `GOOGLE_AI_API_KEY`, `DEEPGRAM_API_KEY`,
  `DEEPGRAM_GRANT_API_KEY` (server-only; mints 30-second browser STT grants),
  `DEEPGRAM_TTS_MODEL`, and `SARVAM_API_KEY` (Indian interviewer voice —
  replaced the retired `AZURE_SPEECH_*` trio on 2026-08-09, see
  INTERVIEW_FLOW.md §8; optional overrides `SARVAM_TTS_SPEAKER`,
  `SARVAM_TTS_MODEL_ID`). Omitting `SARVAM_API_KEY` makes the default
  Indian voice silently serve the US Deepgram voice — the routes log it at
  ERROR and stamp `X-TTS-Provider` on responses; verify `sarvam` appears
  there post-cutover.
- OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`,
  and `GITHUB_CLIENT_SECRET`.
- Inngest/email/jobs: `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`,
  `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TOKEN_SECRET`, optional
  `EMAIL_TOKEN_SECRET_PREVIOUS`, and `RAPIDAPI_KEY`.
- R2: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and
  `REPLAY_RECORDING_RETENTION_DAYS`.
- Analytics/QA build and runtime values: `NEXT_PUBLIC_GA_MEASUREMENT_ID`,
  `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`,
  `QA_AUTOMATION_ENABLED`, `QA_AUTOMATION_SECRET`, and
  `QA_AUTOMATION_EMAIL`. Keep QA automation disabled in production unless its
  complete access-control contract is intentionally approved.
- Public build flags: `NEXT_PUBLIC_FEATURE_MULTIMODAL`,
  `NEXT_PUBLIC_FEATURE_PRIVACY_MODE`, `NEXT_PUBLIC_FEATURE_VOICE_PICKER`,
  `NEXT_PUBLIC_FEATURE_ADAPTIVE_GRACE`, and
  `NEXT_PUBLIC_DEBUG_DEEPGRAM_PACKETS`. These must be present during the
  Coolify image build, not only at container runtime.
- Runtime tuning: `LOG_LEVEL`, `SCORING_V2_CLAUDE_WEIGHT`,
  `SCORING_V2_FORMULA_WEIGHT`, `SCORING_V2_DISAGREEMENT_THRESHOLD`,
  `SCORING_V2_DISAGREE_CLAUDE_WEIGHT`, and
  `SCORING_V2_DISAGREE_FORMULA_WEIGHT` when explicitly configured.
- Preserve every explicitly configured `FEATURE_FLAG_*` value, including
  deliberate `false` overrides; absence is not assumed equivalent to parity.
  The current dynamic registry can read:
  `FEATURE_FLAG_PERSONALIZATION_ENGINE`,
  `FEATURE_FLAG_EVALUATION_ENGINE_V2`, `FEATURE_FLAG_PATHWAY_PLANNER`,
  `FEATURE_FLAG_COMPETENCY_TRACKING`, `FEATURE_FLAG_WEAKNESS_CLUSTERS`,
  `FEATURE_FLAG_SESSION_SUMMARIES`, `FEATURE_FLAG_QUESTION_BANK_RAG`,
  `FEATURE_FLAG_COMPANY_PATTERNS_RAG`, `FEATURE_FLAG_BENCHMARK_HARNESS`,
  `FEATURE_FLAG_ADAPTIVE_DIFFICULTY`, `FEATURE_FLAG_RUBRIC_REGISTRY`,
  `FEATURE_FLAG_RESUME_TO_INTERVIEW`,
  `FEATURE_FLAG_JD_STRUCTURED_PARSING`,
  `FEATURE_FLAG_RESUME_STRUCTURED_PARSING`,
  `FEATURE_FLAG_INTERVIEWER_PERSONAS`,
  `FEATURE_FLAG_SPACED_REPETITION`, `FEATURE_FLAG_ENGAGEMENT_XP`,
  `FEATURE_FLAG_ENGAGEMENT_BADGES`, `FEATURE_FLAG_ENGAGEMENT_STREAKS_V2`,
  `FEATURE_FLAG_ENGAGEMENT_DAILY_CHALLENGE`,
  `FEATURE_FLAG_MULTIMODAL_ANALYSIS`, `FEATURE_FLAG_COMPANY_GUIDES`,
  `FEATURE_FLAG_COACH_MODE`, `FEATURE_FLAG_LIVE_CODING`,
  `FEATURE_FLAG_EMBEDDING_SEARCH`, `FEATURE_FLAG_MONTHLY_PLAN`,
  `FEATURE_FLAG_RESEARCH_COMPARISON`, `FEATURE_FLAG_SESSION_CONFIG_CACHE`,
  `FEATURE_FLAG_INTERVIEW_FLOW_TEMPLATES`, `FEATURE_FLAG_JD_FLOW_OVERLAY`,
  `FEATURE_FLAG_SCORE_TELEMETRY`,
  `FEATURE_FLAG_SKIP_CONNECTDB_WHEN_CACHED`, and
  `FEATURE_FLAG_GROUNDED_FOLLOWUPS`.

Before enabling billing, provision and validate the complete mode-specific
payment set. Production currently has no Razorpay Live/payment-security
manifest in Vercel, so Preview/Test values are not a production source:

- `RAZORPAY_TEST_KEY_ID`, `RAZORPAY_TEST_KEY_SECRET`,
  `RAZORPAY_TEST_WEBHOOK_SECRET`, and optional
  `RAZORPAY_TEST_WEBHOOK_PREVIOUS_SECRET`;
- `RAZORPAY_LIVE_KEY_ID`, `RAZORPAY_LIVE_KEY_SECRET`,
  `RAZORPAY_LIVE_WEBHOOK_SECRET`, and optional
  `RAZORPAY_LIVE_WEBHOOK_PREVIOUS_SECRET`;
- `BILLING_RATE_LIMIT_HMAC_SECRET_BASE64`,
  `BILLING_ROLLOUT_AUTHORITY_HMAC_V1_SECRET_BASE64`,
  `BILLING_ROLLOUT_CMS_CSRF_HMAC_V1_SECRET_BASE64`, and
  `BILLING_ROLLOUT_SEED_ID`;
- `PAYMENT_COMMERCIAL_ANALYTICS_HMAC_V1_SECRET_BASE64`,
  `PAYMENT_WEBHOOK_PAYLOAD_KEY_BASE64`,
  `PAYMENT_WEBHOOK_PAYLOAD_KEY_VERSION`, and the rotation pair
  `PAYMENT_WEBHOOK_PAYLOAD_PREVIOUS_KEY_BASE64` plus
  `PAYMENT_WEBHOOK_PAYLOAD_PREVIOUS_KEY_VERSION` when configured;
- `PR8_INTERVIEW_AUTHORITY_HMAC_V1_SECRET_BASE64` and every other exact
  payment authority name reported by the deployed revision's configuration
  validator. Do not invent or copy obsolete names from an older deployment.

Do **not** copy `VERCEL`, `VERCEL_URL`, `VERCEL_DEPLOYMENT_ID`,
`VERCEL_GIT_COMMIT_SHA`, `VERCEL_REGION`, or `VERCEL_OIDC_TOKEN`.
Oracle must not pretend to be a Vercel request path, particularly for trusted
client-IP handling. Keep `NEXT_PUBLIC_ENABLE_SPEED_INSIGHTS` unset on Oracle;
otherwise the application attempts to enable a Vercel-specific client.

## Historical Gate A — harden the existing Oracle stack (superseded)

### A1. Preserve access and recovery

- Confirm the tenancy is PAYG and retain the current service-limit/support
  answer for the 4 OCPU / 24 GB A1 VM.
- Confirm the VM public address is **reserved**, not ephemeral.
- Store OCI owner recovery, the VM SSH private key, Coolify owner recovery,
  Coolify `APP_KEY`, and all Coolify SSH keys in the founder password manager.
- Back up the Coolify database, `/data/coolify/source/.env`, and
  `/data/coolify/ssh/keys` off-host; perform a restore drill.
- Keep the daily logical Mongo backup to R2 and add an OCI boot-volume backup
  policy. These are complementary, not substitutes.
- Configure OCI budget alerts and two founder-reachable notification channels.

Evidence: screenshots/exports showing PAYG, reserved IP, backup policy, a
successful Coolify restore, and received test notifications.

### A2. Convert MongoDB before testing checkout

Use a maintenance window and take a fresh logical backup of both application
databases before changing topology.

1. Pause Inngest schedules and any operator-triggered Jobs/billing work.
2. Configure the Coolify Mongo service with a stable internal hostname,
   authentication keyfile, persistent volume, and replica-set name `rs0`.
3. Restart Mongo and initiate the single-member replica set using that same
   internal hostname.
4. Wait until the member is PRIMARY.
5. Update the app URI to select the intended database and include
   `replicaSet=rs0`; do not expose Mongo publicly.
6. Redeploy staging and retain:
   - `db.adminCommand({ hello: 1 })` showing a set name and writable primary;
   - a successful transaction-capability probe;
   - the existing Jobs source-control replica-set smoke against staging-only
     temporary collections;
   - a subscription quote and checkout-intent creation that no longer fails on
     transaction topology.
7. Resume background work only after all database and index gates pass.

Do not use the repository's generic `docker-compose.yml` as the production
Coolify definition; it is a local-development stack and does not encode this
topology.

### A3. Make Redis authoritative and recoverable

Retain read-only output for:

- `INFO persistence`;
- `CONFIG GET appendonly`;
- `CONFIG GET appendfsync`;
- `CONFIG GET maxmemory-policy`;
- the mounted persistent-volume path and capacity.

Required state is AOF enabled, an approved fsync policy, `noeviction`, and a
persistent volume. Write a staging canary key with a short non-production name,
restart Redis through Coolify, and prove the value survives. Then run the
application's real atomic quota/rate-limit smoke; `PING` alone is insufficient.

### A4. Make deployment readiness truthful

Deploy the Oracle-readiness patch before cutover:

- Docker excludes every `.env*` file and `.vercel` metadata from its context.
- Docker probes `127.0.0.1`, not `localhost`.
- `HEAD /api/health` returns 200 only when MongoDB and Redis are reachable.

In Coolify, configure a unique `HEALTH_CHECK_TOKEN` and
`DEPLOYMENT_COMMIT_SHA=$SOURCE_COMMIT`. Store the same health token only in
the protected GitHub `jobs-staging` environment. The authenticated response
must report:

- HTTP 200;
- `status: healthy`;
- MongoDB and Redis both `ok`;
- `releaseGateAuthenticated: true`;
- the exact 40-character commit deployed.

Deliberately stop each staging dependency one at a time and prove readiness
becomes 503/unhealthy. Restore it and prove recovery. Verify the Coolify GitHub
App webhook with a recent successful delivery; do not use SSH/manual deploys in
parallel with automatic rollout.

### A5. Monitoring, TLS, and origin recovery

- Enable Oracle Cloud Agent metrics and OCI alarms for instance health, metric
  absence, sustained CPU/load/memory, disk I/O, and network anomalies.
- Configure Coolify notifications for disk usage, unreachable server,
  stopped/restarted containers, failed deployments, and failed backups.
- Add independent HTTPS uptime checks for app, CMS, and authenticated
  dependency health.
- Add the future production app/CMS hostnames in Coolify and verify valid
  origin certificates before Cloudflare Full (strict).
- Configure an immutable Cloudflare cache rule for content-hashed
  `/_next/static/*` assets and prove an in-flight browser can still load old
  chunks across a rolling deploy.
- Exercise the longest Inngest step through the real public route. Cloudflare's
  proxied origin read timeout is shorter than the route's 300-second allowance;
  if the canary cannot complete reliably, move execution to Inngest Connect (the
  container-oriented outbound worker mode) before cutover instead of accepting
  intermittent 524 responses.
- Test alert delivery to both founder channels.

## Historical Gate B — Oracle staging acceptance (superseded)

Every item requires retained output, a timestamp, and the exact deployed commit.

- Sign-up/sign-in/sign-out and both OAuth providers.
- CMS authentication and a safe read-only CMS page.
- One real 20–30 minute interview covering Deepgram STT, TTS, LLM turns,
  feedback, analysis, pathway generation, and resume PDF.
- Direct and multipart R2 upload, retry/replay, playback, and retention.
- Inngest registration **and delivered terminal executions** for a canary event,
  analysis, and a paused Jobs Validate operation.
- Razorpay Test signed webhook delivery plus test subscription checkout,
  verification, activation, cancellation, and idempotent replay.
- Redis atomic quota/rate-limit behavior and restart continuity.
- Deploy the same commit while an interview and an Inngest job are active;
  confirm the old container drains and the sessions finish.
- Compare critical response/error latency with current production.

## Historical Gate C — controlled production cutover (superseded)

1. Announce and begin the write freeze. Pause Inngest schedules, Jobs sources,
   billing checkout, and all other write paths that cannot be reconciled.
2. Snapshot current Vercel/Cloudflare DNS values and TTLs.
3. Take final Atlas and managed-Redis exports.
4. Perform the final Atlas-to-Oracle logical sync for both application
   databases. Reconcile collection counts, document counts, indexes, and
   migration-specific invariants.
5. Configure the Oracle production app with production URLs and the complete
   encrypted environment inventory. Keep staging and production Inngest app IDs
   distinct.
6. Add apex, `www`, `cms`, `hire`, `learn`, `resume`, and `saas`
   production domains in Coolify and prove certificates, Host-based middleware,
   and apex-to-`www` routing before the DNS change.
7. Update and verify Inngest sync, Razorpay live webhook, Google/GitHub OAuth
   callbacks, R2 CORS, and Resend links against the production hostname.
8. Change Cloudflare proxied DNS records to the reserved Oracle IP.
9. Run the production smoke: auth, pricing, checkout, webhook, one short
   interview, feedback/analysis, R2 playback, PDF, CMS, and background job.
10. Resume writes and schedules in controlled order, observing logs, metrics,
    database state, and provider dashboards.

## Historical rollback (superseded)

- Before Oracle accepts writes: restore the recorded Cloudflare records to
  Vercel and verify Vercel health.
- After Oracle accepts any writes: freeze again, stop background deliveries,
  reconcile/reverse-sync authoritative Oracle Mongo data to Atlas, verify the
  target, then restore DNS to Vercel. A DNS-only rollback is forbidden.
- Preserve provider webhook delivery IDs and replay only through their normal
  idempotent endpoints after the selected origin is authoritative.

## Historical Gate D — decommission Vercel (superseded)

Keep Vercel and its old data services available for at least 48 hours after a
clean cutover, preferably through a full business/billing cycle. Then:

1. archive final Vercel environment names and encrypted values outside Vercel;
2. retain final Atlas/Redis exports and restore evidence;
3. prove production domains, callbacks, jobs, storage, backups, monitoring, and
   billing have no Vercel dependency;
4. remove Vercel-only configuration and Speed Insights in a separate reviewed
   change;
5. remove domains/webhooks from Vercel;
6. cancel Vercel, Atlas, and managed Redis only after founder sign-off.

Completion means Oracle is the only writable production origin, all acceptance
and recovery gates have retained evidence, the rollback window has passed, and
Vercel can disappear without changing user-visible behavior or losing data.

## Primary references

- [OCI public IP management](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm)
- [OCI boot-volume backups](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/bootvolumebackups.htm)
- [OCI monitoring agent](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/enablingmonitoring.htm)
- [OCI budgets](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm)
- [Coolify health checks](https://coolify.io/docs/knowledge-base/health-checks)
- [Coolify rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates)
- [Coolify backup and restore](https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify)
- [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
- [Cloudflare proxy read timeout](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)
- [Inngest serving modes](https://www.inngest.com/docs/learn/serving-inngest-functions)
- [Inngest Connect](https://www.inngest.com/docs/improve-performance)
