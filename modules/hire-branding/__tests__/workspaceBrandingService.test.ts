import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@shared/errors'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  exists: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('../boundary', () => ({
  connectHireControlDB: (...args: unknown[]) => mocks.connect(...args),
  activeHireWorkspaceLifecycleFilter: () => ({
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }),
  HireWorkspace: {
    exists: (...args: unknown[]) => mocks.exists(...args),
    findOne: (...args: unknown[]) => mocks.findOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.findOneAndUpdate(...args),
  },
}))

vi.mock('../services/workspaceBrandingStorage', () => ({
  HIRE_WORKSPACE_LOGO_MAX_BYTES: 512 * 1024,
  hireWorkspaceLogoKey: (workspaceId: string) => `hire-workspace-branding/${workspaceId}/logo`,
  hireWorkspaceBrandingStorage: {
    upload: (...args: unknown[]) => mocks.upload(...args),
    download: (...args: unknown[]) => mocks.download(...args),
    delete: (...args: unknown[]) => mocks.remove(...args),
  },
}))

import {
  decodeHireWorkspaceLogoDataUrl,
  readHireWorkspaceLogo,
  uploadHireWorkspaceLogo,
} from '../services/workspaceBrandingService'

const WORKSPACE_ID = '111111111111111111111111'
const NOW = new Date('2026-08-16T12:00:00.000Z')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`

function adminContext() {
  return {
    workspace: { _id: { toString: () => WORKSPACE_ID } },
    membership: { role: 'admin' },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.exists.mockResolvedValue({ _id: WORKSPACE_ID })
  mocks.upload.mockResolvedValue(undefined)
  mocks.download.mockResolvedValue(PNG)
  mocks.remove.mockResolvedValue(undefined)
  mocks.findOneAndUpdate.mockResolvedValue({ _id: WORKSPACE_ID, companyLogo: { updatedAt: NOW } })
})

describe('workspace logo validation and lifecycle', () => {
  it('accepts only bytes matching the declared safe image type', () => {
    expect(decodeHireWorkspaceLogoDataUrl(PNG_DATA_URL)).toMatchObject({
      bytes: PNG,
      contentType: 'image/png',
    })
    expect(() => decodeHireWorkspaceLogoDataUrl(`data:image/jpeg;base64,${PNG.toString('base64')}`))
      .toThrow('does not match its contents')
    expect(() => decodeHireWorkspaceLogoDataUrl('data:image/svg+xml;base64,PHN2Zy8+'))
      .toThrow('PNG, JPEG, or WebP')
  })

  it('allows only an admin to upload and persists safe metadata after the private object write', async () => {
    await uploadHireWorkspaceLogo(adminContext(), { dataUrl: PNG_DATA_URL }, { now: NOW })

    expect(mocks.upload).toHaveBeenCalledWith({
      key: `hire-workspace-branding/${WORKSPACE_ID}/logo`,
      body: PNG,
      contentType: 'image/png',
    })
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything() }),
      {
        $set: {
          companyLogo: {
            contentType: 'image/png',
            byteSize: PNG.byteLength,
            updatedAt: NOW,
          },
        },
      },
      { new: true },
    )

    await expect(
      uploadHireWorkspaceLogo(
        { ...adminContext(), membership: { role: 'member' } } as never,
        { dataUrl: PNG_DATA_URL },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('reads only a current active workspace logo and returns no object key', async () => {
    mocks.findOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({
        companyLogo: { contentType: 'image/png', updatedAt: NOW },
      }),
    })

    await expect(readHireWorkspaceLogo(adminContext())).resolves.toEqual({
      bytes: PNG,
      contentType: 'image/png',
      updatedAt: NOW,
    })
    expect(mocks.download).toHaveBeenCalledWith({
      key: `hire-workspace-branding/${WORKSPACE_ID}/logo`,
    })
  })
})
