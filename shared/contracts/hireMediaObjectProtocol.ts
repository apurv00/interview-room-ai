/**
 * Release-gate identity for the Hire control media object protocol.
 *
 * Keep this value literal and stable. Operators compare it across every
 * control instance before allowing v2 media writes after a cold cutover.
 */
export const HIRE_MEDIA_OBJECT_PROTOCOL =
  'v2-opaque-nonce-if-none-match-zero-seal' as const
