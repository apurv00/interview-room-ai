import { ProductEvent } from '@shared/db/models'

/**
 * Anon→user identity stitch (PRODUCT_FLOW §2): when a signed-in request
 * arrives carrying a valid anon cookie, the pre-signup ProductEvent rows
 * written under that anonId are backfilled with the userId — otherwise the
 * httpOnly cookie's history is orphaned until TTL (no client can read it),
 * signup-funnel metrics break, and userId-keyed GDPR export/deletion miss
 * the rows (Codex on #508).
 *
 * Idempotent: only rows still missing a userId are touched; a re-run is a
 * no-op. Never throws — telemetry stitching must not break a user flow.
 */
export async function stitchAnonEventsToUser(anonId: string, userId: string): Promise<number> {
  try {
    const res = await ProductEvent.updateMany(
      { anonId, userId: { $exists: false } },
      { $set: { userId } }
    )
    return res.modifiedCount ?? 0
  } catch {
    return 0
  }
}
