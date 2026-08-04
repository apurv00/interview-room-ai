import { NextRequest } from 'next/server'
import { z } from 'zod'
import { handleOneTimeOrder } from '../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ResumeOrderRequestSchema = z.object({
  resumeId: z.string().trim().min(1).max(255),
}).strict()

export async function POST(request: NextRequest) {
  return handleOneTimeOrder(request, {
    sku: 'premium_resume',
    schema: ResumeOrderRequestSchema,
    toCheckoutRequest: ({ resumeId }) => ({
      sku: 'premium_resume',
      resumeId,
    }),
  })
}
