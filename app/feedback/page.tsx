'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Redirect bare /feedback to /feedback/local (which uses localStorage fallback)
export default function FeedbackRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/feedback/local')
  }, [router])

  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
    </div>
  )
}
