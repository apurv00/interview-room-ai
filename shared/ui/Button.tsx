'use client'

import { forwardRef } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  isLoading?: boolean
  isFullWidth?: boolean
  glow?: boolean
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-[#6366f1] hover:bg-[#5558e6] text-white',
  secondary: 'bg-white border border-[#e1e8ed] text-[#0f1419] hover:bg-[#f7f9f9]',
  ghost: 'bg-transparent text-[#536471] hover:bg-[#f7f9f9] hover:text-[#0f1419]',
  danger: 'bg-[rgba(244,33,46,0.06)] border border-[rgba(244,33,46,0.15)] text-[#f4212e] hover:bg-[rgba(244,33,46,0.10)]',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 text-xs px-3 rounded-[6px]',
  md: 'h-9 text-sm px-4 rounded-[10px]',
  lg: 'h-11 text-sm px-5 rounded-[10px]',
}

const Spinner = () => (
  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
)

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      leftIcon,
      rightIcon,
      isLoading = false,
      isFullWidth = false,
      glow = false,
      className = '',
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={`
          inline-flex items-center justify-center gap-1.5 font-medium
          transition-all duration-[120ms] ease-out
          disabled:opacity-40 disabled:cursor-not-allowed
          active:scale-[0.97]
          ${variantClasses[variant]}
          ${sizeClasses[size]}
          ${isFullWidth ? 'w-full' : ''}
          ${glow && variant === 'primary' ? 'btn-glow' : ''}
          ${className}
        `.trim()}
        {...props}
      >
        {isLoading ? <Spinner /> : leftIcon}
        {children}
        {rightIcon}
      </button>
    )
  }
)

Button.displayName = 'Button'
export default Button
