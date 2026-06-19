import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Vercel-style `<Button>` primitive for the marketing site (`@cap/www`).
 *
 * Monochrome black/white per the design system (design.md D5): a solid
 * foreground/background `primary` button, an `outline` button with a 1px
 * hairline border, and a borderless `ghost`. Every variant is keyboard
 * focusable with a visible focus ring and shows `cursor-pointer` on hover, per
 * task 2.2 ("honoring focus states and `cursor-pointer`").
 *
 * `asChild` lets a link (`<a>`/Next `<Link>`) inherit the button styling
 * without nesting an `<a>` inside a `<button>`.
 */
export const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-fg text-bg hover:bg-fg/90",
        outline: "border border-hairline bg-transparent text-fg hover:bg-fg/5",
        ghost: "bg-transparent text-fg hover:bg-fg/5",
      },
      size: {
        sm: "h-8 rounded-md px-3 text-xs",
        md: "h-10 px-4 py-2",
        lg: "h-12 rounded-md px-6 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the child element with button styles instead of a `<button>`. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant, size, type, asChild = false, children, ...props },
    ref,
  ) {
    const classes = cn(buttonVariants({ variant, size }), className);

    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{ className?: string }>;
      return React.cloneElement(child, {
        className: cn(classes, child.props.className),
      });
    }

    return (
      <button ref={ref} type={type ?? "button"} className={classes} {...props}>
        {children}
      </button>
    );
  },
);
