# IPG Hire — Phase 1 (The Spine) checklist

Plan of record: [ipg-hire-build-plan.md](./ipg-hire-build-plan.md) · Phase 1 §"The Spine".
Status legend: `[x]` implemented + covered by automated verification · `[ ]` open · `[P]` blocked on a prod action (auth is prod-only — see "Prod demo script").

## Ships (build plan §Phase 1)

- [x] **Workspace + direct member add** — `modules/hire` (HireWorkspace / HireWorkspaceMember), `/workspace` UI, admin-only add/remove, flat permissions (one admin, identical members). Members are added by name + email with **lazy account linking** on first sign-in (no invite flow, no pre-minted User rows — see "Deviations").
- [x] **Create job → JD builder** — title + pasted JD (`/workspace/jobs`); the JD grounds AI-round question generation and jd_match scoring. (The richer generate/parse/upload JD tooling exists in the engine and can be attached later without schema changes.)
- [x] **Add candidates manually** — workspace talent pool (`/workspace/candidates`) + add-directly-to-job from the pipeline board; per-workspace email dedupe.
- [x] **Send AI interview → emailed link with consent screen** — `POST /applications/[id]/rounds` creates a HireRound (32-byte token, sha256 at rest, 7-day expiry, revocable), emails the invite (Resend), and the guest surface `/candidate/[roundId]` is a **magic link**: consent + recording disclosure → straight into the engine's own lobby/room flow. No OTP, no account, no password — `POST /begin` records consent server-side (no ticket can exist without it) and mints a **per-round synthetic guest identity** (`round-<id>@guests.interviewprep.internal`), so the candidate's real email never enters the B2C users table and round↔session attribution is exact by userId. Founder decision (2026-08-09): link possession = authentication (industry-standard for this product class); the invite email tells candidates not to forward it.
- [x] **Evidence-linked results on the candidate card** — `/workspace/applications/[appId]`: decision-first header (AI score · pass probability · confidence), dimension bars, per-question accordion with the actual question, the candidate's answer, and the four per-answer dimension scores + flags; red flags; answered-of-planned + end reason. Results snapshot is keyed to the round (`HireRound.results`), populated by read-time reconciliation.
- [x] **Advance / Reject with actor recorded; close job with required decision note** — fixed pipeline New → Screened → Interviewing → Shortlist → Offer → Hired/Rejected; every move appends `{actor, from, to, note?, at}` to the application's event log; Hired requires a decision note; job close requires a decision note; stage races surface as 409, never silent double-moves.

## Done when (build plan §Phase 1)

- [P] **One real job goes created → candidates AI-interviewed → decision → closed, entirely in-tool** — code-complete; the live run needs prod (see script below).
- [P] **This spine is the live demo for the prospect company** — demo script below.

## Goal DoD items covered in this phase

- **Item 2 — engine untouched, three seams only, zero B2C writes:**
  - `git diff main --stat` contains **no file** under `modules/interview/`, `app/interview/`, `app/lobby/`, `app/api/interviews/`, or any hot-path file. Middleware gained two public-path allowlist entries only.
  - Seam 1 (session provisioning): the guest enters the engine's own public flow; the prepare page writes `INTERVIEW_CONFIG` exactly as the engine's setup form does. Contract pinned by `modules/hire/__tests__/guestFlowContract.test.ts` (CreateSessionSchema accepts the guest config; storage keys pinned; depth allowed at all bands).
  - Seam 2 (completion event): `roundLinkService` reconciles read-only (guestUserId + preparedAt window + role + jdHash, atomic first-claim via unique sparse `sessionId` index). **See "Flagged: first-class engine seam" below.**
  - Seam 3 (guest auth): v1's `otpService` + `inviteTicketService` + `invite-otp` NextAuth provider reused verbatim; the only B2C write in the whole flow is the find-or-create guest User inside the seam route (v1 parity), asserted by tests.
  - Regression proof: full suite green (8091-test baseline + 75 new), production build clean.
- **Item 3 — cross-tenant isolation:** every hire schema requires an immutable `workspaceId` (asserted on the real schemas); every service query threads `ctx.workspace._id` (asserted per-function via mock-filter inspection); guest links are hashed-at-rest, expiring, revocable, single-candidate (round-scoped) — all tested in `modules/hire/__tests__/`.
- **Item 5 — consent + actor recording:** consent version + timestamp + user agent recorded on the round; OTP refuses pre-consent (route + service level, tested); every stage move records actor + timestamp (tested).

## Deviations from the plan (need founder sign-off)

