# Bug: Interview Questions Repeating Identically

## Symptom

Every interview question after Q1 is the same generic fallback: "Tell me about a challenge you faced recently and how you handled it." Reported by multiple users on production. Feedback URL: https://www.interviewprep.guru/feedback/69dd0b09addc258eb9ed7e00

## Actual Root Cause (confirmed via GitNexus trace)

**Model/provider mismatch in `resolveModel()`.**

### GitNexus execution trace

```
useInterview.generateQuestion (hooks/useInterview.ts:439)
  → useInterviewAPI.generateQuestion (hooks/useInterviewAPI.ts:70)
    → fetch POST /api/generate-question
      → handler (api/generate-question/route.ts:28)
        → completion({ taskSlot: 'interview.generate-question', ... })
          → resolveModel('interview.generate-question')
            → TASK_SLOT_DEFAULTS = { model: 'gpt-5.4-mini', provider: 'openai' }
            → BUT resolveModel() hardcoded provider: 'anthropic' (line 92)
            → returns { model: 'gpt-5.4-mini', provider: 'anthropic' }
          → callProvider('anthropic', 'gpt-5.4-mini', ...)
            → Anthropic API rejects unknown model → 500 Internal Server Error
          → fallback chain: no fallbackModel configured → attempt 3 tries openai
            → if OPENAI_API_KEY missing → also fails
          → completion() throws
        → catch block (line 488-506) returns { question: "Tell me about a challenge..." }
      → 200 OK with fallback question
    → data.question = fallback string
  → every question is identical
```

### The two bugs in modelRouter.ts

**Line 92** — when `routingEnabled = false`:
```typescript
// BEFORE (broken): hardcoded 'anthropic' regardless of defaults.provider
return { model: defaults.model, provider: 'anthropic', ... }
// Sent gpt-5.4-mini to Anthropic → 500

// AFTER (fixed): respects defaults.provider
return { model: defaults.model, provider: defaults.provider, ... }
```

**Line 108** — when routing enabled but slot has no CMS config (same bug):
```typescript
// BEFORE: return { model: defaults.model, provider: 'anthropic', ... }
// AFTER:  return { model: defaults.model, provider: defaults.provider, ... }
```

### Silent failure chain (why it was invisible)

1. **Server catch returns 200**: `generate-question/route.ts:503` catches the LLM error and returns `{ question: "fallback..." }` with HTTP 200. The client sees a successful response.
2. **Client catch was silent**: `useInterviewAPI.ts:103` had a bare `catch {}` with no logging — errors were completely swallowed.
3. **No error UI**: The interview UI displays whatever string comes back. A fallback question looks like a real question to the user.

Result: The API failed on every call, but the failure was invisible at every layer.

### Blast radius (from GitNexus)

`completion()` has **30 callers** across the entire app:
- 10 interview slots (generate-question, evaluate-answer, feedback, code eval, etc.)
- 8 resume slots (enhance, ATS, tailor, parse, etc.)
- 4 learn slots (pathway, challenges, drills)
- 3 other (onboarding, b2b, wizard)

All 10 interview slots had `provider: 'openai'` in defaults but got `provider: 'anthropic'` from resolveModel — **all interview AI features were broken** when CMS routing was disabled.

Resume/learn/b2b slots were unaffected because their defaults already use `provider: 'anthropic'` with Claude models.

---

## Mistake Made During First Investigation

### What happened

1. User reported "questions 3,4,5,6 were all the same"
2. I read `useInterview.ts` and saw that `generateQuestion()` prefetches at line 1320 before `finalizeThread()` at line 1467
3. I hypothesized: "completedThreadsRef is stale → dedup prompt missing current topic → LLM generates same question"
4. I built a fix: pass a `threadsSnapshot` that includes the in-flight thread
5. The fix was valid code but **wrong diagnosis** — the LLM wasn't generating duplicate questions, it was **never being called at all**

### Why it was wrong

I **pattern-matched** instead of **tracing**. The symptom "repeated questions" has multiple possible causes:

| Hypothesis | Trace required | What it would show |
|-----------|----------------|-------------------|
| Stale dedup context | Read useInterview.ts only | Plausible but circumstantial |
| LLM returning same output | Check API response bodies | Would show identical prompts |
| **API failing entirely** | **Trace full call chain with GitNexus** | **Would show 500 error + fallback** |
| Abort signal canceling requests | Check signal lifecycle | Would show AbortError |

I only checked hypothesis 1 and stopped. A GitNexus trace would have eliminated it in 3 queries:

```bash
# Query 1: What does generate-question call?
npx gitnexus cypher "MATCH (n)-[r]->(m) WHERE n.name = 'handler' AND n.filePath = 'app/api/generate-question/route.ts' AND r.type = 'CALLS' RETURN m.name, m.filePath"
# → shows completion() in modelRouter.ts

# Query 2: What does completion() call?
npx gitnexus cypher "MATCH (n)-[r]->(m) WHERE n.name = 'completion' AND n.filePath = 'shared/services/modelRouter.ts' AND r.type = 'CALLS' RETURN m.name, m.filePath"
# → shows resolveModel() → callProvider() → getProvider()

# Query 3: Read resolveModel() — immediately see hardcoded 'anthropic'
```

### Rule that was violated

**CLAUDE.md rule**: "MUST run impact analysis before editing any symbol."

**What should have been done**: Before hypothesizing, trace the full execution path from symptom to root. For "questions are repeating":
1. What exact string is repeating? → matches fallback at useInterviewAPI.ts:104 AND route.ts:505
2. That means the API is failing → trace why
3. GitNexus: handler → completion() → resolveModel() → provider mismatch → done

---

## Rules to Enforce Going Forward

1. **Trace before hypothesize.** For any runtime bug, run `gitnexus cypher` to trace the full execution path from the entry point to the failure point BEFORE forming a hypothesis.

2. **Match the symptom string.** If the user reports a specific string/behavior, grep the codebase for that exact string first. "Tell me about a challenge" appears at exactly 2 locations — both are fallback catch blocks. That immediately reframes the bug from "bad LLM output" to "API failure."

3. **Check error handling at every layer.** Silent catches (`catch {}`, catch-and-return-fallback) are the #1 cause of invisible failures. When debugging, map every catch block in the call chain.

4. **PreToolUse hook enforces GitNexus.** `.claude/settings.json` now blocks Edit/Write on source files unless a `gitnexus cypher`/`query`/`augment` command was run first in the session. Active from next session onwards.

---

## Current State (after fix)

### What was fixed
- `shared/services/modelRouter.ts:92,108` — `provider: 'anthropic'` → `provider: defaults.provider`
- `modules/interview/hooks/useInterviewAPI.ts:101-107` — added `res.ok` check + error logging to catch block

### What still needs monitoring
- If `OPENAI_API_KEY` is unset or invalid, all interview slots will fail (they default to `gpt-5.4-mini` / `openai`)
- If CMS routing is enabled but missing slot configs, it falls through to `defaults.provider` (now correct)
- The server-side catch at `generate-question/route.ts:503` still returns a fallback as HTTP 200 — consider returning an error status instead so the client can distinguish real questions from fallbacks
