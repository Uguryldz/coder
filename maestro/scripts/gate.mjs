#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

/**
 * The gate: lint, then typecheck + test across every package, cache disabled.
 *
 * This was a one-line npm script (`turbo run … --concurrency=4`) until the
 * worker arithmetic caught up with it. Turborepo ran four packages at once and
 * each one spawned up to `cpus().length` vitest workers of its own — 4 × 8 = 32
 * processes on an eight-core machine. Nothing failed *because* of the
 * oversubscription, but every test with a timing assumption started losing
 * races under it: a 300 ms process spawn, a PII boundary check, a React screen
 * waiting on a microtask. They passed alone, passed on a quiet gate, and failed
 * on a loaded one — the worst kind of red, indistinguishable from a real defect
 * until you have run it five times.
 *
 * So the budget is divided rather than multiplied: lanes × workers-per-lane
 * stays within the core count. Both numbers are derived here, in one place,
 * from the machine actually running — a developer laptop, this box and CI all
 * get a budget that fits rather than a constant someone tuned once.
 */

const cores = cpus().length;

/**
 * Package-level parallelism. Two cores per lane is the smallest split that
 * still overlaps a package's own suites; below four cores there is nothing to
 * divide and the gate simply runs one package at a time.
 */
const lanes = Math.max(1, Math.min(4, Math.floor(cores / 2)));

/**
 * Workers inside each lane. The floor of one matters: a share of zero would
 * disable threading entirely, and the ceiling of four keeps workers from
 * contending more than they help.
 */
const workersPerLane = Math.max(1, Math.min(4, Math.floor(cores / lanes)));

/**
 * Per-test deadline, scaled to how busy the machine already is.
 *
 * vitest's 5 s default assumes a test has a core mostly to itself. The gate
 * runs several packages at once, and this repo is often built while a dozen
 * background agents compile in parallel — at load 37 on 8 cores, a suite that
 * finishes in 65 ms alone times out at 5 s and reports a defect that is not
 * there. Chasing those wastes more time than the slack costs: a real hang still
 * fails, just later.
 *
 * Read from /proc when available (Linux); elsewhere the plain default stands.
 *
 * Passed as vitest's `--testTimeout` flag, NOT as an environment variable:
 * `VITEST_TESTTIMEOUT` looks plausible and is silently ignored — verified by
 * setting it to 1 ms, after which all 210 storage tests still passed. The flag
 * with the same value fails 140 of them, which is how a knob should behave when
 * you turn it.
 */
function testTimeoutMs() {
  const base = 5_000;
  try {
    const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
    if (!Number.isFinite(load)) return base;
    const pressure = Math.max(1, load / cores);
    return Math.min(60_000, Math.round(base * Math.min(6, pressure)));
  } catch {
    return base;
  }
}

const TEST_TIMEOUT = testTimeoutMs();

const env = {
  ...process.env,
  // vitest reads these; they cap the pool without forcing single-threading, so
  // independent suites still overlap — there are just never more in flight than
  // the machine can actually run.
  VITEST_MAX_THREADS: String(workersPerLane),
  VITEST_MIN_THREADS: "1",
  VITEST_MAX_FORKS: String(workersPerLane),
  VITEST_MIN_FORKS: "1",
};

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

console.info(
  `[gate] ${cores} cores → ${lanes} lanes × ${workersPerLane} workers · test timeout ${TEST_TIMEOUT}ms`,
);

const lintStatus = run("pnpm", ["lint"]);
if (lintStatus !== 0) process.exit(lintStatus);

// `--force` on purpose: a gate that reads the cache proves the cache is warm,
// not that the code passes. This is the one command in the repo that must
// re-run everything.
// Two invocations rather than one.
//
// Everything after `--` is forwarded to EVERY task turbo runs, and `tsc` exits
// non-zero on an unknown `--testTimeout`. Splitting them keeps the flag on the
// only task that understands it; `test` still depends on `typecheck` in
// turbo.json, so the ordering guarantee is unchanged.
const typecheckStatus = run("pnpm", [
  "exec",
  "turbo",
  "run",
  "typecheck",
  "--force",
  `--concurrency=${lanes}`,
]);
if (typecheckStatus !== 0) process.exit(typecheckStatus);

process.exit(
  run("pnpm", [
    "exec",
    "turbo",
    "run",
    "test",
    "--force",
    `--concurrency=${lanes}`,
    // Reaches each package's own `test` script, which is `vitest run` in all
    // of them.
    "--",
    `--testTimeout=${TEST_TIMEOUT}`,
  ]),
);
