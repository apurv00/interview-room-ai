import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'

export const dynamic = 'force-dynamic'

const UpdateConsentSchema = z.object({
  recordingConsent: z.boolean().optional(),
  analysisConsent: z.boolean().optional(),
  marketingOptIn: z.boolean().optional(),
  researchDonationConsent: z.boolean().optional(),
})

type ConsentPayload = z.infer<typeof UpdateConsentSchema>

// GET — Return current consent state
export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:consent-get' },

  async handler(_req, { user }) {
    await connectDB()
    const profile = await User.findById(user.id)
      .select('privacyConsent')
      .lean()

    return NextResponse.json({
      consent: profile?.privacyConsent || {
        recordingConsent: false,
        analysisConsent: false,
        marketingOptIn: false,
        researchDonationConsent: false,
      },
    })
  },
})

// PATCH — Update consent settings
export const PATCH = composeApiRoute<ConsentPayload>({
  schema: UpdateConsentSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:consent-update' },

  async handler(_req, { user, body }) {
    await connectDB()

    const update: Record<string, unknown> = {}
    const now = new Date()

    if (body.recordingConsent !== undefined) {
      update['privacyConsent.recordingConsent'] = body.recordingConsent
      update['privacyConsent.recordingConsentAt'] = now
    }
    if (body.analysisConsent !== undefined) {
      update['privacyConsent.analysisConsent'] = body.analysisConsent
      update['privacyConsent.analysisConsentAt'] = now
    }
    if (body.marketingOptIn !== undefined) {
      update['privacyConsent.marketingOptIn'] = body.marketingOptIn
    }
    if (body.researchDonationConsent !== undefined) {
      update['privacyConsent.researchDonationConsent'] = body.researchDonationConsent
      update['privacyConsent.researchDonationConsentAt'] = now
    }

    await User.findByIdAndUpdate(user.id, { $set: update })

    return NextResponse.json({ success: true })
  },
})
