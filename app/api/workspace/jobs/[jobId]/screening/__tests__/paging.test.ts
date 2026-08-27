import { describe, expect, it } from 'vitest'
import {
  decodeScreeningBatchCursor,
  decodeScreeningHistoryCursor,
  encodeScreeningBatchCursor,
  encodeScreeningHistoryCursor,
  encodeScreeningPreviewPageCursor,
  screeningPreviewPageOffset,
} from '../_lib/paging'

const scope = {
  workspaceId: '111111111111111111111111',
  jobId: '222222222222222222222222',
  memberId: '333333333333333333333333',
}
const fingerprint = 'a'.repeat(64)

describe('screening page cursors', () => {
  it('authenticates preview scope, member, fingerprint, and offset', () => {
    const cursor = encodeScreeningPreviewPageCursor({
      ...scope,
      fingerprint,
      scope: 'evaluated',
      offset: 50,
    })

    expect(screeningPreviewPageOffset({
      ...scope,
      scope: 'evaluated',
      cursor,
      expectedFingerprint: fingerprint,
      currentFingerprint: fingerprint,
    })).toBe(50)
    expect(() => screeningPreviewPageOffset({
      ...scope,
      memberId: '444444444444444444444444',
      scope: 'evaluated',
      cursor,
      expectedFingerprint: fingerprint,
      currentFingerprint: fingerprint,
    })).toThrow(expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }))
    expect(() => screeningPreviewPageOffset({
      ...scope,
      scope: 'evaluated',
      cursor,
      expectedFingerprint: fingerprint,
      currentFingerprint: 'b'.repeat(64),
    })).toThrow(expect.objectContaining({ code: 'SCREENING_PREVIEW_STALE' }))
  })

  it('binds history cursors to the exact page size and tenant scope', () => {
    const coordinate = {
      confirmedAt: new Date('2026-08-27T08:00:00.000Z'),
      id: '555555555555555555555555',
    }
    const cursor = encodeScreeningHistoryCursor(coordinate, scope, 10)

    expect(decodeScreeningHistoryCursor(cursor, scope, 10)).toEqual(coordinate)
    expect(() => decodeScreeningHistoryCursor(cursor, scope, 25)).toThrow(
      expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }),
    )
    expect(() => decodeScreeningHistoryCursor(
      cursor,
      { ...scope, jobId: '666666666666666666666666' },
      10,
    )).toThrow(expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }))
  })

  it('binds batch cursors to gate, page size, member, and job', () => {
    const coordinate = { wave: 9, id: '555555555555555555555555' }
    const batchScope = { ...scope, gateId: '777777777777777777777777' }
    const cursor = encodeScreeningBatchCursor(coordinate, batchScope, 10)

    expect(decodeScreeningBatchCursor(cursor, batchScope, 10)).toEqual(coordinate)
    expect(() => decodeScreeningBatchCursor(
      cursor,
      { ...batchScope, gateId: '888888888888888888888888' },
      10,
    )).toThrow(expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }))
    expect(() => decodeScreeningBatchCursor(cursor, batchScope, 25)).toThrow(
      expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }),
    )
  })
})
