import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils/cn";

type Variant = "default" | "ghost" | "outline";
type Size = "default" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  default: "bg-ink-900 text-white hover:bg-ink-800 focus-visible:ring-ink-700",
  ghost: "text-ink-700 hover:bg-ink-100 focus-visible:ring-ink-300",
  outline:
    "border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 focus-visible:ring-ink-300",
};

const sizeClasses: Record<Size, string> = {
  default: "h-9 px-4 text-sm",
  sm: "h-8 px-3 text-xs",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        "disabled:pointer-events-none disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = "Button";
