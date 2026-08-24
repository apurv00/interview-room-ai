# IPG Hire — Phase 1 (The Spine) checklist

Plan of record: [ipg-hire-build-plan.md](./ipg-hire-build-plan.md) · Phase 1 §"The Spine".
Status legend: `[x]` implemented + covered by automated verification · `[ ]` open · `[P]` blocked on a prod action (auth is prod-only — see "Prod demo script").

> **Historical record / errata (2026-08-24):** This checklist records the
> original Phase 1 implementation snapshot. Statements below that say Hire v1
> still serves the subdomain, or that v2 still uses the v1 invite-ticket/B2C
> guest seam, are intentionally preserved as history and are no longer current.
> Hire v1 was removed on 2026-08-09; the Hire subdomain now serves
> `/workspace`, candidates use Hire-owned guest sessions, and the isolated
> runtime uses its own one-time handoff ticket. Use the later phase checklists
> and current runbooks for release operations.

## Ships (build plan §Phase 1)

- [x] **Workspace + direct member add** — `modules/hire` (HireWorkspace / HireWorkspaceMember), `/workspace` UI, admin-only add/remove, flat permissions (one admin, identical members). Members are added by name + email with **lazy account linking** on first sign-in (no invite flow, no pre-minted User rows — see "Deviations").
- [x] **Create job → JD builder** — title + pasted JD (`/workspace/jobs`); the JD grounds AI-round question generation and jd_match scoring. (The richer generate/parse/upload JD tooling exists in the engine and can be attached later without schema changes.)
- [x] **Add candidates manually** — workspace talent pool (`/workspace/candidates`) + add-directly-to-job from the pipeline board; per-workspace email dedupe.
- [x] **Send AI interview → emailed link with consent screen** — `POST /applications/[id]/rounds` creates a HireRound (32-byte token, sha256 at rest, 7-day expiry, revocable) and emails the invite (Resend). **Candidate verification is the company's choice** (founder decision 2026-08-09) — a per-workspace setting, chosen at workspace creation and changeable on the Team page, **snapshotted onto each round at send time** so links already in inboxes never change semantics:
  - **Magic link** (default) — the emailed link is the authentication: consent + recording disclosure → straight into the engine's own lobby/room flow.
  - **Email code (OTP)** — additionally proves current mailbox control: after consent, a 6-digit code is emailed to the candidate's address on record (never typed/supplied by the caller; 10-min expiry, 5-attempt lockout).
  In both modes `POST /begin` records consent server-side FIRST (no sign-in ticket can exist without the record) and the guest identity is a **per-round synthetic user** (`round-<id>@guests.interviewprep.internal`) — the candidate's real email never enters the B2C users table, and round↔session attribution is exact by userId. Candidates never create accounts in either mode; the invite email tells them not to forward it.
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

## Hardening properties (verified by tests; provenance: adversarial + Codex review passes on predecessor PR #603)

- **Round-unique reconciliation key:** the provisioned JD embeds a `[Interview reference: HR-<roundId>]` line and the round stores the full immutable `jdSnapshot` — an engine session can only match the one round that provisioned it (no cross-round/cross-workspace claims; a post-send JD edit can neither change the assessment nor break matching). Belt on top of the per-round guest userId.
- **Engine-contract safety:** job titles are capped at the engine's 100-char role limit at authoring time and defensively clamped at send; the jdSnapshot never exceeds the engine's JD max; boundaries pinned against `CreateSessionSchema` in the contract suite.
- **Retake visibility:** every engine session a round's config produced is counted (`attemptCount`, kept current even after linking); the card shows "started N times — scores are from the first completed run" (claims are oldest-completed-first, the anti-gaming order).
- **One live round per application:** enforced by a partial unique index (`{workspaceId, applicationId, live:true}`) at the database, not just app code; races surface as 409.
- **Link lifecycle:** invite links hard-expire 14 days after token expiry even mid-flow (checked at token verify AND at /prepare); an expired-link auto-supersede writes an `ai_round_revoked` audit event; a post-revoke completion is attached FLAGGED (`completedAfterRevoke`) with a red card notice — tracked, never silent; a failed ticket sign-in returns the guest to the flow with a retry instead of stranding them on the B2C sign-in page.
- **No fabricated scores:** a pending report never renders as "Overall 0"; all score badges/chips use the canonical 75/55 bands (`scoreBand`).

