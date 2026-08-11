/**
 * Public surface of `@maestro/pilot` for a LAUNCHER that boots it.
 *
 * `main.ts` is the standalone, DB-free entry (env fallback). A launcher that
 * CAN read Postgres — the composition root in `apps/deploy` — imports `bootPilot`
 * from here and hands it a `VariantModelReader` so the model is resolved from the
 * variant (Studio/DB), not env. Only the port TYPE crosses this boundary: the
 * pilot stays DB-free; the reader implementation lives in the launcher.
 */
export { bootPilot } from "./boot.js";
export type { BootOptions, PilotStage } from "./boot.js";
export type { VariantModelReader, ResolvedVariantModel } from "./variant.js";
