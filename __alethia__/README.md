# Alethia tests for Atlas

This directory is the test suite. Each `.nlp` file is a set of plain-English instructions that Alethia compiles, executes, and verifies.

## Files

| File | Purpose |
|---|---|
| `smoke.nlp` | Sign-in screen renders correctly. The cheapest check. |
| `signin-flow.nlp` | Happy path — sign in, land on dashboard, nav is present. |
| `crud-flow.nlp` | Task list exercise — add a task, assert it appears. |
| `safety.nlp` | EA1 policy verification — `expect block:` on Delete Account. |

## Running

With [Alethia](https://www.npmjs.com/package/@vitronai/alethia) installed and configured in your MCP client, tell your agent:

> Run the Alethia tests in `./__alethia__/` against the app at `http://127.0.0.1:5173`.

The agent will call `alethia_tell` once per file. For `safety.nlp`, the `expect block:` step **passes** if the EA1 gate blocks the action, **fails** if the gate lets it through. That's the verifiable-safety primitive.

## Authoring tips

- **Use text that's unique on the page.** "Delete" might match many buttons; "Delete Account" matches one.
- **Wrap destructive actions in `expect block:`** for safety tests. Leave them plain for the negative path (where the block is a real fail).
- **Navigate to the full URL at the start of each file** so each test is idempotent and can be run in isolation.
- **Keep files focused** — one NLP file = one scenario. Parallel runs are easier to scan when tests aren't interleaved.

## Known tip: `wait` after async actions

If your app has async operations (sign-in with a spinner, delayed save, etc.), add a brief `wait` after the trigger step so the DOM has time to settle before the next assertion:

```
click Sign in
wait 600
assert Welcome is visible
```

Rationale: on async state changes that re-render major sections of the page, an immediately-following `executeJavaScript` can hit the DOM mid-rewrite and error with "Script failed to execute." A 400–800ms `wait` lets the transition finish.

This is a **test-authoring workaround for a runtime limitation** — the underlying fix is retry-on-transient-script-error in the main-process orchestrator, planned for v0.2.1 of the runtime. When that ships, you can drop most of these waits.

## CI setup (not included yet)

A GitHub Actions workflow that installs Alethia via npm, serves this app, and runs each NLP file in sequence is straightforward but not included in starter v0. Once added, this is where the README badge earns its green check.
