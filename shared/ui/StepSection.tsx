interface StepSectionProps {
  step: number
  label: string
  children: React.ReactNode
  visible?: boolean
  completed?: boolean
}

export default function StepSection({ step, label, children, visible = true, completed = false }: StepSectionProps) {
  if (!visible) return null

  return (
    <section className="space-y-3">
      <div className="step-label flex items-center gap-1.5">
        <span>
          {completed ? (
            <svg className="w-3.5 h-3.5 text-[#34d399]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            step
          )}
        </span>
        <span className="text-[#4b5563]/50">·</span>
        <span>{label}</span>
      </div>
      {children}
    </section>
  )
}
