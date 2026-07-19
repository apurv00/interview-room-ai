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
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { mockFetch, mockPush } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockPush: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

import JobsStartPage from '../start/page'

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset().mockImplementation((url: string) => {
    // base-resume (anon 401) + events fire-and-forget
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
  })
  sessionStorage.clear()
})

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).toBeTruthy()
  fireEvent.change(input, { target: { files: [file] } })
}

describe('/jobs/start doors', () => {
  it('saved-resume door prefills the role from the latest experience when no saved target exists (founder 2026-07-19)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url) === '/api/jobs/base-resume') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ base: { id: 'r1', name: 'Apurv Resume.pdf', targetRole: '', latestRole: 'Senior Product Manager', skills: ['Roadmaps'] } }) })
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
    })
    render(<JobsStartPage />)
    await waitFor(() => expect(screen.getByText(/Use my saved resume/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Use my saved resume/i))
    await waitFor(() => expect(screen.getByText(/Role you.*targeting/i)).toBeTruthy())
    const input = screen.getByDisplayValue('Senior Product Manager') as HTMLInputElement
    expect(input).toBeTruthy()
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
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ text: 'APURV — Product Manager. Skills: roadmaps.' }) })
      }
      if (String(url) === '/api/resume/parse') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ resume: { contact: { name: 'Apurv' }, experience: [{ title: 'Product Manager' }], skills: [] } }),
        })
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
    })
    render(<JobsStartPage />)
    pickFile(new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }))
    await waitFor(() => expect(screen.getByText(/Role you.*targeting/i)).toBeTruthy())
    const parseCall = mockFetch.mock.calls.find((c) => String(c[0]) === '/api/resume/parse')
    expect(parseCall).toBeTruthy()
    expect(String((parseCall![1] as RequestInit).body)).toContain('Product Manager')
  })
})
