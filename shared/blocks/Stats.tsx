'use client'

import { useEffect, useRef, useState } from 'react'

const stats = [
  { value: 12, suffix: '+', label: 'Career Domains' },
  { value: 6, suffix: '', label: 'Interview Depths' },
  { value: 5, suffix: '', label: 'Scoring Dimensions' },
]

function AnimatedNumber({ target, suffix }: { target: number; suffix: string }) {
  // UAT-008: previous implementation unconditionally `setCount(0)` on
  // mount and relied on the IntersectionObserver to animate back up to
  // `target`. SSR rendered `target` correctly, then the client reset
  // produced a "0 → target" flash on every load even when the element
  // was already in view above the fold.
  //
  // Fix: keep `target` as the steady-state value. On the FIRST observer
  // callback, decide whether to animate:
  //   - element already in view  → skip the animation, show target
  //   - element below the fold   → wait for it to scroll in, then
  //                                animate from 0 → target
  // No zero frame is ever rendered when the user first paints the page.
  const [count, setCount] = useState(target)
  const ref = useRef<HTMLSpanElement>(null)
  const hasResolved = useRef(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    let initialCheck = true
    const observer = new IntersectionObserver(
      ([entry]) => {
        // First fire: classify mount state, then decide.
        if (initialCheck) {
          initialCheck = false
          if (entry.isIntersecting) {
            // Already visible — no animation needed. The displayed value
            // stays at `target`, matching SSR / first paint exactly.
            hasResolved.current = true
            return
          }
          // Off-screen on mount — leave the element showing `target`,
          // but defer the animation until it scrolls into view.
          return
        }

        // Subsequent fires: animate only on the first scroll-into-view.
        if (!entry.isIntersecting || hasResolved.current) return
        hasResolved.current = true

        const duration = 800
        const start = performance.now()
        // Now we deliberately start from 0 because the count-up
        // animation is the visual hook. The 0 frame is the *intent*
        // here, not a hydration glitch.
        setCount(0)
        const animate = (now: number) => {
          const elapsed = now - start
          const progress = Math.min(elapsed / duration, 1)
          const eased = 1 - Math.pow(1 - progress, 3) // easeOutCubic
          setCount(Math.round(eased * target))
          if (progress < 1) requestAnimationFrame(animate)
        }
        requestAnimationFrame(animate)
      },
      { threshold: 0.3 }
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [target])

  return (
    <span ref={ref} className="tabular-nums">
      {count}{suffix}
    </span>
  )
}

export default function Stats() {
  return (
    <section className="px-4 sm:px-6 py-12">
      <div className="max-w-[900px] mx-auto">
        <div className="bg-white rounded-2xl border border-[#e1e8ed] shadow-card p-8 sm:p-12">
          <h2 className="text-xl sm:text-2xl font-bold text-[#0f1419] text-center mb-10">
            Platform at a Glance
          </h2>
          <div className="grid grid-cols-3 gap-6 text-center">
            {stats.map((stat) => (
              <div key={stat.label}>
                <p className="text-3xl sm:text-4xl font-extrabold text-[#2563eb]">
                  <AnimatedNumber target={stat.value} suffix={stat.suffix} />
                </p>
                <p className="mt-2 text-sm text-[#71767b] font-medium">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
