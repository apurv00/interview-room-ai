type BadgeVariant = 'default' | 'primary' | 'success' | 'caution' | 'danger'

interface BadgeProps {
  variant?: BadgeVariant
  dot?: boolean
  children: React.ReactNode
  className?: string
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-surface border-[rgba(255,255,255,0.10)] text-[#b0b8c4]',
  primary: 'bg-[rgba(99,102,241,0.08)] border-[rgba(99,102,241,0.15)] text-[#818cf8]',
  success: 'bg-[rgba(16,185,129,0.08)] border-[rgba(16,185,129,0.15)] text-[#34d399]',
  caution: 'bg-[rgba(245,158,11,0.08)] border-[rgba(245,158,11,0.15)] text-[#fbbf24]',
  danger: 'bg-[rgba(239,68,68,0.08)] border-[rgba(239,68,68,0.15)] text-[#f87171]',
}

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-[#b0b8c4]',
  primary: 'bg-[#818cf8]',
  success: 'bg-[#34d399]',
  caution: 'bg-[#fbbf24]',
  danger: 'bg-[#f87171]',
}

export default function Badge({ variant = 'default', dot = false, children, className = '' }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center gap-1.5 h-5 px-2 rounded-[6px] border
        text-micro font-medium
        ${variantClasses[variant]}
        ${className}
      `.trim()}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${dotColors[variant]}`} />}
      {children}
    </span>
  )
}
