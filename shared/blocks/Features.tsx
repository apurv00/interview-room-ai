import { ClipboardCheck, FileText, Users } from 'lucide-react'
import Link from 'next/link'

const features = [
  {
    icon: ClipboardCheck,
    title: 'Practice Sets',
    description: 'Guided practice plans personalized to your goals, with progress tracking and difficulty scaling.',
    href: '/learn/practice',
    color: 'text-blue-500',
    bg: 'bg-blue-50 group-hover:bg-blue-100',
  },
  {
    icon: FileText,
    title: 'Resume Tools',
    description: 'AI resume builder, job description tailor, and ATS compatibility checker to maximize callbacks.',
    href: '/resume',
    color: 'text-emerald-500',
    bg: 'bg-emerald-50 group-hover:bg-emerald-100',
  },
  {
    icon: Users,
    title: 'IPG Hire',
    description: 'For recruiters: screen candidates with AI-powered interview assessments at scale.',
    href: '/hire',
    color: 'text-violet-500',
    bg: 'bg-violet-50 group-hover:bg-violet-100',
  },
]

export default function Features() {
  return (
    <section className="section-white px-4 sm:px-6 py-16">
      <div className="max-w-[1000px] mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold text-[#0f1419] tracking-tight">
            Complete Career Toolkit
          </h2>
          <p className="mt-3 text-[#536471]">
            Everything you need to land your next role
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-4 stagger-children">
          {features.map((feature) => (
            <Link
              key={feature.title}
              href={feature.href}
              className="card-interactive p-6 text-left group"
            >
              <div className={`w-12 h-12 rounded-2xl ${feature.bg} flex items-center justify-center mb-4 transition-colors`}>
                <feature.icon className={`size-6 ${feature.color}`} strokeWidth={1.5} />
              </div>
              <h3 className="text-base font-semibold text-[#0f1419] group-hover:text-[#2563eb] transition-colors">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm text-[#71767b] leading-relaxed">
                {feature.description}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
