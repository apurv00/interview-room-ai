interface SkeletonProps {
  variant?: 'line' | 'circle' | 'rect'
  width?: string | number
  height?: string | number
  count?: number
  className?: string
}

function SkeletonItem({ variant = 'line', width, height, className = '' }: Omit<SkeletonProps, 'count'>) {
  const baseClass = 'bg-raised animate-pulse'

  if (variant === 'circle') {
    const size = width || height || 40
    return (
      <div
        className={`${baseClass} rounded-full ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  if (variant === 'rect') {
    return (
      <div
        className={`${baseClass} rounded-[10px] ${className}`}
        style={{ width: width || '100%', height: height || 120 }}
      />
    )
  }

  // line variant
  return (
    <div
      className={`${baseClass} rounded-[10px] ${className}`}
      style={{ width: width || '100%', height: height || 16 }}
    />
  )
}

export default function Skeleton({ count = 1, ...props }: SkeletonProps) {
  if (count === 1) return <SkeletonItem {...props} />

  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonItem
          key={i}
          {...props}
          width={props.variant === 'line' ? `${80 - i * 10}%` : props.width}
        />
      ))}
    </div>
  )
}
