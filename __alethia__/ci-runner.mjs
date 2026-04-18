#!/usr/bin/env node
/*
 * CI runner for Alethia tests.
 *
 * Spawns the @vitronai/alethia MCP bridge over stdio, sends each .alethia file
 * as a tools/call request, and exits 0 if every step passes, 1 otherwise.
 *
 * Usage:
 *   node __alethia__/ci-runner.mjs [--target http://127.0.0.1:5173]
 *                                  [--reporter pretty|plain|json]
 *                                  [--only <file>]
 *
 * Env:
 *   ALETHIA_TARGET   — override the navigate-to target URL in tests
 *   ALETHIA_BRIDGE   — override the bridge command (default: npx -y @vitronai/alethia)
 *   NO_COLOR         — disable ANSI colors (respected automatically)
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────────────────
// Args
// ────────────────────────────────────────────────────────────────────────────

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const TARGET = getArg('--target') || process.env.ALETHIA_TARGET || 'http://127.0.0.1:5173';
const REPORTER = getArg('--reporter') || 'pretty';
const ONLY = getArg('--only');
const BRIDGE_CMD = (process.env.ALETHIA_BRIDGE || 'npx -y @vitronai/alethia').split(/\s+/);

// ────────────────────────────────────────────────────────────────────────────
// ANSI styling — respects NO_COLOR and TTY detection
// ────────────────────────────────────────────────────────────────────────────

const COLOR_ENABLED = process.stdout.isTTY && !process.env.NO_COLOR && REPORTER !== 'json';

function ansi(...codes) {
  return (s) => COLOR_ENABLED ? `\x1b[${codes.join(';')}m${s}\x1b[0m` : String(s);
}

const c = {
  red:    ansi(31),
  green:  ansi(32),
  yellow: ansi(33),
  blue:   ansi(34),
  cyan:   ansi(36),
  dim:    ansi(2),
  bold:   ansi(1),
  redBold:    ansi(31, 1),
  greenBold:  ansi(32, 1),
  yellowBold: ansi(33, 1),
  cyanBold:   ansi(36, 1),
  blueBold:   ansi(34, 1),
};

const LINE_DOUBLE = '═'.repeat(64);
const LINE_SINGLE = '─'.repeat(64);

// ────────────────────────────────────────────────────────────────────────────
// MCP stdio client
// ────────────────────────────────────────────────────────────────────────────

class StdioMcpClient {
  constructor(cmd, args) {
    this.child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Bridge exited with code ${code} before responding`));
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

  _send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 120_000) {
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
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  close() {
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Result analysis — classify each file's outcome
// ────────────────────────────────────────────────────────────────────────────

function analyzeResult(file, result, parsed) {
  const text = result?.content?.[0]?.text;
  const stepRuns = parsed?.run?.stepRuns || parsed?.stepResults || [];
  const totalSteps = stepRuns.length || parsed?.run?.totalSteps || 0;
  const passedSteps = stepRuns.filter((s) => s?.ok !== false).length;
  const ms = parsed?.elapsedMs ?? parsed?.run?.elapsedMs ?? 0;

  // Count EA1 policy blocks across steps
  const policyBlocks = stepRuns.filter((s) =>
    s?.policyDecision === 'block' ||
    s?.reasonCode === 'WRITE_HIGH' ||
    (s?.detail && s.detail.includes('EA1 POLICY'))
  ).length;

  // expect-block is a pass when policy blocked as expected
  const expectBlockSuccesses = stepRuns.filter((s) => {
    const d = s?.detail || '';
    return s?.ok === true && (d.includes('expect block') || d.includes('expect-block') || d.includes('EXPECT_BLOCK'));
  }).length;

  const isPolicyVerified = expectBlockSuccesses > 0 && parsed?.ok === true;

  if (parsed?.ok === true) {
    return {
      file, status: isPolicyVerified ? 'block' : 'pass',
      totalSteps, passedSteps, ms, policyBlocks, expectBlockSuccesses,
    };
  }

  // Find the failed step and its details
  const failedStep = stepRuns.find((s) => s?.ok === false);
  let failureDetail = null;
  let nearMatches = null;
  let suggestedFix = null;
  let pageContext = null;

  if (failedStep?.detail) {
    failureDetail = failedStep.detail;
    // The runtime surfaces near matches + suggested fix inline in detail
    const nmMatch = failureDetail.match(/near matches?:\s*(.+?)(?:\s*\||$)/i);
    if (nmMatch) nearMatches = nmMatch[1].trim();
    const sfMatch = failureDetail.match(/Suggested fix:\s*(.+?)(?:\s*\||$)/i);
    if (sfMatch) suggestedFix = sfMatch[1].trim();
    const pcMatch = failureDetail.match(/page title:\s*(".+?")/i);
    if (pcMatch) pageContext = pcMatch[1];
  } else if (parsed?.error) {
    failureDetail = `error: ${parsed.error}`;
  } else if (result?.isError === true) {
    failureDetail = typeof text === 'string' ? text.slice(0, 500) : JSON.stringify(result).slice(0, 500);
  } else if (!parsed) {
    failureDetail = typeof text === 'string' ? `non-JSON response: ${text.slice(0, 300)}` : `unexpected response: ${JSON.stringify(result).slice(0, 300)}`;
  } else {
    failureDetail = `unexpected response shape: ${JSON.stringify(parsed).slice(0, 300)}`;
  }

  return {
    file, status: 'fail',
    totalSteps, passedSteps, ms, policyBlocks, expectBlockSuccesses,
    failureDetail, nearMatches, suggestedFix, pageContext,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Reporters
// ────────────────────────────────────────────────────────────────────────────

function padRight(s, n) {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function padLeft(s, n) {
  if (s.length >= n) return s;
  return ' '.repeat(n - s.length) + s;
}

function reportPretty(results, { target, wallMs, bridgeCmd }) {
  console.log('');
  console.log(c.cyan(LINE_DOUBLE));
  console.log(`  ${c.bold('ALETHIA')}  ${c.dim('·')}  agent-driven E2E with EA1 safety gate`);
  console.log(`  ${c.dim(`target ${target}  ·  workers 1`)}`);
  console.log(c.cyan(LINE_DOUBLE));
  console.log('');

  // Per-file lines
  const badgeFor = (status) => {
    if (status === 'pass')  return c.greenBold ('[PASS] ');
    if (status === 'fail')  return c.redBold   ('[FAIL] ');
    if (status === 'block') return c.blueBold  ('[BLOCK]');
    return c.yellowBold('[SKIP] ');
  };

  for (const r of results) {
    const badge = badgeFor(r.status);
    const name = padRight(r.file, 36);
    let meta;
    if (r.status === 'pass') {
      meta = `${padLeft(String(r.totalSteps), 2)} step${r.totalSteps === 1 ? ' ' : 's'}  ${c.dim('·')}  ${padLeft(String(r.ms), 4)}ms`;
    } else if (r.status === 'block') {
      meta = `${c.blue('EA1 verified')}          ${c.dim('·')}  ${padLeft(String(r.ms), 4)}ms`;
    } else {
      meta = `${c.red(`${r.passedSteps}/${r.totalSteps} steps`)}  ${c.dim('·')}  ${padLeft(String(r.ms), 4)}ms`;
    }
    console.log(`   ${badge}  ${name}  ${meta}`);

    if (r.status === 'fail' && r.failureDetail) {
      // Parse the failure detail into components for cleaner display
      const lines = [];
      // The full detail is usually long — pull out the primary failure line
      const primary = r.failureDetail.split(' | ')[0] || r.failureDetail;
      lines.push(`${c.red('→')} ${primary}`);
      if (r.nearMatches) lines.push(`${c.dim('  near matches:')} ${r.nearMatches}`);
      if (r.suggestedFix) lines.push(`${c.yellow('  suggested fix:')} ${r.suggestedFix}`);
      if (r.pageContext) lines.push(`${c.dim('  page:')} ${r.pageContext}`);
      for (const line of lines) {
        console.log(`            ${line}`);
      }
    } else if (r.status === 'block') {
      console.log(`            ${c.green('✓')} ${r.expectBlockSuccesses} destructive action${r.expectBlockSuccesses === 1 ? '' : 's'} blocked by policy`);
    }
  }

  console.log('');
  console.log(c.cyan(LINE_SINGLE));

  // Slowest
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3);
  if (slowest.length > 0) {
    console.log(`  ${c.bold('SLOWEST')}`);
    for (const r of slowest) {
      console.log(`    ${c.dim(padLeft(String(r.ms), 4) + 'ms')}  ${r.file}`);
    }
    console.log('');
  }

  // EA1 activity
  const totalBlocks = results.reduce((acc, r) => acc + (r.policyBlocks || 0) + (r.expectBlockSuccesses || 0), 0);
  const totalExpectBlocks = results.reduce((acc, r) => acc + (r.expectBlockSuccesses || 0), 0);
  if (totalBlocks > 0) {
    console.log(`  ${c.bold('EA1 ACTIVITY')}`);
    console.log(`    ${c.dim(padLeft(String(totalBlocks), 3))} destructive action${totalBlocks === 1 ? '' : 's'} attempted`);
    console.log(`    ${c.blue(padLeft(String(totalBlocks), 3))} blocked by policy`);
    if (totalExpectBlocks > 0) {
      console.log(`    ${c.green(padLeft(String(totalExpectBlocks), 3))} verified via expect block:  (policy gate confirmed working)`);
    }
    console.log('');
  }

  // Summary
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const blocked = results.filter((r) => r.status === 'block').length;
  const avgMs = results.length > 0 ? Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length) : 0;

  console.log(`  ${c.bold('SUMMARY')}`);
  const parts = [
    `${c.bold(String(results.length))} total`,
    passed > 0 ? c.green(`${passed} pass`) : null,
    failed > 0 ? c.red(`${failed} fail`) : null,
    blocked > 0 ? c.blue(`${blocked} policy-verified`) : null,
  ].filter(Boolean);
  console.log(`    ${parts.join(`  ${c.dim('·')}  `)}`);
  console.log(`    ${c.dim(`${(wallMs / 1000).toFixed(2)}s wall time  ·  avg ${avgMs}ms/test`)}`);
  console.log('');

  if (failed > 0) {
    const failedNames = results.filter((r) => r.status === 'fail').map((r) => r.file).join(' ');
    console.log(c.cyan(LINE_SINGLE));
    console.log('');
    console.log(`  ${c.yellow('RERUN FAILED')}   node __alethia__/ci-runner.mjs --only ${failedNames.split(' ')[0]}`);
    console.log(`  ${c.yellow('JSON OUTPUT')}    node __alethia__/ci-runner.mjs --reporter json`);
    console.log('');
  }

  console.log(c.cyan(LINE_DOUBLE));
  console.log('');
}

function reportPlain(results, { target }) {
  console.log(`Running ${results.length} Alethia test${results.length === 1 ? '' : 's'} against ${target}`);
  console.log('');
  const G = COLOR_ENABLED ? '\x1b[32m' : '';
  const R = COLOR_ENABLED ? '\x1b[31m' : '';
  const B = COLOR_ENABLED ? '\x1b[34m' : '';
  const D = COLOR_ENABLED ? '\x1b[2m' : '';
  const X = COLOR_ENABLED ? '\x1b[0m' : '';
  for (const r of results) {
    if (r.status === 'pass') {
      console.log(`${G}✓${X} ${r.file} (${r.totalSteps} steps, ${r.ms}ms)`);
    } else if (r.status === 'block') {
      console.log(`${B}◆${X} ${r.file} (EA1 verified, ${r.ms}ms)`);
    } else {
      console.log(`${R}✗${X} ${r.file}`);
      if (r.failureDetail) console.log(`${D}  → ${r.failureDetail.slice(0, 300)}${X}`);
    }
  }
}

function reportJson(results, meta) {
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const blocked = results.filter((r) => r.status === 'block').length;
  const payload = {
    schemaVersion: 'alethia-ci-v1',
    ...meta,
    summary: { total: results.length, pass: passed, fail: failed, block: blocked },
    results,
  };
  console.log(JSON.stringify(payload, null, 2));
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

const testsDir = __dirname;
let files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.alethia'))
  .sort();

if (ONLY) {
  const onlyName = ONLY.endsWith('.alethia') ? ONLY : `${ONLY}.alethia`;
  files = files.filter((f) => f === onlyName);
}

if (files.length === 0) {
  console.error('No .alethia files found in __alethia__/');
  process.exit(1);
}

const [bridgeBin, ...bridgeArgs] = BRIDGE_CMD;
const client = new StdioMcpClient(bridgeBin, bridgeArgs);

const results = [];
const wallStart = Date.now();

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'alethia-ci-runner', version: '0.2.0' },
  });
  client.notify('notifications/initialized', {});

  for (const file of files) {
    const raw = readFileSync(resolve(testsDir, file), 'utf8');
    const instructions = raw.replace(/http:\/\/127\.0\.0\.1:5173/g, TARGET);

    try {
      const result = await client.request('tools/call', {
        name: 'alethia_tell',
        arguments: { instructions, name: file.replace(/\.alethia$/, '') },
      });
      const text = result?.content?.[0]?.text;
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      results.push(analyzeResult(file, result, parsed));
    } catch (e) {
      results.push({
        file, status: 'fail',
        totalSteps: 0, passedSteps: 0, ms: 0, policyBlocks: 0, expectBlockSuccesses: 0,
        failureDetail: `request failed: ${e.message}`,
        nearMatches: null, suggestedFix: null, pageContext: null,
      });
    }
  }
} finally {
  client.close();
}

const wallMs = Date.now() - wallStart;
const meta = { target: TARGET, wallMs, bridgeCmd: BRIDGE_CMD.join(' ') };

if (REPORTER === 'json') {
  reportJson(results, meta);
} else if (REPORTER === 'plain') {
  reportPlain(results, meta);
} else {
  reportPretty(results, meta);
}

const anyFailed = results.some((r) => r.status === 'fail');
process.exit(anyFailed ? 1 : 0);
