import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST() {
  return NextResponse.json(
    { error: 'This privacy verification endpoint is no longer available' },
    { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
  )
}
