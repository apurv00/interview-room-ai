import { createHmac } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticateHireMember } from '@hire/services/memberAuthService'
import { AppError } from '@shared/errors'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { setHireMemberCookie } from '../_lib/cookie'
import { revokeLegacyRequestHireMemberSession } from '../_lib/memberSession'
import { clientIp, hasTrustedOrigin } from '../_lib/request'

const SignInSchema = z
  .object({
    workspace: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
      .optional(),
    /** @deprecated Compatibility for saved ObjectId-based sign-ins. */
    workspaceId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(128),
  })
  .strict()
  .refine((value) => Number(!!value.workspace) + Number(!!value.workspaceId) === 1, {
    message: 'Provide one company workspace',
    path: ['workspace'],
  })

export const dynamic = 'force-dynamic'

function signInRateLimitSubject(workspace: string, email: string): string {
  const configuredSecret = process.env.NEXTAUTH_SECRET?.trim()
  if (
    process.env.NODE_ENV === 'production' &&
    (!configuredSecret || configuredSecret.length < 32)
  ) {
    throw new Error('NEXTAUTH_SECRET is unavailable for Hire sign-in throttling')
  }
  return createHmac(
    'sha256',
    configuredSecret || 'hire-signin-development-only-rate-limit-key',
  )
    .update('hire-member-signin:v1\0')
    .update(workspace.trim().toLowerCase())
    .update('\0')
    .update(email.trim().toLowerCase())
    .digest('hex')
}

export async function POST(req: NextRequest) {
  if (!hasTrustedOrigin(req)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }
  const blocked = await checkRateLimit(clientIp(req), {
    windowMs: 15 * 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:hire-member-signin-ip',
    failClosed: true,
  })
  if (blocked) return blocked
  try {
    const body = SignInSchema.parse(await req.json())
    const workspaceCoordinate = body.workspace ?? body.workspaceId ?? ''
    const subjectBlocked = await checkRateLimit(
      signInRateLimitSubject(workspaceCoordinate, body.email),
      {
        windowMs: 15 * 60_000,
        maxRequests: 10,
        keyPrefix: 'rl:hire-member-signin-subject',
        failClosed: true,
      },
    )
    if (subjectBlocked) return subjectBlocked
    const auth = await authenticateHireMember(
      workspaceCoordinate,
      body.email,
      body.password,
    )
    await revokeLegacyRequestHireMemberSession(req)
    const response = NextResponse.json({
      ok: true,
      workspace: {
        slug: auth.workspace.signInSlug ?? null,
        name: auth.workspace.name,
      },
    })
    setHireMemberCookie(response, auth.sessionCredential, auth.expiresAt)
    return response
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid sign-in details' }, { status: 400 })
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      )
    }
    return NextResponse.json({ error: 'Could not sign in' }, { status: 500 })
  }
}
