import { assertVisible } from './shared.mjs';

// Smoke: navigate + four text assertions. Matches __alethia__/smoke.alethia.
export default async function smoke(client, target) {
  await client.call('browser_navigate', { url: target });
  const snap = await client.call('browser_snapshot', {});
  assertVisible(snap, 'Anvil');
  assertVisible(snap, 'Sign in to the operations console');
  assertVisible(snap, 'Email');
  assertVisible(snap, 'Team');
}
