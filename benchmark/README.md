# Benchmark — Alethia vs Playwright

Reproducibility kit for the *"dramatically faster than CDP-based tools"* claim. Same app. Same flows. Same machine. Your numbers.

## What this measures

Per-invocation wall time for three representative flows against the Atlas starter app, in both **Alethia** (via the `@vitronai/alethia` MCP bridge) and **Playwright**.

- `smoke` — navigate + four text assertions
- `signin` — navigate + two form fills + click + three post-state assertions
- `crud` — navigate + signin + nav click + assertion + form fill + click + assertion

Each flow runs N times in each framework. We report mean, p50, p95, min, max, and the mean speedup ratio.

**What's included in the timing:** everything a CI pipeline actually pays on each invocation — process spawn, framework init, browser setup, test execution, teardown. Both frameworks pay this on every call; neither gets a free ride.

**What's excluded:** batch-mode test execution. If you run 100 Alethia steps in one `alethia_tell` call vs 100 Playwright steps in one test file, the per-step cost is very different than this benchmark shows (both frameworks amortize spawn). That scenario is measured elsewhere; this one measures the single-invocation cost an **agent** pays on each tool call, because agents don't batch.

## Reproducing locally

```bash
# From the repo root:
npm install --prefix benchmark
npm run playwright:install --prefix benchmark
npm install -g @vitronai/alethia@latest

# Serve Atlas:
python3 -m http.server 5173 &

# Run the comparison (takes ~3–5 min for N=10):
node benchmark/compare.mjs --iterations 10
```

Results print to stdout as a table and also land in `benchmark/results.json`.

### Flags

- `--iterations <N>` — iterations per flow per framework. Default 10. More = tighter confidence interval, longer wait.
- `--only <flow>` — run just one of `smoke | signin | crud`. Useful for iteration.
- `--target <url>` — non-default Atlas URL.

## Interpreting the output

Example run on a 2022 MacBook Air M2 (see `baseline.json` for the exact environment):

```
Flow      Alethia     Alethia     Playwright  Playwright  Speedup
          mean        p95         mean        p95         (mean)
─────────────────────────────────────────────────────────────
smoke     <tbd>ms     <tbd>ms     <tbd>ms     <tbd>ms     <tbd>×
signin    <tbd>ms     <tbd>ms     <tbd>ms     <tbd>ms     <tbd>×
crud      <tbd>ms     <tbd>ms     <tbd>ms     <tbd>ms     <tbd>×
```

*Run the benchmark locally to fill in the values; or see `baseline.json` for the committed reference numbers.*

## What drives the gap

- **No remote-debugging-protocol overhead.** Alethia drives the page directly; Playwright routes every step through CDP serialization.
- **No browser-launch tax per invocation.** Playwright spawns Chromium on every test invocation. Alethia's runtime is already running; successive `alethia_tell` calls reuse it.
- **No long-lived test harness state.** Both frameworks do per-invocation cleanup, but Alethia's is lighter because it has less state to clean.

## Caveats (honest)

- **Single-machine results vary by hardware.** The baseline numbers in `baseline.json` are from one reference machine. Your laptop will be faster or slower depending on CPU, memory pressure, and background load.
- **First invocation is slower than subsequent ones for both frameworks.** The harness warms each framework once before measuring; the warmup invocation is discarded.
- **This isn't a "best-case" number for Alethia.** A single `alethia_tell` call containing all three flows' NLP batched together would be dramatically faster per-step than this shows. We don't benchmark that scenario here because it doesn't match how agents call tools.
- **Playwright configured for minimum overhead.** No trace, no video, no screenshots, no retries, single worker. If you enable those, Playwright's numbers get worse — this benchmark doesn't unfairly advantage Alethia by comparing against a dressed-up Playwright.

## CI

The `alethia` GitHub Actions workflow runs this benchmark on every push to `main`. Results upload as a build artifact named `benchmark-results`. A significant regression (Alethia ≥ 2× slower than its baseline) fails the build.

## Reporting inconsistencies

If your local numbers materially disagree with the committed `baseline.json` on comparable hardware — or if you find a scenario where Alethia is slower — please open an issue. We want the numbers to be defensible; we'd rather fix the benchmark or the runtime than overclaim.
