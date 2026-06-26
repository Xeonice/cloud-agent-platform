/**
 * Account-menu open/close hook (rebuild-console-tanstack-start task 10.7; 11.2).
 *
 * Drives the shared `AccountMenu` (desktop topbar + mobile nav): open state,
 * Escape-to-close, outside-click-to-close, and the `aria-expanded` wiring for
 * the trigger. Closing on Escape returns focus to the trigger (a11y). The
 * effect is client-only and guards `typeof document` so it is SSR-safe.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { authSessionQuery } from "@/lib/api/queries";
import { isAuthCapable } from "@/lib/mock-session";

/** What {@link useAccountMenu} returns: open state + trigger/menu prop spreads. */
export interface UseAccountMenuResult<
  TTrigger extends HTMLElement = HTMLButtonElement,
  TMenu extends HTMLElement = HTMLDivElement,
> {
  /** Whether the menu is currently open. */
  open: boolean;
  /** Open the menu. */
  openMenu: () => void;
  /** Close the menu. */
  closeMenu: () => void;
  /** Toggle the menu. */
  toggle: () => void;
  /** Ref to attach to the trigger element (outside-click + focus-return anchor). */
  triggerRef: React.RefObject<TTrigger | null>;
  /** Ref to attach to the menu/popover element (outside-click boundary). */
  menuRef: React.RefObject<TMenu | null>;
  /** Props to spread on the trigger: click toggles, `aria-expanded`/`aria-haspopup`. */
  triggerProps: {
    "aria-expanded": boolean;
    "aria-haspopup": "menu";
    onClick: () => void;
  };
}

export function useAccountMenu<
  TTrigger extends HTMLElement = HTMLButtonElement,
  TMenu extends HTMLElement = HTMLDivElement,
>(): UseAccountMenuResult<TTrigger, TMenu> {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<TTrigger | null>(null);
  const menuRef = useRef<TMenu | null>(null);

  const closeMenu = useCallback(() => setOpen(false), []);
  const openMenu = useCallback(() => setOpen(true), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        // Return focus to the trigger for keyboard users.
        triggerRef.current?.focus();
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      // A click inside the trigger or the menu does not close it.
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    // `pointerdown` (not `click`) so the close fires before a re-render of the
    // clicked target can detach it from the DOM and defeat `contains`.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  return {
    open,
    openMenu,
    closeMenu,
    toggle,
    triggerRef,
    menuRef,
    triggerProps: {
      "aria-expanded": open,
      "aria-haspopup": "menu",
      onClick: toggle,
    },
  };
}

/**
 * Whether the current operator is an admin (add-private-account-identity, task
 * 9.4). Gates the account menu's 账号管理 entry, which is admin-only (the
 * account-administration page is restricted to `role = admin` principals; a
 * non-admin is 403'd server-side regardless, so this is a UX gate, not the
 * security boundary).
 *
 * Reads the resolved auth session (the same source the AccountMenu identity
 * derives from). `role` is added to the session shape by the contracts/auth-core
 * tracks; under REAL auth this reads it STRUCTURALLY and treats the operator as
 * admin ONLY when the session explicitly reports `role === "admin"`. Under the
 * MOCK gate (and the `VITE_FORCE_MOCK` visual harness) the single mock
 * operator IS the admin, so this returns `true` — keeping the 账号管理 entry
 * present in the mock/visual posture (matching the design).
 *
 * SSR-safe: a pure read of the query data (no window/clock access).
 */
export function useIsAdmin(): boolean {
  const { data: session } = useQuery(authSessionQuery());
  // Mock gate: the lone mock operator is the admin (design posture).
  if (!isAuthCapable()) return true;
  const role = (session as { role?: unknown } | null | undefined)?.role;
  return role === "admin";
}
