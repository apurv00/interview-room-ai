'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import ResumeEditor from '@resume/components/ResumeEditor'
import type { ResumeData } from '@resume/validators/resume'
import { useAuthGate } from '@shared/providers/AuthGateProvider'

const ANON_DRAFT_KEY = 'resume:draft:anon'

export default function ResumeBuilderPage() {
  const searchParams = useSearchParams()
  const { status: authStatus } = useSession()
  const { requireAuth } = useAuthGate()
  const [initialData, setInitialData] = useState<Partial<ResumeData> | null>(null)
  const [resumeId, setResumeId] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (authStatus === 'loading') return

    const editId = searchParams.get('id')
    const template = searchParams.get('template')

    // Anonymous: hydrate from localStorage draft (if any) or start fresh.
    if (authStatus === 'unauthenticated') {
      try {
        const raw = localStorage.getItem(ANON_DRAFT_KEY)
        if (raw) {
          setInitialData(JSON.parse(raw))
        } else {
          setInitialData({ template: template || 'professional' })
        }
      } catch {
        setInitialData({ template: template || 'professional' })
      }
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
      // Authenticated, no editId — check if a pending anonymous draft exists.
      // If so, hydrate it so the user's pre-signin work isn't lost.
      try {
        const raw = localStorage.getItem(ANON_DRAFT_KEY)
        if (raw) {
          setInitialData(JSON.parse(raw))
        } else {
          setInitialData({ template: template || 'professional' })
        }
      } catch {
        setInitialData({ template: template || 'professional' })
      }
      setLoading(false)
    }
  }, [authStatus, searchParams])

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
    <ResumeEditor
      initialData={initialData}
      resumeId={resumeId}
      onSave={handleSave}
      isAnonymous={authStatus !== 'authenticated'}
      onAnonymousChange={persistAnonDraft}
    />
  )
}
