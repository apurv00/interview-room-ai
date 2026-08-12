import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HireCandidate, type IHireCandidate } from '../models/HireCandidate'
import { serializeCandidate } from '../../../app/api/workspace/_lib/serialize'

describe('HireCandidate creator identity', () => {
  it('keeps the B2C creator optional and makes Hire attribution immutable', () => {
    const legacyCreator = HireCandidate.schema.path('createdBy')
    const memberCreator = HireCandidate.schema.path('createdByMemberId')
    const creatorName = HireCandidate.schema.path('createdByName')

    expect(legacyCreator.options.ref).toBe('User')
    expect(legacyCreator.options.required).not.toBe(true)
    expect(legacyCreator.options.immutable).toBe(true)
    expect(memberCreator.options.ref).toBe('HireWorkspaceMember')
    expect(memberCreator.options.immutable).toBe(true)
    expect(creatorName.options.immutable).toBe(true)
  })

  it('serializes only the Hire-owned creator identity', () => {
    const candidate = {
      _id: { toString: () => 'candidate-1' },
      name: 'Jane Candidate',
      email: 'jane@example.com',
      source: 'manual',
      createdBy: { toString: () => 'legacy-user-1' },
      createdByMemberId: { toString: () => 'member-1' },
      createdByName: 'Recruiter Snapshot',
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
    } as unknown as IHireCandidate

    const output = serializeCandidate(candidate)

    expect(output).toMatchObject({
      createdByMemberId: 'member-1',
      createdByName: 'Recruiter Snapshot',
    })
    expect(output).not.toHaveProperty('createdBy')
  })

  it('uses the Hire member API boundary and never resolves candidate email against User', () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), 'app/api/workspace/candidates/route.ts'),
      'utf8',
    )
    const service = fs.readFileSync(
      path.join(process.cwd(), 'modules/hire/services/pipelineService.ts'),
      'utf8',
    )

    expect(route).toContain("from '../_lib/composeHireApiRoute'")
    expect(route).not.toContain('@shared/middleware/composeApiRoute')
    expect(service).not.toMatch(/\bUser\s*\.(?:find|findOne|exists|aggregate)\s*\(/)
  })
})
