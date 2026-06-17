#!/usr/bin/env npx tsx
/**
 * Seed evaluation rubrics only (idempotent upsert by rubricId).
 *
 * The rubric registry (BUILT_IN_RUBRICS) is otherwise only seeded via the
 * platform_admin POST /api/seed-personalization route. This standalone runner
 * lets you land rubric changes directly.
 *
 * Usage:
 *   npx tsx scripts/seed-rubrics.ts                 # uses .env.local MONGODB_URI
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/seed-rubrics.ts
 */
import { readFileSync } from 'fs'

// Load MONGODB_URI from .env.local if not already in the environment (no dotenv dep).
if (!process.env.MONGODB_URI) {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^\s*MONGODB_URI\s*=\s*(.+?)\s*$/)
      if (m) process.env.MONGODB_URI = m[1].replace(/^["']|["']$/g, '')
    }
  } catch { /* no .env.local — rely on the ambient env */ }
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI is required (set it or add it to .env.local).')
    process.exit(1)
  }
  // Dynamic imports so dotenv loads before the DB modules read the environment.
  const { connectDB } = await import('../shared/db/connection')
  const { seedRubrics } = await import('../shared/db/seedPersonalization')

  console.log(`Connecting to MongoDB (${process.env.MONGODB_URI!.replace(/\/\/[^@]*@/, '//***@')}) ...`)
  await connectDB()
  const result = await seedRubrics()
  console.log(`Done. Upserted ${result.rubrics} rubrics (idempotent by rubricId).`)
  process.exit(0)
}

main().catch((err) => {
  console.error('Rubric seed failed:', err?.message || err)
  process.exit(1)
})
