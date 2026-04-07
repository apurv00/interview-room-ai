import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/shared/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-[#e1e8ed] bg-[#eff3f4] text-[#536471]",
        primary: "border-[rgba(37,99,235,0.15)] bg-[rgba(37,99,235,0.08)] text-[#2563eb]",
        success: "border-[rgba(16,185,129,0.2)] bg-[rgba(16,185,129,0.08)] text-[#059669]",
        caution: "border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.08)] text-[#d97706]",
        destructive: "border-[rgba(244,33,46,0.15)] bg-[rgba(244,33,46,0.06)] text-[#f4212e]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
