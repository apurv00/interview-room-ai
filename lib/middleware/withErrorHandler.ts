import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { AppError } from '@/lib/errors'
import { ZodError } from 'zod'

export function withErrorHandler(
  handler: (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>
) {
  return async (req: NextRequest, ...args: unknown[]): Promise<NextResponse> => {
    try {
      return await handler(req, ...args)
    } catch (err) {
      if (err instanceof ZodError) {
        return NextResponse.json(
          {
            error: 'Validation failed',
            details: err.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
          { status: 400 }
        )
      }

      if (err instanceof AppError) {
        logger.warn({ err, path: req.nextUrl.pathname }, err.message)
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.statusCode }
        )
      }

      logger.error({ err, path: req.nextUrl.pathname }, 'Unhandled error in API route')
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
