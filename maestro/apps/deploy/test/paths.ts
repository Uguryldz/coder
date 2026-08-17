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

/**
 * `maestro/deploy/banka/` — the air-gapped bank bundle.
 *
 * A SEPARATE artefact from the files above, and the distinction matters: the
 * bundle is what leaves the building on a USB stick, it builds nothing, and it
 * is the only copy a bank's sysadmin ever sees. A defect fixed in
 * `deploy/compose.yaml` does not reach it.
 */
export function bankaDir(): string {
  return fileURLToPath(new URL("../../../deploy/banka/", import.meta.url));
}

export function bankaComposePath(): string {
  return `${bankaDir()}docker-compose.yml`;
}

export function bankaEnvExamplePath(): string {
  return `${bankaDir()}.env.example`;
}

export function bankaInstallPath(): string {
  return `${bankaDir()}install.sh`;
}

/**
 * `maestro/.dockerignore` — the repository root, not `deploy/`.
 *
 * It lives beside the build CONTEXT (the monorepo root is what both Dockerfiles
 * are built from), which is why it is not under `deployDir()` with its
 * neighbours.
 */
export function dockerignorePath(): string {
  return fileURLToPath(new URL("../../../.dockerignore", import.meta.url));
}
