'use client'

import { forwardRef } from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, leftIcon, rightIcon, className = '', id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-caption text-[#b0b8c4]">
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4b5563]">
              {leftIcon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={`
              h-9 w-full bg-surface text-sm text-[#f0f2f5] placeholder-[#4b5563]
              border rounded-[6px] transition-all duration-[120ms]
              ${error
                ? 'border-[rgba(239,68,68,0.15)] focus:border-[rgba(239,68,68,0.15)] focus:ring-1 focus:ring-[rgba(239,68,68,0.15)]'
                : 'border-[rgba(255,255,255,0.10)] focus:border-[#6366f1] focus:ring-1 focus:ring-[rgba(99,102,241,0.15)]'
              }
              focus:outline-none
              ${leftIcon ? 'pl-9' : 'pl-3'}
              ${rightIcon ? 'pr-9' : 'pr-3'}
              ${className}
            `.trim()}
            {...props}
          />
          {rightIcon && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[#4b5563]">
              {rightIcon}
            </span>
          )}
        </div>
        {error && <p className="text-caption text-[#f87171]">{error}</p>}
        {hint && !error && <p className="text-caption text-[#4b5563]">{hint}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
export default Input
