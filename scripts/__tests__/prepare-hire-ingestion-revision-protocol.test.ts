import { describe, expect, it, vi } from 'vitest'
import {
  assertHireIngestionRevisionMigrationWindow,
  assertNoAmbiguousLegacyRuntimePublisherRows,
  hireIngestionRevisionMigrationSurface,
  hireIngestionRevisionPreparationMode,
} from '../prepare-hire-ingestion-revision-protocol'

const NOW = new Date('2026-08-21T12:00:00.000Z')

describe('Hire ingestion revision migration command', () => {
  it('parses only explicit plan, check, and apply modes', () => {
    expect(hireIngestionRevisionPreparationMode([])).toBe('plan')
    expect(hireIngestionRevisionPreparationMode(['--check'])).toBe('check')
    expect(hireIngestionRevisionPreparationMode(['--apply'])).toBe('apply')
    expect(() =>
      hireIngestionRevisionPreparationMode(['--apply', '--check']),
    ).toThrow('usage')
  })

  it('uses the same exact runtime surface identity as the deployment boundary', () => {
    expect(
      hireIngestionRevisionMigrationSurface({ IPG_SURFACE: 'hire-control' }),
    ).toBe('hire-control')
    expect(
      hireIngestionRevisionMigrationSurface({ IPG_SURFACE: 'hire-engine' }),
    ).toBe('hire-engine')
    expect(() =>
      hireIngestionRevisionMigrationSurface({ IPG_SURFACE: 'hire-runtime' }),
    ).toThrow('hire-control or hire-engine')
    expect(() =>
      hireIngestionRevisionMigrationSurface({
        IPG_SURFACE: ' hire-engine ',
      }),
    ).toThrow('hire-control or hire-engine')
  })

  it('refuses index mutation until ingress has drained for six minutes', () => {
    expect(() =>
      assertHireIngestionRevisionMigrationWindow({
        environment: {
          HIRE_INGESTION_REVISION_PROTOCOL_MODE: 'required',
        },
        now: NOW,
      }),
    ).toThrow('draining')
    expect(() =>
      assertHireIngestionRevisionMigrationWindow({
        environment: {
          HIRE_INGESTION_REVISION_PROTOCOL_MODE: 'draining',
          HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT:
            '2026-08-21T11:55:00.000Z',
        },
        now: NOW,
      }),
    ).toThrow('at least')
    expect(() =>
      assertHireIngestionRevisionMigrationWindow({
        environment: {
          HIRE_INGESTION_REVISION_PROTOCOL_MODE: 'draining',
          HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT:
            '2026-08-21T11:54:00.000Z',
        },
        now: NOW,
      }),
    ).not.toThrow()
  })

  it('blocks attempted legacy publishers that have no immutable payload snapshot', async () => {
    const countResultBindings = vi.fn().mockResolvedValue(1)
    const countAnalysisOutboxes = vi.fn().mockResolvedValue(2)

    await expect(assertNoAmbiguousLegacyRuntimePublisherRows({
      countResultBindings,
      countAnalysisOutboxes,
    })).rejects.toThrow('results=1, analyses=2')
    expect(countResultBindings).toHaveBeenCalledWith({
      status: { $in: ['active', 'completed', 'revoked'] },
      purgePersonalData: { $ne: true },
      pendingResultPayloadJson: { $exists: false },
      $or: [
        { pendingMediaManifest: { $exists: true } },
        {
          publishedRevision: { $gte: 1, $lt: 10 },
          cameraMediaStatus: 'pending',
        },
        {
          publishedRevision: { $gte: 1, $lt: 10 },
          screenMediaStatus: 'pending',
        },
        {
          publishedRevision: { $gte: 1, $lt: 10 },
          cameraMediaStatus: 'unavailable',
          cameraMediaUnavailableReportedAt: { $exists: false },
        },
        {
          publishedRevision: { $gte: 1, $lt: 10 },
          screenMediaStatus: 'unavailable',
          screenMediaUnavailableReportedAt: { $exists: false },
        },
      ],
    })
    expect(countAnalysisOutboxes).toHaveBeenCalledWith({
      status: 'pending',
      publishAttemptCount: { $gt: 0 },
      payloadSnapshotJson: { $exists: false },
      payloadSnapshotProtocolVersion: { $ne: 1 },
    })
  })

  it('allows only a clean legacy publisher inventory', async () => {
    await expect(assertNoAmbiguousLegacyRuntimePublisherRows({
      countResultBindings: vi.fn().mockResolvedValue(0),
      countAnalysisOutboxes: vi.fn().mockResolvedValue(0),
    })).resolves.toBeUndefined()
  })
})
