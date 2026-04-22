# Benchmark — Alethia vs Playwright

Reproducibility kit for the per-call cost an agent pays when it makes tool calls against a running app. Same app, same flows, same machine. Your numbers.

## What this measures

Three flows against the Atlas starter app:

- `smoke` — navigate + four text assertions
- `signin` — navigate + two form fills + click + three post-state assertions
- `crud` — navigate + signin + nav click + assertion + form fill + click + assertion

Each flow runs N+1 times per framework. Playwright's CLI is per-invocation — every `playwright test` is a fresh process. The benchmark reports both the first call (includes one-time setup cost) and the mean of calls 2..N (steady-state per-call cost).

Reported per flow:

| Metric | What it is | When it matters |
|---|---|---|
| **Alethia cold** | First call's wall time. Includes one-time setup. | Paid once per agent session. |
| **Alethia subsequent** | Mean of calls 2..N. | Every call after the first — agent-typical. |
| **Playwright** | Mean of N fresh CLI invocations. | Every call. |
| **Speedup** | `Playwright mean / Alethia subsequent mean`. | Grows with session length. |

## Why this is the right benchmark

Agents don't invoke-and-exit. A single agent session makes many `alethia_tell` calls over minutes or hours. Playwright's CLI pays a full browser spawn on every single invocation; there is no CLI mode that avoids this.

If you measure only the first call of a session, you're measuring initialization, not workflow. If you measure the cost of the Nth call, you see what agents actually experience.

## Reproducing locally

```bash
# From the repo root:
npm install --prefix benchmark
npm run playwright:install --prefix benchmark
npm install -g @vitronai/alethia@latest

# Serve Atlas:
python3 -m http.server 5173 &

# Run the comparison (~3–5 min for N=10).
# ALETHIA_HEADLESS=1 matches Playwright's headless default for a clean
# apples-to-apples comparison. Drop it if you want to watch the run in
# the Alethia cockpit.
ALETHIA_HEADLESS=1 node benchmark/compare.mjs --iterations 10
```

Results print to stdout as a table and land in `benchmark/results.json` + `benchmark/results.html` (shareable single-file report).

### Flags

- `--iterations <N>` — measured iterations per flow per framework. Default 10. Alethia runs one additional cold iteration (reported separately, not included in the subsequent-call mean).
- `--only <flow>` — run just one of `smoke | signin | crud`.
- `--target <url>` — non-default Atlas URL.

## Interpreting the output

```
Flow      Alethia cold   Alethia subseq  Alethia p95    Playwright     Speedup
          (1st call)     (mean 2..N)                    (mean)
─────────────────────────────────────────────────────────────────────────────
smoke     <tbd>ms        <tbd>ms         <tbd>ms        <tbd>ms        <tbd>×
signin    <tbd>ms        <tbd>ms         <tbd>ms        <tbd>ms        <tbd>×
crud      <tbd>ms        <tbd>ms         <tbd>ms        <tbd>ms        <tbd>×
```

*Run the benchmark locally to fill in values; open `benchmark/results.html` for a shareable visual report.*

## Caveats (honest)

- **Per-call subsequent cost is the headline.** The first call in an agent session includes one-time setup; it's reported separately in the `Alethia cold` column so you can see it. Agents making multiple calls in a session amortize that first-call cost.
- **Playwright configured for minimum overhead.** No trace, no video, no screenshots, no retries, single worker. Enable those and Playwright's numbers get worse — this benchmark doesn't advantage Alethia by comparing against a dressed-up Playwright.
- **Hardware varies.** The CI numbers are from a GitHub Actions Ubuntu runner. Your laptop will differ based on CPU, memory pressure, and background load.

## CI

The `alethia` GitHub Actions workflow runs this benchmark on every push to `main`. The HTML report uploads as a build artifact named `benchmark-report` — download it from the Actions tab and open in any browser.

## Reporting inconsistencies

If your local numbers materially disagree with our CI numbers on comparable hardware, please open an issue. We want the numbers to be defensible; we'd rather fix the benchmark than overclaim.
