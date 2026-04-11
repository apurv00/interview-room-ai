'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import ResumeEditor from '@resume/components/ResumeEditor'
import type { ResumeData } from '@resume/validators/resume'
import { useAuthGate } from '@shared/providers/AuthGateProvider'

const ANON_DRAFT_KEY = 'resume:draft:anon'

/** A draft has "meaningful content" if it contains any PII or user-typed resume
 *  data — not just a template selection. We only prompt the user to import a
 *  draft when it's non-trivial; empty drafts are silently cleared. This is the
 *  check that gates whether we risk showing another user's data. */
function hasMeaningfulContent(draft: Partial<ResumeData> | null | undefined): boolean {
  if (!draft) return false
  const contact = draft.contactInfo
  if (contact && (contact.fullName || contact.email || contact.phone || contact.location)) {
    return true
  }
  if (draft.summary && draft.summary.trim()) return true
  if (draft.experience && draft.experience.length > 0) return true
  if (draft.education && draft.education.length > 0) return true
  if (draft.skills && draft.skills.length > 0) return true
  if (draft.projects && draft.projects.length > 0) return true
  if (draft.certifications && draft.certifications.length > 0) return true
  return false
}

function safeParseDraft(raw: string | null): Partial<ResumeData> | null {
  if (!raw) return null
  try { return JSON.parse(raw) as Partial<ResumeData> } catch { return null }
}

