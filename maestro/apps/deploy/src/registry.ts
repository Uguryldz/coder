import { registerAdoDrivers } from "@maestro/adapter-ado";
import { registerJiraDrivers } from "@maestro/adapter-jira";
import { registerLlmDrivers } from "@maestro/llm-gateway";
import { registerNotifyDrivers } from "@maestro/notify";
import { PortRegistry, type SecretPort, type WorkPort } from "@maestro/ports";
import { registerPublishDrivers } from "@maestro/publish";
import { registerScanDrivers } from "@maestro/scanners";
import { registerRunnerDrivers } from "@maestro/runners";
import { registerSecretDrivers } from "@maestro/secrets";
import { registerStorageDrivers } from "@maestro/storage";
import type { PublishDeps } from "@maestro/publish";
import type { ScanDeps } from "@maestro/scanners";
import type { NotifyDeps } from "@maestro/notify";
import type { LlmGatewayDeps } from "@maestro/llm-gateway";

/**
 * THE composition root's registration half (M44).
 *
 * This module — and only this module — imports driver packages. Everything
 * under `packages/*` resolves its collaborators by port name through the
 * `PortRegistry`; the import list above is the complete, auditable set of
 * concrete technologies this platform can speak to.
 *
 * Registration is split from resolution on purpose. Registering a driver
 * promises nothing: it says "this deployment CAN speak S3", not "this
 * deployment uses S3". The profile decides which of them is actually built,
 * and `resolveDeployment` is where a wrong answer becomes a startup failure.
 */

/**
 * Collaborators no declarative config can carry. Each corresponds to a `deps`
 * parameter one of the `register*` functions demands; grouping them here keeps
 * the call site below a flat list rather than ten ad-hoc object literals.
 */
export interface RegistrationDeps {
  /**
   * Resolves secret REFERENCES for the drivers that need a value at call time
   * (Jira's PAT, ADO's PAT and webhook secret). Built first — the secret port
   * is the one driver that cannot be resolved through the registry, because
   * everything else needs it to exist already.
   */
  readonly secrets: SecretPort;
  /**
   * The work port, built before this registry (see `bootPlatform`). Two
   * drivers register ON TOP of another port rather than on a driver:
   * `notify/jira` and `publish/jira` both post through it, and both demand it
   * at registration time.
   */
  readonly work: WorkPort;
  readonly llm: LlmGatewayDeps;
  readonly notify: NotifyDeps;
  readonly publish: PublishDeps;
  readonly scan: ScanDeps;
}

/**
 * Build the registry every service shares.
 *
 * The order is not arbitrary: `registerSecretDrivers` comes first because the
 * secret port is what the caller had to resolve to build `deps.secrets` at all,
 * and registering it here means the same registry can answer for it later
 * (`PortSelection` includes `secret`, and the worker resolves it like any
 * other port rather than being handed a privileged instance).
 */
export function buildRegistry(deps: RegistrationDeps): PortRegistry {
  const registry = new PortRegistry();

  registerSecretDrivers(registry);
  registerJiraDrivers(registry);
  registerAdoDrivers(registry, {
    // The ADO package deliberately takes callbacks rather than a SecretPort,
    // so that it never imports `@maestro/secrets`. Binding them is this
    // module's job (M44/M80).
    resolveToken: (tokenRef) => deps.secrets.get(tokenRef),
    issueSecret: (scope, ttlSeconds) => deps.secrets.issueShortLived(scope, ttlSeconds),
  });
  registerStorageDrivers(registry);
  registerLlmDrivers(registry, deps.llm);
  registerNotifyDrivers(registry, deps.notify);
  registerPublishDrivers(registry, deps.publish);
  registerScanDrivers(registry, deps.scan);
  registerRunnerDrivers(registry);

  return registry;
}
