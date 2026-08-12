import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { saveHireIdentityPhoto } from '@hire/services/identityMediaService'
import { hireGuestErrorResponse, requireHireGuest } from '../../_lib/hireGuestHttp'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: { roundId: string } },
) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const blocked = await checkRateLimit(`${ip}:${params.roundId}`, {
    windowMs: 15 * 60_000,
    maxRequests: 12,
    keyPrefix: 'rl:hire-identity-photo',
  })
  if (blocked) return blocked

  try {
    const scope = await requireHireGuest(req, params.roundId)
    const form = await req.formData()
    const photo = form.get('photo')
    if (!(photo instanceof File)) {
      return NextResponse.json(
        { error: 'A camera photo is required', code: 'PHOTO_REQUIRED' },
        { status: 400 },
      )
    }
    const asset = await saveHireIdentityPhoto({
      scope,
      body: Buffer.from(await photo.arrayBuffer()),
      declaredContentType: photo.type,
    })
    return NextResponse.json(
      {
        asset: {
          id: asset._id.toString(),
          kind: asset.kind,
          capturedAt: asset.capturedAt.toISOString(),
          width: asset.width,
          height: asset.height,
        },
      },
      { status: 201, headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    return hireGuestErrorResponse(error)
  }
}
