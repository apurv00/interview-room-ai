'use client'

/**
 * Workspace entry: established members land on Overview; a user with no workspace gets the
 * create form (the creator becomes the single admin — build plan §Permission
 * model). Empty states are designed first: creating a workspace drops you
 * straight into creating your first job.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'

const LOGO_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const LOGO_MAX_BYTES = 512 * 1024

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the selected logo.'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read the selected logo.'))
        return
      }
      resolve(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

export default function WorkspaceEntryPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [hasWorkspace, setHasWorkspace] = useState(false)
  const [needsProfileCompletion, setNeedsProfileCompletion] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [companyDescription, setCompanyDescription] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [guestAuthMode, setGuestAuthMode] = useState<'magic_link' | 'otp'>('magic_link')
  const [creating, setCreating] = useState(false)
  const [workspaceCreated, setWorkspaceCreated] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/workspace')
      const data = await res.json()
      if (data.workspace) {
        const description =
          typeof data.workspace.companyDescription === 'string'
            ? data.workspace.companyDescription.trim()
            : typeof data.workspace.companyBlurb === 'string'
              ? data.workspace.companyBlurb.trim()
              : ''
        if (!description && data.membership?.role === 'admin') {
          setName(typeof data.workspace.name === 'string' ? data.workspace.name : '')
          setNeedsProfileCompletion(true)
          setHasWorkspace(false)
          return
        }
        setHasWorkspace(true)
        router.replace('/workspace/overview')
        return
      }
      setNeedsProfileCompletion(false)
      setHasWorkspace(false)
    } catch {
      setError('Could not load your workspace.')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    void load()
  }, [load])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      if (!workspaceCreated) {
        const request = needsProfileCompletion
          ? {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ companyDescription: companyDescription.trim() }),
            }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: name.trim(),
                companyDescription: companyDescription.trim(),
                guestAuthMode,
              }),
            }
        const res = await fetch('/api/workspace', {
          ...request,
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error || 'Could not create the workspace.')
          return
        }
        setWorkspaceCreated(true)
      }

      if (logoFile) {
        const dataUrl = await readFileAsDataUrl(logoFile)
        const logoResponse = await fetch('/api/workspace/branding/logo', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl }),
        })
        const logoData = await logoResponse.json().catch(() => ({}))
        if (!logoResponse.ok) {
          setError(
            logoData.error ||
              'Your workspace was created, but the logo could not be uploaded. You can retry now or add it from the dashboard.',
          )
          return
        }
      }
      window.dispatchEvent(new Event('hire-workspace-brand-updated'))
      router.replace(needsProfileCompletion ? '/workspace/overview' : '/workspace/jobs?welcome=1')
    } catch {
      setError(
        workspaceCreated
          ? 'Your workspace was created, but the logo could not be uploaded. You can retry now or add it from the dashboard.'
          : 'Could not create the workspace. Check your connection.',
      )
    } finally {
      setCreating(false)
    }
  }

  if (loading || hasWorkspace) {
    return <StateView state="loading" skeletonLayout="card" />
  }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-8 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold text-[#0f1419]">
            {needsProfileCompletion ? 'Complete your company profile' : 'Create your workspace'}
          </h1>
          <p className="text-sm text-[#536471]">
            {needsProfileCompletion
              ? 'Add the company context once so every new job description and candidate match uses the same information.'
              : 'One workspace per company. You\'ll be the admin and can add your HR team by email — interviewers and stakeholders never need accounts.'}
          </p>
        </div>
        <form onSubmit={create} className="space-y-4">
          {!needsProfileCompletion ? (
            <Input
              label="Company name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              required
              minLength={2}
              maxLength={120}
            />
          ) : null}
          <div className="space-y-1.5">
            <label htmlFor="hire-company-description" className="block text-sm font-medium text-[#0f1419]">
              Company description
            </label>
            <textarea
              id="hire-company-description"
              value={companyDescription}
              onChange={(event) => setCompanyDescription(event.target.value)}
              required
              minLength={10}
              maxLength={2000}
              rows={4}
              placeholder="What your company builds, who it serves, and why people join."
              className="w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-sm"
            />
            <p className="text-xs text-[#71767b]">
              Used as your company context across Hire and in every new job description.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="hire-company-logo" className="block text-sm font-medium text-[#0f1419]">
              Company logo <span className="font-normal text-[#71767b]">(optional)</span>
            </label>
            <input
              id="hire-company-logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null
                if (!file) {
                  setLogoFile(null)
                  return
                }
                if (!LOGO_CONTENT_TYPES.has(file.type) || file.size > LOGO_MAX_BYTES) {
                  setLogoFile(null)
                  event.currentTarget.value = ''
                  setError('Choose a PNG, JPEG, or WebP logo that is 512 KB or smaller.')
                  return
                }
                setError(null)
                setLogoFile(file)
              }}
              className="block w-full text-sm text-[#536471] file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
            />
            <p className="text-xs text-[#71767b]">
              PNG, JPEG, or WebP up to 512 KB. It stays private to your hiring workspace.
            </p>
          </div>
          {!needsProfileCompletion ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-[#0f1419]">
                How do candidates verify on interview links?
              </legend>
              <p className="text-xs text-[#71767b]">
                You can change this any time from the Team page — links already sent
                keep the mode they were sent with.
              </p>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="guestAuthMode"
                  checked={guestAuthMode === 'magic_link'}
                  onChange={() => setGuestAuthMode('magic_link')}
                  className="mt-0.5"
                />
                <span>
                  <strong>Magic link</strong> — the emailed link takes them straight to
                  the consent screen and interview. Fastest for candidates.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="guestAuthMode"
                  checked={guestAuthMode === 'otp'}
                  onChange={() => setGuestAuthMode('otp')}
                  className="mt-0.5"
                />
                <span>
                  <strong>Email code</strong> — we additionally email them a 6-digit
                  code to confirm mailbox access before the interview starts.
                </span>
              </label>
            </fieldset>
          ) : null}
          {error && <p className="text-xs text-[#f4212e]">{error}</p>}
          <Button
            type="submit"
            disabled={
              creating ||
              (!workspaceCreated &&
                (companyDescription.trim().length < 10 ||
                  (!needsProfileCompletion && name.trim().length < 2)))
            }
          >
            {creating
              ? workspaceCreated
                ? 'Uploading logo…'
                : 'Creating…'
                : workspaceCreated
                  ? logoFile
                    ? 'Retry logo upload'
                    : 'Continue to workspace'
                  : needsProfileCompletion
                    ? 'Save company profile'
                    : 'Create workspace'}
          </Button>
        </form>
      </div>
    </div>
  )
}
