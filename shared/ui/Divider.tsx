interface DividerProps {
  label?: string
  className?: string
}

export default function Divider({ label, className = '' }: DividerProps) {
  if (label) {
    return (
      <div className={`flex items-center gap-3 my-component ${className}`}>
        <div className="flex-1 h-px bg-[#eff3f4]" />
        <span className="text-caption text-[#8b98a5]">{label}</span>
        <div className="flex-1 h-px bg-[#eff3f4]" />
      </div>
    )
  }

  return <div className={`h-px bg-[#eff3f4] my-component ${className}`} />
}
