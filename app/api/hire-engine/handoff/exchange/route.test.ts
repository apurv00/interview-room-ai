import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  exchange: vi.fn(),
  provision: vi.fn(),
  ensurePrincipal: vi.fn(),
  activate: vi.fn(),
  issueTicket: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}))
vi.mock('@shared/logger', () => ({
  logger: { error: mocks.loggerError },
}))
vi.mock('@modules/hire-runtime/services/handoffAuthTicketService', () => ({
  RUNTIME_AUTH_TICKET_CONSUMED: 'consumed',
  RuntimeAuthTicketError: class RuntimeAuthTicketError extends Error {},
  issueRuntimeAuthTicket: mocks.issueTicket,
}))
vi.mock('@modules/hire-runtime/services/controlBridgeClient', async () => {
  const actual = await vi.importActual<
    typeof import('@modules/hire-runtime/services/controlBridgeClient')
  >('@modules/hire-runtime/services/controlBridgeClient')
  return { ...actual, exchangeHandoffWithControl: mocks.exchange }
})
vi.mock('@modules/hire-runtime/services/bindingService', async () => {
  const actual = await vi.importActual<
    typeof import('@modules/hire-runtime/services/bindingService')
  >('@modules/hire-runtime/services/bindingService')
  return {
    ...actual,
    provisionRuntimeBinding: mocks.provision,
    activateRuntimeBinding: mocks.activate,
  }
})
vi.mock('@modules/hire-runtime/services/runtimePrincipalService', () => ({
  ensureRuntimePrincipal: mocks.ensurePrincipal,
}))

import { POST } from './route'

const IDS = {
  workspaceId: '1'.repeat(24),
  roundId: '2'.repeat(24),
  principalId: '3'.repeat(24),
  bindingId: '4'.repeat(24),
}
const CODE = `${IDS.workspaceId}.${'a'.repeat(64)}`
const CLIENT_NONCE = 'b'.repeat(64)
const HANDOFF_NONCE = 'c'.repeat(64)
const TICKET = 'd'.repeat(64)
const ENVELOPE = {
  handoffGeneration: 1,
  nonce: HANDOFF_NONCE,
  issuedAt: '2026-08-21T00:00:00.000Z',
  expiresAt: '2026-08-21T00:01:00.000Z',
}

function objectId(value: string) {
  return { toString: () => value }
}

function request(body: Record<string, unknown>) {
  return new NextRequest('https://hire-runtime.test/api/hire-engine/handoff/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.exchange.mockResolvedValue(ENVELOPE)
  mocks.provision.mockResolvedValue({
    _id: objectId(IDS.bindingId),
    workspaceId: objectId(IDS.workspaceId),
    roundId: objectId(IDS.roundId),
    principalId: objectId(IDS.principalId),
    handoffNonce: HANDOFF_NONCE,
  })
  mocks.ensurePrincipal.mockResolvedValue({ _id: IDS.principalId })
  mocks.activate.mockResolvedValue({})
  mocks.issueTicket.mockResolvedValue(TICKET)
})

describe('POST /api/hire-engine/handoff/exchange', () => {
  it('binds the code to the browser nonce and issues one ticket identity after activation', async () => {
    const response = await POST(request({ code: CODE, clientNonce: CLIENT_NONCE }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ticket: TICKET,
      principalId: IDS.principalId,
      roundId: IDS.roundId,
    })
    expect(mocks.exchange).toHaveBeenCalledWith(CODE, CLIENT_NONCE)
    expect(mocks.activate).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      bindingId: IDS.bindingId,
    })
    expect(mocks.issueTicket).toHaveBeenCalledWith({
      bindingId: IDS.bindingId,
      principalId: IDS.principalId,
      roundId: IDS.roundId,
      workspaceId: IDS.workspaceId,
      envelope: ENVELOPE,
    })
    expect(mocks.activate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.issueTicket.mock.invocationCallOrder[0],
    )
  })

  it('rejects a bearer code that has no independent browser binding', async () => {
    const response = await POST(request({ code: CODE }))

    expect(response.status).toBe(400)
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.issueTicket).not.toHaveBeenCalled()
  })

  it('returns a terminal response when the bound ticket was already consumed', async () => {
    mocks.issueTicket.mockResolvedValue('consumed')

    const response = await POST(request({ code: CODE, clientNonce: CLIENT_NONCE }))

    expect(response.status).toBe(410)
    expect(mocks.activate).toHaveBeenCalledOnce()
  })
})
