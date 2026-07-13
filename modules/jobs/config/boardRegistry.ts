/**
 * ATS-board seed registry (INGESTION §1 build-now; ~780 India jobs verified
 * on the 2026-07-11 sweep). Every row seeds DISABLED — ops verifies the
 * board is live (the weekly probe helps) and flips `enabled` deliberately;
 * data is the only switch (founder ruling 2026-07-13, no flags).
 *
 * Board liveness is a CONFIG INVARIANT, never an assumption — Paytm 404s
 * and CRED is a dead logo; the weekly probe quarantines 404/410 boards and
 * enforces minIndiaPostings (3 breaches → quarantined).
 */
export interface BoardSeed {
  sourceId: string
  atsKind: 'greenhouse' | 'lever' | 'smartrecruiters' | 'ashby' | 'workable' | 'bamboohr'
  slug: string
  minIndiaPostings: number
}

export const BOARD_REGISTRY: BoardSeed[] = [
  // Sweep-verified counts (2026-07-11): Bosch(SR)=546, Continental(SR)=107,
  // PhonePe(GH)=48-53, Meesho(Lever)=44, Groww=15, Postman~15 India.
  { sourceId: 'gh:phonepe', atsKind: 'greenhouse', slug: 'phonepe', minIndiaPostings: 10 },
  { sourceId: 'gh:postman', atsKind: 'greenhouse', slug: 'postman', minIndiaPostings: 5 },
  { sourceId: 'lever:meesho', atsKind: 'lever', slug: 'meesho', minIndiaPostings: 10 },
  { sourceId: 'lever:groww', atsKind: 'lever', slug: 'groww', minIndiaPostings: 5 },
  { sourceId: 'sr:boschgroup', atsKind: 'smartrecruiters', slug: 'BoschGroup', minIndiaPostings: 50 },
  { sourceId: 'sr:continentalag', atsKind: 'smartrecruiters', slug: 'ContinentalAG', minIndiaPostings: 20 },
]
