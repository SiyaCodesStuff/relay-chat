import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";
const variants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border border-border bg-background hover:bg-muted",
      },
      size: { default: "h-11 px-5", sm: "h-9 px-3" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof variants>) {
  return (
    <button
      data-slot="button"
      type={type}
      className={cn(variants({ variant, size }), className)}
      {...props}
    />
  );
}
