'use client'

import BadgeGallery from '@learn/components/BadgeGallery'

export default function BadgesPage() {
  return (
    <main className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-[#f0f2f5]">Achievement Badges</h1>
      <p className="text-sm text-[#6b7280]">
        Earn badges by practicing interviews, building streaks, hitting score milestones, and exploring different domains.
      </p>
      <BadgeGallery />
    </main>
  )
}
