import { describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'

const { mockFindById, mockUpdateOne, mockParse } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockParse: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({ JobPosting: { findById: mockFindById, updateOne: mockUpdateOne } }))
vi.mock('@interview', () => ({ parseJobDescription: mockParse }))

import { getOrParseXray, xrayHashOf } from '../services/xrayService'

const JD = 'Build and operate distributed payment services at scale. Must have Node.js.'
const PARSED = { rawText: JD, company: 'PhonePe', role: 'Backend Engineer', inferredDomain: 'backend', requirements: [], keyThemes: ['payments'] }

function chain(doc: unknown) {
  mockFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) })
}

function reset() {
  for (const m of [mockFindById, mockUpdateOne, mockParse]) m.mockReset()
  mockUpdateOne.mockResolvedValue({})
  mockParse.mockResolvedValue(PARSED)
}

describe('getOrParseXray (ONE parse per posting, keyed by jdHash)', () => {
  it('first view parses via the interview parser and persists {parsedJD, parsedJDHash}', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) })
    const r = await getOrParseXray('j1')
    expect(r).toEqual({ parsed: PARSED, cached: false })
    expect(mockParse).toHaveBeenCalledWith(JD)
    const [, update] = mockUpdateOne.mock.calls[0]
    expect(update.$set.parsedJD).toBe(PARSED)
    expect(update.$set.parsedJDHash).toBe(xrayHashOf(JD))
  })

  it('cache hit on matching hash: NO second parse, no write — the parser never runs twice for one JD', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD)), parsedJD: PARSED, parsedJDHash: xrayHashOf(JD) })
    const r = await getOrParseXray('j1')
    expect(r).toEqual({ parsed: PARSED, cached: true })
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('a merged-in longer JD changes the hash → re-parse (stale X-ray never served)', async () => {
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(JD + ' Plus Kafka experience.')), parsedJD: PARSED, parsedJDHash: xrayHashOf(JD) })
    const r = await getOrParseXray('j1')
    expect(r!.cached).toBe(false)
    expect(mockParse).toHaveBeenCalledTimes(1)
  })

  it('SHORT JDs still cache — the repost hash floor must never cause per-view re-parses', async () => {
    reset()
    const shortJd = 'Tiny JD.' // < 100 chars: bodyHashOf would return null here
    chain({ _id: 'j1', status: 'open', jdCompressed: gzipSync(Buffer.from(shortJd)), parsedJD: PARSED, parsedJDHash: xrayHashOf(shortJd) })
    const r = await getOrParseXray('j1')
    expect(r!.cached).toBe(true)
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('missing posting or empty/corrupt JD → null (route 404s; nothing to parse)', async () => {
    reset()
    chain(null)
    expect(await getOrParseXray('gone')).toBeNull()
    reset()
    chain({ _id: 'j1', status: 'open', jdCompressed: undefined })
    expect(await getOrParseXray('j1')).toBeNull()
    expect(mockParse).not.toHaveBeenCalled()
  })
})
