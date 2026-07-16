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
  // Whitespace-insensitive (PR-C, founder item 7): the display-formatted
  // JD (jdDisplayCompressed — newlines preserved) and the hash-canonical
  // collapsed body are the SAME JD version. Every input this hash has
  // ever stored was already whitespace-collapsed, so the collapse below
  // is a no-op for all existing parsedJDHash / atsResult.jdHash /
  // evidence xrayHash values (pinned by test) — while sessions that
  // capture display-shaped text via the practice hand-off keep hashing
  // equal to the posting's parse. Version detection is about CONTENT,
  // not whitespace shape.
  return createHash('sha1').update(jd.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 20)
}

/** The pre-collapse hash form (raw bytes). Stored atsResult.resumeHash
 *  values predate the whitespace collapse and were computed on RAW resume
 *  text — resumes carry newlines, unlike stored JD bodies where the
 *  collapse is a no-op (Codex #541). Comparison sites accept BOTH forms so
 *  legacy ATS results stay valid; every new WRITE uses xrayHashOf, so the
 *  corpus converges and this stays comparison-only. */
export function legacyXrayHashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 20)
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
  // The parser NEVER throws — model/JSON failures return an all-empty
  // fallback (no requirements, no themes). Caching that would pin a blank
  // X-ray to this hash forever; serve it for THIS view but leave the row
  // unparsed so a later view retries (Codex on #518). A genuine parse of a
  // real JD always carries at least one requirement or theme.
  const isFallback = extracted.requirements.length === 0 && extracted.keyThemes.length === 0
  if (!isFallback) {
    // FIRST-WRITE-WINS per hash (READINESS.md §1, panel R11): evidence
    // rows bind to this parse's requirement ids — a same-hash re-parse
    // (cache-miss race) must never replace the ids they point at.
    await JobPosting.updateOne(
      { _id: jobPostingId, parsedJDHash: { $ne: hash } },
      { $set: { parsedJD: extracted, parsedJDHash: hash } }
    )
  }
  return { parsed: extracted, cached: false }
}
