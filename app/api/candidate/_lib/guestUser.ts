/**
 * The guest-session auth seam's single B2C write: find-or-create the round's
 * SYNTHETIC guest User (`round-<id>@guests.interviewprep.internal`). Shared
 * by /begin (magic_link mode) and /verify (otp mode). Idempotent on the
 * unique email; a concurrent double-call collapses via E11000 and reuses the
 * winner's row. The candidate's real email never enters the B2C users table.
 *
 * Billing: hire interviews are EMPLOYER-FUNDED — the candidate must never
 * see the consumer paywall. Guests are minted with the billing system's own
 * grant lever (`entitlementSource: 'admin_grant'`, honored unconditionally
 * by createSession's admission authority and by the lobby's checkout
 * pre-flight), bounded by GUEST_INTERVIEW_LIMIT so a leaked 7-day guest JWT
 * cannot farm unlimited engine runs (v1 minted 999999 — this is strictly
 * tighter). The consumer plan stays 'free': plan semantics keep meaning
 * "what this account bought", which for a synthetic guest is nothing.
 */

import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { guestEmailForRound } from '@hire'

/** Engine-run budget per round: the real interview plus retake headroom
 * (attemptCount surfaces every extra run to the hiring team). */
export const GUEST_INTERVIEW_LIMIT = 3

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
        monthlyInterviewLimit: GUEST_INTERVIEW_LIMIT,
      })
    } catch (err: unknown) {
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        guest = await User.findOne({ email: syntheticEmail })
      }
      if (!guest) throw err
    }
  }
  // Employer-funded grant, one path for fresh AND pre-grant legacy guests.
  // entitlementSource lives in the billing schema projection (deliberately
  // not widened onto IUser), so it is written via $set — the same way the
  // payments services write it.
  if ((guest as { entitlementSource?: string }).entitlementSource !== 'admin_grant') {
    await User.updateOne(
      { _id: guest._id },
      {
        $set: {
          entitlementSource: 'admin_grant',
          monthlyInterviewLimit: GUEST_INTERVIEW_LIMIT,
        },
      }
    )
  }
  return guest
}
