'use client'

import { useState } from 'react'

interface ShareButtonProps {
  sessionId: string
}

export default function ShareButton({ sessionId }: ShareButtonProps) {
  const [loading, setLoading] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const generateLink = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/learn/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json()
      if (data.url) {
        const fullUrl = `${window.location.origin}${data.url}`
        setShareUrl(fullUrl)
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }

  const copyLink = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  if (shareUrl) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={copyLink}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#f8fafc] text-[#536471] hover:bg-[#eff3f4] transition-colors"
        >
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
        <a
          href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#0077B5]/10 text-[#0077B5] hover:bg-[#0077B5]/20 transition-colors"
        >
          LinkedIn
        </a>
        <a
          href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent('Check out my interview scorecard!')}`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#f8fafc] text-[#536471] hover:bg-[#eff3f4] transition-colors"
        >
          X
        </a>
      </div>
    )
  }

  return (
    <button
      onClick={generateLink}
      disabled={loading}
      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-[#eff3f4] text-white transition-colors"
    >
      {loading ? 'Generating...' : 'Share Scorecard'}
    </button>
  )
}
