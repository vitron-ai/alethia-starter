# Benchmark — Alethia vs Playwright

Reproducibility kit. Same app, same flows, same machine. Your numbers.

## What this measures

An agent running four real flows against the Anvil starter app:

- `smoke` — page loads, key UI renders (navigate + four text assertions)
- `signin` — sign in with valid credentials, land on dashboard
- `crud` — sign in, add a task, verify it appears in the list
- `search` — sign in, type in the search box, verify the list filters, clear and restore

For each flow, the harness runs the same work through three frameworks and reports:

1. **Per-flow timing** — how long each flow takes end to end.
2. **Per-flow tokens** — what the agent reads across the whole flow.
3. **Suite total** — all four flows, end to end, optionally including install cost.

## The three comparison targets

| | What it is | How the agent uses it |
|---|---|---|
| **Alethia** | Zero-IPC in-process runtime | One `alethia_tell` call drives the whole flow. Response bundles step detail, DOM diff, EA1 audit, integrity hash. |
| **PW CLI** | `npx playwright test` | Fresh Node process + fresh Chromium launch for every invocation. What Playwright users run in CI today. |
| **PW MCP** | `@playwright/mcp` server | Long-running MCP server with a warm browser. Flow = sequence of `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`. The apples-to-apples comp for agent-driven browser automation. |

## Reading the numbers

Two notes up front, because they matter:

1. **"Typical"** means mean of calls 2..N — after first-call setup amortizes. The first call is reported separately in `results.json` so you can see the cold-start cost; it's paid once per agent session.
2. **Token counts measure what the agent actually reads.** Alethia's response is bundled (everything in one reply). PW MCP responds per-action (many smaller replies). We sum PW MCP across the full flow for a fair comparison.

### What the numbers tell you

- **Timing:** Alethia wins across all flows against both PW CLI (process-spawn overhead dominates) and PW MCP (warm-browser but CDP-per-action still adds up).
- **Tokens:** **On simple pages, PW MCP is token-competitive or wins.** Alethia's response is bigger because it bundles the audit trail, DOM diff, and Ed25519 integrity hash — features PW MCP doesn't provide. On complex real-world apps with large accessibility trees, PW MCP's per-action snapshots grow faster than Alethia's bundled response and the ratio flips. Anvil is a small demo, so PW MCP's snapshots stay compact.
- **If you don't need the audit trail, Alethia's response could be smaller — but every response carries it by design. It's the feature, not a bug.**

## Why three comparison targets, not two

Playwright CLI is what Playwright users actually run today. PW MCP is what agents actually use. Both are honest comparisons for different questions:

- *"Is this faster than what my CI runs now?"* → compare to **PW CLI**
- *"Is this faster than what my agent uses right now?"* → compare to **PW MCP**

Dropping one hides half the story. Keeping both closes the common objections.

## Reproducing locally

```bash
# From the repo root:
npm install --prefix benchmark
npm run playwright:install --prefix benchmark
npm install -g @vitronai/alethia@latest

# Serve Anvil:
python3 -m http.server 5173 &

# Quick run (~5–8 min for N=10 across 4 flows, no install-cost measurement):
ALETHIA_HEADLESS=1 node benchmark/compare.mjs --iterations 10

# Full run with install-cost measurement (~8–12 min, fresh npm installs into tmp):
ALETHIA_HEADLESS=1 node benchmark/compare.mjs --iterations 10 --include-install
```

`ALETHIA_HEADLESS=1` matches Playwright's headless default for a clean apples-to-apples comparison. Drop it if you want to watch the run in the Alethia cockpit.

Results print to stdout as three tables and land in `benchmark/results.json`.

### Flags

- `--iterations <N>` — measured iterations per flow per framework. Default 10.
- `--only <flow>` — run just one of `smoke | signin | crud | search`.
- `--target <url>` — non-default Anvil URL.
- `--include-install` — also measure fresh-install time for all three frameworks. Adds ~90–180s to the run. On by default in CI.

## Methodology

- **Alethia flows** live in `../__alethia__/*.alethia` as plain-English NLP instructions.
- **PW CLI flows** live in `playwright-flows/*.spec.ts` — standard `@playwright/test` specs.
- **PW MCP flows** live in `pwmcp-flows/*.mjs` — hand-authored tool-call sequences using `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`. Elements are resolved from the snapshot's `[ref=eN]` tags by role + accessible name (the pattern a real agent follows).
- **Playwright configured for minimum overhead.** No trace, no video, no screenshots, no retries, single worker.
- **Sessions are reset between iterations** on mutating flows — Alethia via the runtime's `resetSession`, PW MCP via `localStorage.clear() + sessionStorage.clear()` evaluated in the warm browser, PW CLI via process respawn.

## Caveats (honest)

- **Hand-authored PW MCP flows.** The PW MCP flows under `pwmcp-flows/` are hand-optimized (the author knows which elements to find). A real agent doing ref discovery might take additional snapshots or retry after bad guesses — that would make PW MCP's per-flow token and time cost higher than what we show. We don't simulate agent inefficiency in either direction; both sides are optimized.
- **Simple demo app.** Anvil is deliberately small. On a complex production app (long forms, big dashboards, many interactive elements), PW MCP's accessibility snapshots grow significantly — Alethia's bundled response doesn't grow as fast. Expect the token ratio to shift in Alethia's favor there.
- **Parallel execution not measured.** Alethia supports `alethia_tell_parallel`; the harness currently runs sequentially. Parallel wall-clock comparison is a future chapter.
- **Hardware varies.** CI numbers are from a GitHub Actions Ubuntu runner. Your laptop will differ based on CPU, memory pressure, and background load.
- **Tokenizer is cl100k_base.** Industry-neutral reference. Anthropic and other providers tokenize slightly differently; expect within ~10% of the numbers shown for most production LLMs.

## CI

The `alethia` GitHub Actions workflow runs this benchmark on every push to `main`, with `--include-install` so the public numbers are complete. The full `results.json` uploads as a build artifact. The GitHub Actions step summary renders three tables with bidirectional winner labels — if Playwright ever wins on a metric, the summary will say so by name.

## Reporting inconsistencies

If your local numbers materially disagree with our CI numbers on comparable hardware, please open an issue. We want the numbers to be defensible; we'd rather fix the benchmark than overclaim.
