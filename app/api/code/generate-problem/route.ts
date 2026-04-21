import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { generateCodingProblem } from '@interview/services/core/codingProblemGenerator'
import { aiLogger } from '@shared/logger'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  domain: z.string().min(1).max(64),
  experience: z.string().min(1).max(32),
  solvedProblemIds: z.array(z.string()).max(200).default([]),
})

/**
 * POST /api/code/generate-problem — Generates a fresh AI coding problem when
 * the static pool is exhausted for the candidate's role+experience combination.
 *
 * Why this is an API route and not a client-side dynamic import:
 * The generator calls `completion()` from modelRouter, which (after the
 * require-pattern fix) statically imports mongoose + ioredis. Those are
 * Node-only modules that webpack can NOT bundle into client chunks. Putting
 * the call behind a fetch boundary keeps modelRouter on the server side
 * exclusively — the production-broken `eval('require')` workaround that
 * existed before this change is no longer necessary, and CMS-driven model
 * config now actually loads from Mongo at runtime.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  try {
    const problem = await generateCodingProblem(body.domain, body.experience, body.solvedProblemIds)
    return NextResponse.json({ problem })
  } catch (err) {
    aiLogger.error({ err, domain: body.domain }, '/api/code/generate-problem failed')
    // Match the existing client-fallback contract: null → page falls back to
    // selectProblem (allowing repeats). Don't 500 — that would short-circuit
    // the candidate's interview-start flow.
    return NextResponse.json({ problem: null })
  }
}
