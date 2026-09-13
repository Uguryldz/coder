import { describe, expect, it } from "vitest";
import { PortRegistry } from "@maestro/ports";
import { PORT_NAMES } from "@maestro/workflows";
import { withWorkspaceCloning } from "../src/bin/worker.js";
import type { DeployEnv } from "../src/env.js";
import type { SecretPort } from "@maestro/ports";

/**
 * SARMALAYICI HİÇBİR SÜRÜCÜYÜ DÜŞÜRMEZ.
 *
 * Bu sarmalayıcı `ScmPort`a `ensureWorkspace` eklemek için registry'yi yeniden
 * kuruyor ve bunu yaparken port adlarını bir dönem ELLE yazılmış bir listeden
 * okuyordu. İçindeki `"storage"` yanlıştı — registry'deki gerçek ad
 * `"StoragePort"` (tarihsel yazım, `PORT_NAMES` bunu belgeliyor).
 *
 * Sonuç sessiz ve yıkıcıydı: sarmalayıcı `storage` adıyla hiçbir sürücü
 * bulamadı, kopyalamadı, ve worker açılışta öldü:
 *
 *   startup failed: no driver "pg-blob" for port "StoragePort" — available: (none)
 *
 * Canlıda ölçüldü: worker 3793 kez yeniden başladı ve HİÇ çalışmadı. Klon
 * zincirine yapılan her düzeltme doğruydu ama ölü bir sürecin arkasındaydı.
 *
 * Testin tuttuğu şey bir isim listesi değil, BİR ÖZELLİK: sarmalanmış registry
 * her portta, sarmalanmamış olanın çözebildiği her sürücüyü çözebilmeli.
 */
const env = { source: {} } as unknown as DeployEnv;
const secrets = { get: () => Promise.resolve("t") } as unknown as SecretPort;

function seeded(): PortRegistry {
  const registry = new PortRegistry();
  for (const port of Object.values(PORT_NAMES)) {
    registry.register(port, "birinci", () => ({ port, driver: "birinci" }));
    registry.register(port, "ikinci", () => ({ port, driver: "ikinci" }));
  }
  return registry;
}

describe("withWorkspaceCloning", () => {
  it("carries EVERY port and driver across, storage included", () => {
    const wrapped = withWorkspaceCloning(seeded(), env, secrets);
    for (const port of Object.values(PORT_NAMES)) {
      expect(wrapped.drivers(port).sort(), `port ${port}`).toEqual(["birinci", "ikinci"]);
      // Çözülebilmeli de: kayıtlı olup çözülemeyen bir sürücü worker'ı yine öldürürdü.
      expect(() => wrapped.resolve(port, "birinci"), `resolve ${port}`).not.toThrow();
    }
  });

  it("names the storage port exactly as the registry does", () => {
    // Bu satır kırığın ta kendisi: `"storage"` ile `"StoragePort"` ayrı adlar.
    const wrapped = withWorkspaceCloning(seeded(), env, secrets);
    expect(wrapped.drivers(PORT_NAMES.storage)).toHaveLength(2);
    expect(PORT_NAMES.storage).toBe("StoragePort");
  });

  it("adds ensureWorkspace to scm and leaves the other ports untouched", () => {
    const wrapped = withWorkspaceCloning(seeded(), env, secrets);
    const scm = wrapped.resolve<Record<string, unknown>>(PORT_NAMES.scm, "birinci")({});
    expect(typeof scm["ensureWorkspace"]).toBe("function");
    // Sürücünün kendi alanları korunur — sarmalayıcı ekler, değiştirmez.
    expect(scm["driver"]).toBe("birinci");

    const storage = wrapped.resolve<Record<string, unknown>>(PORT_NAMES.storage, "birinci")({});
    expect(storage["ensureWorkspace"]).toBeUndefined();
    expect(storage["driver"]).toBe("birinci");
  });
});
