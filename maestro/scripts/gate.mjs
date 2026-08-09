#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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

console.info(`[gate] ${cores} cores → ${lanes} lanes × ${workersPerLane} workers`);

const lintStatus = run("pnpm", ["lint"]);
if (lintStatus !== 0) process.exit(lintStatus);

// `--force` on purpose: a gate that reads the cache proves the cache is warm,
// not that the code passes. This is the one command in the repo that must
// re-run everything.
process.exit(run("pnpm", ["exec", "turbo", "run", "typecheck", "test", "--force", `--concurrency=${lanes}`]));
