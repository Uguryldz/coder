import { ScanSeverity } from "@maestro/contracts";
import { z } from "zod";
import { parsePinnedImage } from "./image.js";

export const SCAN_PORT = "scan";

/** The mandatory trio (M27). The rest of `ScanTool` are optional org drivers (M77). */
export const CORE_SCAN_TOOLS = ["gitleaks", "semgrep", "trivy"] as const;
export type CoreScanTool = (typeof CORE_SCAN_TOOLS)[number];

/**
 * Threshold parameter key (M71); the value lives in the DB. The default here
 * mirrors `packages/db/src/params-defaults.ts` on purpose — a driver-local
 * default that disagrees with the platform one is the bug we are avoiding.
 */
export const SCAN_BLOCK_LEVEL_PARAM = "scan.block_level";
export const DEFAULT_BLOCK_LEVEL: ScanSeverity = "high";

const PinnedImageRef = z.string().trim().min(1).superRefine((value, ctx) => {
  try {
    parsePinnedImage(value);
  } catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); }
});

/** Absolute POSIX path the workspace is mounted at inside the container. */
const MountPath = z.string().trim().regex(/^\/[A-Za-z0-9._\-/]*$/, "must be an absolute POSIX path");

export const ContainerScanConfig = z.object({
  image: PinnedImageRef,
  /**
   * Lowest severity that blocks (M71 `scan.block_level`). Findings below it are
   * reported but do not fail the gate; an `error` outcome ignores it and always
   * blocks (M27).
   */
  blockLevel: ScanSeverity.default(DEFAULT_BLOCK_LEVEL),
  timeoutSeconds: z.number().int().positive().max(7_200).default(900),
  extraArgs: z.array(z.string().min(1)).default([]),
  workspaceMountPath: MountPath.default("/workspace"),
  /** Offline by default; `internal` is for sites mirroring the trivy DB in-network. */
  networkMode: z.enum(["none", "internal"]).default("none"),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).default({}),
  /** gitleaks reports no severity of its own; a detected secret is graded here. */
  secretSeverity: ScanSeverity.default("critical"),
  /** semgrep `--config`. Rules are never fetched at scan time — offline runners. */
  rulesRef: z.string().trim().min(1).optional(),
  /** stderr can echo matched source lines: an error result is not a disclosure channel. */
  includeStderrInError: z.boolean().default(false),
});
export type ContainerScanConfig = z.infer<typeof ContainerScanConfig>;
