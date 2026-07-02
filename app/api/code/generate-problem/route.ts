import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { generateCodingProblem } from '@interview/services/core/codingProblemGenerator'
import { getServedProblemSummaries, countServedProblems, recordServedProblem, unionAvoidEntries } from '@interview/services/core/servedProblemLedger'
import { aiLogger } from '@shared/logger'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

/**
 * Per-item cap on solvedProblemIds. Each ID is injected into the Claude
 * prompt via `slice(0, 20).join(', ')`. Without a string length cap, a
 * crafted client could send 200 × huge strings → oversized prompt →
 * latency spike, higher token cost, possible context-window overflow.
 * 64 chars is comfortably above our existing ID scheme (`ai-generated-<timestamp>`
 * ≈ 25-30 chars, kebab-case ≤ 40) and leaves headroom for future formats.
 * Codex P2 on PR #303.
 */
const MAX_PROBLEM_ID_LEN = 64

const BodySchema = z.object({
  // 100 matches the CMS domain-slug validator — 64 silently 400'd generation
  // (dropping to static picks) for long-slug CMS domains.
  domain: z.string().min(1).max(100),
  experience: z.string().min(1).max(32),
  solvedProblemIds: z.array(z.string().max(MAX_PROBLEM_ID_LEN)).max(200).default([]),
  // Candidate-provided resume text (the client holds it in the interview config).
  // Accept up to 50k (the setup flow persists resumes that large) and TRUNCATE to
  // the prompt budget rather than reject — a too-strict max silently 400s
  // long-resume candidates into the generic static problem. Absent → role-only.
  resumeText: z.string().max(50_000).transform((s) => s.slice(0, 1200)).optional(),
  // Time-calibrated difficulty + per-problem minute budget (computed client-side
  // from the interview duration). Optional → generator falls back to experience.
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  budgetMinutes: z.number().int().min(3).max(60).optional(),
})

type Body = z.infer<typeof BodySchema>

/**
 * POST /api/code/generate-problem — Generates a fresh AI coding problem when
 * the static pool is exhausted for the candidate's role+experience combination.
 *
 * Rate-limited via composeApiRoute because the handler invokes
 * `completion()` which hits Claude — unbounded POSTs would let any
 * authed account drive arbitrary LLM spend on this comparatively
 * expensive operation (fresh generation, not evaluation). 5 req/min
 * per user is well above interview-start demand (typical candidate
 * starts 1 interview per session) but low enough to contain a
 * runaway script. Matches the rate-limit posture of /api/evaluate-answer
 * (15/min) — tighter because generation has higher per-call cost and
 * is only needed when the static pool is exhausted. Codex P1 on PR #303.
 *
 * Architectural note: this route exists specifically so modelRouter
 * (and its mongoose+ioredis deps) stays server-only. Previously the
 * page did `await import('@interview/services/core/codingProblemGenerator')`
 * which dragged modelRouter into the client bundle — forcing the
 * broken `eval('require')` pattern that silently failed in production.
 */
export const POST = composeApiRoute<Body>({
  schema: BodySchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:code-gen' },

  async handler(_req, { user, body }) {
    try {
      // Server-authoritative exclusion: union the ServedProblem ledger with the
      // client-sent list. Closes the fail-open hole where a failed client
      // /api/code/history fetch sent [] and dropped every exclusion. Ledger
      // entries come first (and carry titles — the generator renders them as a
      // titled avoid-list and runs its near-duplicate check against them);
      // the served count drives the progressive-difficulty nudge.
      const [served, priorCountInDomain] = await Promise.all([
        getServedProblemSummaries(user.id, 'coding'),
        countServedProblems(user.id, 'coding', body.domain),
      ])
      const avoid = unionAvoidEntries(served, body.solvedProblemIds)

      const problem = await generateCodingProblem(
        body.domain,
        body.experience,
        avoid.map((a) => a.id),
        body.resumeText,
        body.difficulty,
        body.budgetMinutes,
        { avoid, priorCountInDomain },
      )
      if (problem) {
        // Record before responding — a served AI problem can never go
        // unrecorded by client failure. recordServedProblem swallows DB errors.
        await recordServedProblem({
          userId: user.id,
          kind: 'coding',
          problemId: problem.id,
          title: problem.title,
          domain: body.domain,
          difficulty: problem.difficulty,
          source: 'ai',
          problemBody: problem,
        })
      }
      return NextResponse.json({ problem })
    } catch (err) {
      aiLogger.error({ err, domain: body.domain }, '/api/code/generate-problem failed')
      // Match the client-fallback contract: null → page falls back to
      // selectProblem (allowing repeats). Don't 500 — that would
      // short-circuit the candidate's interview-start flow.
      return NextResponse.json({ problem: null })
    }
  },
})
