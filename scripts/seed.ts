#!/usr/bin/env npx tsx
/**
 * Standalone seed script — run locally with production MONGODB_URI to populate
 * interview domains and depth levels.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/seed.ts
 *
 * Or if you have a .env.local with MONGODB_URI:
 *   npx tsx -r dotenv/config scripts/seed.ts
 */

import { seedDatabase } from '../lib/db/seed'
import { connectDB } from '../lib/db/connection'

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI environment variable is required.')
    console.error('Usage: MONGODB_URI="mongodb+srv://..." npx tsx scripts/seed.ts')
    process.exit(1)
  }

  console.log('Connecting to MongoDB...')
  await connectDB()

  console.log('Seeding domains and interview depths...')
  const result = await seedDatabase()

  console.log(`Done! Seeded ${result.domains} domains and ${result.depths} depth levels.`)
  process.exit(0)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
