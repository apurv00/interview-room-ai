/**
 * The guest-session auth seam's single B2C write: find-or-create the round's
 * SYNTHETIC guest User (`round-<id>@guests.interviewprep.internal`). Shared
 * by /begin (magic_link mode) and /verify (otp mode). Idempotent on the
 * unique email; a concurrent double-call collapses via E11000 and reuses the
 * winner's row. The candidate's real email never enters the B2C users table.
 */

import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { guestEmailForRound } from '@hire'

export async function ensureGuestUser(roundId: string, candidateName?: string) {
  await connectDB()
  const syntheticEmail = guestEmailForRound(roundId)
  let guest = await User.findOne({ email: syntheticEmail })
  if (!guest) {
    try {
      guest = await User.create({
        email: syntheticEmail,
        name: candidateName || 'Candidate',
        emailVerified: new Date(),
        role: 'candidate',
        plan: 'free',
        monthlyInterviewLimit: 999999,
      })
    } catch (err: unknown) {
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        guest = await User.findOne({ email: syntheticEmail })
      }
      if (!guest) throw err
    }
  }
  return guest
}
