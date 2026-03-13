'use client'

import Button from './Button'
import Skeleton from './Skeleton'

interface StateViewProps {
  state: 'loading' | 'empty' | 'error' | 'offline'
  // Loading
  skeletonLayout?: 'list' | 'grid' | 'card'
  skeletonCount?: number
  // Empty
  icon?: React.ReactNode
  title?: string
  description?: string
  action?: { label: string; onClick: () => void }
  // Error
  error?: string
  onRetry?: () => void
  retryCount?: number
}

const WarningIcon = () => (
  <div className="w-10 h-10 rounded-[10px] bg-[rgba(239,68,68,0.08)] flex items-center justify-center">
    <svg className="w-5 h-5 text-[#f87171]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
    </svg>
  </div>
)

const CloudOffIcon = () => (
  <div className="w-10 h-10 rounded-[10px] bg-surface flex items-center justify-center">
    <svg className="w-5 h-5 text-[#4b5563]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m0 0l-12.728-12.728m12.728 12.728L5.636 5.636M12 3v.01M3 12h.01M12 21v.01M21 12h.01" />
    </svg>
  </div>
)

export default function StateView({
  state,
  skeletonLayout = 'list',
  skeletonCount = 4,
  icon,
  title,
  description,
  action,
  error,
  onRetry,
  retryCount = 0,
}: StateViewProps) {
  if (state === 'loading') {
    if (skeletonLayout === 'grid') {
      return (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-element" aria-busy="true">
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <Skeleton key={i} variant="rect" height={80} />
          ))}
        </div>
      )
    }
    if (skeletonLayout === 'card') {
      return (
        <div aria-busy="true">
          <Skeleton variant="rect" height={192} />
        </div>
      )
    }
    // list
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <Skeleton key={i} variant="rect" height={48} />
        ))}
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="flex flex-col items-center text-center max-w-[320px] mx-auto py-8" role="alert">
        <WarningIcon />
        <h3 className="text-subheading text-[#f0f2f5] mt-3">Something went wrong</h3>
        <p className="text-body text-[#6b7280] mt-1">
          {error || 'An unexpected error occurred. Please try again.'}
        </p>
        {onRetry && (
          <div className="mt-4">
            <Button variant="secondary" size="md" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {retryCount >= 2 && (
          <p className="text-caption text-[#4b5563] mt-3">
            Still not working? Contact support@interviewprep.guru
          </p>
        )}
      </div>
    )
  }

  if (state === 'offline') {
    return (
      <div className="flex flex-col items-center text-center max-w-[320px] mx-auto py-8">
        <CloudOffIcon />
        <h3 className="text-subheading text-[#f0f2f5] mt-3">You&apos;re offline</h3>
        <p className="text-body text-[#6b7280] mt-1">
          Check your connection and try again.
        </p>
        {onRetry && (
          <div className="mt-4">
            <Button variant="secondary" size="md" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}
      </div>
    )
  }

  // empty
  return (
    <div className="flex flex-col items-center text-center max-w-[320px] mx-auto py-8">
      {icon && (
        <div className="w-10 h-10 rounded-[10px] bg-surface flex items-center justify-center text-[#4b5563]">
          {icon}
        </div>
      )}
      {title && <h3 className="text-subheading text-[#f0f2f5] mt-3">{title}</h3>}
      {description && <p className="text-body text-[#6b7280] mt-1">{description}</p>}
      {action && (
        <div className="mt-4">
          <Button variant="secondary" size="md" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  )
}
