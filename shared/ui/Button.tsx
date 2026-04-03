'use client'

/**
 * Unified Button component — re-exports the shadcn Button with variant mapping
 * for backward compatibility with the old custom Button API.
 *
 * Variant mapping:
 *   primary   → default
 *   secondary → outline
 *   ghost     → ghost
 *   danger    → destructive
 */

import { Button as ShadcnButton, type ButtonProps as ShadcnButtonProps } from '@shared/ui/shadcn/button'
import { forwardRef } from 'react'

type LegacyVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANT_MAP: Record<LegacyVariant, ShadcnButtonProps['variant']> = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
}

interface ButtonProps extends Omit<ShadcnButtonProps, 'variant'> {
  variant?: LegacyVariant | ShadcnButtonProps['variant']
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', ...props }, ref) => {
    const mappedVariant = VARIANT_MAP[variant as LegacyVariant] ?? variant
    return <ShadcnButton ref={ref} variant={mappedVariant as ShadcnButtonProps['variant']} {...props} />
  }
)

Button.displayName = 'Button'
export default Button
