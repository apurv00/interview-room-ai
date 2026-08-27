import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeBulkOperationIssueCursor,
  encodeBulkOperationIssueCursor,
} from '../services/bulkOperationIssueCursor'

const scope = {
  workspaceId: '111111111111111111111111',
  jobId: '222222222222222222222222',
  operationId: '333333333333333333333333',
  memberId: '444444444444444444444444',
  limit: 50,
}
const ITEM_ID = '555555555555555555555555'

afterEach(() => {
  vi.useRealTimers()
})

describe('candidate bulk issue cursor', () => {
  it('encrypts the item coordinate and binds operation, member, and limit', () => {
    const cursor = encodeBulkOperationIssueCursor(ITEM_ID, scope)

    expect(cursor).not.toContain(ITEM_ID)
    expect(decodeBulkOperationIssueCursor(cursor, scope)).toBe(ITEM_ID)
    for (const changed of [
      { ...scope, operationId: '666666666666666666666666' },
      { ...scope, memberId: '777777777777777777777777' },
      { ...scope, limit: 100 },
    ]) {
      expect(() => decodeBulkOperationIssueCursor(cursor, changed)).toThrow(
        expect.objectContaining({ code: 'BULK_OPERATION_INVALID_CURSOR' }),
      )
    }
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`
    expect(() => decodeBulkOperationIssueCursor(tampered, scope)).toThrow(
      expect.objectContaining({ code: 'BULK_OPERATION_INVALID_CURSOR' }),
    )
  })

  it('expires tokens after seven days', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T08:00:00.000Z'))
    const cursor = encodeBulkOperationIssueCursor(ITEM_ID, scope)
    vi.setSystemTime(new Date('2026-09-04T08:00:00.000Z'))

    expect(() => decodeBulkOperationIssueCursor(cursor, scope)).toThrow(
      expect.objectContaining({ code: 'BULK_OPERATION_INVALID_CURSOR' }),
    )
  })
})
