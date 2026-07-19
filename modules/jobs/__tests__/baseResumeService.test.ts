import { describe, it, expect, vi } from 'vitest'

const { mockList, mockGet, mockSave } = vi.hoisted(() => ({ mockList: vi.fn(), mockGet: vi.fn(), mockSave: vi.fn() }))
// Partial mock: the REAL ResumeSchema does the validating (that behavior is
// exactly what these tests pin); only the persistence functions are stubbed.
vi.mock('@resume', async (importOriginal) => {
  const real = await importOriginal<typeof import('@resume')>()
  return { ...real, listResumes: mockList, getResume: mockGet, saveResume: mockSave }
})

import { saveBaseResume, getBaseResume } from '../services/baseResumeService'

function reset() {
  for (const m of [mockList, mockGet, mockSave]) m.mockReset()
  mockList.mockResolvedValue({ resumes: [] })
  mockSave.mockResolvedValue({ id: 'new-id' })
}

const STRUCT = { contactInfo: { fullName: 'A', email: 'a@x.com' }, skills: [{ category: 'Tech', items: ['SQL'] }] }

describe('saveBaseResume (Stage-2 auto-save — cap-honest, dedup-by-role)', () => {
  it('creates "Base Resume — {role}" with preserveFullText (the upload text is authoritative)', async () => {
    reset()
    const r = await saveBaseResume('u1', STRUCT, 'Data Analyst', 'FULL TEXT')
    expect(r).toEqual({ saved: true, id: 'new-id', updated: false })
    const [userId, data, opts] = mockSave.mock.calls[0]
    expect(userId).toBe('u1')
    expect(data.name).toBe('Base Resume — Data Analyst')
    expect(data.targetRole).toBe('Data Analyst')
    expect(data.fullText).toBe('FULL TEXT')
    expect(data.id).toBeUndefined()
    expect(opts).toEqual({ preserveFullText: true })
  })

  it('re-upload for the SAME role UPDATES the existing base resume — never eats a cap slot', async () => {
    reset()
    mockList.mockResolvedValue({ resumes: [{ id: 'base-1', name: 'Base Resume — Data Analyst', updatedAt: '2026-07-01' }] })
    mockSave.mockResolvedValue({ id: 'base-1' })
    const r = await saveBaseResume('u1', STRUCT, 'Data Analyst')
    expect(r).toEqual({ saved: true, id: 'base-1', updated: true })
    expect(mockSave.mock.calls[0][1].id).toBe('base-1') // update path, not create
  })

  it('the 3/3 cap maps to {saved:false, reason:cap} — a notice, never a block', async () => {
    reset()
    mockSave.mockResolvedValue({ error: 'Resume limit reached. Delete an existing resume to create a new one.', code: 'RESUME_LIMIT' })
    expect(await saveBaseResume('u1', STRUCT, 'QA')).toEqual({ saved: false, reason: 'cap' })
    mockSave.mockResolvedValue({ error: 'This resume no longer exists', code: 'NOT_FOUND' })
    expect(await saveBaseResume('u1', STRUCT, 'QA')).toEqual({ saved: false, reason: 'error' })
  })
})

describe('saveBaseResume validation (same contract as /api/resume/save)', () => {
  it('malformed shapes are rejected as invalid — saveResume never sees them', async () => {
    reset()
    const r = await saveBaseResume('u1', { experience: 'not-an-array', summary: { evil: true } }, 'QA')
    expect(r).toEqual({ saved: false, reason: 'invalid' })
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('oversized fullText is clamped by the schema to its legal 100k — not truncated below it', async () => {
    reset()
    const r = await saveBaseResume('u1', STRUCT, 'QA', 'x'.repeat(150_000))
    expect(r).toMatchObject({ saved: true })
    const saved = mockSave.mock.calls[0][1]
    expect(saved.fullText).toHaveLength(100_000) // schema clamp, no 60k amputation
  })
})

describe('getBaseResume (the import door)', () => {
  it("latestRole = first non-empty experience title — the confirm bar's prefill when no saved target exists (founder 2026-07-19)", async () => {
    reset()
    mockList.mockResolvedValue({ resumes: [{ id: 'r1', name: 'Apurv Resume.pdf', updatedAt: '2026-07-19' }] })
    mockGet.mockResolvedValue({
      skills: [{ items: ['Roadmaps'] }],
      experience: [{ title: '' }, { title: '  Senior Product Manager  ' }, { title: 'Analyst' }],
    })
    const r = await getBaseResume('u1')
    expect(r!.latestRole).toBe('Senior Product Manager')
    expect(r!.targetRole).toBe('')
  })


  it('returns the most recently updated resume with a flat deduped skill list', async () => {
    reset()
    mockList.mockResolvedValue({ resumes: [
      { id: 'old', name: 'Base Resume — QA', updatedAt: '2026-06-01' },
      { id: 'newer', name: 'Base Resume — Data Analyst', targetRole: 'Data Analyst', updatedAt: '2026-07-10' },
    ] })
    mockGet.mockResolvedValue({ skills: [{ items: ['SQL', 'Tableau'] }, { items: ['SQL', ' Python '] }] })
    const r = await getBaseResume('u1')
    expect(r).toEqual({ id: 'newer', name: 'Base Resume — Data Analyst', targetRole: 'Data Analyst', latestRole: '', skills: ['SQL', 'Tableau', 'Python'] })
    expect(mockGet).toHaveBeenCalledWith('u1', 'newer')
  })

  it('no saved resumes → null (the door stays hidden)', async () => {
    reset()
    expect(await getBaseResume('u1')).toBeNull()
  })
})
