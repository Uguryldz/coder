import { describe, expect, it } from "vitest";
import { auth, harness, type Harness } from "./helpers.js";

async function twoAdmins(h: Harness): Promise<{ first: string; second: string }> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  await h.addUser({ username: "mert.demir", roles: ["admin"] });
  return { first: await h.login("ayse.kaya"), second: await h.login("mert.demir") };
}

function put(h: Harness, token: string, key: string, value: unknown) {
  return h.app.inject({
    method: "PUT",
    url: `/params/${key}`,
    headers: auth(token),
    payload: { value },
  });
}

describe("PUT /params/:key (M71, four eyes)", () => {
  it("applies an unguarded parameter straight away", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    const response = await put(h, first, "reminder.channel", "smtp");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "applied", change: { version: 1 } });
    expect(await h.params.values()).toHaveLength(1);
  });

  it("does NOT apply a guarded parameter on one signature", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    const response = await put(h, first, "gate.set", { kritik: ["4", "5"] });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "pending" });
    expect(await h.params.values()).toHaveLength(0);
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).not.toContain("PARAM_CHANGED");
  });

  it("still does not apply it when the same person presses twice", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    await put(h, first, "gate.set", { kritik: ["4", "5"] });
    const second = await put(h, first, "gate.set", { kritik: ["4", "5"] });

    expect(second.statusCode).toBe(202);
    expect(await h.params.values()).toHaveLength(0);
  });

  it("applies it when a second, different person confirms the same value", async () => {
    const h = await harness();
    const { first, second } = await twoAdmins(h);
    const value = { kritik: ["4", "5"] };

    await put(h, first, "gate.set", value);
    const response = await put(h, second, "gate.set", value);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "applied",
      change: {
        changedBy: "ayse.kaya@ugurbank.local",
        approvedBy: "mert.demir@ugurbank.local",
        version: 1,
      },
    });
    expect(await h.params.pending()).toHaveLength(0);

    const events = await h.auditStore.read();
    const recorded = events.filter((event) => event.action === "PARAM_CHANGED");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.actor).toBe("mert.demir@ugurbank.local");
  });

  it("refuses to apply when the second person confirms a DIFFERENT value", async () => {
    const h = await harness();
    const { first, second } = await twoAdmins(h);

    await put(h, first, "gate.set", { kritik: ["4", "5"] });
    const response = await put(h, second, "gate.set", { kritik: ["5"] });

    expect(response.statusCode).toBe(409);
    expect(await h.params.values()).toHaveLength(0);
    expect(await h.params.pending()).toHaveLength(1);
  });

  it("treats a re-ordered object as the same value", async () => {
    const h = await harness();
    const { first, second } = await twoAdmins(h);

    await put(h, first, "gate.set", { a: 1, b: 2 });
    const response = await put(h, second, "gate.set", { b: 2, a: 1 });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a value that does not fit the definition", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    const response = await put(h, first, "reminder.channel", "carrier-pigeon");

    expect(response.statusCode).toBe(400);
    expect(await h.params.values()).toHaveLength(0);
  });

  it("404s on an unknown parameter", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    const response = await put(h, first, "made.up", "x");

    expect(response.statusCode).toBe(404);
  });

  it("versions successive changes", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    await put(h, first, "reminder.channel", "smtp");
    const second = await put(h, first, "reminder.channel", "slack");

    expect(second.json()).toMatchObject({ change: { version: 2 } });
  });
});

describe("GET /params", () => {
  it("returns definitions, values and the pending queue", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);
    await put(h, first, "gate.set", { kritik: ["4"] });

    const response = await h.app.inject({ method: "GET", url: "/params", headers: auth(first) });

    const body = response.json() as { definitions: unknown[]; values: unknown[]; pending: unknown[] };
    expect(body.definitions).toHaveLength(2);
    expect(body.values).toHaveLength(0);
    expect(body.pending).toHaveLength(1);
  });
});
