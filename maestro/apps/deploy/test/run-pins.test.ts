import { describe, expect, it } from "vitest";
import {
  activeAnalystVariantId,
  activeEngineerVariantId,
  activeTemplateVersion,
  DEFAULT_ANALYST_VARIANT,
  DEFAULT_ENGINEER_VARIANT,
  UNVERSIONED_TEMPLATE,
  type RunPinDb,
} from "../src/stores/run-pins.js";

/**
 * What a run is pinned to when it opens.
 *
 * The fallbacks are the point. An empty variant is not a neutral default: it
 * reaches the gateway as a contract violation on the first model call, which is
 * how a run opened without one presents itself — as a model failure, three
 * activity retries away from the actual mistake.
 */

function db(over: Partial<RunPinDb> = {}): RunPinDb {
  return {
    variant: { findFirst: () => Promise.resolve(null) },
    analysisTemplateVersion: { findFirst: () => Promise.resolve(null) },
    ...over,
  };
}

describe("activeAnalystVariantId", () => {
  it("uses the analyst variant the deployment has", async () => {
    const id = await activeAnalystVariantId(
      db({ variant: { findFirst: () => Promise.resolve({ id: "analyst-kredi" }) } }),
    );
    expect(id).toBe("analyst-kredi");
  });

  it("falls back to a named variant rather than an empty string", async () => {
    expect(await activeAnalystVariantId(db())).toBe(DEFAULT_ANALYST_VARIANT);
    expect(DEFAULT_ANALYST_VARIANT.length).toBeGreaterThan(0);
  });

  it("asks for the analyst role, not whichever variant sorts first", async () => {
    // `engineer-default` sorts before `analyst-kredi` by id; asking without the
    // role filter would pin an analysis run to the engineering agent.
    let asked: unknown;
    await activeAnalystVariantId(
      db({
        variant: {
          findFirst: (args) => {
            asked = args.where;
            return Promise.resolve({ id: "analyst-kredi" });
          },
        },
      }),
    );
    expect(asked).toEqual({ role: "analyst" });
  });
});

describe("activeEngineerVariantId", () => {
  it("uses the engineer variant the deployment has", async () => {
    const id = await activeEngineerVariantId(
      db({ variant: { findFirst: () => Promise.resolve({ id: "engineer-dotnet" }) } }),
    );
    expect(id).toBe("engineer-dotnet");
  });

  it("falls back to a named variant rather than an empty string", async () => {
    expect(await activeEngineerVariantId(db())).toBe(DEFAULT_ENGINEER_VARIANT);
    expect(DEFAULT_ENGINEER_VARIANT.length).toBeGreaterThan(0);
  });

  it("asks for the ENGINEER role — the whole point of the second pin", async () => {
    // Bu satır olmadan mühendislik turu analistin ajanıyla koşuyordu: pin tekti
    // ve onu `activeAnalystVariantId` `role: 'analyst'` diye planlıyordu.
    let asked: unknown;
    await activeEngineerVariantId(
      db({
        variant: {
          findFirst: (args) => {
            asked = args.where;
            return Promise.resolve({ id: "engineer-dotnet" });
          },
        },
      }),
    );
    expect(asked).toEqual({ role: "engineer" });
  });

  it("mühendis ve analist iğneleri BİRBİRİNDEN FARKLI rolleri sorar", async () => {
    // Aynı sahte veritabanına iki soru: ikisi de aynı rolü sorsaydı, iki ajanlı
    // bir kurulum tek ajanla koşardı — göç 0022 öncesinin tam olarak hâli.
    const roles: unknown[] = [];
    const shared = db({
      variant: {
        findFirst: (args) => {
          roles.push(args.where);
          return Promise.resolve(null);
        },
      },
    });
    await activeAnalystVariantId(shared);
    await activeEngineerVariantId(shared);
    expect(roles).toEqual([{ role: "analyst" }, { role: "engineer" }]);
  });
});

describe("activeTemplateVersion", () => {
  it("pins the newest published version", async () => {
    const version = await activeTemplateVersion(
      db({ analysisTemplateVersion: { findFirst: () => Promise.resolve({ version: 7 }) } }),
    );
    expect(version).toBe("7");
  });

  it("names the absence rather than pinning an empty string", async () => {
    // `assertDocument` compares this against what the analyst stamped and
    // reports the mismatch; "" would make that message say nothing.
    expect(await activeTemplateVersion(db())).toBe(UNVERSIONED_TEMPLATE);
  });
});
