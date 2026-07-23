import os from 'node:os';
import Docker from 'dockerode';

/**
 * Repo-store volume detection (add-repo-content-store D4).
 *
 * The `volume` workspace source names a DOCKER VOLUME, which orchestration
 * cannot know by itself: under compose the volume is project-qualified
 * (`<project>_repo-store`). The api container already has it mounted, so the
 * name is read back from the api's OWN container mounts — the same
 * self-inspection idiom the self-update topology resolver uses.
 *
 * It lives in the provider package (not in API code) because it is a
 * container-runtime detail; orchestration consumes the neutral interface.
 */
export interface RepoStoreVolumeInspector {
  /** Name of the volume mounted at `destination`, or null when not found. */
  resolveVolumeName(destination: string): Promise<string | null>;
}

export interface AioRepoStoreVolumeInspectorOptions {
  /** Injected for tests; production self-inspects over the docker socket. */
  readonly inspectSelf?: () => Promise<{
    readonly Mounts?: ReadonlyArray<{
      readonly Type?: string;
      readonly Name?: string;
      readonly Destination?: string;
    }>;
  } | null>;
  readonly hostname?: () => string;
}

export function createRepoStoreVolumeInspector(
  options: AioRepoStoreVolumeInspectorOptions = {},
): RepoStoreVolumeInspector {
  const inspectSelf =
    options.inspectSelf ??
    (async () => {
      const docker = new Docker();
      // The container's hostname defaults to its own (short) id.
      const hostname = (options.hostname ?? os.hostname)();
      return (await docker
        .getContainer(hostname)
        .inspect()
        .catch(() => null)) as {
        readonly Mounts?: ReadonlyArray<{
          readonly Type?: string;
          readonly Name?: string;
          readonly Destination?: string;
        }>;
      } | null;
    });
  return {
    async resolveVolumeName(destination: string): Promise<string | null> {
      const self = await inspectSelf().catch(() => null);
      const match = (self?.Mounts ?? []).find(
        (mount) =>
          mount.Type === 'volume' &&
          typeof mount.Name === 'string' &&
          mount.Name.length > 0 &&
          trimTrailingSlash(mount.Destination ?? '') ===
            trimTrailingSlash(destination),
      );
      return match?.Name ?? null;
    },
  };
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/u, '') : value;
}
