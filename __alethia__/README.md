# Alethia tests for Atlas

This directory is the test suite. Each `.nlp` file is a set of plain-English instructions that Alethia compiles, executes, and verifies.

## Files

| File | Purpose |
|---|---|
| `smoke.nlp` | Sign-in screen renders correctly. The cheapest check. |
| `signin-flow.nlp` | Happy path — sign in, land on dashboard, nav is present. |
| `crud-flow.nlp` | Task list exercise — add a task, assert it appears. |
| `edit-flow.nlp` | Edit-task modal — click Edit → modal opens → update title → Save → verify in list. Tests conditional DOM + pre-filled input replacement. |
| `search-flow.nlp` | Search filter — type into search box, verify filtered-in tasks appear and filtered-out ones go absent. Exercises `ASSERT_EXISTS` and `assert X is not visible` against a live-filtered list. |
| `priority-flow.nlp` | Priority dropdown — change a task's priority via `<select>`. Exercises the SELECT command + the change-toast pattern. |
| `toast-flow.nlp` | Toast notifications — add task → assert toast appears → wait out the auto-dismiss → assert it's gone. Tests transient UI with `assert X is not visible`. |
| `count-flow.nlp` | Text-count assertions — asserts exact count strings ("3 total", "2 active"), then verifies the counts change after adding a task. |
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

## Handling async state changes

Alethia retries transient execution errors automatically — the runtime detects when a page is mid-rewrite (after a click that kicks off an async handler + re-render) and backs off a few times before surfacing a real failure. That means you usually **don't** need to add `wait` statements between steps, even when the app has real async behavior. The starter's tests demonstrate this: the Sign-in flow uses a 400ms fake-API handler with a full DOM re-render, and the assertions that follow it run without any explicit wait.

When you DO need `wait`:

- Animations that take a long time to settle (>1s)
- Polling an external service that might take seconds
- Watching for a specific element to appear — prefer `wait for X to appear` (explicit, documents intent) over a blind `wait 500`

## CI setup (not included yet)

A GitHub Actions workflow that installs Alethia via npm, serves this app, and runs each NLP file in sequence is straightforward but not included in starter v0. Once added, this is where the README badge earns its green check.
