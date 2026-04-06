export default function SocialProof() {
  const stats = [
    { num: '12+', label: 'Career Domains' },
    { num: '6', label: 'Interview Depths' },
    { num: '5', label: 'Scoring Dimensions' },
  ]

  return (
    <section className="px-4 sm:px-6 py-section">
      <div className="max-w-[1100px] mx-auto">
        <div className="surface-card-bordered p-8 sm:p-10">
          <h2 className="text-heading text-[#0f1419] text-center mb-8">Platform at a Glance</h2>
          <div className="grid grid-cols-3 gap-component text-center">
            {stats.map((s) => (
              <div key={s.label}>
                <p className="text-display text-[#2563eb] font-bold">{s.num}</p>
                <p className="text-caption text-[#71767b] mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
