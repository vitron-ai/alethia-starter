#!/usr/bin/env node
/*
 * CI runner for Alethia NLP tests.
 *
 * Spawns the @vitronai/alethia MCP bridge over stdio, sends each .nlp file
 * as a tools/call request, and exits 0 if every step passes, 1 otherwise.
 *
 * Usage:
 *   node __alethia__/ci-runner.mjs [--target http://127.0.0.1:5173]
 *
 * Env:
 *   ALETHIA_TARGET  — override the navigate-to target URL in tests
 *   ALETHIA_BRIDGE  — override the bridge command (default: npx -y @vitronai/alethia)
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const argTarget = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const TARGET = argTarget || process.env.ALETHIA_TARGET || 'http://127.0.0.1:5173';
const BRIDGE_CMD = (process.env.ALETHIA_BRIDGE || 'npx -y @vitronai/alethia').split(/\s+/);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const ok = (msg) => console.log(`${GREEN}✓${RESET} ${msg}`);
const fail = (msg) => console.log(`${RED}✗${RESET} ${msg}`);
const dim = (msg) => console.log(`${DIM}${msg}${RESET}`);

// ────────────────────────────────────────────────────────────────────────────
// MCP stdio client — minimal, just enough to call tools/call on the bridge.
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
// Main
// ────────────────────────────────────────────────────────────────────────────

const testsDir = __dirname;
const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.nlp'))
  .sort();

if (files.length === 0) {
  console.error('No .nlp files found in __alethia__/');
  process.exit(1);
}

console.log(`Running ${files.length} Alethia test${files.length === 1 ? '' : 's'} against ${TARGET}`);
console.log('');

const [bridgeBin, ...bridgeArgs] = BRIDGE_CMD;
const client = new StdioMcpClient(bridgeBin, bridgeArgs);

let totalFailed = 0;

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'alethia-ci-runner', version: '0.1.0' },
  });
  client.notify('notifications/initialized', {});

  for (const file of files) {
    const raw = readFileSync(resolve(testsDir, file), 'utf8');
    // Rewrite the navigate target if it uses the 5173 default. Keeps the
    // committed .nlp files portable (localhost-dev friendly) while letting
    // CI point them at whatever port the runner served the app on.
    const nlp = raw.replace(/http:\/\/127\.0\.0\.1:5173/g, TARGET);

    try {
      const result = await client.request('tools/call', {
        name: 'alethia_tell',
        arguments: { nlp, name: file.replace(/\.nlp$/, '') },
      });
      const text = result?.content?.[0]?.text;
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }

      if (parsed?.ok === true) {
        const steps = parsed.run?.stepRuns?.length ?? 0;
        const ms = parsed.elapsedMs ?? parsed.run?.elapsedMs ?? 0;
        ok(`${file} (${steps} steps, ${ms}ms)`);
      } else {
        totalFailed++;
        const failedStep = (parsed?.stepResults || parsed?.run?.stepRuns || []).find((s) => s?.ok === false);
        fail(`${file}`);
        if (failedStep?.detail) dim(`  → ${failedStep.detail}`);
        else if (parsed?.error) dim(`  → ${parsed.error}`);
        else dim(`  → (no structured failure detail)`);
      }
    } catch (e) {
      totalFailed++;
      fail(`${file}`);
      dim(`  → ${e.message}`);
    }
  }
} finally {
  client.close();
}

console.log('');
if (totalFailed === 0) {
  console.log(`${GREEN}All ${files.length} tests passed.${RESET}`);
  process.exit(0);
} else {
  console.log(`${RED}${totalFailed} of ${files.length} tests failed.${RESET}`);
  process.exit(1);
}
