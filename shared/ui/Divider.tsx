interface DividerProps {
  label?: string
  className?: string
}

export default function Divider({ label, className = '' }: DividerProps) {
  if (label) {
    return (
      <div className={`flex items-center gap-3 my-component ${className}`}>
        <div className="flex-1 h-px bg-[rgba(255,255,255,0.06)]" />
        <span className="text-caption text-[#4b5563]">{label}</span>
        <div className="flex-1 h-px bg-[rgba(255,255,255,0.06)]" />
      </div>
    )
  }

  return <div className={`h-px bg-[rgba(255,255,255,0.06)] my-component ${className}`} />
}
