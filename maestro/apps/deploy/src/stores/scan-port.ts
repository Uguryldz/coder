import type { ScanTool } from "@maestro/contracts";
import type { ScanPort, ScanTarget } from "@maestro/ports";

/** The registry name of the three-tool container scan port. */
export const CONTAINER_TRIO_DRIVER = "container-trio";
export const TRIO_TOOLS = ["gitleaks", "semgrep", "trivy"] as const;
export type TrioTool = (typeof TRIO_TOOLS)[number];

/**
 * One `ScanPort` over the three mandatory tools (M27: gitleaks, semgrep,
 * trivy). `@maestro/scanners` registers each tool as its own driver with its
 * own digest-pinned image; the workflow's step 6b talks to ONE port and names
 * the tool per call, so something has to fan out — this does, and refuses a
 * tool it was not composed for with a message that says which variable to set
 * instead of pretending the scan happened.
 */
export function compositeScanPort(byTool: Partial<Record<ScanTool, ScanPort>>): ScanPort {
  return {
    run(tool: ScanTool, target: ScanTarget) {
      const port = byTool[tool];
      if (port === undefined) {
        return Promise.reject(
          new Error(
            `scan: no driver composed for "${tool}" — set SCAN_IMAGE_${tool.toUpperCase()} to a digest-pinned image (M27)`,
          ),
        );
      }
      return port.run(tool, target);
    },
  };
}

export interface TrioSelection {
  readonly images: Record<TrioTool, string>;
  readonly semgrepRules: string;
}

/**
 * What the trio needs before it may be composed: three digest-pinned images
 * AND semgrep's offline rules. `missing` names the variables, in the order an
 * operator would set them, so the boot note can be copied into `.env`.
 */
export function trioSelectionFrom(source: {
  readonly images: Partial<Record<TrioTool, string | undefined>>;
  readonly semgrepRules?: string | undefined;
}): { readonly configured: TrioSelection | null; readonly missing: readonly string[] } {
  const missing: string[] = [];
  for (const tool of TRIO_TOOLS) {
    if ((source.images[tool] ?? "").trim() === "") missing.push(`SCAN_IMAGE_${tool.toUpperCase()}`);
  }
  if ((source.semgrepRules ?? "").trim() === "") missing.push("SCAN_SEMGREP_RULES");
  if (missing.length > 0) return { configured: null, missing };
  return {
    configured: {
      images: {
        gitleaks: source.images.gitleaks!.trim(),
        semgrep: source.images.semgrep!.trim(),
        trivy: source.images.trivy!.trim(),
      },
      semgrepRules: source.semgrepRules!.trim(),
    },
    missing: [],
  };
}
