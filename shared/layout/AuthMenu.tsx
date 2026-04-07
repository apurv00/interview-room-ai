'use client'

import { useState, useRef, useEffect } from 'react'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import Image from 'next/image'
import { useAuthGate } from '@shared/providers/AuthGateProvider'

const PLAN_BADGE: Record<string, { label: string; className: string }> = {
  free: { label: 'Free', className: 'bg-slate-100 text-slate-600' },
  pro: { label: 'Pro', className: 'bg-blue-50 text-blue-700' },
  enterprise: { label: 'Enterprise', className: 'bg-violet-50 text-violet-700' },
}

export default function AuthMenu() {
  const { data: session } = useSession()
  const { open: openAuthGate } = useAuthGate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (!session?.user) {
    return (
      <button
        type="button"
        onClick={() => openAuthGate('generic')}
        className="px-5 py-1.5 text-[13px] font-semibold rounded-full bg-blue-600 text-white hover:bg-blue-700 transition-colors"
      >
        Sign In
      </button>
    )
  }

  const user = session.user
  const plan = (user.plan as string) || 'free'
  const badge = PLAN_BADGE[plan] || PLAN_BADGE.free
  const initials = (user.name || user.email || '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 group"
      >
        {user.image ? (
          <Image
            src={user.image}
            alt="Profile"
            width={32}
            height={32}
            className="w-8 h-8 rounded-full border-2 border-slate-200 group-hover:border-blue-600 transition"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold text-white border-2 border-slate-200 group-hover:border-blue-600 transition">
            {initials}
          </div>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden z-50 animate-slide-up">
          {/* Header with plan badge */}
          <div className="px-4 py-3 border-b border-slate-100">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-slate-900 truncate">{user.name}</p>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${badge.className}`}>
                {badge.label}
              </span>
            </div>
            <p className="text-xs text-slate-500 truncate">{user.email}</p>
            {plan === 'free' && (
              <Link
                href="/pricing"
                onClick={() => setOpen(false)}
                className="inline-block mt-1.5 text-[11px] text-blue-600 hover:text-blue-700 transition"
              >
                Upgrade your plan →
              </Link>
            )}
          </div>

          {/* Links */}
          <div className="py-1">
            <Link
              href="/history"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition"
            >
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              History
            </Link>
            <Link
              href="/learn/progress"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition"
            >
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              Progress
            </Link>
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition"
            >
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
          </div>

          <div className="border-t border-slate-100 py-1">
            <button
              onClick={() => {
                setOpen(false)
                // Clear interview localStorage to prevent cross-user data leakage
                try {
                  localStorage.removeItem('interviewConfig')
                  localStorage.removeItem('interviewData')
                  localStorage.removeItem('interviewActiveSession')
                } catch { /* ignore */ }
                signOut({ callbackUrl: '/' })
              }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-slate-50 transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
