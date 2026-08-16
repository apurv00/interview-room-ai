/**
 * Private Hire workspace branding object. It deliberately never returns an
 * R2 URL: membership is checked before every byte leaves the control surface.
 */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import {
  readHireWorkspaceLogo,
  UploadHireWorkspaceLogoSchema,
  uploadHireWorkspaceLogo,
  type UploadHireWorkspaceLogoPayload,
} from '@hire-branding'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'
import { serializeMembership } from '../../_lib/serialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function privateHeaders(contentType?: string): HeadersInit {
  return {
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    ...(contentType ? { 'Content-Type': contentType } : {}),
  }
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-workspace-logo-read' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const logo = await readHireWorkspaceLogo(ctx)
    if (!logo) {
      return NextResponse.json(
        { error: 'Company logo not found' },
        { status: 404, headers: privateHeaders() },
      )
    }
    return new NextResponse(new Uint8Array(logo.bytes), {
      headers: privateHeaders(logo.contentType),
    })
  },
})

export const PUT = composeHireApiRoute<UploadHireWorkspaceLogoPayload>({
  schema: UploadHireWorkspaceLogoSchema,
  rateLimit: { windowMs: 10 * 60_000, maxRequests: 10, keyPrefix: 'rl:hire-workspace-logo-write' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const workspace = await uploadHireWorkspaceLogo(ctx, body)
    ctx.workspace = workspace
    return NextResponse.json(serializeMembership(ctx), { headers: privateHeaders() })
  },
})
