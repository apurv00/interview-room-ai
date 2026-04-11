# BUGFIX-PLAN — User Feedback (Rakshit, 11 Apr 2026)

Branch: `fix/user-feedback-apr-11`

This document captures the investigation, root causes, and fix status for 11 issues reported by Rakshit's live testing of the product. Scorecards from the test sessions:
- https://www.interviewprep.guru/scorecard/blEpsTyGYN1N
- https://www.interviewprep.guru/scorecard/F0VoD5y689TW
- https://www.interviewprep.guru/scorecard/M3gpxMtnvcOt

---

## BUG 1 — Interview keeps asking questions after user ends midway (CRITICAL)

**Reported**: "Ended interview midway still it was asking question"

**Root cause** (in `modules/interview/hooks/useInterview.ts:558-661`):
- `finishInterview()` calls `interviewAbortRef.current?.abort()` but the ongoing `await avatarSpeak(spokenQuestion)` at line 861 doesn't receive the abort signal — TTS fetch in `useAvatarSpeech.ts:155-169` has no `signal` parameter.
- `cancelTTS()` happens after `transitionTo('SCORING')`, leaving a window where the loop's next iteration can fire a new question.
- When in-flight question generation completes after end-click, a new question gets added to the transcript.

**Fix**:
1. In `finishInterview()`, call `cancelTTS()` and `interviewAbortRef.current?.abort()` BEFORE any state transition.
2. Pass the AbortSignal to the TTS fetch in `useAvatarSpeech.ts` so in-flight requests cancel.
3. Add `if (isInterviewOver()) return` immediately after `await avatarSpeak()` resolves and before any transcript writes.

**Files**:
- `modules/interview/hooks/useInterview.ts`
- `modules/interview/hooks/useAvatarSpeech.ts`

**Status**: DONE

---

## BUG 2 — Scoring still not correct (MEDIUM)

**Reported**: "Scoring still not correct"

