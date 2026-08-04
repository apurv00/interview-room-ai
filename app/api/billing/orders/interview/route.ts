import { NextRequest } from 'next/server'
import { z } from 'zod'
import { handleOneTimeOrder } from '../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const InterviewOrderRequestSchema = z.object({}).strict()

export async function POST(request: NextRequest) {
  return handleOneTimeOrder(request, {
    sku: 'single_interview',
    schema: InterviewOrderRequestSchema,
    toCheckoutRequest: () => ({ sku: 'single_interview' }),
  })
}
