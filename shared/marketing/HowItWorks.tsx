export default function HowItWorks() {
  const steps = [
    { step: '1', title: 'Choose Domain & Type', desc: 'Pick from 12+ interview domains and select the interview depth — from HR screening to technical deep dives.' },
    { step: '2', title: 'Practice with AI', desc: 'Our AI interviewer asks realistic questions tailored to your domain, type, and experience level.' },
    { step: '3', title: 'Get Instant Feedback', desc: 'Receive scored feedback on content relevance, structure, specificity, and delivery.' },
  ]

  return (
    <section className="section-white px-4 sm:px-6 py-section">
      <div className="max-w-[1100px] mx-auto">
        <h2 className="text-heading text-[#0f1419] text-center mb-section">How It Works</h2>
        <div className="grid md:grid-cols-3 gap-4 stagger-children">
          {steps.map((item) => (
            <div key={item.step} className="surface-card-bordered p-7 relative">
              <div className="w-8 h-8 rounded-full bg-indigo-50 text-[#6366f1] text-sm font-bold flex items-center justify-center">
                {item.step}
              </div>
              <h3 className="text-subheading text-[#0f1419] mt-4">{item.title}</h3>
              <p className="text-body text-[#71767b] mt-2">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
