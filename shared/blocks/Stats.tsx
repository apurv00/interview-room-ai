'use client'

import { useEffect, useRef, useState } from 'react'

const stats = [
  { value: 12, suffix: '+', label: 'Career Domains' },
  { value: 6, suffix: '', label: 'Interview Depths' },
  { value: 5, suffix: '', label: 'Scoring Dimensions' },
]

function AnimatedNumber({ target, suffix }: { target: number; suffix: string }) {
  const [count, setCount] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  const hasAnimated = useRef(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated.current) {
          hasAnimated.current = true
          const duration = 800
          const start = performance.now()

          const animate = (now: number) => {
            const elapsed = now - start
            const progress = Math.min(elapsed / duration, 1)
            const eased = 1 - Math.pow(1 - progress, 3) // easeOutCubic
            setCount(Math.round(eased * target))
            if (progress < 1) requestAnimationFrame(animate)
          }

          requestAnimationFrame(animate)
        }
      },
      { threshold: 0.3 }
    )

    if (ref.current) observer.observe(ref.current)
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
                <p className="text-3xl sm:text-4xl font-extrabold text-[#6366f1]">
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
