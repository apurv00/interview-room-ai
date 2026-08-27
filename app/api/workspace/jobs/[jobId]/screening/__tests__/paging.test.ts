import { describe, expect, it, vi } from 'vitest'
import {
  decodeScreeningBatchCursor,
  decodeScreeningHistoryCursor,
  decodeScreeningRecipientCursor,
  encodeScreeningBatchCursor,
  encodeScreeningHistoryCursor,
  encodeScreeningPreviewPageCursor,
  encodeScreeningRecipientCursor,
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

  it('encrypts recipient cursors and binds member, batch, job, and page size', () => {
    const coordinate = { itemId: '555555555555555555555555' }
    const recipientScope = {
      ...scope,
      batchId: '777777777777777777777777',
    }
    const cursor = encodeScreeningRecipientCursor(
      coordinate,
      recipientScope,
      25,
    )

    expect(cursor).not.toContain(coordinate.itemId)
    expect(
      decodeScreeningRecipientCursor(cursor, recipientScope, 25),
    ).toEqual(coordinate)
    expect(() =>
      decodeScreeningRecipientCursor(
        cursor,
        { ...recipientScope, memberId: '888888888888888888888888' },
        25,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }))
    expect(() =>
      decodeScreeningRecipientCursor(
        cursor,
        { ...recipientScope, batchId: '999999999999999999999999' },
        25,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }))
    expect(() =>
      decodeScreeningRecipientCursor(cursor, recipientScope, 50),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }))
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`
    expect(() =>
      decodeScreeningRecipientCursor(tampered, recipientScope, 25),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }))
  })

  it('rejects a recipient cursor after the seven-day lifetime', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-20T08:00:00.000Z'))
      const recipientScope = {
        ...scope,
        batchId: '777777777777777777777777',
      }
      const cursor = encodeScreeningRecipientCursor(
        { itemId: '555555555555555555555555' },
        recipientScope,
        25,
      )
      vi.setSystemTime(new Date('2026-08-27T08:00:00.001Z'))

      expect(() =>
        decodeScreeningRecipientCursor(cursor, recipientScope, 25),
      ).toThrow(expect.objectContaining({ code: 'INVALID_SCREENING_CURSOR' }))
    } finally {
      vi.useRealTimers()
    }
  })
})
