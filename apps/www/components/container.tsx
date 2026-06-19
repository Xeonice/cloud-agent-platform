import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `<Container>` — the horizontal width constraint for the marketing site
 * (`@cap/www`).
 *
 * Centers content to a max width with responsive gutters so every section
 * aligns to the same measure and never overflows the viewport (supporting the
 * "no horizontal scroll" responsiveness bar at 375/768/1024/1440). Pairs with
 * `<Section>`, which owns vertical rhythm.
 *
 * Polymorphic via `as` so it can render as a semantic landmark (e.g. `nav`,
 * `footer`) without an extra wrapper element.
 */
type ContainerProps<T extends React.ElementType> = {
  as?: T;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentPropsWithoutRef<T>, "as" | "className" | "children">;

export function Container<T extends React.ElementType = "div">({
  as,
  className,
  children,
  ...props
}: ContainerProps<T>) {
  const Component = (as ?? "div") as React.ElementType;
  return (
    <Component
      className={cn("mx-auto w-full max-w-6xl px-6 sm:px-8", className)}
      {...props}
    >
      {children}
    </Component>
  );
}
