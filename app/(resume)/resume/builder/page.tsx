'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import ResumeEditor from '@resume/components/ResumeEditor'
import type { ResumeData } from '@resume/validators/resume'
import { hasStructuredResumeContent } from '@resume/lib/structuredContent'
import { useAuthGate } from '@shared/providers/AuthGateProvider'

const ANON_DRAFT_KEY = 'resume:draft:anon'

/** A draft has "meaningful content" if it contains any PII or user-typed resume
 *  data — not just a template or styling selection. We only prompt the user to
 *  import a draft when it's non-trivial; empty drafts are silently cleared.
 *  This is the check that gates whether we risk showing another user's data,
 *  AND whether we risk silently discarding a legitimate draft — so err on the
 *  side of flagging anything a user actually typed. */
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
  if (draft.customSections && draft.customSections.length > 0) return true
  if (draft.targetRole && draft.targetRole.trim()) return true
  if (draft.targetCompany && draft.targetCompany.trim()) return true
  // A non-default resume name means the user typed their own title.
  if (draft.name && draft.name.trim() && draft.name !== 'My Resume') return true
  return false
}

function safeParseDraft(raw: string | null): Partial<ResumeData> | null {
  if (!raw) return null
  try { return JSON.parse(raw) as Partial<ResumeData> } catch { return null }
}

