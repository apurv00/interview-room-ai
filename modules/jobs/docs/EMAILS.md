# Jobs Email Wave — Spec of Record

Status: v2 for founder review (2026-07-15). v1 was adversarially reviewed
(3-lens panel, 34 findings: 4 blockers / 17 majors / 13 minors — all folded
in; the material ones are marked `[R#]`). Companion to PRODUCT_FLOW.md (§1
tracker loop, §4b return-sheet budgets, §4c deferred CTA) and DECISIONS.md
(P-4 auto-ghost, never-nag rulings). The learn digest (`emailDigestJob`)
stays hard-disabled; its documented defects (no dedupe, no pagination,
ignored preferences) are the structural checklist this design prevents.

## 0. Why email at all

The tracker runs on user-reported facts we cannot fetch (employer responses,
interview dates). In-app solicitation only reaches users while they're on
the site; email reaches them when they actually learn things. Every stream
is a solicitation or a payoff — never engagement spam. Corollary the review
sharpened: email NEVER gets to ask a question the in-app budget already
closed, and never asserts a claim the user hasn't made [R0].

## 1. Streams

Two classes with different rules [R1]:

**Transactional (user-requested — consent is the request itself):**

| # | Stream | Trigger | Discipline |
|---|--------|---------|------------|
| E0 | Tonight's practice link | User taps "Email me tonight's practice link" (PRODUCT_FLOW §4c, `jobs.prep_deferred_email`) | Sent immediately (shifted into quiet hours only if outside 08:00–21:00 IST). Bypasses prefs and the weekly cap. dedupeKey `applicationId:requestedAtISO-hour` (double-tap safe, re-request tomorrow works). An honored E0 consumes the automatic E4 for that application. |
| E2 | T-1 interview reminder | `interviewDate` set (exact/week confidence). Setting the date IS the request. | Send T-1 09:00 IST (exact) / Monday 09:00 IST of interview week (week; if that has passed at arming time, next 09:00 IST slot; if the week passed, never) [R14]. Cap-exempt. Ceiling: max 3 E2s per application ever; a date edit re-arms only if the new date differs by ≥1 calendar day [R19]. Skips the warm-up CTA (logistics-only variant) if a practice session happened in the last 24h [R10]. |

**Solicitation (system-initiated — strict budgets):**

| # | Stream | Trigger | Discipline |
|---|--------|---------|------------|
| E1 | Response nudge | status = `applied` (NEVER `apply_clicked` — an unconfirmed apply gets no response-status email, ever; the in-app confirm card owns that question and its 2-ask budget is closed [R0]) + 14 calendar days without a user-sourced tracker touch | ONE per application, ever. Never sent after day 28 of silence — it must land before the 35-day auto-ghost, not after it [R2]. Shares the response-status ask ledger with the in-app 7d/21d nudges: reads/writes `outcome.{lastAskedAt, askCount}`; an in-app answer or ask inside 7 days defers/consumes E1 [R4]. ≥3 due for one user → ONE batched email listing all rows with per-row one-taps, consuming one cap slot and one ask per application [R2]. |
| E3 | Weekly digest | Cron Tue 10:00 IST; users with ≥1 tracker row or base resume | Weekly. Zero new content → no send (silence is the honest state). Sunset: paused after 8 consecutive zero-click digests, resumed by any site visit or tracker action; stopped at `offer` with no other active applications [R8]. **Wave 1.5, not wave 1**: E3 does not enable until Resend bounce/complaint webhooks feed a suppression set (hard bounce → suppress; complaint → suppress + unsubscribe). A bulk stream without a feedback loop is a reputation death spiral with no brake [R20]. |
| E4 | Deferred practice | status `apply_clicked` or `applied` (merely-saved jobs never trigger per-application mail — that's the engagement spam §0 forbids; saved-not-practiced becomes one batched digest line) + 0 practice sessions after 3 calendar days | ONE per application, ever. Not sent if the posting closed or the application is >14 days stale [R2][R7]. Suppressed if an E0 was honored for the application. |

**Caps & priority:** max 3 solicitation emails per user per rolling 7 days
(E0/E2 exempt). Cap-miss for E1/E4 = DROP, not queue — the moment passed;
a retrying sweep must never turn the cap into a target [R2]. Slot priority
when competing: E1 > E4 > E3 [R11]. All sends land 08:00–21:00 IST.

## 2. The structural guards

1. **Send ledger** — `JobsEmailSend` `{ userId, stream, dedupeKey, sentAt,
   resendId }`, UNIQUE `{userId, stream, dedupeKey}`.
   - *Solicitation streams (E1/E3/E4)*: reserve-first (insert ledger row →
     send → stamp `resendId`). Duplicate key = skip. A reserved-unstamped
     row is dashboard-surfaced, never auto-retried — losing a nudge is
     acceptable; double-sending is not.
   - *Transactional streams (E0/E2)*: send-first with a **Resend
     idempotency key = the dedupeKey**, then record. Provider-side
     idempotency makes send-then-record double-safe, and a crash can't
     burn the dedupe key on an unsent time-critical mail [R15]. Same-run
     bounded retry (2 attempts); an E2 still unsent alerts immediately
     (log level error + dashboard), not after 24h [R6].
   - *Ordering*: any content-dependent skip (E3's zero-content rule) is
     decided BEFORE reservation — a skipped digest is not a false alarm
     [R32].
2. **Pagination by `_id` cursor** until exhaustion; per-run hard stop (500)
   with remainder logged. No `limit(50)` head-reads.
3. **Preferences at the query** — filter shape is explicitly
   `{ 'emailPreferences.jobs.<pref>': { $ne: false } }`: absent = default
   true, because existing users have no stored field and a `: true` match
   would silently select nobody [R26]. Re-checked per user immediately
   before the Resend call (post-reserve); an in-window unsubscribe releases
   the reservation [R24].
4. **Switches are data** — singleton `JobsEmailConfig` `{ e0Enabled,
   e1Enabled, e2Enabled, e3Enabled, e4Enabled, globalWeeklyCap }`, all
   default OFF, served by its OWN admin sub-route
   `app/api/cms/jobs-ingest/email/route.ts` (the existing PATCH is
   hard-wired to the JobsVerdictConfig singleton; one handler per
   singleton) [R29], displayed on the same dashboard page.

## 3. Preferences & unsubscribe

- `User.emailPreferences.jobs = { nudges: boolean, digest: boolean,
  unsubscribedStreams: string[] }` [R5][R27]. Coarse toggles for settings
  UI (E1/E4 ride `nudges`, E3 rides `digest`); the suppression list is what
  unsubscribe links write (`e1`…`e4`, or all four for `all-jobs`).
  Two-layer semantics: a send requires its coarse toggle ≠ false AND its
  stream not suppressed. **E2's "setting a date is the request" overrides
  `nudges=false` but NEVER a suppression entry — one-click unsubscribe is
  absolute (RFC 8058 compliance and basic respect)** [R5][R24]. E0 bypasses
  toggles (it is a direct request) but still honors `all-jobs` suppression.
- **Two unsubscribe paths** [R17]:
  - `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
    headers point at a dedicated endpoint that commits suppression
    IMMEDIATELY on POST, returns 2xx, no UI — mail clients are robots.
  - The footer link for humans: GET renders a confirm page (no external
    subresources, `Referrer-Policy: no-referrer`, no personal data
    rendered [R23]) with a one-button POST commit.
- **Legacy hole (out of scope, filed)**: `/api/learn/unsubscribe?userId=...`
  accepts raw unauthenticated ids; retrofit with the same token helper.

## 4. Signed tokens & one-tap actions

- **Dedicated `EMAIL_TOKEN_SECRET`** — never `NEXTAUTH_SECRET` (auth-secret
  rotation must not invalidate mail in flight; no dev-fallback secret; both
  mint and verify fail closed if unset). Token = versioned structured
  payload `base64url(JSON{v, typ, uid, aid?, action?, dk?, exp})` + HMAC-SHA256,
  constant-time compare; `typ` ∈ {`unsub`, `status`} verified at each
  endpoint — an unsubscribe token can never fire a status action [R16][R22].
  Key rotation: `v` selects among {current, previous} verify keys.
- **Status actions** (`/api/jobs/email-action`): GET renders a confirm page
  (same hardening as §3) with one-button POST; exp 30 days; expired →
  friendly "link expired" + login-gated deep link to the tracker row;
  invalid signature → generic page, zero information [R12][R23].
- **Single-emitter rule survives** [R25][R18]: the edge-guarded
  `jobs.interview_scheduled` emission MOVES from the status route into
  `applicationService.transitionStatus` — the service becomes the sole
  emitter; the session-gated route and the token-gated endpoint are thin
  callers. The implementing PR updates the status/interview-date route
  comments in the same diff. Event props gain `channel: 'web' | 'email'`.
- **Action semantics**: one-taps are USER CLAIMS routed through the same
  transitions as the tracker UI. `[Nothing yet]` writes ONLY
  `outcome.lastAskedAt/askCount` (an answer, never a status flip) [R0].
  Stale-guard compares against the last **source:'user'** transition only —
  a system auto-ghost NEVER blocks a token action; `[Got an interview]` on
  a ghosted row applies normally (ghosted is recoverable by design) [R3].
  `[Got an interview]`'s date-sheet continuation passes through the sign-in
  redirect back to the tracker's date sheet (date capture stays
  auth-gated; the token authorizes the claim, not the account) [R33].

## 5. Content rules

- Digest counts come from the live feed with the user's own target; skills
  named only when a resume matched; zero matched jobs → no send.
- No readiness-ranking claims; no evidence claims except on
  jobs-attributed facts (Wave-5 rules extend to email).
- **Subjects and preview text are product-voice and must never imply
  employer contact or an application-status change we don't possess**
  ("Any news from {Company}? Tell us in one tap" ✓; "Update on your
  {Company} application" ✗). Snapshot tests assert subject templates
  against a banned-pattern list [R9].
- Templates receive display labels, never raw status enums — `ghosted`
  renders as "No response" in the inbox too, enforced by template input
  types [R13].
- Footer: why-you-got-this line naming the TRUE trigger fact, branching on
  status ("you clicked apply on X" ≠ "you applied to X") [R0]; per-stream +
  all-jobs unsubscribe links.

## 6. Architecture

- Inngest: `jobsEmailSweepJob` (hourly `35 * * * *` UTC = :05 past each IST
  hour [R30]) derives due E1/E2/E4 lazily (nothing persisted before the
  ledger step); `jobsDigestJob` (`30 4 * * 2` UTC = Tue 10:00 IST). Guard
  pipeline order: config switch → IST quiet-hours gate → prefs query →
  staleness ceilings → cap + priority → content build & skip decision →
  ledger (per §2 class) → final pref re-check → send → stamp [R24][R30][R32].
  E0 is event-triggered (`jobs/email.requested`), not swept. 20 sends per
  `step.run`.
- Templates: pure functions `modules/jobs/emails/{e0..e4}.ts` →
  `{subject, html}`, snapshot-tested, zero DB access.
- `sendEmail()` return shape changes to `{ ok: boolean, id?: string }`
  (ledger needs `resendId`) + optional `headers`/`replyTo`/`idempotencyKey`;
  the implementing PR audits existing boolean-consuming callers in the same
  diff [R31].
- Token helper: `shared/services/signedActionToken.ts` (shared with the
  legacy-route retrofit).
- **Module-size budget**: the implementing PR adds ~3 counted `shared/`
  files against ~1 file of headroom — it must bump `scripts/
  check-module-size.mjs` shared maxFiles with a paired ADR (ADR-0016
  precedent) [R28].

## 7. Rollout ladder (founder-side, per stream)

0. **Before ANY stream**: verify SPF/DKIM/DMARC + From-domain alignment in
   Resend (custom domain, not a resend.dev fallback) and validate one-click
   unsubscribe end-to-end with a self-send [R21].
1. Merge + deploy — inert (all switches OFF; prefs default via `$ne: false`,
   no backfill).
2. Founder self-test per stream from the dashboard (`?to=self` kick).
3. Flip order: E0 + E2 (transactional, highest value) → E1 → E4.
4. E3 waits for wave 1.5 (bounce/complaint webhook suppression live) [R20].

## 8. Explicitly out of scope (wave 1)

E3 bulk digest (wave 1.5 behind webhook suppression); open-tracking pixels
(never); learn-digest resurrection; Gmail-inbox response detection
(privacy posture); per-user send-time optimization.
