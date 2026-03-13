import { NextRequest, NextResponse } from 'next/server'
import { ZodSchema, ZodError } from 'zod'

export function withValidation<T>(schema: ZodSchema<T>) {
  return function (
    handler: (req: NextRequest, body: T, ...args: unknown[]) => Promise<NextResponse>
  ) {
    return async (req: NextRequest, ...args: unknown[]): Promise<NextResponse> => {
      try {
        const raw = await req.json()
        const body = schema.parse(raw)
        return handler(req, body, ...args)
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
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
      }
    }
  }
}