1. **"Password on first sign-in" for members** — no password auth exists in the codebase at all (registration is a 410 tombstone; providers are Google/GitHub OAuth + the invite-otp ticket). Phase 1 ships: admin adds member by email → membership links automatically on the member's first **OAuth** sign-in with that email. Building a password provider is a new auth surface — deliberately not smuggled into Phase 1.
2. **Member UI lives at `/workspace/*`, not the `hire.` subdomain yet** — the `hire.*` rewrite currently serves the v1 org-based product and gates on recruiter-role JWTs, which v2's flat model doesn't use. Switching the subdomain rewrite target to `/workspace` is a 2-line middleware change staged for when v2 reaches parity (Phase 2/3); v1 remains untouched and working meanwhile.
3. **Fixed AI-round shape** — depth `behavioral` (the catalog has no dedicated 'screening' depth), duration 15 min, experience band chosen at send time. Matches "fixed over configurable".

## Adversarial review outcome (17-agent pass over the PR diff)

13 findings survived adversarial verification; the material ones are fixed on the branch:

- **Fixed (was P1) — cross-tenant session claim:** the reconciliation match key is now unique **per round**: the provisioned JD embeds a `[Interview reference: HR-<roundId>]` line and the round stores the full immutable `jdSnapshot` (also killing the "JD edited after send breaks matching" edge — prepare serves the snapshot, never live `jdText`).
- **Fixed (was P1/P2) — title/engine contract break:** job titles are capped at the engine's 100-char role limit at authoring time and defensively clamped at send; boundary pinned in the contract suite.
- **Fixed (was P2) — invisible retakes:** every engine session a round's config produced is counted (`attemptCount`) at reconcile; the card shows "started N times — scores are from the first completed run" (claims are oldest-completed-first, the anti-gaming order).
- **Fixed (was P2/P3) — duplicate-live-round race:** a partial unique index (`{workspaceId, applicationId, live:true}`) enforces one live AI round per application at the database, not just in app code.
- **Fixed (P3s):** invite links now hard-expire 14 days after token expiry even mid-flow; the expired-link auto-supersede writes an `ai_round_revoked` audit event; a failed ticket sign-in returns the guest to the OTP form with a retry message instead of stranding them on the B2C sign-in page.

**Known limitations (documented, deliberate for Phase 1):**
- `createWorkspace` / membership linking are check-then-create; a user double-submitting can in theory create two workspaces (recoverable, no data risk). One-membership-per-user is the Phase 1 rule; a person added to two workspaces by email links to the earliest row.
- A guest exercising account deletion (GDPR) removes their engine sessions; an unreconciled round then stays "awaiting results" — correct privacy behavior, surfaced not silent.

## Flagged: first-class engine seam (guardrail: not touched)

A deterministic, event-driven seam needs three **additive engine-file changes** (the exact pattern the Jobs feature used): a hire-handoff branch in `app/api/interviews/route.ts` + `CreateSessionSchema` (stamp verified hire attribution at create), and a completion hook (or Inngest event) in the `PATCH /api/interviews/[id]` path. Per the goal guardrail these were **not** made. The read-time reconciliation implemented instead is encapsulated in ONE file (`modules/hire/services/roundLinkService.ts`) so swapping to the first-class seam later is a one-file replacement. Residual risk of the reconciliation approach: linkage requires the member to open the card (no push), and a candidate with two live rounds carrying byte-identical JD+title could claim in arrival order (surfaced, never silent).

## Prod demo script (founder — ~15 min, after merge + deploy)

1. Sign in at www.interviewprep.guru → visit `/workspace` → create workspace ("Acme").
2. Jobs → New job → real title + real JD (≥50 chars).
3. Open the job → Add candidate (your own second email) → candidate appears in "New".
4. View card → Send AI interview (pick experience) → confirm email arrives (or copy the invite URL from the success banner).
5. Open the invite link (incognito): verify the **consent screen appears first**, OTP arrives by email, sign-in lands on "Setting up your interview…" → engine lobby → complete the short interview.
6. Back as the member: open the candidate card → results appear (reconciliation runs on card load; if the report is still generating, the per-answer scores show with a "report pending" note — reload after the feedback page finishes).
7. Advance the candidate stage by stage → Hired (decision note required) → close the job (decision note required) → check the History timeline shows every actor + timestamp.
8. Regression spot-check: run one normal B2C mock interview end-to-end to confirm the core product is untouched.

## Verification record

- `modules/hire`: 14 source files / 1,750 LOC (budget 45 / 10k, ADR 0028).
- New automated coverage: 75 tests across 7 suites (workspace, pipeline, aiRound, roundLink, tenant isolation, guest-flow contract, guest routes).
- Full suite, ESLint, `tsc --noEmit`, `check-module-size`, production build: all green at PR time (see PR checks).
