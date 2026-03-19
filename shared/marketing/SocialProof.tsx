export default function SocialProof() {
  const stats = [
    { num: '12+', label: 'Career Domains' },
    { num: '6', label: 'Interview Depths' },
    { num: '5', label: 'Scoring Dimensions' },
  ]

  return (
    <section className="px-4 sm:px-6 py-section">
      <div className="max-w-[1100px] mx-auto">
        <h2 className="text-heading text-[#f0f2f5] text-center mb-section">Platform at a Glance</h2>
        <div className="grid grid-cols-3 gap-component text-center">
          {stats.map((s) => (
            <div key={s.label}>
              <p className="text-display text-[#f0f2f5] font-bold">{s.num}</p>
              <p className="text-caption text-[#6b7280]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
