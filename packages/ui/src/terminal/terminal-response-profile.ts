import type {
  TerminalResponseClass,
  TerminalResponseProfileDescriptor,
} from "@cap/contracts";
import type { ITerminalAddon, Terminal as XTerm } from "@xterm/xterm";

/** The response-affecting window reports negotiated by the live terminal. */
export interface TerminalResponseWindowOptions {
  readonly getWinSizePixels: boolean;
  readonly getCellSizePixels: boolean;
  readonly getWinSizeChars: boolean;
}

/**
 * Runtime values read back from the mounted production wrapper. Package
 * versions are resolved by Node-side source conformance from the UI package's
 * actual install context, never guessed by the browser bundle.
 */
export interface TerminalResponseProfileRuntimeInputs {
  readonly termName: string;
  readonly disableStdin: boolean;
  readonly windowOptions: TerminalResponseWindowOptions;
  readonly responseAffectingAddons: readonly {
    readonly name: string;
    readonly configuration?: string;
  }[];
}

export const TERMINAL_RESPONSE_UNICODE_ADDON_NAME =
  "@xterm/addon-unicode11" as const;
export const TERMINAL_RESPONSE_UNICODE_ACTIVE_VERSION = "11" as const;

/**
 * Canonical response-affecting production inputs. The xterm constructor,
 * addon activation, browser Playwright probe, and lightweight release gate all
 * consume this object, so changing an option cannot leave a parallel static
 * descriptor behind.
 */
export const PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS = Object.freeze({
  termName: "xterm",
  disableStdin: false,
  windowOptions: Object.freeze({
    getWinSizePixels: false,
    getCellSizePixels: false,
    getWinSizeChars: false,
  }),
  responseAffectingAddons: Object.freeze([
    Object.freeze({
      name: TERMINAL_RESPONSE_UNICODE_ADDON_NAME,
      configuration: `activeVersion=${TERMINAL_RESPONSE_UNICODE_ACTIVE_VERSION}`,
    }),
  ]),
}) satisfies TerminalResponseProfileRuntimeInputs;

/** Backward-compatible name used by existing Terminal callers. */
export const TERMINAL_RESPONSE_WINDOW_OPTIONS =
  PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS.windowOptions;

/**
 * Reconstruct the exact descriptor used by both Playwright and the release
 * source gate. Package resolution stays an injected Node-only concern, keeping
 * this helper safe to export from the browser UI package.
 */
export function buildTerminalResponseProfileDescriptor(args: {
  readonly runtimeInputs: TerminalResponseProfileRuntimeInputs;
  readonly schemaVersion: 1;
  readonly responseClasses: readonly TerminalResponseClass[];
  readonly resolvePackageVersion: (packageName: string) => string;
}): TerminalResponseProfileDescriptor {
  return {
    schemaVersion: args.schemaVersion,
    xtermVersion: args.resolvePackageVersion("@xterm/xterm"),
    termName: args.runtimeInputs.termName,
    disableStdin: args.runtimeInputs.disableStdin,
    windowOptions: { ...args.runtimeInputs.windowOptions },
    responseAffectingAddons:
      args.runtimeInputs.responseAffectingAddons.map((addon) => ({
        name: addon.name,
        version: args.resolvePackageVersion(addon.name),
        ...(addon.configuration === undefined
          ? {}
          : { configuration: addon.configuration }),
      })),
    responseClasses: [...args.responseClasses],
  };
}

/** Read back the response-affecting addon state from a mounted xterm. */
export function productionTerminalResponseAddonInputs(
  activeUnicodeVersion: string,
): TerminalResponseProfileRuntimeInputs["responseAffectingAddons"] {
  return [
    {
      name: TERMINAL_RESPONSE_UNICODE_ADDON_NAME,
      configuration: `activeVersion=${activeUnicodeVersion}`,
    },
  ];
}

/**
 * Activate exactly the response-affecting addon declared by the canonical
 * source descriptor. Non-response addons (fit/serialize) stay with the wrapper.
 */
export function activateProductionTerminalResponseAddons(
  term: Pick<XTerm, "loadAddon" | "unicode">,
  unicode11Addon: ITerminalAddon,
): void {
  term.loadAddon(unicode11Addon);
  term.unicode.activeVersion = TERMINAL_RESPONSE_UNICODE_ACTIVE_VERSION;
}
