#!/usr/bin/env node
/*
 * Alethia vs Playwright — agent-workflow benchmark harness.
 *
 * Measures the per-call cost an agent pays across a workflow. Agents don't
 * invoke-and-exit — they make many tool calls over minutes or hours, so the
 * number that matters is the cost of the Nth call, not the first. Playwright's
 * CLI spawns a fresh process (and a fresh browser) on every invocation; there
 * is no CLI mode that avoids this.
 *
 * What we report per flow:
 *   - Alethia cold:       first call in an agent workflow (includes setup)
 *   - Alethia subsequent: mean of calls 2..N — the agent-typical cost
 *   - Playwright:         mean of N fresh CLI invocations
 *   - Speedup:            Playwright mean / Alethia subsequent mean
 *
 * Usage:
 *   node compare.mjs                       # default N=10 measured iterations each
 *   node compare.mjs --iterations 30       # more iterations = tighter CI
 *   node compare.mjs --only smoke          # run just one flow
 *   node compare.mjs --target <url>        # non-default Atlas target
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
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
const BRIDGE_CMD = (process.env.ALETHIA_BRIDGE || 'alethia-mcp').split(/\s+/);

const FLOWS = ['smoke', 'signin', 'crud'].filter(name => !ONLY || ONLY === name);

// Alethia flow filenames (live in __alethia__/ at the starter root).
const ALETHIA_FILES = {
  smoke: 'smoke.alethia',
  signin: 'signin-flow.alethia',
  crud: 'crud-flow.alethia',
};

// Summary statistics for a set of timings (milliseconds).
const stats = (timings) => {
  if (timings.length === 0) return { n: 0 };
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

// ────────────────────────────────────────────────────────────────────────────
// MCP stdio client — drives a long-running alethia-mcp bridge over JSON-RPC.
// One client instance runs the full benchmark for one flow.
// ────────────────────────────────────────────────────────────────────────────

class StdioMcpClient {
  constructor(cmd, args, env) {
    this.child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Bridge exited with code ${code} before responding. Stderr: ${this.stderr.slice(-500)}`));
      }
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'RPC error'));
          else resolve(msg.result);
        }
      } catch {
        // non-JSON lines (bridge diagnostics) — ignore
      }
    }
  }

  request(method, params, timeoutMs = 180_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(to); resolve(r); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close() {
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Alethia benchmark — one bridge per flow, N+1 tool calls.
// First call is reported separately (cold); calls 2..N+1 are the steady-state
// per-call cost an agent pays throughout a session.
// ────────────────────────────────────────────────────────────────────────────

async function benchmarkAlethia(flow, iterations) {
  const flowFile = resolve(STARTER_ROOT, '__alethia__', ALETHIA_FILES[flow]);
  const rawInstructions = readFileSync(flowFile, 'utf8');
  const instructions = rawInstructions.replace(/http:\/\/127\.0\.0\.1:5173/g, TARGET);

  const [bridgeBin, ...bridgeArgs] = BRIDGE_CMD;
  const client = new StdioMcpClient(bridgeBin, bridgeArgs, {
    ALETHIA_TARGET: TARGET,
    ELECTRON_DISABLE_SANDBOX: process.env.ELECTRON_DISABLE_SANDBOX ?? '1',
  });

  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'alethia-benchmark', version: '0.2.0' },
    });
    client.notify('notifications/initialized', {});

    // Mutating flows (signin, crud) modify app state. Without resetting
    // between iterations, re-running the same flow lands on the "already
    // signed in" branch and wastes seconds on fuzzy-matching recovery.
    // We opt in to the runtime's per-call `resetSession` so every iteration
    // starts from a clean origin baseline. The reset happens inside the
    // alethia_tell call — the time cost is intentionally included in the
    // per-call measurement since that's what an agent workflow pays.
    const callOnce = async (resetSession) => {
      const t = performance.now();
      const result = await client.request('tools/call', {
        name: 'alethia_tell',
        // stepPaceMs: 0 disables the per-step highlight pause. The runtime
        // defaults to a 500ms pause per step when a cockpit window is open
        // (so humans can watch steps flash), which is the right default for
        // interactive demos but poisons benchmark timings. Explicit zero
        // gives us clean per-call cost regardless of cockpit state.
        arguments: { instructions, name: flow, resetSession, stepPaceMs: 0 },
      });
      const elapsedMs = performance.now() - t;
      const text = result?.content?.[0]?.text;
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (parsed && parsed.ok === false) {
        throw new Error(`alethia_tell reported failure on ${flow}: ${parsed.error || JSON.stringify(parsed).slice(0, 300)}`);
      }
      return elapsedMs;
    };

    // First call — includes one-time setup cost for the agent session.
    process.stdout.write(`  alethia cold...`);
    const coldMs = await callOnce(false);
    process.stdout.write(` ${Math.round(coldMs)}ms\n`);

    // Subsequent calls — steady-state per-call cost. Each starts from a
    // reset origin baseline (via resetSession) so mutating flows stay idempotent.
    const subseqTimings = [];
    for (let i = 0; i < iterations; i++) {
      process.stdout.write(`  alethia call ${i + 1}/${iterations}...`);
      const ms = await callOnce(true);
      subseqTimings.push(ms);
      process.stdout.write(` ${Math.round(ms)}ms\n`);
    }

    return { coldMs, subseqTimings };
  } finally {
    client.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Playwright benchmark — each iteration is a fresh CLI invocation.
// The CLI has no cross-call mode; each `playwright test` is a new process.
// ────────────────────────────────────────────────────────────────────────────

function timePlaywrightRun(flow) {
  return new Promise((resolve) => {
    const started = performance.now();
    const proc = spawn('npx', ['playwright', 'test', `playwright-flows/${flow}.spec.ts`], {
      env: { ...process.env, CI: '1', DISPLAY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: __dirname,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      resolve({ ok: code === 0, elapsedMs: performance.now() - started, code, stdout, stderr });
    });
  });
}

async function benchmarkPlaywright(flow, iterations) {
  // One warmup so we don't charge first-run caches.
  process.stdout.write(`  playwright warmup...`);
  const warm = await timePlaywrightRun(flow);
  if (!warm.ok) {
    console.error(`\n    playwright warmup FAILED on ${flow}: exit ${warm.code}`);
    console.error('--- stderr ---\n' + (warm.stderr || '(empty)'));
    console.error('--- stdout ---\n' + (warm.stdout || '(empty)'));
    process.exit(1);
  }
  process.stdout.write(` ${Math.round(warm.elapsedMs)}ms\n`);

  const timings = [];
  for (let i = 0; i < iterations; i++) {
    process.stdout.write(`  playwright ${i + 1}/${iterations}...`);
    const r = await timePlaywrightRun(flow);
    if (!r.ok) {
      console.error(`\n    playwright FAILED on ${flow} iter ${i + 1}: exit ${r.code}`);
      console.error('--- stderr ---\n' + (r.stderr || '(empty)'));
      console.error('--- stdout ---\n' + (r.stdout || '(empty)'));
      process.exit(1);
    }
    timings.push(r.elapsedMs);
    process.stdout.write(` ${Math.round(r.elapsedMs)}ms\n`);
  }
  return timings;
}

// ────────────────────────────────────────────────────────────────────────────
// Reporter
// ────────────────────────────────────────────────────────────────────────────

const formatRow = (flow, coldMs, subseq, pw) => {
  const speedup = pw.meanMs / subseq.meanMs;
  return [
    flow.padEnd(8),
    `${Math.round(coldMs)}ms`.padEnd(13),
    `${subseq.meanMs}ms`.padEnd(13),
    `${subseq.p95Ms}ms`.padEnd(13),
    `${pw.meanMs}ms`.padEnd(13),
    `${speedup.toFixed(1)}×`,
  ].join('  ');
};

async function main() {
  console.log(`Alethia vs Playwright — agent-workflow benchmark`);
  console.log(`${ITERATIONS} measured iterations per flow  ·  target ${TARGET}`);
  console.log(`Flows: ${FLOWS.join(', ')}\n`);

  const results = {
    target: TARGET,
    iterations: ITERATIONS,
    mode: 'agent-workflow',
    description: 'Per-call cost in an agent workflow. Alethia subseq = mean of calls 2..N. Playwright = mean of N fresh CLI invocations.',
    flows: {},
    generatedAt: new Date().toISOString(),
  };

  for (const flow of FLOWS) {
    console.log(`── ${flow} ──`);

    const { coldMs, subseqTimings } = await benchmarkAlethia(flow, ITERATIONS);
    const pwTimings = await benchmarkPlaywright(flow, ITERATIONS);

    const subseq = stats(subseqTimings);
    const pw = stats(pwTimings);

    results.flows[flow] = {
      alethia: {
        coldMs: Math.round(coldMs * 10) / 10,
        subseq,
      },
      playwright: pw,
      speedup: pw.meanMs / subseq.meanMs,
    };
    console.log('');
  }

  const sep = '─'.repeat(85);
  console.log(sep);
  console.log('Flow      Alethia cold   Alethia subseq Alethia p95    Playwright     Speedup');
  console.log('          (1st call)     (mean 2..N)                   (mean)');
  console.log(sep);
  for (const flow of FLOWS) {
    const r = results.flows[flow];
    console.log(formatRow(flow, r.alethia.coldMs, r.alethia.subseq, r.playwright));
  }
  console.log(sep);
  console.log('');
  console.log('How to read this:');
  console.log('  · Alethia cold    — first call in an agent session (includes setup).');
  console.log('                      Paid once; amortized over every subsequent call.');
  console.log('  · Alethia subseq  — mean of calls 2..N. The agent-typical per-call cost.');
  console.log('  · Playwright      — every call is a fresh CLI invocation.');
  console.log('  · Speedup         — Playwright / Alethia subseq. The ratio that matters');
  console.log('                      for multi-call agent workflows.');
  console.log('');

  writeFileSync(join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Wrote results.json (${Object.keys(results.flows).length} flows, ${ITERATIONS} iterations each).`);
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});
