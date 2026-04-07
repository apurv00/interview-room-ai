'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import { LayoutDashboard, FileText, Wand2, ShieldCheck, LayoutTemplate, ArrowLeft, Menu } from 'lucide-react'

const RESUME_NAV = [
  { href: '/resume', label: 'Dashboard', Icon: LayoutDashboard },
  { href: '/resume/builder', label: 'Resume Builder', Icon: FileText },
  { href: '/resume/tailor', label: 'Tailor for Job', Icon: Wand2 },
  { href: '/resume/ats-check', label: 'ATS Check', Icon: ShieldCheck },
  { href: '/resume/templates', label: 'Templates', Icon: LayoutTemplate },
]

export default function ResumeLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-40 w-60 bg-white border-r border-slate-200
        transform transition-transform duration-200
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        md:translate-x-0 md:static
      `}>
        <div className="h-14 flex items-center px-5 border-b border-slate-200">
          <Link href="/resume" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-xl bg-blue-600 flex items-center justify-center">
              <FileText className="w-4 h-4 text-white" />
            </div>
            <div>
              <span className="text-sm font-bold text-slate-900">IPG Resume</span>
              <span className="block text-[10px] text-slate-500">AI Resume Builder</span>
            </div>
          </Link>
        </div>

        <nav className="px-3 py-3 space-y-0.5">
          {RESUME_NAV.map(({ href, label, Icon }) => {
            const isActive = pathname === href || (href !== '/resume' && pathname.startsWith(href))
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                  isActive
                    ? 'bg-blue-50 text-blue-600 border border-blue-200'
                    : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50 border border-transparent'
                }`}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" strokeWidth={1.5} />
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-slate-200">
          <Link href="/" className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-800 transition-colors mb-3">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Main Site
          </Link>
          {session?.user ? (
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-700 truncate">{session.user.name}</p>
                <p className="text-[10px] text-slate-500 truncate">{session.user.email}</p>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: '/' })}
                className="text-[10px] text-slate-500 hover:text-red-500 transition-colors"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <Link href="/signin" className="text-xs text-blue-600 hover:text-blue-700 transition-colors">
              Sign In
            </Link>
          )}
        </div>
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="flex-1 md:ml-0">
        <header className="md:hidden sticky top-0 z-20 h-14 bg-white border-b border-slate-200 flex items-center px-4">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-slate-500 hover:text-slate-900 transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-6 h-6" />
          </button>
          <span className="ml-3 text-sm font-bold text-slate-900">IPG Resume</span>
        </header>

        <main className="p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  )
}
