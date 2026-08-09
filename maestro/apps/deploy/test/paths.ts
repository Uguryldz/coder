import { fileURLToPath } from "node:url";

/**
 * Paths to the deployment artefacts the tests read.
 *
 * Resolved from this module's own URL rather than from `process.cwd()`: the
 * suite must give the same answer whether it is run from the package, from the
 * repository root, or by turbo.
 */

/** `maestro/deploy/` — the non-code deployment artefacts. */
export function deployDir(): string {
  return fileURLToPath(new URL("../../../deploy/", import.meta.url));
}

export function composePath(): string {
  return `${deployDir()}compose.yaml`;
}

export function envExamplePath(): string {
  return `${deployDir()}.env.example`;
}

export function dockerfilePath(name: string): string {
  return `${deployDir()}docker/${name}`;
}
