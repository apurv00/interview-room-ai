import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { seedAllPersonalization } from '@shared/db/seedPersonalization'

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 2, keyPrefix: 'rl:seed-p' },
  requiredRole: 'platform_admin',

  async handler() {
    const result = await seedAllPersonalization()
    return NextResponse.json({ success: true, seeded: result })
  },
})
