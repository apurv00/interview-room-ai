import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { generateCodingProblem } from '@interview/services/core/codingProblemGenerator'
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
  domain: z.string().min(1).max(64),
  experience: z.string().min(1).max(32),
  solvedProblemIds: z.array(z.string().max(MAX_PROBLEM_ID_LEN)).max(200).default([]),
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

  async handler(_req, { body }) {
    try {
      const problem = await generateCodingProblem(body.domain, body.experience, body.solvedProblemIds)
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
