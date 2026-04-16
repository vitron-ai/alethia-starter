# Alethia tests for Atlas

This directory is the test suite. Each `.nlp` file is a set of plain-English
instructions that Alethia compiles, executes, and verifies.

## Files

| File | Purpose |
|---|---|
| `smoke.nlp` | Sign-in screen renders correctly. The cheapest check. |
| `signin-flow.nlp` | Happy path — sign in, land on dashboard, nav is present. |
| `crud-flow.nlp` | Task list exercise — add a task, assert it appears. |
| `safety.nlp` | EA1 policy verification — `expect block:` on Delete Account. |

## Running

With [Alethia](https://www.npmjs.com/package/@vitronai/alethia) installed
and configured in your MCP client, tell your agent:

> Run the Alethia tests in `./alethia/` against the app at
> `http://127.0.0.1:5173`.

The agent will call `alethia_tell` once per file. To run `safety.nlp`
directly, the `expect block:` step will **pass** if the EA1 gate blocks
the action, **fail** if the gate lets it through. That's the
verifiable-safety primitive.

## Authoring tips

- Use text that's unique on the page. "Delete" might match many buttons;
  "Delete Account" matches one.
- Wrap destructive actions in `expect block:` for safety tests.
  Leave them plain for the negative path (where the block is a real fail).
- Navigate to the full URL at the start of each file so each test is
  idempotent and can be run in isolation.
- Keep files focused — one NLP file = one scenario. Parallel runs are
  easier to scan when tests aren't interleaved.
