/**
 * @cap/ui — shared component library consumed by apps/web via workspace:*.
 *
 * Holds the shadcn + Tailwind primitives and the xterm `<Terminal>` wrapper
 * (frontend-console spec, D14). apps/web imports these rather than redefining
 * them locally ("Web app consumes shared components").
 */

/** Package marker retained from the foundation scaffold for wiring proofs. */
export const UI_PACKAGE = "@cap/ui" as const;

export { cn } from "./lib/cn.js";
export {
  Button,
  buttonVariants,
  type ButtonProps,
} from "./components/button.js";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/card.js";
export {
  Badge,
  badgeVariants,
  statusBadgeVariant,
  type BadgeProps,
  type BadgeVariant,
} from "./components/badge.js";
export {
  Terminal,
  type TerminalProps,
  type TerminalHandle,
  type TerminalGeometry,
  type TerminalResponseProfileRuntimeInputs,
  type TerminalResponseWindowOptions,
  type ActiveBufferSnapshotTerminal,
  serializeActiveBuffer,
} from "./terminal/terminal.js";
export {
  PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS,
  TERMINAL_RESPONSE_UNICODE_ACTIVE_VERSION,
  TERMINAL_RESPONSE_UNICODE_ADDON_NAME,
  TERMINAL_RESPONSE_WINDOW_OPTIONS,
  activateProductionTerminalResponseAddons,
  buildTerminalResponseProfileDescriptor,
  productionTerminalResponseAddonInputs,
} from "./terminal/terminal-response-profile.js";
