import type { JobVerdict } from '../config/verdictSchema'
import { CLEAN_REASON_CODES } from '../config/verdictSchema'

/**
 * Verdict reconciliation policy (INGESTION §4.5) — PURE. The worker owns
 * all DB writes; this module only decides.
 *
 * Monotonicity (ruling #15/#16): the LLM only ADDS severity. It can never
 * clear a layer-1 flag or resurrect a rules-dropped row (those were never
 * stored). `llmClearedFlaggedRow` is telemetry-only — the flag stands.
 *
 * Enforcement (founder decision I-4): auto soft-close requires BOTH the
 * `fraud` verdict AND genuineness ≤ 0.2 — a low-confidence fraud call
 * demotes via the stored verdict fields, it does not hide supply. Soft-close
 * never deletes; fingerprint stays = anti-resurrection; CMS-reopenable.
 */

export const SOFT_CLOSE_GENUINENESS_MAX = 0.2

export interface ReconcileFlags {
  /** True when ANY layer-1 demotion flag is set on the stored row. */
  anyDemotionFlag: boolean
}

export interface ReconcileResult {
  /** Policy verdict — the worker applies it ONLY when enforcement is enabled. */
  wouldSoftClose: boolean
  disagreesWithRules: boolean
  /** LLM found severity rules missed (fraud/suspicious on a rules-clean row). */
  llmFlaggedCleanRow: boolean
  /** LLM would clear a flagged row — advisory only, the flag stands. */
  llmClearedFlaggedRow: boolean
}

export function reconcileVerdict(verdict: JobVerdict, flags: ReconcileFlags): ReconcileResult {
  const wouldSoftClose = verdict.verdict === 'fraud' && verdict.genuineness <= SOFT_CLOSE_GENUINENESS_MAX
  const severe = verdict.verdict === 'fraud' || verdict.verdict === 'suspicious'
  const llmFlaggedCleanRow = !flags.anyDemotionFlag && severe
  const clean = verdict.verdict === 'genuine'
    && verdict.reasonCodes.some((c) => (CLEAN_REASON_CODES as readonly string[]).includes(c))
  const llmClearedFlaggedRow = flags.anyDemotionFlag && clean
  return {
    wouldSoftClose,
    disagreesWithRules: llmFlaggedCleanRow || llmClearedFlaggedRow,
    llmFlaggedCleanRow,
    llmClearedFlaggedRow,
  }
}
