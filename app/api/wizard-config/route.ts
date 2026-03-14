import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { WizardConfig } from '@shared/db/models'

export const dynamic = 'force-dynamic'

const DEFAULTS = { costCapEnabled: true, costCapUsd: 1.0 }

export async function GET() {
  try {
    await connectDB()
    const config = await WizardConfig.getConfig()
    return NextResponse.json(config, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' },
    })
  } catch {
    // DB not available — return static defaults
    return NextResponse.json(DEFAULTS, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' },
    })
  }
}
