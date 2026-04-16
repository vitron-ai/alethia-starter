# alethia-starter

A working starting point for writing agent-native E2E tests with [Alethia](https://www.npmjs.com/package/@vitronai/alethia). Fork this, adapt the NLP, point your agent at it.

No framework. No build step. Two files, runs in any static server.

---

## Try it in 30 seconds

```bash
git clone https://github.com/vitron-ai/alethia-starter.git
cd alethia-starter
python3 -m http.server 5173
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) — you should see **Atlas**, a tiny operations console. Sign in with anything (e.g. `alice@company.com` / `platform`).

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
| `smoke.nlp` | Sign-in screen renders |
| `signin-flow.nlp` | Happy path — sign in, land on dashboard, nav is present |
| `crud-flow.nlp` | Task list — add, assert it appears |
| `safety.nlp` | **EA1 policy verification** — `expect block:` on Delete Account |

---

## What the tests exercise

The Atlas app is deliberately small but real enough to surface bugs that a static HTML demo wouldn't:

- **Async operations** with loading spinners (sign-in, add-task, toggle, delete — each is a `setTimeout`-simulated round trip)
- **Client-side form validation** with inline error messages
- **SPA routing** via hash-based nav (back/forward, direct links to `/settings`)
- **Destructive-action gating** — `Delete Account` is a write-high action that Alethia's EA1 policy gate should refuse by default

If any of those surfaces break under a future Alethia release, the tests in `__alethia__/` will catch it.

---

## `expect block:` — the verifiable-safety primitive

The `safety.nlp` file ends with:

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

## License

The starter code (this repo) is MIT. The Alethia runtime it's testing is patent-pending and governed by a separate license — see [github.com/vitron-ai/alethia](https://github.com/vitron-ai/alethia).
