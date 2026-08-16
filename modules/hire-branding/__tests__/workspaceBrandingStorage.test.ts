import { describe, expect, it } from 'vitest'
import {
  assertHireWorkspaceLogoKeyScope,
  hireWorkspaceLogoKey,
  parseHireWorkspaceLogoKey,
} from '../services/workspaceBrandingStorage'

const WORKSPACE_ID = '111111111111111111111111'

describe('workspace branding storage scope', () => {
  it('uses one deterministic, non-traversable private key per workspace', () => {
    const key = hireWorkspaceLogoKey(WORKSPACE_ID)
    expect(key).toBe(`hire-workspace-branding/${WORKSPACE_ID}/logo`)
    expect(parseHireWorkspaceLogoKey(key)).toEqual({ workspaceId: WORKSPACE_ID })
    expect(parseHireWorkspaceLogoKey(`hire-workspace-branding/${WORKSPACE_ID}/../logo`)).toBeNull()
    expect(parseHireWorkspaceLogoKey(`hire-workspace-branding/${WORKSPACE_ID}/logo%2fother`)).toBeNull()
  })

  it('rejects a key from another workspace before an object operation', () => {
    expect(() =>
      assertHireWorkspaceLogoKeyScope(
        hireWorkspaceLogoKey('222222222222222222222222'),
        WORKSPACE_ID,
      ),
    ).toThrow('outside the authorized scope')
  })
})
