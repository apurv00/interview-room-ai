import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/shared/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-sm font-semibold transition-all duration-200 ease-out disabled:pointer-events-none disabled:opacity-40 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 active:scale-[0.97]",
  {
    variants: {
      variant: {
        default: "bg-[#6366f1] text-white shadow-sm hover:bg-[#5558e6] hover:shadow-md",
        destructive: "bg-[rgba(244,33,46,0.06)] text-[#f4212e] border border-[rgba(244,33,46,0.15)] hover:bg-[rgba(244,33,46,0.10)]",
        outline: "border border-[#e1e8ed] bg-white text-[#0f1419] shadow-sm hover:bg-[#f7f9f9] hover:border-[#cfd9de]",
        secondary: "bg-[#eff3f4] text-[#0f1419] hover:bg-[#e1e8ed]",
        ghost: "text-[#536471] hover:bg-[#f7f9f9] hover:text-[#0f1419]",
        link: "text-[#6366f1] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-5 py-2 rounded-full",
        sm: "h-8 rounded-full gap-1.5 px-3.5 text-xs",
        md: "h-9 px-5 rounded-full",
        lg: "h-11 rounded-full px-6",
        icon: "size-9 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Spinner = () => (
  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
)

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  isLoading?: boolean
  isFullWidth?: boolean
  glow?: boolean
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  leftIcon,
  rightIcon,
  isLoading = false,
  isFullWidth = false,
  glow = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      disabled={disabled || isLoading}
      className={cn(
        buttonVariants({ variant, size }),
        isFullWidth && "w-full",
        glow && (variant === "default" || !variant) && "btn-glow",
        className
      )}
      {...props}
    >
      {isLoading ? <Spinner /> : leftIcon}
      {children}
      {rightIcon}
    </Comp>
  )
}

export { Button, buttonVariants }