**Root cause**:
- The evaluation prompt in `app/api/evaluate-answer/route.ts:176-220` has NO scoring anchors — Claude defaults to a 60-75 range without calibration.
- `app/api/generate-feedback/route.ts:368-372` computes `overall_score` from `feedback.dimensions.answer_quality.score` (Claude's freeform value), NOT from the actual per-question evaluation scores in the DB.
- JD Alignment is conditionally added but never excluded from any aggregation when no JD is provided.

**Fix**:
1. Add a "SCORING GUIDE" section with explicit anchors (0-20, 21-40, 41-60, 61-80, 81-100) to the evaluation prompt.
2. In `generate-feedback`, replace the Claude-generated `aqScore` with a true average of per-question evaluation scores: `(relevance + structure + specificity + ownership) / 4`.

**Files**:
- `app/api/evaluate-answer/route.ts`
- `app/api/generate-feedback/route.ts`

**Status**: DONE

---

## BUG 3 — AI voice volume drops at end of long questions (MEDIUM)

**Reported**: "AI voice can a bit more clear, sometime i feel when ai is asking long question it volume goes down at the end"

**Root cause** (probable):
- `app/api/tts/route.ts:24-26` sanitizes text by replacing transitional phrases like `So,` → `So... ` — adds artificial pauses that may sound like volume drops on long questions.
- No fade-out logic found in any TTS code (good).

**Fix**:
1. Apply the ellipsis sanitizer only to short text (`< 200 chars`), not long questions.

**Files**:
- `app/api/tts/route.ts`

**Status**: DONE

---

## BUG 4 — "Take your time" prompt repeats unnecessarily (HIGH)

**Reported**: "After giving an answer like 3rd answer it again ask take your time and give answer whenever you are ready"

**Root cause** (`modules/interview/hooks/useInterview.ts:887-895`):
- For each question, the conversation loop resets `conversationTurns = 0`.
- If the user is silent for 30s (`listenForAnswer` timeout), the "take your time" prompt fires for EVERY question.

**Fix**:
1. Add a session-level ref `lastTakeYourTimeRef = useRef<number>(0)`.
2. Wrap the prompt with a 2-minute cooldown check.

**Files**:
- `modules/interview/hooks/useInterview.ts`

**Status**: DONE

---

## BUG 5 — STAR coaching tip disappears too quickly (MEDIUM)

**Reported**: "The suggestion for improvement mainly in purple comes for very short time - Mainly related to STAR"

**Root cause** (`modules/interview/hooks/useInterview.ts:479-507`):
- Auto-dismiss is hardcoded to **800ms** — way too short for 100+ character STAR tips.

**Fix**:
1. Calculate dismiss duration based on tip length: `<50` chars → 2000ms, `50-100` → 4000ms, `>100` → 6000ms.

**Files**:
- `modules/interview/hooks/useInterview.ts`

**Status**: DONE

---

## BUG 6 — Navbar not sticky on feedback page scroll (MEDIUM)

**Reported**: "Scroll in the page of interview feedback the navbar ui should be fixed"

**Root cause**:
- `shared/layout/AppShell.tsx:73` uses `sticky top-0 z-50`. The `backdrop-filter: blur` (`backdrop-blur-xl`) on the nav creates a stacking context that interferes with sticky positioning in some browsers (notably iOS Safari).
- Sticky is also fragile to ancestor `overflow` / `transform` properties.

**Fix**:
1. Switch to `fixed top-0 left-0 right-0` for guaranteed cross-browser behavior.
2. Add `pt-[68px]` to the children wrapper to compensate for the now-removed reserved space.

**Files**:
- `shared/layout/AppShell.tsx`

**Status**: DONE

---

## BUG 7 — AI voice starts speaking 5-10s after question text appears (HIGH)

**Reported**: "AI starts speaking 5-10 sec after the question is shown"

**Root cause** (`modules/interview/hooks/useInterview.ts:838, 861`):
- Line 838: `setCurrentQuestion(question)` renders the text immediately.
- Line 861: `await avatarSpeak(spokenQuestion, emotion)` THEN makes a Deepgram API call (1-2s) + generates audio (2-4s) + downloads buffer (1-2s) = 5-8s gap.
- Prefetch logic at line 1099-1100 fires AFTER evaluation, so by the time the next question is asked, prefetch hasn't completed.

**Fix** (Option A — surgical):
1. REMOVE `setCurrentQuestion(question)` from line 838.
2. Move it to AFTER `await avatarSpeak()` resolves, so the text appears just as audio starts.

**Files**:
- `modules/interview/hooks/useInterview.ts`

**Status**: DONE

---

## BUG 8 — Recording timestamp shows `0:00 / Infinity:NaN` (CRITICAL)

**Reported**: "Recording mein yeh timestamp show horha h 0:00 / Infinity:NaN"

**Root cause**:
- `shared/utils.ts:4-8` `formatTime()` doesn't guard against `Infinity` or `NaN`.
- `modules/interview/components/feedback/AudioPlayer.tsx:61-64` reads `audio.duration` directly. For MediaRecorder WebM files, `duration` is `Infinity` until the browser scans EOF.
- `VideoPlayer.tsx:68-102` already handles this correctly by seeking to `MAX_SAFE_INTEGER`; AudioPlayer is missing this probe.

**Fix**:
1. Add `if (!Number.isFinite(s) || s < 0) return '0:00'` guard to `formatTime()`.
2. Port the duration-probe pattern from `VideoPlayer.tsx` to `AudioPlayer.tsx`.

**Files**:
- `shared/utils.ts`
- `modules/interview/components/feedback/AudioPlayer.tsx`

**Status**: DONE

---

## BUG 9 — AI Analysis tab shows "timed out" (HIGH)

**Reported**: "ai analysis timed out dikha rha h"

**Root cause**:
- `app/api/analysis/start/route.ts` has `maxDuration = 60` but the client polls in `app/feedback/[sessionId]/page.tsx:245-278` only for **90s** before showing "timed out".
- For long interviews the inline pipeline can take 30-90s; the client gives up before completion or the server returns 500 at 60s.
- Recent fixes via PR #226 (text-transcript fallback, fusion 30s timeout, max_tokens reduction) help but the client polling cap is still the bottleneck.

**Fix**:
1. Bump client polling timeout from 90s → 180s.
2. Wrap the inline `runMultimodalPipeline` call in `Promise.race` with a 55s soft timeout; on timeout, mark `status='processing'` (not `'failed'`) so the next visit can resume.
3. Improve the timeout error message: "Analysis is taking longer than expected — please refresh in a minute".

**Files**:
- `app/api/analysis/start/route.ts`
- `app/feedback/[sessionId]/page.tsx`

**Status**: DONE

---

## BUG 10 — Feedback page feels cluttered (LOW — UX)

**Reported**: "Ui level pr ek feedback h ki ab kch jyada hi bhra lg rha h... boht kch h ek hi jagah pr... smjh ni aarha kaunsa main h... thoda clean hona chahiye"

**Root cause**: 9 sections in OverviewTab + 7 sections in Analysis tab = visual overload. No clear hierarchy.

**Fix** (low-effort, high-impact only):
1. Wrap the "Deep Analysis" section in the Analysis tab in a `<details>` collapsed by default. The replay segment (video + transcript + moments) stays visible — that's the primary value.
2. Don't restructure OverviewTab in this PR — log as a follow-up.

**Files**:
- `app/feedback/[sessionId]/page.tsx`

**Status**: DONE

---

## BUG 11 — Homepage needs more visuals (BACKLOG)

**Reported**: "landing page looks good... bs i prefer content km ho aur visual pictures jyada... abhi ek bhi picture nahi hai"

**Root cause**: The homepage uses CSS mockups (icons + bordered divs) instead of real product screenshots. There are 0 `<img>` or `<Image>` tags on the page.

**Fix**: NONE in this pass — this is a design/content task. Future work:
- Add product screenshots in TAB 2/3 (currently CSS mockups)
- Add customer testimonial avatars
- Consider decorative illustrations (wave patterns, data viz)

**Status**: BACKLOG (no code changes)

---

## Execution Order (Priority)

1. BUG 1 — Interview end cancellation (CRITICAL)
2. BUG 8 — Infinity:NaN timestamp (CRITICAL)
3. BUG 9 — AI analysis timeout (HIGH)
4. BUG 4 — Take your time repeating (HIGH)
5. BUG 7 — Voice 5-10s delay (HIGH)
6. BUG 6 — Navbar not sticky (MEDIUM)
7. BUG 5 — Coaching tip too fast (MEDIUM)
8. BUG 3 — Volume drop on long questions (MEDIUM)
9. BUG 2 — Scoring accuracy (MEDIUM)
10. BUG 10 — Feedback page declutter (LOW)
11. BUG 11 — Homepage visuals (BACKLOG)

One commit per bug, message format `fix(BUG-N): short description`.
