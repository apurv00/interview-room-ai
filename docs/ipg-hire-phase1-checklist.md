# IPG Hire — Phase 1 (The Spine) checklist

Plan of record: [ipg-hire-build-plan.md](./ipg-hire-build-plan.md) · Phase 1 §"The Spine".
Status legend: `[x]` implemented + covered by automated verification · `[ ]` open · `[P]` blocked on a prod action (auth is prod-only — see "Prod demo script").

## Ships (build plan §Phase 1)

- [x] **Workspace + direct member add** — `modules/hire` (HireWorkspace / HireWorkspaceMember), `/workspace` UI, admin-only add/remove, flat permissions (one admin, identical members). Members are added by name + email with **lazy account linking** on first sign-in (no invite flow, no pre-minted User rows — see "Deviations").
- [x] **Create job → JD builder** — title + pasted JD (`/workspace/jobs`); the JD grounds AI-round question generation and jd_match scoring. (The richer generate/parse/upload JD tooling exists in the engine and can be attached later without schema changes.)
- [x] **Add candidates manually** — workspace talent pool (`/workspace/candidates`) + add-directly-to-job from the pipeline board; per-workspace email dedupe.
- [x] **Send AI interview → emailed link with consent screen** — `POST /applications/[id]/rounds` creates a HireRound (32-byte token, sha256 at rest, 7-day expiry, revocable), emails the invite (Resend), and the guest surface `/candidate/[roundId]` runs **consent + recording disclosure → email OTP → sign-in → engine's own lobby/room flow**. Consent gates the flow server-side (OTP endpoints refuse before consentAt).
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
