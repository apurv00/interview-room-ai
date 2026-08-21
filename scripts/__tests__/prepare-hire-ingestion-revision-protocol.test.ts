import { describe, expect, it } from 'vitest'
import {
  assertHireIngestionRevisionMigrationWindow,
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
})
