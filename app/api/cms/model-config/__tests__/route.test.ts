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
  TASK_SLOTS: ['jobs.evaluate-posting'],
  TASK_SLOT_DEFAULTS: {
    'jobs.evaluate-posting': {
      model: 'gpt-5.6-luna',
      provider: 'openai',
      maxTokens: 800,
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

function requestWith(slot: Record<string, unknown>, routingEnabled = true) {
  return new NextRequest('http://localhost/api/cms/model-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routingEnabled,
      slots: [{
        taskSlot: 'jobs.evaluate-posting',
        model: 'gpt-5.6-luna',
        provider: 'openai',
        maxTokens: 800,
        isActive: true,
        ...slot,
      }],
    }),
  })
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

  it('rejects an incomplete fallback pair instead of storing an unused field', async () => {
    const response = await PUT(requestWith({ fallbackProvider: 'anthropic' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'slots.0 must set fallbackModel and fallbackProvider together',
    })
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('persists and publishes a runnable provider configuration', async () => {
    const response = await PUT(requestWith({
      fallbackModel: 'claude-sonnet-4-6',
      fallbackProvider: 'anthropic',
    }))

    expect(response.status).toBe(200)
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {},
      {
        $set: expect.objectContaining({
          routingEnabled: true,
          slots: [expect.objectContaining({
            provider: 'openai',
            fallbackProvider: 'anthropic',
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
