# alethia-anvil

[![alethia](https://github.com/vitron-ai/alethia-anvil/actions/workflows/alethia.yml/badge.svg?branch=main)](https://github.com/vitron-ai/alethia-anvil/actions/workflows/alethia.yml?query=branch%3Amain)
[![alethia verified](https://img.shields.io/badge/alethia-verified-22c55e?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2ZmZiI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48L3N2Zz4=)](https://github.com/vitron-ai/alethia)
[![npm](https://img.shields.io/npm/v/%40vitronai%2Falethia?label=%40vitronai%2Falethia&color=3b82f6)](https://www.npmjs.com/package/@vitronai/alethia)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Reference application + complete E2E test suite for [Alethia](https://www.npmjs.com/package/@vitronai/alethia). Fork **Anvil** to learn the agent-native testing pattern, adapt the 14 plain-English `.alethia` specs to your own app, and run them in CI. Also hosts the reproducible head-to-head Playwright / Playwright-MCP benchmark cited on [vitron.ai](https://vitron.ai).

No framework. No build step. Static HTML + 14 NLP test files, runs in any static server.

---

## Try it in 30 seconds

```bash
git clone https://github.com/vitron-ai/alethia-anvil.git
cd alethia-anvil
python3 -m http.server 5173
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) — you should see **Anvil**, a tiny operations console. Sign in with anything (e.g. `alice@company.com` / `platform`).

---

## Run the tests with your agent

Install Alethia in your MCP client's config:

```json
{
  "mcpServers": {
    "alethia": { "command": "alethia-mcp" }
  }
}
```

Then tell your agent:

> Run the Alethia tests in `./__alethia__/` against the app at http://127.0.0.1:5173.

The agent will call `alethia_tell` once per test file and report pass/fail. Files are in `__alethia__/`:

| File | What it tests |
|---|---|
| `smoke.alethia` | Sign-in screen renders |
| `signin-flow.alethia` | Happy path — sign in, land on dashboard, nav is present |
| `crud-flow.alethia` | Task list — add, assert it appears |
| `edit-flow.alethia` | Inline editing — open modal, change title, save |
| `search-flow.alethia` | Live-filter search box narrows the task list |
| `priority-flow.alethia` | Priority dropdown updates a task + confirms via toast |
| `toast-flow.alethia` | Transient toast appears, then auto-dismisses |
| `count-flow.alethia` | Text-based counters stay consistent after add |
| `tabs-flow.alethia` | Tab filter (All/Active/Done) narrows the list |
| `bulk-flow.alethia` | Select-all + bulk complete across the visible tasks |
| `export-flow.alethia` | Settings → Export Tasks emits JSON + success toast |
| `shortcuts-flow.alethia` | Keyboard-shortcut legend renders in Settings |
| `toast-stack-flow.alethia` | Multiple toasts stack newest-first without replacement |
| `safety.alethia` | **EA1 policy verification** — `expect block:` on Delete Account |

---

## Running the tests in CI

This repo ships a GitHub Actions workflow at [`.github/workflows/alethia.yml`](./.github/workflows/alethia.yml) that:

1. Starts Anvil on a static server
2. Installs xvfb + Electron's Linux deps
3. Runs [`__alethia__/ci-runner.mjs`](./__alethia__/ci-runner.mjs) — a tiny stdio MCP client that pipes every `.alethia` file through `@vitronai/alethia` and fails the build on the first red step

To run the same flow locally:

```bash
python3 -m http.server 5173 &
node __alethia__/ci-runner.mjs
```

The runner respects `ALETHIA_TARGET` if your app runs on a different port.

---

## Verify the "faster than CDP-based tools" claim yourself

The [`benchmark/`](./benchmark) directory is a reproducibility kit. Same Anvil app. Same three flows. Same machine. Numbers you can check.

```bash
npm install --prefix benchmark
npm run playwright:install --prefix benchmark
npm install -g @vitronai/alethia@latest

python3 -m http.server 5173 &
ALETHIA_HEADLESS=1 node benchmark/compare.mjs --iterations 10
```

Prints a comparison table; writes `benchmark/results.json`. Takes ~3–5 min for N=10. Committed baseline numbers from a reference machine live in `benchmark/baseline.json`. Full methodology, flag list, and honest caveats in [`benchmark/README.md`](./benchmark/README.md).

If your numbers disagree with the baseline on comparable hardware, open an issue — we want the claim to be defensible, not marketing-absolute.

### Reporter options

```bash
node __alethia__/ci-runner.mjs --reporter pretty   # default — full summary, EA1 activity, slowest tests
node __alethia__/ci-runner.mjs --reporter plain    # one-line-per-test minimal output (good for logs)
node __alethia__/ci-runner.mjs --reporter json     # structured output for agent consumption
node __alethia__/ci-runner.mjs --only safety       # run a single test by name
```

Set `NO_COLOR=1` to disable ANSI colors. Status badges: `[PASS]` green, `[FAIL]` red, `[BLOCK]` blue (policy-verified via `expect block:`).

---

## What the tests exercise

The Anvil app is deliberately small but real enough to surface bugs that a static HTML demo wouldn't:

- **Async operations** with loading spinners (sign-in, add-task, toggle, delete — each is a `setTimeout`-simulated round trip)
- **Client-side form validation** with inline error messages
- **SPA routing** via hash-based nav (back/forward, direct links to `/settings`)
- **Destructive-action gating** — `Delete Account` is a write-high action that Alethia's EA1 policy gate should refuse by default

If any of those surfaces break under a future Alethia release, the tests in `__alethia__/` will catch it.

---

## `expect block:` — the verifiable-safety primitive

The `safety.alethia` file ends with:

```
expect block: click Delete Account
```

That line **passes** when the EA1 gate blocks the action, **fails** when the gate lets it through. It's how you regression-test your app's safety boundary itself — not just "does my UI work" but "does the policy gate still catch the destructive action I wired to this button?"

No other E2E framework can express this cleanly, because none have a policy gate to assert against. This is the v0.2 primitive.

---

## Adapting this to your own app

1. Replace `index.html` with your app (or point the tests at your existing dev server).
2. Update the NLP in `__alethia__/` to reference your own headings, buttons, and flows.
3. Run the tests. Iterate.

That's it. No config, no test runner, no `.spec` files. Your agent reads the NLP, calls Alethia, reads back structured `nearMatches` / `suggestedFix` / `pageContext` fields, and self-corrects.

---

## Links

- Alethia runtime: [github.com/vitron-ai/alethia](https://github.com/vitron-ai/alethia)
- MCP bridge (npm): [npmjs.com/package/@vitronai/alethia](https://www.npmjs.com/package/@vitronai/alethia)
- Tessl listing: [tessl.io/registry/vitron-ai/alethia](https://tessl.io/registry/vitron-ai/alethia)
- Website: [vitron.ai](https://vitron.ai)

## Security posture — local-only by architecture

Alethia is a **local-only** runtime by design. The signed binary refuses to navigate to any origin outside the local allowlist (`file://`, `localhost`, `127.0.0.1`, `.local`, RFC1918 ranges). This is a compile-time constant enforced in four places inside the runtime — it is **not** a CLI flag, env var, MCP argument, profile, or UI toggle.

Why: Alethia's zero-IPC execution would make it an ideal credential-stuffing / account-takeover / abuse-automation tool if turned against the open web. It will not become that tool. For partner-specific production-origin access, contact **gatekeeper@vitron.ai** — we issue custom-signed builds; we do not ship configurability.

Full posture at [vitron.ai/safety](https://vitron.ai/safety).

## License

The starter code (this repo) is MIT. The Alethia runtime it's testing is patent-pending and governed by a separate license — see [github.com/vitron-ai/alethia](https://github.com/vitron-ai/alethia).