**Known limitations (documented, deliberate for Phase 1):**
- `createWorkspace` / membership linking are check-then-create; a user double-submitting can in theory create two workspaces (recoverable, no data risk). One-membership-per-user is the Phase 1 rule; a person added to two workspaces by email links to the earliest row.
- A guest exercising account deletion (GDPR) removes their engine sessions; an unreconciled round then stays "awaiting results" — correct privacy behavior, surfaced not silent.

## Flagged: first-class engine seam (guardrail: not touched) — THREE justifications now

A deterministic, event-driven seam needs **additive engine-file changes** (the exact pattern the Jobs feature used): a hire-handoff branch in `app/api/interviews/route.ts` + `CreateSessionSchema` (stamp verified hire attribution at create), a completion hook (or Inngest event) in the `PATCH /api/interviews/[id]` path, and extending the `answerScoringReceipts` provenance writer (currently filtered to `'attribution.source': 'jobs'` in `shared/services/scoringProvenance.ts`) to hire-attributed sessions. Per the goal guardrail none were made. The reconciliation fallback is encapsulated in ONE file (`modules/hire/services/roundLinkService.ts`) for a clean swap. What the seam would buy, in order of weight:

1. **Scoring provenance (Codex P1 on #604):** the guest owns their engine session and the engine's persistence is client-trusted (fine for B2C — users only cheat themselves; wrong for hiring evidence). An API-savvy candidate could fabricate or inflate their own `evaluations`/`feedback` before the card is opened. Hire sessions carry **no** server-side receipts today, so this is unverifiable read-only. Residual threat class until sanctioned: the assessed candidate forging *their own* results — same fraud class as proxy interviewing (also undetectable today).
2. **Revoke/expiry authority through session creation:** a guest who reached the lobby before a revoke can still complete; results attach FLAGGED (`completedAfterRevoke`), never silently, but only the seam can prevent the session outright.
3. **Push-based completion + zero-inference linkage** (the reconciliation already achieves exactness via per-round identity + jdSnapshot; the seam removes the open-card trigger dependency).
4. **Round-bound guest sessions (Codex round-5 P1):** the invite ticket mints an ordinary NextAuth session; for its 7-day lifetime the synthetic guest can call authed B2C endpoints beyond their round (bounded LLM-spend abuse requiring a valid invite; strictly narrower than v1, where invited candidates got real-email accounts with the same reach). Constraining the JWT to the round and enforcing it at the interview APIs requires auth/engine-side changes — same seam decision.

## Prod demo script (founder — ~15 min, after merge + deploy)

1. Sign in at www.interviewprep.guru → visit `/workspace` → create workspace ("Acme").
2. Jobs → New job → real title + real JD (≥50 chars).
3. Open the job → Add candidate (your own second email) → candidate appears in "New".
4. View card → Send AI interview (pick experience) → confirm email arrives (or copy the invite URL from the success banner).
5. Open the invite link (incognito): verify the **consent screen appears first**, then (magic link, the default) you land directly on "Setting things up…" → engine lobby → complete the short interview. Optional 5b: on the Team page flip verification to "Email code", send a second candidate an invite, and verify the 6-digit code step appears after consent.
6. Back as the member: open the candidate card → results appear (reconciliation runs on card load; if the report is still generating, the per-answer scores show with a "report pending" note — reload after the feedback page finishes).
7. Advance the candidate stage by stage → Hired (decision note required) → close the job (decision note required) → check the History timeline shows every actor + timestamp.
8. Regression spot-check: run one normal B2C mock interview end-to-end to confirm the core product is untouched.

## Verification record

- `modules/hire`: 14 source files / 1,750 LOC (budget 45 / 10k, ADR 0028).
- New automated coverage: 75 tests across 7 suites (workspace, pipeline, aiRound, roundLink, tenant isolation, guest-flow contract, guest routes).
- Full suite, ESLint, `tsc --noEmit`, `check-module-size`, production build: all green at PR time (see PR checks).
