/**
 * Short-lived, single-use auth ticket used to bridge the
 * verify-otp endpoint and the NextAuth `invite-otp` Credentials provider.
 *
 * The invite OTP flow cannot mint NextAuth sessions directly from
 * verify-otp — NextAuth needs to go through its own Credentials provider
 * to issue the session cookie. But we also don't want to run OTP
 * verification inside the Credentials provider's `authorize()` because
 * NextAuth collapses every non-ok result to a generic 401, destroying
 * error UX (can't distinguish expired / locked / mismatch).
 *
 * The ticket is the primitive that lets us split responsibility:
 *   - verify-otp does the security-critical work and returns a ticket
 *   - Credentials provider redeems the ticket and trusts its contents
 *
 * Properties:
 *   - 32 bytes of crypto-random entropy (hex-encoded → 64-char string)
 *   - 60-second TTL (minted and redeemed in the same browser flow)
 *   - Single-use: one Redis script atomically reads and deletes the ticket,
 *     so concurrent redeemers cannot both receive its payload
 *   - Stored alongside { userId, sessionId }; the isolated Hire runtime also
 *     carries its organizationId so every principal lookup is tenant-scoped
 */

import mongoose from 'mongoose'
import { randomBytes } from 'crypto'
import { redis } from '@shared/redis'
import { authLogger } from '@shared/logger'

const TICKET_PREFIX = 'auth:invite-ticket:'
const TICKET_TTL_SECONDS = 60

const REDEEM_TICKET_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then
  return nil
end
redis.call('DEL', KEYS[1])
return value
`

export interface TicketPayload {
  userId: string
  sessionId: string
  organizationId?: string
}

export async function issueAuthTicket(
  userId: string,
  sessionId: string,
  organizationId?: string,
): Promise<string | null> {
  const ticket = randomBytes(32).toString('hex')
  try {
    await redis.set(
      `${TICKET_PREFIX}${ticket}`,
      JSON.stringify({
        userId,
        sessionId,
        ...(organizationId ? { organizationId } : {}),
      }),
      'EX',
      TICKET_TTL_SECONDS,
    )
    return ticket
  } catch (err) {
    authLogger.error({ err }, 'issueAuthTicket: Redis error')
    return null
  }
}

export async function redeemAuthTicket(
  ticket: string,
): Promise<TicketPayload | null> {
  if (!ticket || typeof ticket !== 'string' || ticket.length !== 64) {
    return null
  }
  try {
    const key = `${TICKET_PREFIX}${ticket}`
    const raw = await redis.eval(
      REDEEM_TICKET_SCRIPT,
      1,
      key,
    )
    if (typeof raw !== 'string') return null
    const parsed = JSON.parse(raw) as TicketPayload
    if (
      !parsed.userId ||
      !parsed.sessionId ||
      !mongoose.Types.ObjectId.isValid(parsed.userId) ||
      !mongoose.Types.ObjectId.isValid(parsed.sessionId) ||
      (parsed.organizationId !== undefined &&
        !mongoose.Types.ObjectId.isValid(parsed.organizationId))
    ) {
      return null
    }
    return parsed
  } catch (err) {
    authLogger.error({ err }, 'redeemAuthTicket: Redis error')
    return null
  }
}

export const __internals = {
  TICKET_PREFIX,
  TICKET_TTL_SECONDS,
  REDEEM_TICKET_SCRIPT,
}
