import { createLogger } from "@orkestra/config";
import type { OrkestraYamlConfig } from "@orkestra/contracts";
import Docker from "dockerode";
import { createHash } from "node:crypto";

const log = createLogger("sandbox.dep-cache");

/**
 * Derive a deterministic cache-volume key from the orkestra config and the
 * hash of lockfile(s). Keys are prefixed `orkestra-dep-` so they are easy
 * to reap offline with `docker volume ls`.
 */
export function getDepCacheKey(orkestra: OrkestraYamlConfig, lockfileHash: string): string {
  const h = createHash("sha256");
  h.update(orkestra.language);
  h.update("|");
  h.update(orkestra.sandbox_image);
  h.update("|");
  h.update(orkestra.cache_paths.join(","));
  h.update("|");
  h.update(lockfileHash);
  return `orkestra-dep-${h.digest("hex").slice(0, 24)}`;
}

/**
 * Ensure a named Docker volume exists; returns its name.
 * Volumes are created lazily and labeled for sweep scripts.
 */
export async function getOrCreateVolume(docker: Docker, key: string): Promise<string> {
  try {
    const vol = docker.getVolume(key);
    await vol.inspect();
    log.debug({ key }, "dep cache volume exists");
    return key;
  } catch {
    log.info({ key }, "creating dep cache volume");
    await docker.createVolume({
      Name: key,
      Driver: "local",
      Labels: {
        "orkestra.role": "dep-cache",
        "orkestra.created": new Date().toISOString(),
      },
    });
    return key;
  }
}

export interface DepCacheMount {
  /** Absolute path inside the container where the cache should mount. */
  target: string;
  /** Optional sub-path within the volume to isolate per-ecosystem dirs. */
  subpath?: string;
}

/**
 * Produce HostConfig `Binds` / `Mounts` entries the caller can pass to
 * `docker.createContainer`. We use Mounts so we can set `Consistency`
 * and `Target` discretely for each cache path.
 */
export function attachToContainer(
  volumeName: string,
  mountPoints: DepCacheMount[],
): Docker.MountSettings[] {
  return mountPoints.map((mp) => ({
    Type: "volume",
    Source: volumeName,
    Target: mp.target,
    ReadOnly: false,
    VolumeOptions: mp.subpath
      ? { NoCopy: false, DriverConfig: { Name: "local", Options: {} }, Labels: {} }
      : undefined,
  }));
}
