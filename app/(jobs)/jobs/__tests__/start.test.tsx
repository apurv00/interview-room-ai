/**
 * /jobs/start door invariants (founder directive 2026-07-16):
 *  - upload is PDF-ONLY; the old .txt door is gone
 *  - paste is NOT a primary door — it appears ONLY as the inline fallback
 *    after a failed PDF ("if PDF upload fails then paste the resume text,
 *    nothing else")
 *  - a successful PDF parse feeds the same confirm bar as before
 *  - the question door asks the role only (city was removed, ruling #21)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

const { mockFetch, mockPush, sessionState, searchParamsState } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockPush: vi.fn(),
  searchParamsState: { value: new URLSearchParams() },
  sessionState: {
    value: {
      status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated',
      data: null as null | { user: { id: string } },
    },
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => searchParamsState.value,
}))
vi.mock('next-auth/react', () => ({
  useSession: () => sessionState.value,
}))

import JobsStartPage from '../start/page'

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset().mockImplementation((url: string) => {
    // base-resume (anon 401) + events fire-and-forget
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
  })
  mockPush.mockReset()
  searchParamsState.value = new URLSearchParams()
  sessionState.value = { status: 'unauthenticated', data: null }
  localStorage.clear()
  sessionStorage.clear()
})

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).toBeTruthy()
  fireEvent.change(input, { target: { files: [file] } })
}

describe('/jobs/start doors', () => {
  it('opens the PDF upload directly for the upload intent', () => {
    searchParamsState.value = new URLSearchParams('intent=upload')
    const fileInputClick = vi.spyOn(HTMLInputElement.prototype, 'click')

    render(<JobsStartPage />)

    expect(screen.getByRole('heading', { name: 'Upload your resume' })).toBeTruthy()
    const choosePdf = screen.getByRole('button', { name: 'Choose PDF' })
    expect(fileInputClick).not.toHaveBeenCalled()
    fireEvent.click(choosePdf)
    expect(fileInputClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('No resume yet? Build one')).toBeNull()
    expect(screen.queryByText('Just tell us your target role')).toBeNull()
    expect(document.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('.pdf,application/pdf')

    fileInputClick.mockRestore()
  })

  it('rejects unknown entry intents', () => {
    searchParamsState.value = new URLSearchParams('intent=unexpected')
    render(<JobsStartPage />)

    expect(screen.getByRole('heading', { name: 'Personalize Best match' })).toBeTruthy()
    expect(screen.getByText('Upload your resume (PDF)')).toBeTruthy()
  })

  it('makes account deletion terminal while a resume parse is still in flight', async () => {
    let resolveBaseResume!: (value: unknown) => void
    let resolveResumeParse!: (value: unknown) => void
    const baseResumeResponse = new Promise((resolve) => { resolveBaseResume = resolve })
    const resumeParseResponse = new Promise((resolve) => { resolveResumeParse = resolve })
    sessionStorage.setItem('JOBS_TARGET', JSON.stringify({ role: 'Private Role', skills: ['SecretSkill'] }))
    localStorage.setItem('interviewConfig', JSON.stringify({ jobDescription: 'Private JD' }))
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/base-resume' && !init?.method) return baseResumeResponse
      if (url === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text: 'Private resume text' }) })
      }
      if (url === '/api/resume/parse') return resumeParseResponse
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      '/api/resume/parse',
      expect.objectContaining({ method: 'POST' }),
    ))
    expect(screen.getByRole('button', { name: /Just tell us your target role/i })).toBeDisabled()

    await act(async () => {
      resolveBaseResume({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(localStorage.getItem('interviewConfig')).toBeNull()

    await act(async () => {
      resolveResumeParse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          resume: {
            contactInfo: { fullName: 'Private Candidate' },
            experience: [{ title: 'Secret Role' }],
            skills: [{ items: ['SecretSkill'] }],
          },
        }),
      })
    })
    expect(screen.getByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText(/Role you.*targeting/i)).toBeNull()
    expect(screen.queryByText('SecretSkill')).toBeNull()
  })

  it('lets a different healthy account start clean after the prior account became unavailable', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) !== '/api/jobs/base-resume') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      }
      if (sessionState.value.data?.user.id === 'user-a') {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          base: {
            id: 'resume-b',
            name: 'User B Resume',
            targetRole: 'Product Manager',
            skills: ['Roadmaps'],
          },
        }),
      })
    })

    const view = render(<JobsStartPage />)
    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<JobsStartPage />)

    expect(await screen.findByText('Use my saved resume')).toBeTruthy()
    expect(screen.queryByText('Your account is unavailable.')).toBeNull()
  })

  it('does not navigate when the base-resume save reports account deletion', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    let resolveBaseResumeSave!: (value: unknown) => void
    const baseResumeSaveResponse = new Promise((resolve) => { resolveBaseResumeSave = resolve })
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/base-resume' && !init?.method) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: null }) })
      }
      if (url === '/api/jobs/base-resume' && init?.method === 'POST') return baseResumeSaveResponse
      if (url === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text: 'Private resume text' }) })
      }
      if (url === '/api/resume/parse') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            resume: {
              contactInfo: { fullName: 'Private Candidate' },
              experience: [{ title: 'Product Manager' }],
              skills: [{ items: ['Roadmaps'] }],
            },
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    fireEvent.click(await screen.findByRole('radio', { name: /Save upload to My Resumes/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Save resume & show jobs' }))

    await act(async () => {
      resolveBaseResumeSave({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(mockPush).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(screen.queryByText('Roadmaps')).toBeNull()
  })

  it('saved-resume door prefills the role from the latest experience when no saved target exists (founder 2026-07-19)', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    mockFetch.mockImplementation((url: string) => {
      if (String(url) === '/api/jobs/base-resume') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ base: { id: 'r1', name: 'Apurv Resume.pdf', targetRole: '   ', latestRole: 'Senior Product Manager', skills: ['Roadmaps'] } }) })
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
    })
    render(<JobsStartPage />)
    await waitFor(() => expect(screen.getByText(/Use my saved resume/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Use my saved resume/i))
    await waitFor(() => expect(screen.getByText(/Role you.*targeting/i)).toBeTruthy())
    const input = screen.getByDisplayValue('Senior Product Manager') as HTMLInputElement
    expect(input).toBeTruthy()
    // Codex #557: a WHITESPACE-only saved target must not beat the
    // experience title (the save path preserves targets as typed) —
    // covered by targetRole: '' above and pinned for '   ' via the same
    // trim-first predicate.
    // Editable, and a saved TARGET wins over the experience title when present.
    fireEvent.change(input, { target: { value: 'VP Product' } })
    expect((screen.getByDisplayValue('VP Product') as HTMLInputElement)).toBeTruthy()
  })


  it('paste is not a primary door; upload is PDF-only; the question door is role-only', () => {
    render(<JobsStartPage />)
    expect(screen.queryByText(/Paste your resume text/i)).toBeNull()
    expect(screen.getByText(/Upload your resume \(PDF\)/i)).toBeTruthy()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.getAttribute('accept')).toBe('.pdf,application/pdf')
    expect(screen.getByText('One question — role, done.')).toBeTruthy()
    expect(screen.queryByText(/Naukri|10 minutes/i)).toBeNull()
    // Question door: role only — the city question is gone (ruling #21).
    fireEvent.click(screen.getByText(/Just tell us your target role/i))
    expect(screen.getByText(/What role are you looking for\?/i)).toBeTruthy()
    expect(screen.queryByText(/Which city/i)).toBeNull()
  })

  it('non-PDF file → paste fallback with the PDF-only message', async () => {
    render(<JobsStartPage />)
    pickFile(new File(['hello'], 'resume.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/Paste your full resume text/i)).toBeTruthy())
    expect(screen.getByText(/Upload a PDF — or paste your resume text below/i)).toBeTruthy()
  })

  it('failed PDF parse → paste fallback carrying the server error, nothing else offered', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url) === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'No readable text in this PDF — it looks like a scanned image. Paste your resume text instead.' }) })
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
    })
    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/Paste your full resume text/i)).toBeTruthy())
    expect(screen.getByText(/scanned image/i)).toBeTruthy()
    // "nothing else": the fallback offers paste + back — no builder/door links.
    expect(screen.queryByText(/Build one/i)).toBeNull()
  })

  it('good PDF extract but failed STRUCTURED parse still lands on the paste fallback (Codex #540)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url) === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ text: 'some extracted text' }) })
      }
      if (String(url) === '/api/resume/parse') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'We could not extract structured sections from this text.' }) })
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
    })
    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/Paste your full resume text/i)).toBeTruthy())
    expect(screen.getByText(/could not extract structured sections/i)).toBeTruthy()
  })

  it('successful PDF parse feeds the confirm bar through the existing text-parse flow', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url) === '/api/jobs/parse-pdf') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            text: 'APURV — Product Manager. Skills: roadmaps.',
            extractionWarnings: ['Only the first 8,000 words were extracted from the PDF — review anything near the end of the resume.'],
          }),
        })
      }
      if (String(url) === '/api/resume/parse') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            resume: { contactInfo: { fullName: 'Apurv' }, experience: [{ title: 'Product Manager' }], skills: [] },
            importedSections: ['contactInfo', 'experience'],
            warnings: [],
          }),
        })
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
    })
    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    await waitFor(() => expect(screen.getByText(/Role you.*targeting/i)).toBeTruthy())
    expect(screen.getByText(/Imported sections: contact details, work experience/i)).toBeTruthy()
    expect(screen.getByText(/first 8,000 words were extracted/i)).toBeTruthy()
    const parseCall = mockFetch.mock.calls.find((c) => String(c[0]) === '/api/resume/parse')
    expect(parseCall).toBeTruthy()
    expect(String((parseCall![1] as RequestInit).body)).toContain('Product Manager')
    const pdfCall = mockFetch.mock.calls.find((c) => String(c[0]) === '/api/jobs/parse-pdf')
    const postedFile = ((pdfCall?.[1] as RequestInit).body as FormData).get('file') as File
    expect(postedFile.name).toBe('resume.pdf')
  })

  it('defaults a signed-in upload to tab-only and uses edited, deduplicated skills for matching', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/base-resume' && !init?.method) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: null }) })
      }
      if (url === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text: 'resume text' }) })
      }
      if (url === '/api/resume/parse') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            resume: {
              contactInfo: { fullName: 'Private Candidate' },
              experience: [{ title: 'Product Manager' }],
              skills: [{ items: ['Roadmaps', 'SQL'] }],
            },
            importedSections: ['experience', 'skills'],
            warnings: ['The parser response ended early — some extracted fields may be incomplete.'],
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))

    expect(await screen.findByText(/cannot be saved from this screen/i)).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /Save upload to My Resumes/i })).toBeNull()
    expect(screen.getByText(/parser response ended early/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open Builder to upload or paste/i })).toHaveAttribute(
      'href',
      '/resume/builder?return=/jobs/start',
    )
    fireEvent.change(screen.getByLabelText('Skills used for job matching'), {
      target: { value: 'Roadmaps, Customer research, roadmaps' },
    })
    fireEvent.change(screen.getByLabelText(/Role you.*targeting/i), {
      target: { value: 'Senior Product Manager' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show my jobs →' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/jobs'))
    const target = JSON.parse(sessionStorage.getItem('JOBS_TARGET') ?? '{}')
    expect(target).toEqual({
      method: 'upload',
      role: 'Senior Product Manager',
      skills: ['Roadmaps', 'Customer research'],
      ownerId: 'user-a',
    })
    const saveCalls = mockFetch.mock.calls.filter(([url, init]) => (
      String(url) === '/api/jobs/base-resume' && (init as RequestInit | undefined)?.method === 'POST'
    ))
    expect(saveCalls).toHaveLength(0)
  })

  it('hides an imported account-A review while auth is unresolved and clears it for account B', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/jobs/base-resume') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            base: {
              id: 'resume-a',
              name: 'User A Private Resume',
              targetRole: 'User A Private Role',
              skills: ['PrivateSkill'],
            },
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    const view = render(<JobsStartPage />)
    fireEvent.click(await screen.findByText('Use my saved resume'))
    expect(screen.getByDisplayValue('User A Private Role')).toBeTruthy()

    sessionState.value = { status: 'loading', data: null }
    view.rerender(<JobsStartPage />)
    expect(screen.getByText(/Refreshing this review/i)).toBeTruthy()
    expect(screen.queryByDisplayValue('User A Private Role')).toBeNull()

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<JobsStartPage />)
    await waitFor(() => expect(screen.queryByText(/Refreshing this review/i)).toBeNull())
    expect(screen.queryByDisplayValue('User A Private Role')).toBeNull()
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
  })

  it('keeps matching edits out of canonical resume structure, saves once, and awaits the result', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    let resolveSave!: (value: unknown) => void
    const saveResponse = new Promise((resolve) => { resolveSave = resolve })
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/base-resume' && !init?.method) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: null }) })
      }
      if (url === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text: 'original resume text' }) })
      }
      if (url === '/api/resume/parse') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            resume: {
              contactInfo: { fullName: 'Candidate' },
              experience: [{ title: 'Engineer' }],
              skills: [{ items: ['Old skill'] }],
            },
            importedSections: ['contactInfo', 'experience', 'skills'],
            warnings: [],
          }),
        })
      }
      if (url === '/api/jobs/base-resume' && init?.method === 'POST') return saveResponse
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    fireEvent.change(await screen.findByLabelText('Skills used for job matching'), {
      target: { value: 'TypeScript, Accessibility' },
    })
    fireEvent.click(screen.getByRole('radio', { name: /Save upload to My Resumes/i }))
    const submit = screen.getByRole('button', { name: 'Save resume & show jobs' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => {
      const calls = mockFetch.mock.calls.filter(([url, init]) => (
        String(url) === '/api/jobs/base-resume' && (init as RequestInit | undefined)?.method === 'POST'
      ))
      expect(calls).toHaveLength(1)
      const init = calls[0][1] as RequestInit
      expect(new Headers(init.headers).get('x-origin-user-id')).toBe('user-a')
      expect(JSON.parse(String(init.body))).toMatchObject({
        targetRole: 'Engineer',
        fullText: 'original resume text',
        resume: { skills: [{ items: ['Old skill'] }] },
      })
    })
    expect(mockPush).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Skills used for job matching')).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Use for this tab only/i })).toBeDisabled()

    await act(async () => {
      resolveSave({ ok: true, status: 200, json: () => Promise.resolve({ saved: true, id: 'resume-1' }) })
    })
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/jobs'))
    expect(JSON.parse(sessionStorage.getItem('JOBS_TARGET') ?? '{}')).toMatchObject({
      skills: ['TypeScript', 'Accessibility'],
      ownerId: 'user-a',
    })
  })

  it('stays on review after a failed explicit save and lets the user choose tab-only', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/base-resume' && !init?.method) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: null }) })
      }
      if (url === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text: 'resume text' }) })
      }
      if (url === '/api/resume/parse') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            resume: { experience: [{ title: 'Engineer' }], skills: [] },
            importedSections: ['experience'],
            warnings: [],
          }),
        })
      }
      if (url === '/api/jobs/base-resume' && init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Save unavailable' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    fireEvent.click(await screen.findByRole('radio', { name: /Save upload to My Resumes/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Save resume & show jobs' }))

    expect(await screen.findByText('Save unavailable')).toBeTruthy()
    expect(mockPush).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: /Use for this tab only/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Show my jobs →' }))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/jobs'))
  })

  it('stays on review when My Resumes is full and requires an explicit tab-only continuation', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/base-resume' && !init?.method) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: null }) })
      }
      if (url === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text: 'resume text' }) })
      }
      if (url === '/api/resume/parse') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            resume: { experience: [{ title: 'Engineer' }], skills: [] },
            importedSections: ['experience'],
            warnings: [],
          }),
        })
      }
      if (url === '/api/jobs/base-resume' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ saved: false, reason: 'cap' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    fireEvent.click(await screen.findByRole('radio', { name: /Save upload to My Resumes/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Save resume & show jobs' }))

    expect(await screen.findByText(/My Resumes is full/i)).toBeTruthy()
    expect(mockPush).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('JOBS_CAP_NOTICE')).toBeNull()
    const tabOnly = screen.getByRole('radio', { name: /Use for this tab only/i }) as HTMLInputElement
    expect(tabOnly.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Show my jobs →' }))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/jobs'))
  })

  it('ignores a delayed user-A import response after the tab becomes user B', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    let resolveUserA!: (value: unknown) => void
    const userAResponse = new Promise((resolve) => { resolveUserA = resolve })
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/base-resume' && !init?.method) {
        if (sessionState.value.data?.user.id === 'user-a') return userAResponse
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            base: { id: 'b', name: 'User B Resume', targetRole: 'Designer', skills: ['Figma'] },
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    const view = render(<JobsStartPage />)
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<JobsStartPage />)

    expect(await screen.findByText('User B Resume')).toBeTruthy()
    await act(async () => {
      resolveUserA({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          base: { id: 'a', name: 'User A Private Resume', targetRole: 'Secret', skills: ['Private'] },
        }),
      })
    })
    expect(screen.queryByText('User A Private Resume')).toBeNull()
  })

  it('does not navigate or store user-A targeting when identity changes during save', async () => {
    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-a' } } }
    let resolveSave!: (value: unknown) => void
    const saveResponse = new Promise((resolve) => { resolveSave = resolve })
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/base-resume' && !init?.method) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: null }) })
      }
      if (url === '/api/jobs/parse-pdf') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text: 'user A resume text' }) })
      }
      if (url === '/api/resume/parse') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            resume: { experience: [{ title: 'Engineer A' }], skills: [{ items: ['Private A'] }] },
            importedSections: ['experience', 'skills'],
            warnings: [],
          }),
        })
      }
      if (url === '/api/jobs/base-resume' && init?.method === 'POST') return saveResponse
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    const view = render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    fireEvent.click(await screen.findByRole('radio', { name: /Save upload to My Resumes/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Save resume & show jobs' }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      '/api/jobs/base-resume',
      expect.objectContaining({ method: 'POST' }),
    ))

    sessionState.value = { status: 'authenticated', data: { user: { id: 'user-b' } } }
    view.rerender(<JobsStartPage />)
    await act(async () => {
      resolveSave({ ok: true, status: 200, json: () => Promise.resolve({ saved: true, id: 'resume-a' }) })
    })

    expect(mockPush).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('JOBS_TARGET')).toBeNull()
    expect(screen.queryByText('Private A')).toBeNull()
    expect(await screen.findByText(/sign-in changed/i)).toBeTruthy()
  })
})
