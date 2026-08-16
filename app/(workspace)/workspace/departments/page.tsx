'use client'

/**
 * Workspace-scoped department catalog. Departments classify jobs for
 * operational tracking; they are not a member-permission boundary.
 */

import { useCallback, useEffect, useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'

interface DepartmentRow {
  id: string
  name: string
  status: 'active' | 'archived'
  kind: string
}

type MembershipRole = 'admin' | 'member'

function sortDepartments(departments: DepartmentRow[]): DepartmentRow[] {
  return [...departments].sort((left, right) => {
    if (left.status !== right.status) return left.status === 'active' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

export default function DepartmentsPage() {
  const [departments, setDepartments] = useState<DepartmentRow[] | null>(null)
  const [role, setRole] = useState<MembershipRole | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [actionBusyId, setActionBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [departmentsResponse, workspaceResponse] = await Promise.all([
        fetch('/api/workspace/departments', { cache: 'no-store' }),
        fetch('/api/workspace', { cache: 'no-store' }),
      ])
      const [departmentsData, workspaceData] = await Promise.all([
        departmentsResponse.json().catch(() => ({})),
        workspaceResponse.json().catch(() => ({})),
      ])
      if (!departmentsResponse.ok || !Array.isArray(departmentsData.departments)) {
        throw new Error(departmentsData.error || 'Could not load departments.')
      }
      if (!workspaceResponse.ok || !workspaceData.workspace) {
        throw new Error(workspaceData.error || 'Workspace membership required.')
      }
      setDepartments(sortDepartments(departmentsData.departments as DepartmentRow[]))
      setRole(workspaceData.membership?.role === 'admin' ? 'admin' : 'member')
    } catch {
      setError('Could not load departments.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function createDepartment(event: React.FormEvent) {
    event.preventDefault()
    const value = name.trim()
    if (!value) return
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/workspace/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(data.error || 'Could not add the department.')
        return
      }
      setName('')
      setNotice(`Department “${value}” added.`)
      await load()
    } catch {
      setError('Could not add the department. Check your connection.')
    } finally {
      setCreating(false)
    }
  }

  async function updateDepartment(department: DepartmentRow, action: 'archive' | 'restore') {
    setActionBusyId(department.id)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/workspace/departments/${department.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(data.error || `Could not ${action} the department.`)
        return
      }
      setNotice(
        action === 'archive'
          ? `Department “${department.name}” archived. Existing jobs retain it.`
          : `Department “${department.name}” restored.`,
      )
      await load()
    } catch {
      setError(`Could not ${action} the department. Check your connection.`)
    } finally {
      setActionBusyId(null)
    }
  }

  if (error && departments === null) {
    return <StateView state="error" error={error} onRetry={load} />
  }
  if (departments === null || role === null) {
    return <StateView state="loading" skeletonLayout="list" />
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#0f1419]">Departments</h1>
        <p className="mt-1 text-sm text-[#536471]">
          Every job belongs to one department. Departments organize hiring and reporting;
          they do not change who can access candidates or interviews.
        </p>
      </header>

      {role === 'admin' ? (
        <form
          onSubmit={createDepartment}
          className="rounded-2xl border border-[#e1e8ed] bg-white p-6 space-y-4"
        >
          <div>
            <p className="text-sm font-medium text-[#0f1419]">Add a department</p>
            <p className="mt-1 text-xs text-[#71767b]">
              Department names are permanent tracking labels. Archive a department when it
              should no longer be used for new jobs.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Input
                label="Department name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Engineering"
                required
                maxLength={120}
              />
            </div>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? 'Adding…' : 'Add department'}
            </Button>
          </div>
        </form>
      ) : (
        <p className="rounded-2xl border border-[#e1e8ed] bg-white p-4 text-sm text-[#536471]">
          Only the workspace administrator can add, archive, or restore departments.
        </p>
      )}

      {notice && (
        <p role="status" className="text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[#f4212e]">
          {error}
        </p>
      )}

      {departments.length === 0 ? (
        <StateView
          state="empty"
          title="No departments yet"
          description={
            role === 'admin'
              ? 'Add your first department before creating a job.'
              : 'Ask the workspace administrator to add a department before creating a job.'
          }
        />
      ) : (
        <div className="space-y-3">
          {departments.map((department) => {
            const isStandard = department.kind === 'standard'
            const active = department.status === 'active'
            return (
              <article
                key={department.id}
                className="flex items-center justify-between gap-4 rounded-2xl border border-[#e1e8ed] bg-white p-5"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[#0f1419]">{department.name}</p>
                  <p className="mt-1 text-xs text-[#71767b]">
                    {isStandard
                      ? active
                        ? 'Available for new jobs'
                        : 'Archived — retained for existing job history'
                      : 'System-managed — retained for historical or practice records'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={active ? 'success' : 'default'}>{department.status}</Badge>
                  {!isStandard && <Badge variant="default">{department.kind}</Badge>}
                  {role === 'admin' && isStandard && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={actionBusyId !== null}
                      onClick={() =>
                        void updateDepartment(department, active ? 'archive' : 'restore')
                      }
                    >
                      {actionBusyId === department.id
                        ? active
                          ? 'Archiving…'
                          : 'Restoring…'
                        : active
                          ? 'Archive'
                          : 'Restore'}
                    </Button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
