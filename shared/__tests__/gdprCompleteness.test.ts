import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * GDPR completeness tripwire (ruling #6 / PRODUCT_FLOW §2, jobs Wave 1b):
 * every model whose schema carries a `userId` path must appear in BOTH the
 * accountDeletion cascade and the dataExportService export — or be listed
 * here as a KNOWN, documented exception. A new user-scoped model that lands
 * in neither list fails this test by name.
 *
 * Source-scan by design: runtime enumeration of Mongoose models depends on
 * import order; the source files are the ground truth reviewers read.
 */

const MODELS_DIR = path.join(__dirname, '../db/models')
const CASCADE_SRC = fs.readFileSync(path.join(__dirname, '../services/accountDeletion.ts'), 'utf8')
const EXPORT_SRC = fs.readFileSync(path.join(__dirname, '../services/dataExportService.ts'), 'utf8')

// The User doc itself is deleted/exported as the root object, not a cascade
// entry keyed by userId.
const ROOT_MODEL = 'User'

// Deletion-side exceptions — each must state WHY it is safe to skip.
const DELETION_EXCEPTIONS: Record<string, string> = {
  // Anonymized 30d-TTL score-drift telemetry; rows self-expire and carry
  // no content beyond scores/token counts (G.1 design).
  ScoreTelemetry: 'TTL-expiring anonymized telemetry (30d)',
}

// Export-side legacy gaps — PRE-EXISTING debt, cataloged not endorsed.
// Removing a name from this list (by adding the model to the export) is
// always safe; ADDING a name requires the same justification discipline
// as DELETION_EXCEPTIONS.
const EXPORT_LEGACY_GAPS: Record<string, string> = {
  MultimodalAnalysis: 'pre-Wave-1b gap — replay signals; large payloads need a redacted shape',
  UsageRecord: 'pre-Wave-1b gap — billing metadata',
  StreakDay: 'pre-Wave-1b gap — derivable from xp/streak fields already exported',
  DailyChallengeAttempt: 'pre-Wave-1b gap',
  DrillAttempt: 'pre-Wave-1b gap',
  WizardConfig: 'pre-Wave-1b gap',
  WizardSession: 'pre-Wave-1b gap — wizard drafts',
  GeneratedLesson: 'cache keyed by content, user-linked rows are engagement not authorship',
  LessonEngagement: 'pre-Wave-1b gap',
  ScoreTelemetry: 'TTL-expiring anonymized telemetry (30d)',
}

function modelsWithUserIdPath(): string[] {
  return fs
    .readdirSync(MODELS_DIR)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .filter((f) => {
      const src = fs.readFileSync(path.join(MODELS_DIR, f), 'utf8')
      return /userId:\s*\{[^}]*Schema\.Types\.ObjectId/s.test(src)
    })
    .map((f) => f.replace(/\.ts$/, ''))
    .filter((name) => name !== ROOT_MODEL)
}

describe('GDPR completeness (ruling #6)', () => {
  const userModels = modelsWithUserIdPath()

  it('finds a plausible model population (sanity: the scan is not broken)', () => {
    expect(userModels.length).toBeGreaterThan(10)
    expect(userModels).toContain('InterviewSession')
    expect(userModels).toContain('JobApplication')
    expect(userModels).toContain('ProductEvent')
  })

  it('every userId-bearing model is in the deletion cascade or a documented exception', () => {
    const missing = userModels.filter(
      (m) => !CASCADE_SRC.includes(m) && !(m in DELETION_EXCEPTIONS)
    )
    expect(missing, `models missing from accountDeletion cascade: ${missing.join(', ')}`).toEqual([])
  })

  it('every userId-bearing model is in the data export or a documented legacy gap', () => {
    const missing = userModels.filter(
      (m) => !EXPORT_SRC.includes(m) && !(m in EXPORT_LEGACY_GAPS)
    )
    expect(missing, `models missing from dataExportService: ${missing.join(', ')}`).toEqual([])
  })

  it('jobs Wave 1b models are FULLY covered — no exceptions consumed', () => {
    for (const m of ['JobApplication', 'ProductEvent']) {
      expect(CASCADE_SRC.includes(m), `${m} in cascade`).toBe(true)
      expect(EXPORT_SRC.includes(m), `${m} in export`).toBe(true)
      expect(m in DELETION_EXCEPTIONS).toBe(false)
      expect(m in EXPORT_LEGACY_GAPS).toBe(false)
    }
  })
})
