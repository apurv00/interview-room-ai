type BadgeVariant = 'default' | 'primary' | 'success' | 'caution' | 'danger'

interface BadgeProps {
  variant?: BadgeVariant
  dot?: boolean
  children: React.ReactNode
  className?: string
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-[#eff3f4] border-[#e1e8ed] text-[#536471]',
  primary: 'bg-[rgba(37,99,235,0.08)] border-[rgba(37,99,235,0.15)] text-[#2563eb]',
  success: 'bg-[rgba(16,185,129,0.08)] border-[rgba(16,185,129,0.2)] text-[#059669]',
  caution: 'bg-[rgba(245,158,11,0.08)] border-[rgba(245,158,11,0.2)] text-[#d97706]',
  danger: 'bg-[rgba(244,33,46,0.06)] border-[rgba(244,33,46,0.15)] text-[#f4212e]',
}

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-[#536471]',
  primary: 'bg-[#2563eb]',
  success: 'bg-[#059669]',
  caution: 'bg-[#d97706]',
  danger: 'bg-[#f4212e]',
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
