'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import ResumeEditor from '@resume/components/ResumeEditor'
import type { ResumeData } from '@resume/validators/resume'

export default function ResumeBuilderPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { status: authStatus } = useSession()
  const [initialData, setInitialData] = useState<Partial<ResumeData> | null>(null)
  const [resumeId, setResumeId] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (authStatus === 'unauthenticated') {
      router.push('/signin')
      return
    }
    if (authStatus !== 'authenticated') return

    const editId = searchParams.get('id')
    const template = searchParams.get('template')

    if (editId) {
      // Load existing resume for editing
      fetch('/api/resume/save')
        .then(r => r.json())
        .then(data => {
          const resume = data.resumes?.find((r: { id: string }) => r.id === editId)
          if (resume) {
            // Fetch full resume data
            fetch(`/api/resume/save?id=${editId}`)
              .then(r => r.json())
              .then(fullData => {
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
      setInitialData({ template: template || 'professional' })
      setLoading(false)
    }
  }, [authStatus, router, searchParams])

  async function handleSave(data: ResumeData) {
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
      return { id: result.id }
    } catch {
      return { error: 'Network error' }
    }
  }

  if (authStatus === 'loading' || loading || !initialData) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  return <ResumeEditor initialData={initialData} resumeId={resumeId} onSave={handleSave} />
}
