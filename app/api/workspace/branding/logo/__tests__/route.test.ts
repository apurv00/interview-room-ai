import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  readLogo: vi.fn(),
  uploadLogo: vi.fn(),
  serializeMembership: vi.fn(),
}))

vi.mock('../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (req: Request) => {
    const body = options.schema ? options.schema.parse(await req.json()) : {}
    return options.handler(req, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
      body,
      params: {},
    })
  },
}))

vi.mock('../../../_lib/serialize', () => ({
  serializeMembership: mocks.serializeMembership,
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
}))

vi.mock('@hire-branding', () => ({
  readHireWorkspaceLogo: mocks.readLogo,
  uploadHireWorkspaceLogo: mocks.uploadLogo,
  UploadHireWorkspaceLogoSchema: { parse: (value: unknown) => value },
}))

import { GET, PUT } from '../route'

const ctx = {
  workspace: { _id: { toString: () => '111111111111111111111111' } },
  membership: { role: 'admin' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue(ctx)
  mocks.readLogo.mockResolvedValue({
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    contentType: 'image/png',
    updatedAt: new Date('2026-08-16T12:00:00.000Z'),
  })
  mocks.uploadLogo.mockResolvedValue({ _id: 'workspace-1' })
  mocks.serializeMembership.mockReturnValue({
    workspace: { name: 'Acme', companyLogo: { updatedAt: '2026-08-16T12:00:00.000Z' } },
  })
})

describe('private workspace branding logo route', () => {
  it('streams logo bytes only through membership and no-store security headers', async () => {
    const response = await GET(
      new Request('https://hire.example/api/workspace/branding/logo') as never,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.readLogo).toHaveBeenCalledWith(ctx)
  })

  it('returns an opaque private 404 without a logo', async () => {
    mocks.readLogo.mockResolvedValue(null)

    const response = await GET(
      new Request('https://hire.example/api/workspace/branding/logo') as never,
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('passes a bounded upload payload only through the admin branding service', async () => {
    const response = await PUT(
      new Request('https://hire.example/api/workspace/branding/logo', {
        method: 'PUT',
        body: JSON.stringify({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
      }) as never,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.uploadLogo).toHaveBeenCalledWith(ctx, {
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })
    await expect(response.json()).resolves.toMatchObject({ workspace: { name: 'Acme' } })
  })
})
