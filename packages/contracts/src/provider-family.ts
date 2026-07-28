/**
 * THE declaration of which sandbox provider families exist.
 *
 * This list was previously restated independently in four places whose contents
 * disagreed — two schemas in this package (differing even in member ORDER, the
 * signature of independent hand-maintenance) and two api-side enums that omit
 * `cloud-http`. Adding a provider meant finding all of them, with nothing
 * pointing at them and nothing failing if one was missed.
 *
 * Everything that depends on which providers exist derives from here.
 * A surface that legitimately admits MORE (a diagnostic emitted before a
 * provider is selected) or covers only a SUBSET (a seam that genuinely cannot
 * apply to some provider) states that as an explicit extension of, or subset of,
 * this list — so the widening or narrowing is visible rather than hidden in a
 * separately maintained array.
 */
export const SANDBOX_PROVIDER_FAMILIES = [
  'aio',
  'boxlite',
  'cloud-http',
] as const;

export type SandboxProviderFamily = (typeof SANDBOX_PROVIDER_FAMILIES)[number];