export default function ResumeBuilderPage() {
  const searchParams = useSearchParams()
  const { status: authStatus, data: session } = useSession()
  const { requireAuth } = useAuthGate()
  const [initialData, setInitialData] = useState<Partial<ResumeData> | null>(null)
  const [resumeId, setResumeId] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  /** When an authenticated user arrives and a non-trivial anonymous draft
   *  exists in localStorage, we hold it here and ask the user whether to
   *  import it. We NEVER auto-hydrate it into the editor, because the draft
   *  may belong to a previous visitor on the same browser (PII leak). */
  const [pendingAnonDraft, setPendingAnonDraft] = useState<Partial<ResumeData> | null>(null)

  useEffect(() => {
    if (authStatus === 'loading') return

    const editId = searchParams.get('id')
    const template = searchParams.get('template')

    // Anonymous: hydrate from localStorage draft (if any) or start fresh.
    // This is safe because the draft, if present, belongs to whoever is
    // currently using the browser — there is no prior identity to confuse it
    // with.
    if (authStatus === 'unauthenticated') {
      const draft = safeParseDraft(localStorage.getItem(ANON_DRAFT_KEY))
      setInitialData(draft ?? { template: template || 'professional' })
      setLoading(false)
      return
    }

    // Authenticated: load existing resume by id, or fresh.
    if (editId) {
      fetch('/api/resume/save')
        .then(r => r.json())
        .then(data => {
          const resume = data.resumes?.find((r: { id: string }) => r.id === editId)
          if (resume) {
            fetch(`/api/resume/save?id=${editId}`)
              .then(r => r.json())
              .then(async (fullData) => {
                const hasStructuredContent = !!(
                  fullData.summary ||
                  fullData.experience?.length ||
                  fullData.education?.length ||
                  fullData.skills?.length ||
                  (fullData.contactInfo?.fullName && fullData.contactInfo.fullName !== '')
                )
                if (!hasStructuredContent && fullData.fullText) {
                  try {
                    const parseRes = await fetch('/api/resume/parse', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text: fullData.fullText }),
                    })
                    if (parseRes.ok) {
                      const structured = await parseRes.json()
                      const mergedData = { ...fullData, ...structured }
                      setInitialData(mergedData)
                      setResumeId(editId)
                      setLoading(false)
                      fetch('/api/resume/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...mergedData, id: editId, name: mergedData.name || 'Untitled Resume' }),
                      }).catch(() => {})
                      return
                    }
                  } catch { /* fallback to raw data */ }
                }
                setInitialData(fullData)
                setResumeId(editId)
                setLoading(false)
              })
              .catch(() => {
                setInitialData({ template: template || 'professional' })
                setLoading(false)
              })
          } else {
            setInitialData({ template: template || 'professional' })
            setLoading(false)
          }
        })
        .catch(() => {
          setInitialData({ template: template || 'professional' })
          setLoading(false)
        })
    } else {
      // Authenticated, no editId. An anonymous draft may exist in
      // localStorage from an earlier visit on this browser — possibly by a
      // DIFFERENT user. We must NOT hydrate it blindly (would leak PII).
      // Instead:
      //   - If the draft has meaningful content, stash it and prompt the
      //     user to decide whether it's theirs (import or discard).
      //   - Otherwise it's just a template selection — silently drop it.
      const draft = safeParseDraft(localStorage.getItem(ANON_DRAFT_KEY))
      if (draft && hasMeaningfulContent(draft)) {
        setPendingAnonDraft(draft)
        setInitialData({ template: template || 'professional' })
      } else {
        if (draft) {
          try { localStorage.removeItem(ANON_DRAFT_KEY) } catch { /* ignore */ }
        }
        setInitialData({ template: template || 'professional' })
      }
      setLoading(false)
    }
  // session.user.id is included so a sign-in transition re-runs the import
  // prompt check against whoever is now signed in.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, searchParams, session?.user?.id])

  const importAnonDraft = useCallback(() => {
    if (!pendingAnonDraft) return
    setInitialData(pendingAnonDraft)
    setPendingAnonDraft(null)
    try { localStorage.removeItem(ANON_DRAFT_KEY) } catch { /* ignore */ }
  }, [pendingAnonDraft])

  const discardAnonDraft = useCallback(() => {
    setPendingAnonDraft(null)
    try { localStorage.removeItem(ANON_DRAFT_KEY) } catch { /* ignore */ }
  }, [])

  const persistAnonDraft = useCallback((data: ResumeData) => {
    try { localStorage.setItem(ANON_DRAFT_KEY, JSON.stringify(data)) } catch { /* quota */ }
  }, [])

  const handleSave = useCallback(
    async (data: ResumeData): Promise<{ id?: string; error?: string; code?: string }> => {
      // Anonymous: persist locally and prompt for sign-in.
      if (authStatus !== 'authenticated') {
        persistAnonDraft(data)
        return new Promise((resolve) => {
          requireAuth('save_resume', () => {
            // After auth (which redirects via OAuth), this callback rarely fires
            // because the page reloads. Resolve with a soft error so the editor
            // shows a friendly state in the meantime.
            resolve({ error: 'Sign in to save to the cloud' })
          })
          // If user dismisses modal, the resolver above never fires; resolve here.
          setTimeout(() => resolve({ error: 'Sign in to save to the cloud' }), 300)
        })
      }

      try {
        const res = await fetch('/api/resume/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...data, id: resumeId }),
        })
        const result = await res.json()
        if (!res.ok) {
          return { error: result.error || 'Save failed', code: result.code }
        }
        if (result.id && !resumeId) {
          setResumeId(result.id)
        }
        // Clear any leftover anonymous draft now that it's persisted.
        try { localStorage.removeItem(ANON_DRAFT_KEY) } catch { /* ignore */ }
        return { id: result.id }
      } catch {
        return { error: 'Network error' }
      }
    },
    [authStatus, resumeId, requireAuth, persistAnonDraft]
  )

  if (authStatus === 'loading' || loading || !initialData) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <>
      {pendingAnonDraft && (
        <ImportAnonDraftModal
          draft={pendingAnonDraft}
          onImport={importAnonDraft}
          onDiscard={discardAnonDraft}
        />
      )}
      <ResumeEditor
        initialData={initialData}
        resumeId={resumeId}
        onSave={handleSave}
        isAnonymous={authStatus !== 'authenticated'}
        onAnonymousChange={persistAnonDraft}
      />
    </>
  )
}

/** Prompt shown to an authenticated user when a non-trivial draft exists in
 *  localStorage under the anonymous key. Shows a short preview so the user
 *  can tell at a glance whether the draft is theirs — protecting against
 *  accidentally importing a previous visitor's PII. */
function ImportAnonDraftModal({
  draft,
  onImport,
  onDiscard,
}: {
  draft: Partial<ResumeData>
  onImport: () => void
  onDiscard: () => void
}) {
  const name = draft.contactInfo?.fullName || '(no name)'
  const email = draft.contactInfo?.email || '(no email)'
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-draft-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 id="import-draft-title" className="text-lg font-semibold text-slate-900">
          Import unsaved draft?
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          We found a resume draft on this browser from before you signed in.
          Confirm it&apos;s yours before importing — if it was left by someone
          else on this device, discard it.
        </p>
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="font-medium text-slate-900">{name}</div>
          <div className="text-slate-500">{email}</div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onImport}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Import as mine
          </button>
        </div>
      </div>
    </div>
  )
}
