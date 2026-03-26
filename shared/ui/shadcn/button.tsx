import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/shared/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold transition-all duration-200 ease-out disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 active:scale-[0.97]",
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

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
