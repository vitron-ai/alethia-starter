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
 *   node compare.mjs --target <url>        # non-default Anvil target
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { getEncoding } from 'js-tiktoken';

// cl100k_base is the tokenizer used by GPT-4 / GPT-3.5-turbo. It's the de-facto
// industry reference for agent-token accounting; numbers translate closely to
// Anthropic and other providers' tokenizers (within ~10%). We use it as a
// neutral yardstick so any engineer reading the numbers can re-run the math
// against whatever LLM they're using.
const tokenizer = getEncoding('cl100k_base');
const countTokens = (text) => (text ? tokenizer.encode(text).length : 0);

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

// Install-cost measurement is opt-in — it does fresh npm installs into tmp
// directories, which on a cold network can take 60-90 seconds. On by default
// in CI (where we want the complete picture for public numbers), off by default
// locally (where iteration speed matters).
const INCLUDE_INSTALL = process.argv.includes('--include-install');

const FLOWS = ['smoke', 'signin', 'crud', 'search'].filter(name => !ONLY || ONLY === name);

// Alethia flow filenames (live in __alethia__/ at the starter root).
const ALETHIA_FILES = {
  smoke: 'smoke.alethia',
  signin: 'signin-flow.alethia',
  crud: 'crud-flow.alethia',
  search: 'search-flow.alethia',
};

// Short descriptions of what each flow exercises — used by the CI step
// summary so anyone skimming a PR sees what the numbers actually mean.
const FLOW_DESCRIPTIONS = {
  smoke: 'Page loads, key UI renders',
  signin: 'Sign in, land on dashboard',
  crud: 'Sign in, add a task, verify it appears',
  search: 'Sign in, search tasks, verify filter narrows',
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
  constructor(cmd, args, env, cwd, { forwardStderr = false } = {}) {
    this.child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
    });
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      // When enabled, forward the child's stderr to the benchmark's own stderr
      // so human-readable one-liners and failure diagnostics show up in CI
      // logs. Agents reading stdout are unaffected — this is strictly for the
      // human scrolling the workflow output.
      if (forwardStderr) process.stderr.write(chunk);
    });
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
  // Forward the bridge's stderr so its one-line tell summaries (and failure
  // diagnostics) land in the benchmark's own output. Valuable for humans
  // scrolling CI logs; the agent stdout path is untouched.
  const client = new StdioMcpClient(bridgeBin, bridgeArgs, {
    ALETHIA_TARGET: TARGET,
    ELECTRON_DISABLE_SANDBOX: process.env.ELECTRON_DISABLE_SANDBOX ?? '1',
  }, undefined, { forwardStderr: true });

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
        const failingStep = parsed.run?.stepRuns?.find((s) => s.ok === false);
        const detail = failingStep
          ? `step "${failingStep.detail || failingStep.type}" failed: ${failingStep.error || failingStep.reasonCode || 'unknown'}`
          : JSON.stringify(parsed).slice(0, 800);
        throw new Error(`alethia_tell reported failure on ${flow}: ${detail}`);
      }
      // Tokenize the actual response text an agent would receive — semantic
      // snapshot + diff + EA1 audit + hash. This is the per-call token cost
      // the agent pays to parse the tool result.
      const tokens = countTokens(text);
      return { elapsedMs, tokens };
    };

    // First call — includes one-time setup cost for the agent session.
    process.stdout.write(`  alethia cold...`);
    const cold = await callOnce(false);
    process.stdout.write(` ${Math.round(cold.elapsedMs)}ms (${cold.tokens} tokens)\n`);

    // Subsequent calls — steady-state per-call cost. Each starts from a
    // reset origin baseline (via resetSession) so mutating flows stay idempotent.
    const subseqTimings = [];
    const subseqTokens = [];
    for (let i = 0; i < iterations; i++) {
      process.stdout.write(`  alethia call ${i + 1}/${iterations}...`);
      const r = await callOnce(true);
      subseqTimings.push(r.elapsedMs);
      subseqTokens.push(r.tokens);
      process.stdout.write(` ${Math.round(r.elapsedMs)}ms (${r.tokens} tokens)\n`);
    }

    return { coldMs: cold.elapsedMs, coldTokens: cold.tokens, subseqTimings, subseqTokens };
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
// Playwright MCP benchmark — long-running MCP server (warm browser) driven
// through the agent-style tool vocabulary (browser_navigate, browser_snapshot,
// browser_click, browser_type, ...).
//
// This is the sharper apples-to-apples comparison for agent workloads than the
// CLI benchmark: Playwright MCP keeps the browser hot between calls, so per-
// call cost is CDP round-trip + action rather than a full process + browser
// respawn. Flows live in ./pwmcp-flows/ and use refs parsed from the snapshot
// output — the pattern a real agent would follow.
//
// What we measure per flow:
//   - Total wall time to complete the flow (sum of all MCP tool calls).
//   - Total response tokens the agent reads over the flow (snapshots dominate).
// ────────────────────────────────────────────────────────────────────────────

