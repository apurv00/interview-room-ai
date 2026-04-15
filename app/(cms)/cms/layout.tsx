'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ReactNode } from 'react'

const navItems = [
  { href: '/cms', label: 'Dashboard', icon: '📊' },
  { href: '/cms/domains', label: 'Domains', icon: '🏷️' },
  { href: '/cms/interview-types', label: 'Interview Types', icon: '🎯' },
  { href: '/cms/skills', label: 'Skills', icon: '📝' },
  { href: '/cms/wizard-config', label: 'Wizard Config', icon: '⚙️' },
  { href: '/cms/model-config', label: 'Model Config', icon: '🤖' },
  { href: '/cms/score-telemetry', label: 'Score Telemetry', icon: '📈' },
]

export default function CmsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex min-h-screen bg-white text-[#0f1419]">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-[#e1e8ed] flex flex-col">
        <div className="p-6 border-b border-[#e1e8ed]">
          <h1 className="text-xl font-bold text-[#2563eb]">CMS Admin</h1>
          <p className="text-xs text-[#8b98a5] mt-1">Interview Prep Guru</p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const isActive =
              item.href === '/cms'
                ? pathname === '/cms'
                : pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600/20 text-[#2563eb] font-medium'
                    : 'text-[#536471] hover:text-[#0f1419] hover:bg-[#f8fafc]'
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            )
          })}
        </nav>
        <div className="p-4 border-t border-[#e1e8ed]">
          <Link
            href="/"
            className="text-xs text-[#8b98a5] hover:text-[#536471] transition-colors"
          >
            Back to main app
          </Link>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8 overflow-auto">
        {children}
      </main>
    </div>
  )
}
