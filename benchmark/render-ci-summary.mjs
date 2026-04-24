#!/usr/bin/env node
// Render the benchmark's GitHub Actions step summary from results.json.
// Kept out of the workflow YAML so we don't wrestle with three layers of
// shell/heredoc escaping every time the schema changes.

import { readFileSync, writeFileSync } from 'node:fs';

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

const r = JSON.parse(readFileSync('benchmark/results.json', 'utf8'));
const lines = [];

lines.push('## Benchmark — Alethia vs Playwright');
lines.push('');
lines.push('An agent making tool calls against a real app (the Anvil starter). Lower is better.');
lines.push('');

// ── Per-flow timing ─────────────────────────────────────────────────────────
lines.push('### Per-flow timing — how long each flow takes, end to end');
lines.push('');
lines.push('| Flow | What it tests | Alethia *(typical)* | PW CLI *(mean)* | PW MCP *(typical)* | vs PW CLI | vs PW MCP |');
lines.push('|---|---|---|---|---|---|---|');
for (const [flow, v] of Object.entries(r.flows)) {
  lines.push(
    `| ${flow} | ${v.description || ''} | ${fmt(v.alethia.typical.meanMs)} | ${fmt(v.playwright.meanMs)} | ${fmt(v.playwrightMcp.typical.meanMs)} | **${v.speedupVsPwCli.toFixed(1)}× faster** | **${v.speedupVsPwMcp.toFixed(1)}× faster** |`
  );
}
lines.push('');

// ── Per-flow tokens ─────────────────────────────────────────────────────────
lines.push('### Per-flow tokens — what the agent reads during one flow');
lines.push('');
lines.push('Tokenized with `cl100k_base` (GPT-4 / GPT-3.5-turbo). Alethia returns one bundled response per flow (steps + DOM diffs + EA1 audit + integrity hash). PW MCP returns a snapshot after each action; we sum across the whole flow.');
lines.push('');
lines.push('| Flow | Alethia *(per call)* | PW MCP *(total per flow)* | Winner |');
lines.push('|---|---|---|---|');
for (const [flow, v] of Object.entries(r.flows)) {
  const ratio = v.tokenRatioVsPwMcp;
  const winner = ratio >= 1
    ? `**Alethia ${ratio.toFixed(1)}× fewer**`
    : `_PW MCP ${(1 / ratio).toFixed(1)}× fewer_`;
  lines.push(`| ${flow} | ${v.alethia.typicalTokens.meanTokens} | ${v.playwrightMcp.typicalTokens.meanTokens} | ${winner} |`);
}
lines.push('');

// ── Suite total ─────────────────────────────────────────────────────────────
if (r.suiteTotal) {
  const st = r.suiteTotal;
  const showInstall = r.installCost !== null;
  lines.push('### Suite total — agent running every flow once, end to end');
  lines.push('');
  lines.push('| | Alethia | PW CLI | PW MCP |');
  lines.push('|---|---|---|---|');
  if (showInstall) {
    lines.push(`| Install (one-time) | ${fmt(st.alethia.installMs)} | ${fmt(st.playwright.installMs)} | ${fmt(st.playwrightMcp.installMs)} |`);
  }
  lines.push(`| All flows × ${r.iterations} | ${fmt(st.alethia.flowsMs)} | ${fmt(st.playwright.flowsMs)} | ${fmt(st.playwrightMcp.flowsMs)} |`);
  lines.push(`| **Total** | **${fmt(st.alethia.totalMs)}** | **${fmt(st.playwright.totalMs)}** | **${fmt(st.playwrightMcp.totalMs)}** |`);
  lines.push('');

  const bidirectional = (ratio, name) => ratio >= 1
    ? `**Alethia is ${ratio.toFixed(1)}× faster than ${name}**`
    : `_${name} is ${(1 / ratio).toFixed(1)}× faster than Alethia at this iteration count — Alethia's first-call setup hasn't amortized yet. Increase iterations to see the crossover._`;
  lines.push(bidirectional(st.speedupVsPwCli, 'PW CLI') + ', including one-time install cost.');
  lines.push('');
  lines.push(bidirectional(st.speedupVsPwMcp, 'PW MCP') + ', including one-time install cost.');
  lines.push('');
}

// ── Reading the numbers ─────────────────────────────────────────────────────
lines.push('### Reading the numbers');
lines.push('');
lines.push('- **Alethia** drives the whole flow in one `alethia_tell` call. The response bundles every step, a DOM diff, an EA1 policy audit, and an Ed25519 integrity hash — that\'s why its per-call token count is higher than PW MCP\'s per-action snapshots.');
lines.push('- **PW CLI** (`npx playwright test`) spawns a fresh process + browser for every invocation. This is what Playwright users run today in CI.');
lines.push('- **PW MCP** keeps the browser warm across tool calls. Flows are sequences of `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type` — the pattern an agent actually uses.');
lines.push('- **Tokens** are measured on the real response text each framework returns. Multiply by your LLM\'s input price for $/call.');
lines.push('- **Install cost** is a fresh `npm install` into a tmp directory. PW CLI and PW MCP both download Chromium (~170MB); Alethia downloads its runtime on first call, captured in the per-flow "first call" timing in `results.json`.');
lines.push('- **Simple vs complex flows matter for tokens.** On simple pages (small accessibility trees), PW MCP\'s snapshots are compact. On complex real-world apps, they grow substantially faster than Alethia\'s audit bundle; the token ratio shifts accordingly.');
lines.push('');
lines.push(`_${r.iterations} measured iterations per flow, one GitHub Actions runner, headless. [compare.mjs](benchmark/compare.mjs) and [results.json](benchmark/results.json) are the full story — including p50/p95 and per-iteration data we don't show in the summary._`);

const outPath = process.env.GITHUB_STEP_SUMMARY || '/dev/stdout';
writeFileSync(outPath, lines.join('\n') + '\n');
