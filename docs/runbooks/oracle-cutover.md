# Oracle cutover runbook

Status: **pre-cutover; production is still on Vercel**

Last audited: 2026-08-05 against `origin/main`
`5fc149a4b65d00318ed2bfb4e8063ce71f31c327`.

This is the operational source of truth for moving InterviewPrepGuru from
Vercel to the existing Oracle Cloud Mumbai A1 VM managed by Coolify. It keeps
Cloudflare DNS/R2, Inngest Cloud, Razorpay, OAuth, Resend, and the AI providers
as external services.

## Non-negotiable invariants

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

## Current evidence

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
| Staging environment manifest | The local `.env.staging` contains placeholder Mongo/Redis and six other configuration values, reuses the Vercel Production NextAuth secret, and lacks `HEALTH_CHECK_TOKEN`, `DEPLOYMENT_COMMIT_SHA`, and `INNGEST_APP_ID` | Not deployable as-is |
| Release artifact | Node 24 production build succeeds; the standalone server returns public liveness 200 and dependency readiness 503 when Mongo/Redis are absent | Application artifact pass; Docker image build still unverified |

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

Copy and verify from the provider/source of truth:

- AI/speech: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`,
  `GOOGLE_AI_API_KEY`, `DEEPGRAM_API_KEY`, `AZURE_SPEECH_KEY`,
  `AZURE_SPEECH_REGION`, and `AZURE_SPEECH_VOICE`.
- OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`,
  and `GITHUB_CLIENT_SECRET`.
- Inngest/email/jobs: `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`,
  `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TOKEN_SECRET`, and
  `RAPIDAPI_KEY`.
- R2: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and
  `REPLAY_RECORDING_RETENTION_DAYS`.
- Analytics/QA and all intentionally enabled feature flags.

Before enabling billing, provision and validate the complete mode-specific
payment set. Production currently has no Razorpay Live/payment-security
manifest in Vercel, so Preview/Test values are not a production source:

- `RAZORPAY_TEST_KEY_ID`, `RAZORPAY_TEST_KEY_SECRET`,
  `RAZORPAY_TEST_WEBHOOK_SECRET`, and optional previous webhook secret;
- `RAZORPAY_LIVE_KEY_ID`, `RAZORPAY_LIVE_KEY_SECRET`,
  `RAZORPAY_LIVE_WEBHOOK_SECRET`, and optional previous webhook secret;
- `BILLING_RATE_LIMIT_HMAC_SECRET_BASE64`,
  `BILLING_ROLLOUT_AUTHORITY_HMAC_V1_SECRET_BASE64`,
  `BILLING_ROLLOUT_CMS_CSRF_HMAC_V1_SECRET_BASE64`, and
  `BILLING_ROLLOUT_SEED_ID`;
- `PAYMENT_COMMERCIAL_ANALYTICS_HMAC_V1_SECRET_BASE64`,
  `PAYMENT_WEBHOOK_PAYLOAD_KEY_BASE64`,
  `PAYMENT_WEBHOOK_PAYLOAD_KEY_VERSION`, and any configured previous payload
  key/version;
- the customer-communication, tier-operation cursor, financial-document, and
  interview-authority HMAC/key variables referenced by the deployed revision.

Do **not** copy `VERCEL`, `VERCEL_URL`, `VERCEL_DEPLOYMENT_ID`,
`VERCEL_GIT_COMMIT_SHA`, `VERCEL_REGION`, or `VERCEL_OIDC_TOKEN`.
Oracle must not pretend to be a Vercel request path, particularly for trusted
client-IP handling.

## Gate A — harden the existing Oracle stack

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

## Gate B — Oracle staging acceptance

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

## Gate C — controlled production cutover

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

## Rollback

- Before Oracle accepts writes: restore the recorded Cloudflare records to
  Vercel and verify Vercel health.
- After Oracle accepts any writes: freeze again, stop background deliveries,
  reconcile/reverse-sync authoritative Oracle Mongo data to Atlas, verify the
  target, then restore DNS to Vercel. A DNS-only rollback is forbidden.
- Preserve provider webhook delivery IDs and replay only through their normal
  idempotent endpoints after the selected origin is authoritative.

## Gate D — decommission Vercel

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
