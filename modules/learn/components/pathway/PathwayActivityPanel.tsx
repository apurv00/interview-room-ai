'use client'

import RecentSessionsStrip from './RecentSessionsStrip'

export default function PathwayActivityPanel() {
  return (
    <section className="space-y-3">
      <div className="px-1">
        <h2 className="text-sm font-semibold text-[#0f1419]">Activity</h2>
        <p className="text-xs text-[#71767b] mt-0.5">Recent interviews that feed the improvement loop.</p>
      </div>
      <RecentSessionsStrip />
    </section>
  )
}
