import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { InterviewConfigSchema } from '../validators/interview'
import { InterviewSession } from '@shared/db/models/InterviewSession'

/**
 * Attribution round-trip guard (jobs plan Wave 0.2 — the package-4 deliverable
 * that must exist BEFORE any UI writes attribution).
 *
 * Why this test is paranoid: BOTH persistence boundaries silently strip
 * unknown keys — Zod (InterviewConfigSchema) and Mongoose (strict mode).
 * `pathwayContext` is the proof precedent: validated by Zod, absent from the
 * Mongoose config subdoc, therefore never persisted, with zero errors. All
 * three 60-day jobs verdict metrics read `InterviewSession.attribution`; if
 * any layer drops it, the metrics go dark silently. Each layer is asserted
 * here independently so a regression names its own boundary.
 */

const ATTRIBUTION = { source: 'jobs' as const, jobId: 'job_abc123', applicationId: 'app_xyz789' }

const VALID_CONFIG = {
  role: 'Backend Engineer',
  experience: '0-2' as const,
  duration: 15,
  jobDescription: 'We need a backend engineer who knows Node.',
  attribution: ATTRIBUTION,
}

describe('attribution round-trip (Wave 0.2)', () => {
  it('layer 1 — Zod: InterviewConfigSchema keeps attribution intact', () => {
    const parsed = InterviewConfigSchema.parse(VALID_CONFIG)
    expect(parsed.attribution).toEqual(ATTRIBUTION)
  })

  it('layer 1b — Zod: applicationId is optional, malformed source rejected', () => {
    const { applicationId: _omitted, ...noAppId } = ATTRIBUTION
    expect(
      InterviewConfigSchema.parse({ ...VALID_CONFIG, attribution: noAppId }).attribution
    ).toEqual(noAppId)
    expect(
      InterviewConfigSchema.safeParse({
        ...VALID_CONFIG,
        attribution: { source: 'evil', jobId: 'x' },
      }).success
    ).toBe(false)
  })

  it('layer 2 — Mongoose: the schema persists attribution (no strict-mode strip)', () => {
    // Offline doc construction — no DB needed; strict-mode stripping happens
    // right here at assignment. This is the exact layer that ate pathwayContext.
    const doc = new InterviewSession({
      userId: '64b7f1f77bcf86cd79943901',
      config: { role: 'Backend Engineer', experience: '0-2', duration: 15 },
      attribution: ATTRIBUTION,
    })
    const obj = doc.toObject() as { attribution?: typeof ATTRIBUTION }
    expect(obj.attribution).toBeDefined()
    expect(obj.attribution?.source).toBe('jobs')
    expect(obj.attribution?.jobId).toBe('job_abc123')
    expect(obj.attribution?.applicationId).toBe('app_xyz789')
  })

  it('layer 2b — Mongoose: pathwayContext precedent still strips (documents WHY this test exists)', () => {
    const doc = new InterviewSession({
      userId: '64b7f1f77bcf86cd79943901',
      config: {
        role: 'Backend Engineer', experience: '0-2', duration: 15,
        pathwayContext: { source: 'pathway' },
      },
    })
    const obj = doc.toObject() as { config: Record<string, unknown> }
    // If this ever starts PASSING pathwayContext through, the strict-mode
    // assumption this whole test rests on has changed — re-audit both layers.
    expect(obj.config.pathwayContext).toBeUndefined()
  })

  it('layer 3 — service promotion line exists in createSession (tripwire)', () => {
    // The passthrough is plain JS that neither Zod nor Mongoose can guard;
    // a deleted line = attribution silently never persisted. Crude but
    // effective: the source must contain the promotion.
    const src = fs.readFileSync(
      path.join(__dirname, '../services/core/interviewService.ts'),
      'utf8'
    )
    expect(src).toMatch(/attribution:\s*input\.config\.attribution/)
  })
})
