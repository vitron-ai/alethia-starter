// Shared helpers for Playwright MCP flows.
//
// Playwright MCP returns YAML-style snapshots where each named element carries
// a [ref=eN] tag. Actions (click, type) require the ref, not a selector — so a
// realistic agent takes a snapshot, parses it for role + accessible name, then
// uses the ref for the next action. We model that pattern directly.

const REF_RE = /(\w+)\s+"([^"]+)"[^\n]*?\[ref=(e\d+)\]/g;

export function extractRefs(snapshot) {
  const refs = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(snapshot)) !== null) {
    refs.push({ role: m[1], name: m[2], ref: m[3] });
  }
  return refs;
}

export function findRef(snapshot, role, name) {
  const refs = extractRefs(snapshot);
  const found = refs.find((r) => r.role === role && r.name === name);
  if (!found) {
    throw new Error(
      `PW MCP: couldn't find ${role} "${name}" in snapshot. ` +
      `Available: ${refs.map((r) => `${r.role}/${r.name}`).join(', ')}`
    );
  }
  return found.ref;
}

// Assert text appears in the current snapshot the client already has.
export function assertVisible(snapshot, text) {
  if (!snapshot.includes(text)) {
    throw new Error(`PW MCP: expected "${text}" visible; snapshot head: ${snapshot.slice(0, 300)}`);
  }
}

export function assertNotVisible(snapshot, text) {
  if (snapshot.includes(text)) {
    throw new Error(`PW MCP: expected "${text}" NOT visible; but found it in snapshot`);
  }
}
