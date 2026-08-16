import { NextResponse } from 'next/server'
import { AppError } from '@shared/errors'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'
import {
  requireMembership,
  BuildJobDescriptionSchema,
  type BuildJobDescriptionPayload,
} from '@hire'
import { buildSmartJd } from '@hire/services/jdBuilderService'

export const dynamic = 'force-dynamic'

/** Generate the two Smart-JD artifacts for HR review before job creation. */
export const POST = composeHireApiRoute<BuildJobDescriptionPayload>({
  schema: BuildJobDescriptionSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-jd-builder' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    // New workspaces expose companyDescription. Keep the legacy fallback only
    // so an untouched workspace still renders a coherent JD while it moves
    // through onboarding; the request body can never override this value.
    const workspace = ctx.workspace as typeof ctx.workspace & {
      companyDescription?: string | null
    }
    const companyDescription = workspace.companyDescription ?? workspace.companyBlurb
    if (typeof companyDescription !== 'string' || !companyDescription.trim()) {
      throw new AppError(
        'Complete the company profile before creating a job description.',
        409,
        'WORKSPACE_COMPANY_DESCRIPTION_REQUIRED',
      )
    }
    const artifact = await buildSmartJd({
      role: body.title,
      level: body.level,
      targetExperienceRange: body.targetExperienceRange,
      mustHaves: body.mustHaves,
      niceToHaves: body.niceToHaves,
      location: body.location,
      workMode: body.workMode,
      ...(body.compensation ? { compensation: body.compensation } : {}),
      companyBlurb: companyDescription.trim(),
      jdSource: 'ai_generated',
    })
    return NextResponse.json(artifact)
  },
})
