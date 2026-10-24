import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "flex h-11 w-full rounded-lg border border-input bg-background px-3 text-base shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}
