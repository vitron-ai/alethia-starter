#!/usr/bin/env node
/*
 * Alethia vs Playwright — apples-to-apples benchmark harness.
 *
 * Runs three equivalent flows (smoke, signin, crud) through both frameworks
 * N times each, against the same Atlas app served from the starter's root.
 * Measures wall time per iteration, reports mean / p50 / p95, and writes
 * results.json alongside a human-readable table.
 *
 * What this measures: end-to-end execution time of a single invocation of
 * a test file — exactly what a CI pipeline would clock. Includes spawn
 * cost, which favors neither framework; both pay it.
 *
 * What this does NOT measure: multi-suite, multi-file batch execution.
 * Both frameworks are faster per-step in batch mode. The point of this
 * benchmark is the single-invocation cost an agent pays on each tool call.
 *
 * Usage:
 *   node compare.mjs                       # default N=10 iterations each
 *   node compare.mjs --iterations 30       # more iterations = tighter CI
 *   node compare.mjs --only smoke          # run just one flow
 *   node compare.mjs --target <url>        # non-default Atlas target
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readdirSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STARTER_ROOT = resolve(__dirname, '..');

const getArg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const ITERATIONS = Number(getArg('--iterations', '10'));
const TARGET = getArg('--target', 'http://127.0.0.1:5173');
const ONLY = getArg('--only', null);

const FLOWS = ['smoke', 'signin', 'crud'].filter(name => !ONLY || ONLY === name);

// Atlas flow filenames differ slightly between the two frameworks:
//   .alethia side:  smoke.alethia, signin-flow.alethia, crud-flow.alethia
//   playwright:     smoke.spec.ts, signin.spec.ts, crud.spec.ts
const ALETHIA_FILES = {
  smoke: 'smoke.alethia',
  signin: 'signin-flow.alethia',
  crud: 'crud-flow.alethia',
};

// Summary statistics for a set of per-iteration timings (milliseconds).
const stats = (timings) => {
  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n: sorted.length,
    meanMs: Math.round(mean * 10) / 10,
    p50Ms: Math.round(p(0.5) * 10) / 10,
    p95Ms: Math.round(p(0.95) * 10) / 10,
    minMs: Math.round(sorted[0] * 10) / 10,
    maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
  };
};

// Spawn a command, measure wall time from spawn to exit. Resolves with the
// elapsed ms (or null on non-zero exit). Stderr is captured for diagnosis.
const timeRun = (cmd, args, env = {}) => new Promise((resolvePromise) => {
  const started = performance.now();
  const proc = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('exit', (code) => {
    const elapsedMs = performance.now() - started;
    resolvePromise({ ok: code === 0, elapsedMs, stdout, stderr, code });
  });
});

const runAlethiaOnce = (flow) =>
  timeRun('node', [
    join(STARTER_ROOT, '__alethia__', 'ci-runner.mjs'),
    '--only', ALETHIA_FILES[flow],
    '--reporter', 'plain',
    '--target', TARGET,
  ], {
    ALETHIA_BRIDGE: process.env.ALETHIA_BRIDGE || 'alethia-mcp',
    ALETHIA_TARGET: TARGET,
    ELECTRON_DISABLE_SANDBOX: process.env.ELECTRON_DISABLE_SANDBOX ?? '1',
  });

const runPlaywrightOnce = (flow) =>
  timeRun('npx', [
    'playwright', 'test',
    '--config', join(__dirname, 'playwright.config.ts'),
    join(__dirname, 'playwright-flows', `${flow}.spec.ts`),
  ], {
    CI: '1',
  });

const formatRow = (flow, aleth, pw) => {
  const ratio = pw.meanMs / aleth.meanMs;
  return [
    flow.padEnd(8),
    `${aleth.meanMs}ms`.padEnd(10),
    `${aleth.p95Ms}ms`.padEnd(10),
    `${pw.meanMs}ms`.padEnd(10),
    `${pw.p95Ms}ms`.padEnd(10),
    `${ratio.toFixed(1)}×`,
  ].join('  ');
};

async function main() {
  console.log(`Alethia vs Playwright — ${ITERATIONS} iterations per flow`);
  console.log(`Target: ${TARGET}`);
  console.log(`Flows: ${FLOWS.join(', ')}\n`);

  const results = { target: TARGET, iterations: ITERATIONS, flows: {}, generatedAt: new Date().toISOString() };

  for (const flow of FLOWS) {
    console.log(`── ${flow} ──`);
    // Warm up each framework once so we don't charge the first-run install
    // (Playwright browsers already present; Alethia runtime already spawned).
    console.log('  warmup alethia...');
    await runAlethiaOnce(flow);
    console.log('  warmup playwright...');
    await runPlaywrightOnce(flow);

    const alethTimings = [];
    const pwTimings = [];

    for (let i = 0; i < ITERATIONS; i++) {
      process.stdout.write(`  iter ${i + 1}/${ITERATIONS} alethia...`);
      const a = await runAlethiaOnce(flow);
      if (!a.ok) {
        console.error(`\n    alethia FAILED on ${flow}: exit ${a.code}\n${a.stderr.slice(-500)}`);
        process.exit(1);
      }
      alethTimings.push(a.elapsedMs);
      process.stdout.write(` ${Math.round(a.elapsedMs)}ms  playwright...`);
      const p = await runPlaywrightOnce(flow);
      if (!p.ok) {
        console.error(`\n    playwright FAILED on ${flow}: exit ${p.code}\n${p.stderr.slice(-500)}`);
        process.exit(1);
      }
      pwTimings.push(p.elapsedMs);
      process.stdout.write(` ${Math.round(p.elapsedMs)}ms\n`);
    }

    results.flows[flow] = {
      alethia: stats(alethTimings),
      playwright: stats(pwTimings),
      speedupMean: pwTimings.reduce((a, b) => a + b, 0) / alethTimings.reduce((a, b) => a + b, 0),
    };
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('Flow      Alethia     Alethia     Playwright  Playwright  Speedup');
  console.log('          mean        p95         mean        p95         (mean)');
  console.log('─────────────────────────────────────────────────────────────');
  for (const flow of FLOWS) {
    const r = results.flows[flow];
    console.log(formatRow(flow, r.alethia, r.playwright));
  }
  console.log('─────────────────────────────────────────────────────────────');

  // Write machine-readable results next to this script.
  writeFileSync(join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nWrote results.json (${Object.keys(results.flows).length} flows, ${ITERATIONS} iterations each).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
