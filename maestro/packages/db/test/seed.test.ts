import { describe, expect, it } from "vitest";
import {
  GATES_BY_RISK,
  Locale,
  NotifyChannel,
  ParamDefinition,
  ParamKey,
} from "@maestro/contracts";
import {
  DEFAULT_PARAM_DEFINITIONS,
  GLOBAL_SCOPE_REF,
  SEED_ACTOR,
  seedParams,
} from "../src/index.js";

type SeedDb = Parameters<typeof seedParams>[0];

interface UpsertCall {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/** In-memory stand-in for the two delegates the seed touches. No database. */
function fakeDb(): { db: SeedDb; params: UpsertCall[]; versions: UpsertCall[] } {
  const params: UpsertCall[] = [];
  const versions: UpsertCall[] = [];
  const db = {
    param: {
      upsert: (args: UpsertCall) => {
        params.push(args);
        return Promise.resolve(args.create);
      },
    },
    paramVersion: {
      upsert: (args: UpsertCall) => {
        versions.push(args);
        return Promise.resolve(args.create);
      },
    },
  } as unknown as SeedDb;
  return { db, params, versions };
}

describe("default parameter definitions", () => {
  it("ships the 12 parameters of the Studio parameters screen", () => {
    expect(DEFAULT_PARAM_DEFINITIONS.length).toBe(12);
  });

  it("validates against the ParamDefinition contract", () => {
    for (const def of DEFAULT_PARAM_DEFINITIONS) {
      const parsed = ParamDefinition.safeParse(def);
      expect(parsed.success, `${def.key}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("uses unique, contract-shaped keys", () => {
    const keys = DEFAULT_PARAM_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(ParamKey.safeParse(key).success).toBe(true);
  });

  it("names every description through the i18n catalog (M104)", () => {
    for (const def of DEFAULT_PARAM_DEFINITIONS) {
      expect(def.descriptionKey.startsWith("params.description."), def.key).toBe(true);
    }
  });

  it("declares enumValues exactly for enum-typed parameters", () => {
    for (const def of DEFAULT_PARAM_DEFINITIONS) {
      if (def.type === "enum") {
        expect(def.enumValues, def.key).toBeDefined();
        expect((def.enumValues ?? []).length, def.key).toBeGreaterThan(1);
      } else {
        expect(def.enumValues, def.key).toBeUndefined();
      }
    }
  });

  it("gives every parameter a default matching its declared type", () => {
    for (const def of DEFAULT_PARAM_DEFINITIONS) {
      switch (def.type) {
        case "boolean":
          expect(typeof def.defaultValue, def.key).toBe("boolean");
          break;
        case "number":
          expect(typeof def.defaultValue, def.key).toBe("number");
          break;
        case "string":
          expect(typeof def.defaultValue, def.key).toBe("string");
          break;
        case "enum":
          expect(def.enumValues ?? [], def.key).toContain(def.defaultValue);
          break;
        case "json":
          expect(typeof def.defaultValue, def.key).toBe("object");
          break;
      }
    }
  });

  it("four-eyes guards every control-weakening parameter", () => {
    const guarded = DEFAULT_PARAM_DEFINITIONS.filter((d) => d.guarded).map((d) => d.key).sort();
    expect(guarded).toEqual([
      "coverage.ratchet",
      "dataclass.policy",
      "gates.risk_tiers",
      "killswitch.state",
      "merge.mode",
      "sod.qa_split",
    ]);
  });
});

/** Seeded values are decisions from the master plan — pinned one by one. */
describe("seeded defaults follow the decision record", () => {
  function def(key: string) {
    const found = DEFAULT_PARAM_DEFINITIONS.find((d) => d.key === key);
    expect(found, `missing seed parameter ${key}`).toBeDefined();
    return found!;
  }

  it("M51 gate sets equal the contract's GATES_BY_RISK", () => {
    expect(def("gates.risk_tiers").defaultValue).toEqual({
      dusuk: [...GATES_BY_RISK.dusuk],
      orta: [...GATES_BY_RISK.orta],
      kritik: [...GATES_BY_RISK.kritik],
    });
  });

  it("M88 escalation ladder is 24h -> 72h -> 7d", () => {
    const ladder = def("escalation.ladder").defaultValue as { steps: { afterHours: number }[] };
    expect(ladder.steps.map((s) => s.afterHours)).toEqual([24, 72, 168]);
  });

  it("M59 output language offers the supported locales and defaults to tr", () => {
    const language = def("lang.output");
    expect(language.enumValues).toEqual([...Locale.options]);
    expect(language.defaultValue).toBe("tr");
  });

  it("M70 coverage ratchet forbids decreases and floors new lines at 80%", () => {
    expect(def("coverage.ratchet").defaultValue).toEqual({
      allowDecrease: false,
      minNewLinePct: 80,
    });
  });

  it("M92 QA separation of duties ships OFF", () => {
    expect(def("sod.qa_split").defaultValue).toBe(false);
  });

  it("M65 workspace archive age is 60 days", () => {
    expect(def("workspace.max_age_days").defaultValue).toBe(60);
  });

  it("M58 kill switch has both levels plus off, and starts off", () => {
    const killSwitch = def("killswitch.state");
    expect(killSwitch.enumValues).toEqual(["off", "intake_only", "all"]);
    expect(killSwitch.defaultValue).toBe("off");
  });

  it("M48 merge mode defaults to human merge", () => {
    expect(def("merge.mode").defaultValue).toBe("human_merge");
    expect(def("merge.mode").scope).toBe("project");
  });

  it("M102 dry-run sample size is 20", () => {
    expect(def("binding.dry_run_sample_size").defaultValue).toBe(20);
  });

  it("M18 data-class policy degrades to ai-assist when on-prem is missing", () => {
    expect(def("dataclass.policy").defaultValue).toEqual({
      backendByClass: { acik: "api", dahili: "api", gizli: "onprem" },
      whenOnpremMissing: "degrade_ai_assist",
    });
  });

  it("M55 subscription queueing is on (exhausted pool waits, never fails)", () => {
    expect(def("subscription.queue_enabled").defaultValue).toBe(true);
  });

  it("M45 reminder channel is a NotifyPort channel, defaulting to Jira", () => {
    const channel = def("notify.reminder_channel");
    expect(channel.enumValues).toEqual([...NotifyChannel.options]);
    expect(channel.defaultValue).toBe("jira");
  });
});

describe("seedParams", () => {
  const now = new Date("2026-08-08T09:00:00.000Z");

  it("upserts one definition and one initial version per parameter", async () => {
    const { db, params, versions } = fakeDb();
    const result = await seedParams(db, { now });

    expect(result).toEqual({ definitions: 12, initialVersions: 12 });
    expect(params.length).toBe(12);
    expect(versions.length).toBe(12);
  });

  it("writes the definition remainder into defJson", async () => {
    const { db, params } = fakeDb();
    await seedParams(db, { now });

    const gateSet = params.find((p) => p.where["key"] === "gates.risk_tiers");
    expect(gateSet?.create).toMatchObject({
      key: "gates.risk_tiers",
      scope: "global",
      type: "json",
      guarded: true,
    });
    expect(gateSet?.create["defJson"]).toEqual({
      enumValues: null,
      descriptionKey: "params.description.gate_set",
      defaultValue: {
        dusuk: ["5", "12"],
        orta: ["4", "5", "11", "12"],
        kritik: ["4", "5", "9", "11", "12"],
      },
    });
  });

  it("records version 1 at the global scope ref with the injected clock", async () => {
    const { db, versions } = fakeDb();
    await seedParams(db, { now });

    for (const version of versions) {
      expect(version.create).toMatchObject({
        scopeRef: GLOBAL_SCOPE_REF,
        version: 1,
        changedBy: SEED_ACTOR,
        approvedBy: null,
        at: now,
      });
    }
  });

  it("never overwrites an operator's value on re-run", async () => {
    const { db, params, versions } = fakeDb();
    await seedParams(db, { now });

    // Definitions are code-owned, so they are refreshed...
    expect(params.every((p) => Object.keys(p.update).length > 0)).toBe(true);
    // ...but values are only ever created.
    expect(versions.every((v) => Object.keys(v.update).length === 0)).toBe(true);
  });

  it("accepts an explicit actor", async () => {
    const { db, versions } = fakeDb();
    await seedParams(db, { now, changedBy: "ugur@corp" });
    expect(versions[0]?.create["changedBy"]).toBe("ugur@corp");
  });
});
