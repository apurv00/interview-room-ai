import type { Metadata } from 'next'
import SessionProvider from '@/providers/SessionProvider'
import AppShell from '@/components/layout/AppShell'
import './globals.css'

export const metadata: Metadata = {
  title: 'Interview Prep Guru',
  description: 'AI-powered mock interview practice with realistic HR screening simulation',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#070b14] text-slate-100 antialiased">
        <SessionProvider>
          <AppShell>{children}</AppShell>
        </SessionProvider>
      </body>
    </html>
  )
}
