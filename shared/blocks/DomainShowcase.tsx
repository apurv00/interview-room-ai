import Link from 'next/link'

const domains = [
  { icon: '💻', label: 'Software Engineering' },
  { icon: '📊', label: 'Data Science' },
  { icon: '🗂', label: 'Product Management' },
  { icon: '🎨', label: 'Design / UX' },
  { icon: '💰', label: 'Finance' },
  { icon: '📈', label: 'Marketing' },
]

export default function DomainShowcase() {
  return (
    <section className="section-white px-4 sm:px-6 py-16">
      <div className="max-w-[1000px] mx-auto text-center">
        <h2 className="text-2xl sm:text-3xl font-bold text-[#0f1419] tracking-tight">
          Built for Every Career Path
        </h2>
        <p className="mt-3 text-[#536471]">
          Tailored questions for 12+ career domains
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-10 max-w-[600px] mx-auto stagger-children">
          {domains.map((d) => (
            <div
              key={d.label}
              className="card-interactive p-5 flex flex-col items-center gap-2.5 cursor-default"
            >
              <span className="text-3xl">{d.icon}</span>
              <span className="text-sm font-semibold text-[#536471]">{d.label}</span>
            </div>
          ))}
        </div>

        <Link
          href="/signup"
          className="inline-block mt-8 text-sm font-semibold text-[#2563eb] hover:text-[#1d4ed8] transition-colors"
        >
          See all domains &rarr;
        </Link>
      </div>
    </section>
  )
}
