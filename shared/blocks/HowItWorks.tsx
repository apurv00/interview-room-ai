import { Search, Mic, BarChart3 } from 'lucide-react'

const steps = [
  {
    icon: Search,
    step: '01',
    title: 'Choose Domain & Type',
    description: 'Pick from 12+ interview domains and select the interview depth — from HR screening to technical deep dives.',
  },
  {
    icon: Mic,
    step: '02',
    title: 'Practice with AI',
    description: 'Our AI interviewer asks realistic questions tailored to your domain, type, and experience level.',
  },
  {
    icon: BarChart3,
    step: '03',
    title: 'Get Instant Feedback',
    description: 'Receive scored feedback on content relevance, structure, specificity, and delivery.',
  },
]

export default function HowItWorks() {
  return (
    <section className="section-white px-4 sm:px-6 py-16">
      <div className="max-w-[1100px] mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold text-[#0f1419] tracking-tight">
            How It Works
          </h2>
          <p className="mt-3 text-[#536471]">
            Get interview-ready in three simple steps
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6 stagger-children">
          {steps.map((item, i) => (
            <div
              key={item.step}
              className="relative bg-white rounded-2xl border border-[#e1e8ed] shadow-card p-7 transition-all duration-200 hover:shadow-card-hover hover:border-[#cfd9de]"
            >
              {/* Step number */}
              <span className="text-xs font-bold text-[#8b98a5] tracking-wider">
                STEP {item.step}
              </span>

              {/* Icon */}
              <div className="mt-4 w-11 h-11 rounded-xl bg-blue-50 flex items-center justify-center">
                <item.icon className="size-5 text-[#2563eb]" strokeWidth={1.5} />
              </div>

              <h3 className="mt-4 text-lg font-semibold text-[#0f1419]">
                {item.title}
              </h3>
              <p className="mt-2 text-sm text-[#71767b] leading-relaxed">
                {item.description}
              </p>

              {/* Connector line (not on last) */}
              {i < steps.length - 1 && (
                <div className="hidden md:block absolute top-14 -right-3 w-6 border-t-2 border-dashed border-[#e1e8ed]" />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
