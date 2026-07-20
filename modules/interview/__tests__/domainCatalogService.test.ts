import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConnectDB, mockFind, mockLoggerWarn } = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockFind: vi.fn(),
  mockLoggerWarn: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({ InterviewDomain: { find: mockFind } }))
vi.mock('@shared/logger', () => ({ logger: { warn: mockLoggerWarn } }))

import { FALLBACK_DOMAINS } from '@shared/db/seed'
import { INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS } from '@shared/interviewContract'
import { getActiveInterviewDomainCatalog } from '../services/persona/domainCatalogService'

function rows(value: unknown) {
  const query = {
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  query.select.mockReturnValue(query)
  return query
}

describe('active interview domain catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnectDB.mockResolvedValue(undefined)
  })

  it('uses the exact active CMS snapshot, including custom roles and excluding inactive built-ins', async () => {
    mockFind.mockReturnValue(rows([
      { slug: 'custom-quant-role' },
      { slug: 'backend' },
      { slug: 'custom-quant-role' },
    ]))

    const catalog = await getActiveInterviewDomainCatalog()

    expect(mockFind).toHaveBeenCalledWith({ isActive: true })
    expect(catalog.slugs).toEqual(['backend', 'custom-quant-role'])
    expect(catalog.slugSet.has('custom-quant-role')).toBe(true)
    expect(catalog.inferenceSlugSet.has('custom-quant-role')).toBe(true)
    expect(catalog.slugSet.has('frontend')).toBe(false)
    expect(catalog.revision).toMatch(/^jd-role-v2:/)
    expect(catalog).toMatchObject({ authoritative: true, source: 'cms' })
  })

  it.each(['empty', 'unavailable'] as const)('uses seed fallback when the CMS catalog is %s', async (state) => {
    if (state === 'empty') mockFind.mockReturnValue(rows([]))
    else mockConnectDB.mockRejectedValue(new Error('database unavailable'))

    const catalog = await getActiveInterviewDomainCatalog()

    expect(catalog.slugs).toEqual(
      FALLBACK_DOMAINS.map((domain) => domain.slug).sort(),
    )
    expect(catalog).toMatchObject({
      authoritative: false,
      source: 'seed-fallback',
      fallbackReason: state === 'empty' ? 'empty' : 'unavailable',
    })
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  it.each([
    INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS,
    INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS + 1,
  ])('keeps %i active CMS roles authoritative while bounding only inference', async (activeCount) => {
    mockFind.mockReturnValue(rows(Array.from(
      { length: activeCount },
      (_, index) => ({ slug: `role-${String(index).padStart(3, '0')}` }),
    )))

    const catalog = await getActiveInterviewDomainCatalog()

    expect(catalog).toMatchObject({
      authoritative: true,
      source: 'cms',
    })
    expect(catalog.slugSet.size).toBe(activeCount)
    expect(catalog.slugs).toHaveLength(Math.min(
      activeCount,
      INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS,
    ))
    expect(catalog.inferenceSlugSet.size).toBe(catalog.slugs.length)
    if (activeCount > INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS) {
      expect(catalog.slugSet.has(`role-${INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS}`)).toBe(true)
      expect(catalog.inferenceSlugSet.has(`role-${INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS}`)).toBe(false)
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ promptMax: INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS }),
        expect.stringMatching(/prompt cap/i),
      )
    } else {
      expect(mockLoggerWarn).not.toHaveBeenCalled()
    }
  })

  it('makes revisions order-independent and changes them with the active set', async () => {
    mockFind.mockReturnValueOnce(rows([{ slug: 'backend' }, { slug: 'frontend' }]))
    const first = await getActiveInterviewDomainCatalog()
    mockFind.mockReturnValueOnce(rows([{ slug: 'frontend' }, { slug: 'backend' }]))
    const reordered = await getActiveInterviewDomainCatalog()
    mockFind.mockReturnValueOnce(rows([{ slug: 'frontend' }, { slug: 'product' }]))
    const changed = await getActiveInterviewDomainCatalog()

    expect(reordered.revision).toBe(first.revision)
    expect(changed.revision).not.toBe(first.revision)
  })
})
