import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { recordServedProblem } from '@interview/services/core/servedProblemLedger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/problems/served — records that a coding / system-design problem was
 * shown to the user, so future rounds exclude it (ServedProblem ledger).
 *
 * Fired fire-and-forget from the interview page at selection time for STATIC
 * pool picks (AI problems are recorded server-side inside the generate-problem
 * routes before they respond, so a served AI problem can never go unrecorded).
 * Recording at selection time (not session create) is deliberate: a candidate
 * who saw the problem and bailed in the lobby has still seen it.
 *
 * problemId max matches the InterviewSession codingProblemId/designProblemId
 * validator cap (modules/interview/validators/interview.ts).
 */
const BodySchema = z.object({
  kind: z.enum(['coding', 'system-design']),
  problemId: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  domain: z.string().max(64).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  source: z.enum(['static', 'ai']),
})

type Body = z.infer<typeof BodySchema>

export const POST = composeApiRoute<Body>({
  schema: BodySchema,
  // One record per interview start; 10/min absorbs retries and two-tab races
  // without letting a script spam ledger writes.
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:problem-served' },

  async handler(_req, { user, body }) {
    await recordServedProblem({
      userId: user.id,
      kind: body.kind,
      problemId: body.problemId,
      title: body.title,
      domain: body.domain,
      difficulty: body.difficulty,
      source: body.source,
    })
    // recordServedProblem swallows DB errors by design (recording must never
    // break interview start) — the response is always ok for a valid body.
    return NextResponse.json({ ok: true })
  },
})
