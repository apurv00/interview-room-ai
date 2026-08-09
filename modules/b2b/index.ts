/**
 * B2B module barrel. The v1 org-based hiring product (hireService,
 * scorecardService, org/invite routes and pages) was deleted 2026-08-09
 * after IPG Hire v2 (modules/hire) replaced it on hire.interviewprep.guru.
 *
 * What remains are the two auth primitives v2's guest flow reuses — both
 * Redis-only and org-agnostic:
 *   - otpService: 6-digit mailbox-control codes (hire keys: `hire:{roundId}`)
 *   - inviteTicketService: 60s single-use tickets redeemed by the
 *     `invite-otp` NextAuth provider
 */
export { issueOtp, verifyOtp, type VerifyResult, type IssuedOtp } from './services/otpService'
export {
  issueAuthTicket,
  redeemAuthTicket,
  type TicketPayload,
} from './services/inviteTicketService'
