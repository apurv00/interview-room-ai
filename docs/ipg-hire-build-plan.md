# IPG Hire — Build Plan

## Design thesis

The core object is the **decision, backed by evidence**. Every screen leads with "who needs a decision and what do we know" — and every screen worth presenting can export itself.

## Principles

1. **Flat permissions** — one admin, identical members. Members are the HR team only.
2. **Everyone else is a link** — interviewers and stakeholders interact through expiring, no-login guest links, never accounts.
3. **Reuse before build** — all AI comes from the live IPG engine.
4. **Fixed over configurable** — fixed stages, fixed scorecard.
5. **No silent failures** — records are side effects of actions the reliable actor already wants to take.
6. **Evidence over scores** — every number links to the moment that produced it; the AI recommends, a human makes every move.

## Permission model

- Workspace = one company; creator is admin. Admin adds core members (the HR team) directly by name + email — account provisioned or linked on the spot, password on first sign-in. No invite flow.
- Admin-only: add/remove members, delete workspace. Everything else identical for all members.
- **Hiring managers, panelists, and outside stakeholders are never members.** They receive guest links scoped to a single candidate: an interview kit (to run a round) or a share packet (to give a verdict).
- Session shared across `*.interviewprep.guru`.

## Core data model

- **Workspace / Member** — members are the HR team
- **Job** — title, JD, status (open / on-hold / closed)
- **Candidate** — workspace-level: contact, resume, parsed profile; persists across jobs (talent pool + "seen before" flags)
- **Application** — candidate × job, stage, JD-match score, decision note (required when marked Hired)
- **Round** — per application; type AI or human. AI rounds carry recording, transcript, scores. Human rounds are created when HR logs the round (or a member opens the in-app room); the call itself always happens outside the tool.
- **Scorecard** — reviewer (member or guest), overall rec, dimension ratings, comments — per round
- **GuestLink** — application-scoped; kind `interview-kit` (sent to an interviewer's email: brief + scorecard) or `share-packet` (section toggles + one-tap verdict); expiring, revocable, no login

Every table keyed by `workspace_id`.

## Pipeline

**New → Screened → Interviewing → Shortlist → Offer → Hired / Rejected**

Cards carry round + evidence chips (`AI 82 · R1 ✓ · R2 scorecard pending, 2d`). Stage moves are explicit buttons, and every move records who and when — so "did a human review this?" is always answerable in one sentence. The AI ranks and recommends; it never auto-rejects.

## Dashboard & screens

**KPI header strip (max 4):** open jobs · candidates awaiting decision · scorecard completion · median time-to-close.

1. **Action inbox (home)** — "4 candidates need a decision · 2 scorecards pending from you · 1 verdict arrived." Operating and evaluating never mix; performance is one tap away.
2. **Jobs health view** — one row per job: days open, mini funnel bar, attention chips ("5 stuck in Shortlist 6+ days"). Sorted by needs-attention, not alphabetically.
3. **Per-job performance** — funnel conversion, score distribution (charts only at n ≥ ~10; below that, show the ranked people, not statistics), top of pool. No cross-job candidate comparisons — scores aren't comparable across different JDs and interview configs.
4. **Candidate card** — decision-first header ("AI: Advance · 2 of 3 reviewers Yes"), dimension bars that tap through to transcript moments, in-pool rank (internal only — never in packets or exports), round timeline, reviewer tally. No radar charts, no single blended index.
5. **Interview kit (guest page)** — candidate brief on top, scorecard below; opened during the interviewer's own call, submitted at the end.
6. **Interview room (member page)** — same layout for rounds a member runs themselves; opening it logs the round.
7. **Share packet (guest page)** — read-only sections per toggles + a one-tap verdict stored as an external scorecard.
8. **Candidate surface** — public apply page, AI-interview consent + recording disclosure, status link ("You're at round 2 of 3").
9. **Compare view** — up to 3 candidates, presentation-clean: evidence chips, reviewer tally, zero admin chrome. This is the debrief-meeting screen.

Empty and small-n states are designed first — every new workspace starts with 1 job and 8 candidates.

## Reports & exports

- **Candidate assessment PDF** — profile, scores with evidence highlights, all scorecards, recommendation. The forwardable version of the share packet.
- **Pipeline status report** (per job or all jobs) — stage counts, aging, blockers. PDF or Excel; the Monday-morning leadership answer.
- **Job close-out report** — funnel numbers, time-to-close, who was hired and the decision note. Generated at close.
- **CSV export** — all candidates + statuses. The "my data isn't trapped" escape hatch.

Criteria: PDFs render from the same components as the screens — no separately designed report layouts. Internal-only context (in-pool ranks) never appears in any export.

---

## Phase 1 — The Spine — demo-ready

**Ships**
- Workspace + direct member add
- Create job → JD builder (existing)
- Add candidates manually
- Send AI interview → emailed link with consent screen (existing engine)
- Evidence-linked results on the candidate card
- Advance / Reject buttons with actor recorded; close job with required decision note

**Done when**
- One real job goes created → candidates AI-interviewed → decision → closed, entirely in-tool
- This spine is the live demo for the prospect company

## Phase 2 — Volume + Screening

**Ships**
- Bulk resume upload on an async queue (existing parser)
- Public apply page per job (no-login link)
- Auto JD-match scoring + ranked queue, with the bottom of the list one scroll away
- Email dedupe + "previously seen in [job]" flag

**Done when**
- 50 resumes parsed, scored, ranked, and deduped with zero manual steps

## Phase 3 — Human Rounds via Interview Kits

**Ships**
- HR logs a round + interviewer email → interview kit sent automatically
- Kit page: brief + scorecard, tokenized, expiring, no login
- In-app interview room for rounds a member runs themselves (opening it logs the round)
- Round/evidence chips on cards; pending-scorecard tracking with one reminder

**Done when**
- A hiring manager who has never seen the tool receives a kit, runs the round on their own Meet, and submits the scorecard — no account, no training, no chasing from HR

## Phase 4 — Decide Together

**Ships**
- Aggregate view: recommendation tally, averages, reviewer spread
- Presentation-clean compare (up to 3)
- Action inbox
- Share packet + external verdict
- Candidate assessment PDF
- Close flow with editable, templated rejection emails

**Done when**
- 3 member scorecards + 1 guest scorecard aggregate correctly
- The assessment PDF generates and gets forwarded without manual edits

## Phase 5 — Reports, Trust + Polish

**Ships**
- Pipeline status report (PDF/Excel) and job close-out report
- CSV export
- Jobs health view, per-job performance view, KPI strip
- Candidate status page
- "Interview yourself" onboarding test drive
- Audit trail, empty states, daily email digest

**Done when**
- A new workspace reaches its first AI-interview result within 15 minutes
- The Monday status report is one click, not an Excel rebuild

---

## Cross-cutting implementation criteria

- Same monorepo; subdomain routing; shared session across `*.interviewprep.guru`
- Interview engine writes results keyed to application/round IDs via internal API — never into B2C tables
- Async queue (Inngest pattern) for parsing, scoring, result ingestion, and report generation
- `workspace_id` scoping on every read/write + cross-tenant leak tests; guest links tokenized, expiring, revocable, scoped to one candidate
- Consent + recording disclosure before any AI interview; humans make every stage move
- Email is the only channel: interview links, kits, scorecard reminder, daily digest

## Success metrics

- Spine demo delivered at end of Phase 1 (~week 3)
- Job created → first AI interview completed in under 48 hours
- ≥90% of human rounds have a scorecard within 24 hours — the interview-kit test
- Weekly status pulled from the tool, not rebuilt in Excel
- One pilot team closes a real requisition fully in-tool
