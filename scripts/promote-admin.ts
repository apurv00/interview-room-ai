#!/usr/bin/env npx tsx
/**
 * Promote a user to platform_admin role.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/promote-admin.ts user@example.com
 *
 * Or if you have a .env.local with MONGODB_URI:
 *   npx tsx -r dotenv/config scripts/promote-admin.ts user@example.com
 */

import { connectDB } from '../lib/db/connection'
import { User } from '../lib/db/models'

async function main() {
  const email = process.argv[2]

  if (!email) {
    console.error('Usage: npx tsx scripts/promote-admin.ts <email>')
    process.exit(1)
  }

  if (!process.env.MONGODB_URI) {
    console.error('ERROR: MONGODB_URI environment variable is required.')
    process.exit(1)
  }

  console.log('Connecting to MongoDB...')
  await connectDB()

  const user = await User.findOne({ email: email.toLowerCase() })
  if (!user) {
    console.error(`No user found with email: ${email}`)
    console.error('Sign up first at the main app, then run this script.')
    process.exit(1)
  }

  if (user.role === 'platform_admin') {
    console.log(`User ${email} is already a platform_admin.`)
    process.exit(0)
  }

  const previousRole = user.role
  user.role = 'platform_admin'
  await user.save()

  console.log(`Promoted ${email} from "${previousRole}" to "platform_admin".`)
  console.log('Sign out and back in for the change to take effect.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
