import { NextResponse } from 'next/server'
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
    await requireMembership({ userId: user.id, email: user.email })
    const artifact = await buildSmartJd({
      role: body.title,
      level: body.level,
      mustHaves: body.mustHaves,
      niceToHaves: body.niceToHaves,
      location: body.location,
      workMode: body.workMode,
      ...(body.compensation ? { compensation: body.compensation } : {}),
      ...(body.companyBlurb ? { companyBlurb: body.companyBlurb } : {}),
    })
    return NextResponse.json(artifact)
  },
})
