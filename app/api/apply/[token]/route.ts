import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/** Legacy path capabilities are intentionally dead: credentials belong only
 * in fragments and request bodies/headers, never in request targets. */
export async function POST() {
  return NextResponse.json(
    { error: 'This application link is no longer active' },
    { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
  )
}