class PwMcpClient {
  constructor(stdioClient) {
    this.stdio = stdioClient;
    this.totalTokens = 0;
    this.totalCalls = 0;
  }
  async call(name, args) {
    const r = await this.stdio.request('tools/call', { name, arguments: args });
    const text = r?.content?.[0]?.text || '';
    this.totalTokens += countTokens(text);
    this.totalCalls += 1;
    return text;
  }
  resetCounters() {
    this.totalTokens = 0;
    this.totalCalls = 0;
  }
}

async function benchmarkPlaywrightMcp(flow, iterations) {
  const { default: flowFn } = await import(`./pwmcp-flows/${flow}.mjs`);
  // Spawn in the benchmark dir so npx resolves @playwright/mcp from
  // benchmark/node_modules (it's a dev dep there, not at the repo root).
  const stdio = new StdioMcpClient('npx', ['@playwright/mcp', '--headless', '--isolated'], {}, __dirname);

  try {
    await stdio.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'alethia-benchmark-pwmcp', version: '0.2.0' },
    });
    stdio.notify('notifications/initialized', {});

    const client = new PwMcpClient(stdio);

    // Reset state between iterations so mutating flows (signin, crud, search)
    // don't land on "already signed in" and poison the timing. Skip for the
    // first iteration — there's no prior state to reset.
    const resetState = async () => {
      try {
        await client.call('browser_evaluate', {
          function: '() => { localStorage.clear(); sessionStorage.clear(); }',
        });
      } catch {
        // If the page isn't loaded yet, eval fails — that's fine, nothing to reset.
      }
    };

    const runOne = async (isCold) => {
      if (!isCold) await resetState();
      client.resetCounters();
      const t = performance.now();
      await flowFn(client, TARGET);
      const elapsedMs = performance.now() - t;
      return { elapsedMs, tokens: client.totalTokens, calls: client.totalCalls };
    };

    // First iteration — includes browser launch cost.
    process.stdout.write(`  pwmcp cold...`);
    const cold = await runOne(true);
    process.stdout.write(` ${Math.round(cold.elapsedMs)}ms (${cold.calls} calls, ${cold.tokens} tokens)\n`);

    const subseqTimings = [];
    const subseqTokens = [];
    const subseqCalls = [];
    for (let i = 0; i < iterations; i++) {
      process.stdout.write(`  pwmcp call ${i + 1}/${iterations}...`);
      const r = await runOne(false);
      subseqTimings.push(r.elapsedMs);
      subseqTokens.push(r.tokens);
      subseqCalls.push(r.calls);
      process.stdout.write(` ${Math.round(r.elapsedMs)}ms (${r.calls} calls, ${r.tokens} tokens)\n`);
    }

    return {
      coldMs: cold.elapsedMs,
      coldTokens: cold.tokens,
      coldCalls: cold.calls,
      subseqTimings,
      subseqTokens,
      subseqCalls,
    };
  } finally {
    stdio.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Install-cost measurement.
//
// Runs a fresh npm install into a throwaway tmp directory for each framework,
// measuring wall time. Honest baseline for "how long does it take to go from
// zero to able-to-run on a fresh machine" — the number a user pays once, on
// first setup, and a CI pays on every uncached runner.
//
// Methodology notes:
//   - Both installs hit the public npm registry. Network speed affects both
//     equally; this measures the *work done*, not a guarantee of wall time on
//     any specific machine.
//   - Playwright install = npm package + Chromium browser download (~170MB).
//   - Alethia install = npm package. The runtime binary downloads on first
//     tool call, which shows up in the "first call" timing, not here.
//   - `--no-audit --no-fund --silent` suppress noise but don't speed up work.
// ────────────────────────────────────────────────────────────────────────────

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'pipe', ...opts });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.slice(-400)}`));
    });
    proc.on('error', reject);
  });
}

async function measureInstallCost() {
  console.log('── install-cost measurement ──');
  console.log('  (fresh npm installs into tmp dirs — measures the "first-time setup" cost)\n');

  const results = {};

  // Playwright: npm package + browser download.
  process.stdout.write('  playwright install...');
  const pwDir = mkdtempSync(join(tmpdir(), 'pw-install-'));
  writeFileSync(join(pwDir, 'package.json'), JSON.stringify({
    name: 'pw-install-measure', version: '0.0.0', private: true,
  }));
  const pwT0 = performance.now();
  try {
    await runCmd('npm', ['install', '@playwright/test@1.48.0', '--no-audit', '--no-fund', '--silent'], { cwd: pwDir });
    await runCmd('npx', ['playwright', 'install', 'chromium'], { cwd: pwDir });
    results.playwrightMs = performance.now() - pwT0;
    process.stdout.write(` ${Math.round(results.playwrightMs / 1000)}s\n`);
  } finally {
    try { rmSync(pwDir, { recursive: true, force: true }); } catch {}
  }

  // Playwright MCP: same Chromium + the @playwright/mcp wrapper.
  process.stdout.write('  playwright-mcp install...');
  const pwMcpDir = mkdtempSync(join(tmpdir(), 'pwmcp-install-'));
  writeFileSync(join(pwMcpDir, 'package.json'), JSON.stringify({
    name: 'pwmcp-install-measure', version: '0.0.0', private: true,
  }));
  const pwMcpT0 = performance.now();
  try {
    await runCmd('npm', ['install', '@playwright/mcp@latest', '--no-audit', '--no-fund', '--silent'], { cwd: pwMcpDir });
    await runCmd('npx', ['playwright', 'install', 'chromium'], { cwd: pwMcpDir });
    results.playwrightMcpMs = performance.now() - pwMcpT0;
    process.stdout.write(` ${Math.round(results.playwrightMcpMs / 1000)}s\n`);
  } finally {
    try { rmSync(pwMcpDir, { recursive: true, force: true }); } catch {}
  }

  // Alethia: npm package. The runtime binary auto-downloads on first call,
  // which is intentionally captured in the "first call" timing instead.
  process.stdout.write('  alethia install...');
  const alDir = mkdtempSync(join(tmpdir(), 'al-install-'));
  writeFileSync(join(alDir, 'package.json'), JSON.stringify({
    name: 'al-install-measure', version: '0.0.0', private: true,
  }));
  const alT0 = performance.now();
  try {
    await runCmd('npm', ['install', '@vitronai/alethia@latest', '--no-audit', '--no-fund', '--silent'], { cwd: alDir });
    results.alethiaMs = performance.now() - alT0;
    process.stdout.write(` ${Math.round(results.alethiaMs / 1000)}s\n`);
  } finally {
    try { rmSync(alDir, { recursive: true, force: true }); } catch {}
  }

  console.log('');
  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Reporter
// ────────────────────────────────────────────────────────────────────────────

const fmtTime = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const formatTimingRow = (flow, coldMs, subseq, pw) => {
  const speedup = pw.meanMs / subseq.meanMs;
  return [
    flow.padEnd(10),
    fmtTime(coldMs).padEnd(14),
    fmtTime(subseq.meanMs).padEnd(14),
    fmtTime(pw.meanMs).padEnd(14),
    `${speedup.toFixed(1)}× faster`,
  ].join('  ');
};

const formatTokensRow = (flow, subseqTokensMean) => {
  return [
    flow.padEnd(10),
    `${Math.round(subseqTokensMean)} tokens/call`,
  ].join('  ');
};

async function main() {
  console.log(`Alethia vs Playwright — agent-workflow benchmark`);
  console.log(`${ITERATIONS} measured iterations per flow  ·  target ${TARGET}`);
  console.log(`Flows: ${FLOWS.join(', ')}`);
  console.log(`Install-cost measurement: ${INCLUDE_INSTALL ? 'enabled' : 'skipped (pass --include-install to enable)'}`);
  console.log('');

  const results = {
    target: TARGET,
    iterations: ITERATIONS,
    mode: 'agent-workflow',
    description: 'Per-call cost in an agent workflow. Alethia typical = mean of calls 2..N. Playwright = mean of N fresh CLI invocations.',
    methodology: {
      tokenizer: 'cl100k_base (GPT-4 / GPT-3.5-turbo). Industry-neutral reference; translates within ~10% to Anthropic tokenizers.',
      alethiaResponseTokenized: 'Full tool response text (semantic snapshot + DOM diff + EA1 audit + integrity hash).',
      playwrightHeadlessParity: 'Alethia runs headless (ALETHIA_HEADLESS=1) to match Playwright default.',
      installMeasurement: INCLUDE_INSTALL
        ? 'Fresh npm install into tmp dir. Playwright = npm + Chromium download. Alethia = npm only (runtime auto-downloads on first call, captured in "first call" timing).'
        : 'Not measured in this run.',
    },
    installCost: null,
    flows: {},
    suiteTotal: null,
    generatedAt: new Date().toISOString(),
  };

  // ── Optional: fresh-install wall-time measurement ────────────────────────
  if (INCLUDE_INSTALL) {
    results.installCost = await measureInstallCost();
  }

  // ── Per-flow timing + token measurement ──────────────────────────────────
  for (const flow of FLOWS) {
    console.log(`── ${flow} ──`);

    const alethia = await benchmarkAlethia(flow, ITERATIONS);
    const pwTimings = await benchmarkPlaywright(flow, ITERATIONS);
    const pwMcp = await benchmarkPlaywrightMcp(flow, ITERATIONS);

    const subseq = stats(alethia.subseqTimings);
    const pw = stats(pwTimings);
    const pwMcpSubseq = stats(pwMcp.subseqTimings);
    const alethiaTokenStats = stats(alethia.subseqTokens);
    const pwMcpTokenStats = stats(pwMcp.subseqTokens);
    const pwMcpCallsStats = stats(pwMcp.subseqCalls);

    results.flows[flow] = {
      description: FLOW_DESCRIPTIONS[flow] ?? '',
      alethia: {
        firstCallMs: Math.round(alethia.coldMs * 10) / 10,
        firstCallTokens: alethia.coldTokens,
        typical: subseq,
        typicalTokens: {
          meanTokens: Math.round(alethiaTokenStats.meanMs),
          minTokens: alethiaTokenStats.minMs,
          maxTokens: alethiaTokenStats.maxMs,
        },
      },
      playwright: pw,
      playwrightMcp: {
        firstCallMs: Math.round(pwMcp.coldMs * 10) / 10,
        firstCallTokens: pwMcp.coldTokens,
        firstCallCalls: pwMcp.coldCalls,
        typical: pwMcpSubseq,
        typicalTokens: {
          meanTokens: Math.round(pwMcpTokenStats.meanMs),
          minTokens: pwMcpTokenStats.minMs,
          maxTokens: pwMcpTokenStats.maxMs,
        },
        typicalCalls: {
          mean: Math.round(pwMcpCallsStats.meanMs),
        },
      },
      speedupVsPwCli: pw.meanMs / subseq.meanMs,
      speedupVsPwMcp: pwMcpSubseq.meanMs / subseq.meanMs,
      tokenRatioVsPwMcp: pwMcpTokenStats.meanMs / Math.max(1, alethiaTokenStats.meanMs),
    };
    console.log('');
  }

  // ── Suite-total — what an agent running all flows once actually pays ─────
  const sumTypicalAlethiaMs = FLOWS.reduce((sum, f) => {
    const r = results.flows[f];
    return sum + r.alethia.firstCallMs + (ITERATIONS - 1) * r.alethia.typical.meanMs;
  }, 0);
  const sumPlaywrightMs = FLOWS.reduce((sum, f) => {
    const r = results.flows[f];
    return sum + ITERATIONS * r.playwright.meanMs;
  }, 0);
  const sumPwMcpMs = FLOWS.reduce((sum, f) => {
    const r = results.flows[f];
    return sum + r.playwrightMcp.firstCallMs + (ITERATIONS - 1) * r.playwrightMcp.typical.meanMs;
  }, 0);
  const installAlethiaMs = results.installCost?.alethiaMs ?? 0;
  const installPwMs = results.installCost?.playwrightMs ?? 0;
  const installPwMcpMs = results.installCost?.playwrightMcpMs ?? 0;

  results.suiteTotal = {
    description: `All ${FLOWS.length} flows × ${ITERATIONS} iterations, including install cost${INCLUDE_INSTALL ? '' : ' (install not measured)'}.`,
    alethia: {
      installMs: Math.round(installAlethiaMs),
      flowsMs: Math.round(sumTypicalAlethiaMs),
      totalMs: Math.round(installAlethiaMs + sumTypicalAlethiaMs),
    },
    playwright: {
      installMs: Math.round(installPwMs),
      flowsMs: Math.round(sumPlaywrightMs),
      totalMs: Math.round(installPwMs + sumPlaywrightMs),
    },
    playwrightMcp: {
      installMs: Math.round(installPwMcpMs),
      flowsMs: Math.round(sumPwMcpMs),
      totalMs: Math.round(installPwMcpMs + sumPwMcpMs),
    },
    speedupVsPwCli: (installPwMs + sumPlaywrightMs) / (installAlethiaMs + sumTypicalAlethiaMs),
    speedupVsPwMcp: (installPwMcpMs + sumPwMcpMs) / (installAlethiaMs + sumTypicalAlethiaMs),
  };

  // ── Console output — plain-English for engineers skimming stdout ─────────
  const sep = '─'.repeat(90);

  console.log('\nPer-flow timing  (how long each flow takes, end to end)');
  console.log(sep);
  console.log('Flow        Alethia         PW CLI          PW MCP          vs PW CLI     vs PW MCP');
  console.log('            (typical)       (mean)          (typical)');
  console.log(sep);
  for (const flow of FLOWS) {
    const r = results.flows[flow];
    console.log([
      flow.padEnd(10),
      fmtTime(r.alethia.typical.meanMs).padEnd(15),
      fmtTime(r.playwright.meanMs).padEnd(15),
      fmtTime(r.playwrightMcp.typical.meanMs).padEnd(15),
      `${r.speedupVsPwCli.toFixed(1)}× faster`.padEnd(13),
      `${r.speedupVsPwMcp.toFixed(1)}× faster`,
    ].join('  '));
  }
  console.log(sep);

  console.log('\nPer-flow tokens  (what the agent reads during one flow, cl100k_base)');
  console.log(sep);
  console.log('Flow        Alethia         PW MCP          Ratio');
  console.log('            (per call)      (total/flow)');
  console.log(sep);
  for (const flow of FLOWS) {
    const r = results.flows[flow];
    const ratio = r.tokenRatioVsPwMcp;
    const verdict = ratio >= 1
      ? `Alethia ${ratio.toFixed(1)}× fewer`
      : `PW MCP ${(1 / ratio).toFixed(1)}× fewer`;
    console.log([
      flow.padEnd(10),
      `${r.alethia.typicalTokens.meanTokens} tokens`.padEnd(15),
      `${r.playwrightMcp.typicalTokens.meanTokens} tokens`.padEnd(15),
      verdict,
    ].join('  '));
  }
  console.log(sep);
  console.log('(PW MCP totals all snapshot/action responses across the full flow — that\'s what the agent reads.');
  console.log(' Alethia returns everything in one bundled response: steps, DOM diffs, audit, integrity hash.)');

  console.log('\nSuite total  (agent running every flow once, end to end)');
  console.log(sep);
  console.log('                       Alethia         PW CLI          PW MCP');
  const installRow = INCLUDE_INSTALL
    ? `Install (one-time)     ${fmtTime(installAlethiaMs).padEnd(15)} ${fmtTime(installPwMs).padEnd(15)} ${fmtTime(installPwMcpMs)}`
    : `Install (one-time)     (not measured — pass --include-install)`;
  console.log(installRow);
  const flowsLabel = `All flows × ${ITERATIONS}`.padEnd(22);
  console.log(`${flowsLabel} ${fmtTime(sumTypicalAlethiaMs).padEnd(15)} ${fmtTime(sumPlaywrightMs).padEnd(15)} ${fmtTime(sumPwMcpMs)}`);
  console.log(sep);
  const totalAlethia = installAlethiaMs + sumTypicalAlethiaMs;
  const totalPw = installPwMs + sumPlaywrightMs;
  const totalPwMcp = installPwMcpMs + sumPwMcpMs;
  const ratioVsCli = totalPw / totalAlethia;
  const ratioVsMcp = totalPwMcp / totalAlethia;
  console.log(`Total                  ${fmtTime(totalAlethia).padEnd(15)} ${fmtTime(totalPw).padEnd(15)} ${fmtTime(totalPwMcp)}`);
  console.log(sep);
  const namedWinner = (ratio, name) => ratio >= 1
    ? `Alethia is ${ratio.toFixed(1)}× faster than ${name}`
    : `${name} is ${(1 / ratio).toFixed(1)}× faster than Alethia (setup hasn't amortized yet — increase iterations)`;
  console.log(`vs PW CLI:  ${namedWinner(ratioVsCli, 'PW CLI')}`);
  console.log(`vs PW MCP:  ${namedWinner(ratioVsMcp, 'PW MCP')}`);
  console.log(sep);

  console.log('\nReading the numbers:');
  console.log('  · Alethia typical — Mean of calls 2..N for one `alethia_tell` call per flow.');
  console.log('                      One tool call drives the entire flow end to end.');
  console.log('  · PW CLI          — `npx playwright test` — fresh process + browser every call.');
  console.log('  · PW MCP          — Long-running Playwright MCP server with a warm browser.');
  console.log('                      Flow = multiple tool calls (navigate, snapshot, click, type,');
  console.log('                      snapshot...) — the agent pattern this tool was built for.');
  console.log('  · Tokens          — Alethia returns ~1 compact response per flow; PW MCP returns');
  console.log('                      an accessibility snapshot after each action. We sum what the');
  console.log('                      agent reads over the whole flow. Multiply by your LLM\'s input');
  console.log('                      price for $/call.');
  if (INCLUDE_INSTALL) {
    console.log('  · Install         — Fresh `npm install` into a tmp directory. Playwright also');
    console.log('                      downloads Chromium (~170MB); Alethia downloads its runtime');
    console.log('                      on first call, which shows up in the "first call" timing.');
  }
  console.log('');

  writeFileSync(join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Wrote results.json (${Object.keys(results.flows).length} flows, ${ITERATIONS} iterations each).`);
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});