export default function ResumeBuilderPage() {
  const searchParams = useSearchParams()
  const requestedJobId = searchParams.get('jobId')
  const requestedEditId = searchParams.get('id')
  const requestedTemplate = searchParams.get('template')
  const returnJobId = /^[a-f0-9]{24}$/i.test(requestedJobId ?? '')
    ? requestedJobId
    : null
  // The Jobs onboarding entry point currently has one legitimate generic
  // return destination. Keep this an exact allowlist instead of reflecting an
  // arbitrary query value into an href. A validated tracked-job destination
  // is more specific and therefore wins when both intents are present.
  const returnToJobsStart = !returnJobId && searchParams.get('return') === '/jobs/start'
  const { status: authStatus, data: session } = useSession()
  const sessionUserId = session?.user?.id ?? null
  const resolvedUserId = authStatus === 'authenticated' ? sessionUserId : null
  const lastSettledIdentityRef = useRef<{ initialized: boolean; userId: string | null }>({ initialized: false, userId: null })
  if (authStatus !== 'loading') {
    lastSettledIdentityRef.current = { initialized: true, userId: resolvedUserId }
  }
  // A transient session refresh is not a new owner. Keep the current editor
  // mounted but hidden until auth settles; remount only when the resolved
  // account actually changes.
  const editorOwnerId = authStatus === 'loading'
    ? (lastSettledIdentityRef.current.initialized ? lastSettledIdentityRef.current.userId : undefined)
    : resolvedUserId
  const editorIdentityKey = editorOwnerId === undefined
    ? 'pending'
    : editorOwnerId === null
      ? 'anonymous'
      : `user:${editorOwnerId}`
  const editorContextKey = [editorIdentityKey, requestedEditId ?? '', requestedTemplate ?? ''].join(':')
  const liveIdentityRef = useRef({ status: authStatus, userId: resolvedUserId })
  liveIdentityRef.current = { status: authStatus, userId: resolvedUserId }
  const { requireAuth } = useAuthGate()
  const [initialData, setInitialData] = useState<Partial<ResumeData> | null>(null)
  const [resumeId, setResumeId] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  /** When an authenticated user arrives and a non-trivial anonymous draft
   *  exists in localStorage, we hold it here and ask the user whether to
   *  import it. We NEVER auto-hydrate it into the editor, because the draft
   *  may belong to a previous visitor on the same browser (PII leak). */
  const [pendingAnonDraft, setPendingAnonDraft] = useState<Partial<ResumeData> | null>(null)
  /** True when the user already has the max number of saved resumes and is
   *  building a NEW one — warn upfront instead of failing at save time. */
  const [atResumeCap, setAtResumeCap] = useState<{ count: number; limit: number } | null>(null)
  /** Set when an edit link (?id=…) couldn't load the resume — the old code
   *  silently opened a BLANK editor, which read as "my resume was wiped". */
  const [loadNotice, setLoadNotice] = useState('')
  /** Bumped when we commit a new initialData snapshot (e.g. importing a
   *  pending anonymous draft). React uses this as the ResumeEditor's key
   *  so it fully unmounts/remounts — otherwise `useResume(initial)` would
   *  ignore the new prop since `useState` only uses its initializer once. */
  const [editorKey, setEditorKey] = useState(0)
  /** The identity + edit target whose data is currently safe to render.
   *  This render-time tag closes the frame before effects run on an account
   *  transition, and forces the stateful editor to remount for the new owner. */
  const [loadedEditorContextKey, setLoadedEditorContextKey] = useState<string | null>(null)
  const loadedEditorContextRef = useRef<string | null>(null)
  /** Whether the (re)mounted editor should start dirty — true only when the
   *  initialData is UNSAVED imported content (a claimed anonymous draft). */
  const [editorInitialDirty, setEditorInitialDirty] = useState(false)
  /** Jobs onboarding must not auto-redirect after Save: people commonly save
   *  midway through editing. This flips the context strip to a clear,
   *  user-directed continuation once a server save has actually succeeded. */
  const [jobsReturnReady, setJobsReturnReady] = useState(false)

  useEffect(() => {
    if (authStatus === 'loading') return
    if (loadedEditorContextRef.current === editorContextKey) return
    let cancelled = false
    const requestUserId = resolvedUserId
    const requestStatus = authStatus
    const isStale = () => (
      cancelled ||
      liveIdentityRef.current.status !== requestStatus ||
      liveIdentityRef.current.userId !== requestUserId
    )

    // Never leave the prior account's editor snapshot visible while the next
    // identity is loading. The async branch below repopulates only after its
    // captured identity still matches.
    setLoading(true)
    setInitialData(null)
    setResumeId(undefined)
    setPendingAnonDraft(null)
    setJobsReturnReady(false)
    setEditorInitialDirty(false)
    setLoadNotice('')
    setAtResumeCap(null)
    loadedEditorContextRef.current = null
    setLoadedEditorContextKey(null)

    const editId = requestedEditId
    const template = requestedTemplate
    const markEditorContextLoaded = () => {
      loadedEditorContextRef.current = editorContextKey
      setLoadedEditorContextKey(editorContextKey)
    }

    // Anonymous: hydrate from localStorage draft (if any) or start fresh.
    // This is safe because the draft, if present, belongs to whoever is
    // currently using the browser — there is no prior identity to confuse it
    // with.
    if (authStatus === 'unauthenticated') {
      const draft = safeParseDraft(localStorage.getItem(ANON_DRAFT_KEY))
      setInitialData(draft ?? { template: template || 'professional' })
      markEditorContextLoaded()
      setLoading(false)
      return () => { cancelled = true }
    }

    const identityHeaders = requestUserId ? { 'x-origin-user-id': requestUserId } : undefined

    async function loadAuthenticatedResume() {
      if (!editId) {
        // Authenticated, no editId. An anonymous draft may belong to a
        // different browser user, so ask before hydrating meaningful content.
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
        markEditorContextLoaded()
        setLoading(false)
        return
      }

      try {
        const listResponse = await fetch('/api/resume/save', { headers: identityHeaders })
        if (!listResponse.ok) throw new Error(`list fetch ${listResponse.status}`)
        const data = await listResponse.json()
        if (isStale()) return
        const resume = data.resumes?.find((row: { id: string }) => row.id === editId)
        if (!resume) {
          setLoadNotice('That resume could not be found — it may have been deleted. This editor started blank.')
          setInitialData({ template: template || 'professional' })
          markEditorContextLoaded()
          setLoading(false)
          return
        }

        const detailResponse = await fetch(`/api/resume/save?id=${editId}`, { headers: identityHeaders })
        if (!detailResponse.ok) throw new Error(`detail fetch ${detailResponse.status}`)
        const fullData = await detailResponse.json()
        if (isStale()) return

        // Shared predicate (covers projects/certs/custom sections too): a
        // projects-only resume is already structured and must not be reparsed.
        if (!hasStructuredResumeContent(fullData) && fullData.fullText) {
          try {
            const parseRes = await fetch('/api/resume/parse', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: fullData.fullText }),
            })
            if (parseRes.ok) {
              const parsed = await parseRes.json()
              if (isStale()) return
              const structured = parsed.resume ?? {}
              const mergedData = { ...fullData, ...structured }
              setInitialData(mergedData)
              setResumeId(editId)
              markEditorContextLoaded()
              setLoading(false)
              if (parsed.warning) {
                setLoadNotice(`We structured most of this resume, but ${parsed.warning} Your original text is preserved — review the sections and Save when they look right.`)
              } else if (requestUserId) {
                // Bind the background upgrade to the same identity that read
                // the resume. A session switch makes the server reject it.
                fetch('/api/resume/save', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ...mergedData,
                    id: editId,
                    name: mergedData.name || 'Untitled Resume',
                    preserveFullText: true,
                    originUserId: requestUserId,
                  }),
                }).catch(() => {})
              }
              return
            }
          } catch { /* fall back to the authoritative saved data */ }
        }
        if (isStale()) return
        setInitialData(fullData)
        setResumeId(editId)
        markEditorContextLoaded()
        setLoading(false)
      } catch {
        if (isStale()) return
        setLoadNotice('Could not load your resume (network error) — your saved copy is unchanged. This editor started blank; reload the page to try again.')
        setInitialData({ template: template || 'professional' })
        markEditorContextLoaded()
        setLoading(false)
      }
    }

    void loadAuthenticatedResume()
    return () => { cancelled = true }
  // session.user.id is included so a sign-in transition re-runs the import
  // prompt check against whoever is now signed in.
  }, [authStatus, editorContextKey, requestedEditId, requestedTemplate, resolvedUserId])

  // Building a NEW resume while already at the cap previously surfaced
  // nothing until the save failed with RESUME_LIMIT — after the user had
  // done all the work. Check upfront and warn before they start.
  useEffect(() => {
    if (authStatus !== 'authenticated' || resumeId) {
      setAtResumeCap(null)
      return
    }
    let cancelled = false
    fetch('/api/resume/save', {
      headers: sessionUserId ? { 'x-origin-user-id': sessionUserId } : undefined,
    })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (typeof data.count === 'number' && typeof data.limit === 'number' && data.count >= data.limit) {
          setAtResumeCap({ count: data.count, limit: data.limit })
        } else {
          setAtResumeCap(null)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [authStatus, resumeId, sessionUserId])

  const importAnonDraft = useCallback(() => {
    if (!pendingAnonDraft) return
    setInitialData(pendingAnonDraft)
    // Mark the remounted editor dirty: this claimed draft is unsaved, and we're
    // about to delete its only localStorage copy (the anon key). Without this
    // the editor started clean, so a review-then-close before any keystroke lost
    // the draft entirely (no beforeunload, no authed autosave had armed).
    setEditorInitialDirty(true)
    // Force the ResumeEditor to remount so useResume() re-initializes from
    // the new initialData. Without the key bump, the editor would keep its
    // existing internal state and the imported draft would be discarded.
    setEditorKey((k) => k + 1)
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
    async (data: ResumeData): Promise<{ id?: string; error?: string; code?: string; clamped?: boolean }> => {
      if (authStatus === 'loading') {
        return { error: 'Your sign-in status is changing. Wait a moment, then save again.', code: 'SESSION_CHANGING' }
      }
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
        const saveUserId = sessionUserId
        if (!saveUserId) return { error: 'Sign in to save to the cloud' }
        const res = await fetch('/api/resume/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...data, id: resumeId, originUserId: saveUserId }),
        })
        const result = await res.json()
        if (
          liveIdentityRef.current.status !== 'authenticated' ||
          liveIdentityRef.current.userId !== saveUserId
        ) {
          return { error: 'Your sign-in changed before the save completed. Review this resume again before retrying.', code: 'SESSION_CHANGED' }
        }
        if (!res.ok) {
          // The stored resume is gone (deleted in another tab). Clearing
          // resumeId turns the NEXT Save into a create instead of re-sending
          // the dead id forever — the old error promised "save as new" but no
          // path did it, stranding the user's edits. The edits stay in the
          // editor's state; one more Save now persists them as a new resume.
          if (result.code === 'NOT_FOUND') {
            setResumeId(undefined)
            return { error: 'This resume was deleted elsewhere. Click Save again to keep your edits as a new resume.', code: result.code }
          }
          // Field-level validation issues → a message the user can act on,
          // not the old bare "Invalid data".
          const detail = Array.isArray(result.issues) && result.issues.length > 0
            ? `${result.error}: ${result.issues.map((i: { path: string; message: string }) => `${i.path || 'resume'} — ${i.message}`).join('; ')}`
            : result.error || 'Save failed'
          return { error: detail, code: result.code }
        }
        if (result.id && !resumeId) {
          setResumeId(result.id)
        }
        if (returnToJobsStart) setJobsReturnReady(true)
        // Clear any leftover anonymous draft now that it's persisted.
        try { localStorage.removeItem(ANON_DRAFT_KEY) } catch { /* ignore */ }
        return { id: result.id, clamped: result.clamped === true }
      } catch {
        return { error: 'Network error' }
      }
    },
    [authStatus, resumeId, requireAuth, persistAnonDraft, returnToJobsStart, sessionUserId]
  )

  if (
    loading ||
    !initialData ||
    loadedEditorContextKey !== editorContextKey
  ) {
    return (
      <div role="status" aria-label="Loading resume builder" className="flex items-center justify-center py-20">
        <div aria-hidden="true" className="w-6 h-6 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <>
      {authStatus === 'loading' && (
        <div role="status" aria-label="Refreshing sign-in status" className="flex items-center justify-center py-20">
          <div aria-hidden="true" className="w-6 h-6 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
        </div>
      )}
      <div hidden={authStatus === 'loading'} aria-hidden={authStatus === 'loading' || undefined}>
      {pendingAnonDraft && (
        <ImportAnonDraftModal
          draft={pendingAnonDraft}
          onImport={importAnonDraft}
          onDiscard={discardAnonDraft}
        />
      )}
      {loadNotice && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-700">
          {loadNotice}
        </div>
      )}
      {atResumeCap && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-700">
          You&apos;ve used all {atResumeCap.limit} resume slots — saving this new resume will fail
          until you delete one from{' '}
          <a href="/resume" className="font-medium underline hover:text-amber-800">your resumes</a>.
        </div>
      )}
      {returnJobId && (
        <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-slate-700">
          This resume came from a tracked job.{' '}
          <Link
            href={`/jobs/${encodeURIComponent(returnJobId)}?from=tailor#apply`}
            className="font-medium text-blue-700 underline"
          >
            Return to job application
          </Link>
        </div>
      )}
      {returnToJobsStart && (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-slate-700"
        >
          {jobsReturnReady ? (
            <>
              A saved version is ready in My Resumes.{' '}
              <Link href="/jobs/start" className="font-medium text-blue-700 underline">
                Continue to job setup
              </Link>
            </>
          ) : (
            <>
              You came from Jobs. Finish this resume, save it when ready, then return to choose it and set your target role.{' '}
              <Link href="/jobs/start" className="font-medium text-blue-700 underline">
                Back to job setup
              </Link>
            </>
          )}
        </div>
      )}
      <ResumeEditor
        key={`${editorContextKey}:${editorKey}`}
        initialData={initialData}
        resumeId={resumeId}
        onSave={handleSave}
        isAnonymous={editorOwnerId === null}
        onAnonymousChange={persistAnonDraft}
        draftKey={editorOwnerId ? `resume:draft:${editorOwnerId}:${resumeId || 'new'}` : undefined}
        initialDirty={editorInitialDirty}
      />
      </div>
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
