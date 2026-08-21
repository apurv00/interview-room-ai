import { describe, expect, it } from 'vitest'
import {
  HIRE_INGESTION_REVISION_DRAIN_MS,
  evaluateHireIngestionRevisionProtocol,
} from '../hireIngestionRevisionProtocol'

const NOW = new Date('2026-08-21T12:00:00.000Z')

describe('Hire ingestion revision deployment interlock', () => {
  it('fails closed in production when mode is not configured', () => {
    expect(
      evaluateHireIngestionRevisionProtocol({
        requestVersion: '2',
        environment: { NODE_ENV: 'production' },
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'disabled' })
  })

  it('rejects every worker while the route is draining', () => {
    expect(
      evaluateHireIngestionRevisionProtocol({
        requestVersion: '2',
        environment: {
          NODE_ENV: 'production',
          HIRE_INGESTION_REVISION_PROTOCOL_MODE: 'draining',
        },
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'draining' })
  })

  it('requires an elapsed drain marker and the exact worker version', () => {
    const environment = {
      NODE_ENV: 'production',
      HIRE_INGESTION_REVISION_PROTOCOL_MODE: 'required',
      HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT: new Date(
        NOW.getTime() - HIRE_INGESTION_REVISION_DRAIN_MS,
      ).toISOString(),
    }
    expect(
      evaluateHireIngestionRevisionProtocol({
        requestVersion: '1',
        environment,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'version_mismatch' })
    expect(
      evaluateHireIngestionRevisionProtocol({
        requestVersion: '2',
        environment,
        now: NOW,
      }),
    ).toEqual({ ok: true })
  })
})
