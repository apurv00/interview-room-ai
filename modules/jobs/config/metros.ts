/**
 * Metro alias table — the locationKey normalization source (INGESTION §4.2).
 * Ported verbatim from the probe reference impl (scripts/jobs-liquidity-probe.mjs),
 * hardened on PR #503: separator spelling is collapsed BEFORE lookup, so
 * "Delhi-NCR" / "Delhi NCR" / "delhi_ncr" never mint distinct fingerprints.
 *
 * Geo expansion (ruling #14) = add a country's alias file, not architecture.
 */
export const METROS = ['Bengaluru', 'Delhi NCR', 'Mumbai', 'Hyderabad', 'Pune', 'Chennai'] as const

export const METRO_ALIASES: Record<string, string> = {
  gurgaon: 'delhi-ncr', gurugram: 'delhi-ncr', noida: 'delhi-ncr', 'greater noida': 'delhi-ncr',
  'new delhi': 'delhi-ncr', delhi: 'delhi-ncr', 'delhi ncr': 'delhi-ncr', ncr: 'delhi-ncr',
  ghaziabad: 'delhi-ncr', faridabad: 'delhi-ncr',
  bangalore: 'bengaluru', bengaluru: 'bengaluru', 'bangalore urban': 'bengaluru',
  mumbai: 'mumbai', 'navi mumbai': 'mumbai', thane: 'mumbai',
  hyderabad: 'hyderabad', secunderabad: 'hyderabad',
  pune: 'pune', chennai: 'chennai',
}
