import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DepartmentsPage from '../page'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DepartmentsPage', () => {
  it('lets an admin create and archive standard departments while preserving system categories', async () => {
    let productCreated = false
    let engineeringArchived = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace') return json({ membership: { role: 'admin' }, workspace: { id: 'ws-1' } })
      if (url === '/api/workspace/departments' && !init?.method) {
        return json({
          departments: [
            {
              id: 'department-1',
              name: 'Engineering',
              status: engineeringArchived ? 'archived' : 'active',
              kind: 'standard',
            },
            ...(productCreated
              ? [{ id: 'department-2', name: 'Product', status: 'active', kind: 'standard' }]
              : []),
            { id: 'department-3', name: 'Legacy import', status: 'active', kind: 'legacy' },
          ],
        })
      }
      if (url === '/api/workspace/departments' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Product' })
        productCreated = true
        return json({
          department: { id: 'department-2', name: 'Product', status: 'active', kind: 'standard' },
        }, 201)
      }
      if (url === '/api/workspace/departments/department-1') {
        expect(init).toEqual({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'archive' }),
        })
        engineeringArchived = true
        return json({
          department: { id: 'department-1', name: 'Engineering', status: 'archived', kind: 'standard' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DepartmentsPage />)

    await screen.findByRole('heading', { name: 'Departments' })
    expect(screen.getByText('Available for new jobs')).toBeInTheDocument()
    expect(screen.getByText(/System-managed — retained for historical/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument()
    const legacyRow = screen.getByText('Legacy import').closest('article')
    expect(legacyRow).not.toBeNull()
    expect(within(legacyRow as HTMLElement).queryByRole('button')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Department name'), { target: { value: 'Product' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add department' }))
    await screen.findByText('Department “Product” added.')
    expect(screen.getByText('Product')).toBeInTheDocument()

    const engineeringRow = screen.getByText('Engineering').closest('article')
    expect(engineeringRow).not.toBeNull()
    fireEvent.click(within(engineeringRow as HTMLElement).getByRole('button', { name: 'Archive' }))
    await screen.findByText('Department “Engineering” archived. Existing jobs retain it.')
    await waitFor(() => {
      expect(screen.getByText('Archived — retained for existing job history')).toBeInTheDocument()
    })
  })

  it('makes the catalog read-only for members', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace') return json({ membership: { role: 'member' }, workspace: { id: 'ws-1' } })
      if (url === '/api/workspace/departments') {
        return json({
          departments: [
            { id: 'department-1', name: 'Engineering', status: 'active', kind: 'standard' },
          ],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DepartmentsPage />)

    await screen.findByText(/Only the workspace administrator can add/i)
    expect(screen.queryByLabelText('Department name')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Archive|Restore/ })).not.toBeInTheDocument()
  })
})
