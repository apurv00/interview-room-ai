import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Signed action tokens for email links (EMAILS.md §4): unsubscribe and
 * one-tap status actions. Deliberately NOT NEXTAUTH_SECRET — auth-secret
 * rotation must never invalidate mail in flight, and email tokens get
 * their own blast radius. FAIL CLOSED: no EMAIL_TOKEN_SECRET → minting
 * throws and verification rejects; there is no dev fallback secret.
 *
 * Token = base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload)).
 * Payload is versioned and TYPED — `typ` is verified by the consuming
 * endpoint so an unsubscribe token can never fire a status action.
 * Key rotation (Codex #531): the payload does NOT encode which key signed
 * it — a pre-rotation token can't know it's about to be superseded.
 * Verification tries EMAIL_TOKEN_SECRET first, then
 * EMAIL_TOKEN_SECRET_PREVIOUS, so in-flight mail survives a rotation for
 * as long as the previous key stays configured. `v` is the payload FORMAT
 * version (currently 1), nothing more.
 */

export type TokenType = 'unsub' | 'status'

export interface ActionTokenPayload {
  /** Payload FORMAT version — key selection is not encoded in the token. */
  v: 1
  typ: TokenType
  /** User id (string form of the ObjectId). */
  uid: string
  /** Application id — status tokens only. */
  aid?: string
  /** The single action this token may perform (status tokens) or the
   *  suppression scope (unsub tokens: 'e0'..'e4' | 'all'). */
  action: string
  /** Ledger dedupeKey binding (status tokens) — ties a click back to the
   *  exact send that carried it. */
  dk?: string
  /** Unix seconds. REQUIRED — a token without exp never verifies. */
  exp: number
}

export type VerifyResult =
  | { ok: true; payload: ActionTokenPayload }
  | { ok: false; reason: 'unconfigured' | 'invalid' | 'expired' | 'wrong-type' }

const b64url = (buf: Buffer) => buf.toString('base64url')

function sign(payloadB64: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadB64).digest()
}

/** Current key first, previous key during a rotation grace window. */
function verifyKeys(): string[] {
  return [process.env.EMAIL_TOKEN_SECRET, process.env.EMAIL_TOKEN_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  )
}

export function mintActionToken(
  input: Omit<ActionTokenPayload, 'v' | 'exp'> & { expDays: number }
): string {
  const secret = process.env.EMAIL_TOKEN_SECRET
  if (!secret) throw new Error('EMAIL_TOKEN_SECRET not configured — refusing to mint email tokens')
  const { expDays, ...rest } = input
  const payload: ActionTokenPayload = {
    ...rest,
    v: 1,
    exp: Math.floor(Date.now() / 1000) + Math.floor(expDays * 86400),
  }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)))
  return `${payloadB64}.${b64url(sign(payloadB64, secret))}`
}

export function verifyActionToken(token: string, expectedTyp: TokenType): VerifyResult {
  if (!process.env.EMAIL_TOKEN_SECRET) return { ok: false, reason: 'unconfigured' }
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid' }
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  let payload: ActionTokenPayload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid' }
  if (payload.v !== 1) return { ok: false, reason: 'invalid' }

  let sig: Buffer
  try {
    sig = Buffer.from(sigB64, 'base64url')
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  // In-flight tokens survive rotation: try current, then previous (Codex
  // #531 — the token cannot know which key signed it).
  const signedByKnownKey = verifyKeys().some((secret) => {
    const expected = sign(payloadB64, secret)
    return sig.length === expected.length && timingSafeEqual(sig, expected)
  })
  if (!signedByKnownKey) return { ok: false, reason: 'invalid' }

  // Signature is valid — now the claims. exp is mandatory (Codex-reviewed
  // spec: absent exp never verifies), typ must match the endpoint.
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' }
  }
  if (payload.typ !== expectedTyp) return { ok: false, reason: 'wrong-type' }
  if (typeof payload.uid !== 'string' || !payload.uid) return { ok: false, reason: 'invalid' }
  if (typeof payload.action !== 'string' || !payload.action) return { ok: false, reason: 'invalid' }

  return { ok: true, payload }
}
