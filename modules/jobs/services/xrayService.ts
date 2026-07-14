import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import { JobPosting } from '@shared/db/models'
import { parseJobDescription } from '@interview'
import type { IParsedJobDescription } from '@shared/types'

/**
 * Interview X-ray (PRODUCT_FLOW §2 detail route, Wave 3.1b) — ONE persisted
 * JD parse per posting, keyed by the normalized body hash (standing trap:
 * "one JD parse per job: key by JD hash on JobPosting, pass through the
 * hand-off — never two parsers"). The parser is the interview module's own
 * parseJobDescription (billed via the existing interview.jd-extract slot),
 * imported through the barrel — jobs never grows a second parser.
 *
 * Lazy + cached: the first authed detail view pays the parse; every later
 * view (and the Wave-4 practice hand-off) reads JobPosting.parsedJD. A
 * merge that replaces the JD changes the hash and the next view re-parses.
 * Two concurrent first-viewers may both parse (same content, same result,
 * last-write-wins) — the Redis NX lock stays in the deferred backlog with
 * the problem-generation one.
 */

/**
 * Dedicated X-ray key — NOT bodyHashOf: that one carries mass-repost
 * semantics (null under 100 chars, 2000-char slice). Reusing it here meant
 * short-JD postings re-parsed on EVERY view (unbounded LLM spend) and JD
 * edits beyond char 2000 never re-parsed. This hash is unconditional and
 * covers the full body the parser actually sees.
 */
export function xrayHashOf(jd: string): string {
  return createHash('sha1').update(jd).digest('hex').slice(0, 20)
}

/** rawText is deliberately ABSENT: persisting the parser's echo of the full
 *  JD would duplicate every posting's body uncompressed inside parsedJD and
 *  survive retention slimming after jdCompressed is stripped (Codex on
 *  #518). Consumers that need the JD text read jdCompressed. */
export type XrayParsed = Omit<IParsedJobDescription, 'rawText'>

export interface XrayResult {
  parsed: XrayParsed
  cached: boolean
}

export async function getOrParseXray(jobPostingId: string): Promise<XrayResult | null> {
  const doc = await JobPosting.findById(jobPostingId)
    .select('jdCompressed parsedJD parsedJDHash status')
    .lean()
  // Closed postings 404 on the detail body — the X-ray endpoint must not
  // out-serve it during the retention window (Codex on #518).
  if (!doc || doc.status !== 'open') return null

  const buf = doc.jdCompressed as Buffer | undefined
  let jd = ''
  try {
    jd = buf?.length ? gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from((buf as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8') : ''
  } catch { /* corrupt gzip = no body; nothing to parse */ }
  if (!jd) return null

  const hash = xrayHashOf(jd)
  if (doc.parsedJD && doc.parsedJDHash === hash) {
    return { parsed: doc.parsedJD as XrayParsed, cached: true }
  }

  const { rawText: _omit, ...extracted } = await parseJobDescription(jd)
  await JobPosting.updateOne({ _id: jobPostingId }, { $set: { parsedJD: extracted, parsedJDHash: hash } })
  return { parsed: extracted, cached: false }
}
