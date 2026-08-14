/**
 * Reusable Button component with variant (`default`, `ghost`, `outline`)
 * and size (`default`, `icon`, `sm`, `lg`) props.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "icon" | "sm" | "lg";
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center rounded-md text-sm font-medium transition-[background-color,color,box-shadow,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50 disabled:pointer-events-none",
          {
            "bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-[0_0_0_1px_var(--primary)]":
              variant === "default",
            "text-foreground hover:bg-muted": variant === "ghost",
            "border border-border bg-transparent hover:border-primary/60 hover:bg-card":
              variant === "outline",
            "h-10 py-2 px-4": size === "default",
            "h-10 w-10": size === "icon",
            "h-9 px-3": size === "sm",
            "h-11 px-8": size === "lg",
          },
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };

