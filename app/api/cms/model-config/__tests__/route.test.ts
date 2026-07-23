import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockConnectDB,
  mockFindOneAndUpdate,
  mockGetAllProviders,
  mockGetServerSession,
  mockReplaceModelConfigCache,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockReplaceModelConfigCache: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
}))
vi.mock('@shared/db/models', () => ({
  ModelConfig: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
  TASK_SLOTS: ['jobs.evaluate-posting', 'interview.generate-feedback'],
  TASK_SLOT_DEFAULTS: {
    'jobs.evaluate-posting': {
      model: 'gpt-5.6-luna',
      provider: 'openai',
      maxTokens: 800,
    },
    'interview.generate-feedback': {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      maxTokens: 7000,
    },
  },
}))
vi.mock('@shared/services/modelRouter', () => ({
  replaceModelConfigCache: (...args: unknown[]) => mockReplaceModelConfigCache(...args),
}))
vi.mock('@shared/services/providers', () => ({
  getAllProviders: (...args: unknown[]) => mockGetAllProviders(...args),
}))
vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn() },
}))

import { PUT } from '../route'

function requestWithSlots(slots: Array<Record<string, unknown>>, routingEnabled = true) {
  return new NextRequest('http://localhost/api/cms/model-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routingEnabled,
      slots,
    }),
  })
}

function requestWith(slot: Record<string, unknown>, routingEnabled = true) {
  return requestWithSlots([{
    taskSlot: 'jobs.evaluate-posting',
    model: 'gpt-5.6-luna',
    provider: 'openai',
    maxTokens: 800,
    isActive: true,
    ...slot,
  }], routingEnabled)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({
    user: { id: '507f1f77bcf86cd799439011', role: 'platform_admin' },
  })
  mockConnectDB.mockResolvedValue(undefined)
  mockGetAllProviders.mockReturnValue([
    { name: 'anthropic', label: 'Anthropic', configured: true },
    { name: 'openai', label: 'OpenAI', configured: true },
  ])
  mockFindOneAndUpdate.mockResolvedValue({ _id: 'config-1' })
  mockReplaceModelConfigCache.mockResolvedValue(undefined)
})

describe('PUT /api/cms/model-config provider validation', () => {
  it('rejects an unknown primary provider before persisting', async () => {
    const response = await PUT(requestWith({ provider: 'not-registered' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Unknown provider for slots.0.provider: not-registered',
    })
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('rejects an active provider that cannot run in this environment', async () => {
    mockGetAllProviders.mockReturnValue([
      { name: 'openai', label: 'OpenAI', configured: false },
    ])

    const response = await PUT(requestWith({}))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Provider "openai" is not configured',
    })
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown model', { model: 'unpriced-model', provider: 'openai' }, 'openai/unpriced-model'],
    ['a model/provider mismatch', { model: 'gpt-5.6-luna', provider: 'anthropic' }, 'anthropic/gpt-5.6-luna'],
  ])('rejects %s for the active Jobs verdict route', async (_label, slot, route) => {
    const response = await PUT(requestWith(slot))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: `Jobs verdict pricing is unavailable for ${route}`,
    })
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('rejects an incomplete fallback pair instead of storing an unused field', async () => {
    const response = await PUT(requestWith({
      taskSlot: 'interview.generate-feedback',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      maxTokens: 7000,
      fallbackProvider: 'openai',
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'slots.0 must set fallbackModel and fallbackProvider together',
    })
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('rejects duplicate task-slot authorities', async () => {
    const slot = {
      taskSlot: 'jobs.evaluate-posting',
      model: 'gpt-5.6-luna',
      provider: 'openai',
      maxTokens: 800,
      isActive: true,
    }
    const response = await PUT(requestWithSlots([slot, slot]))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Duplicate task slot: jobs.evaluate-posting',
    })
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it.each([
    [
      { fallbackModel: 'claude-sonnet-4-6', fallbackProvider: 'anthropic' },
      'Jobs task slot jobs.evaluate-posting does not accept a configured fallback',
    ],
    [
      { useToonInput: true },
      'Jobs task slot jobs.evaluate-posting does not accept TOON input',
    ],
  ])('rejects unsupported Jobs controls %#', async (slot, error) => {
    const response = await PUT(requestWith(slot))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('keeps fallback and TOON controls available outside the Jobs capability boundary', async () => {
    const response = await PUT(requestWith({
      taskSlot: 'interview.generate-feedback',
      model: 'private-unpriced-model',
      provider: 'anthropic',
      maxTokens: 7000,
      fallbackModel: 'gpt-5.6-luna',
      fallbackProvider: 'openai',
      useToonInput: true,
    }))

    expect(response.status).toBe(200)
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {},
      {
        $set: expect.objectContaining({
          routingEnabled: true,
          slots: [expect.objectContaining({
            taskSlot: 'interview.generate-feedback',
            provider: 'anthropic',
            fallbackProvider: 'openai',
            useToonInput: true,
          })],
        }),
      },
      { upsert: true, returnDocument: 'after' },
    )
    expect(mockReplaceModelConfigCache).toHaveBeenCalledWith(
      expect.objectContaining({ routingEnabled: true }),
    )
  })
})
