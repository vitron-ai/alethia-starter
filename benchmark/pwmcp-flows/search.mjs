import { findRef, assertVisible, assertNotVisible } from './shared.mjs';

// Search: sign in, go to Tasks, search, verify filter, clear. Matches
// __alethia__/search-flow.alethia.
export default async function search(client, target) {
  await client.call('browser_navigate', { url: target });
  const snap1 = await client.call('browser_snapshot', {});
  const emailRef = findRef(snap1, 'textbox', 'Email');
  const teamRef = findRef(snap1, 'textbox', 'Team');
  const signInBtn = findRef(snap1, 'button', 'Sign in');

  await client.call('browser_type', { element: 'Email', ref: emailRef, text: 'alice@company.com' });
  await client.call('browser_type', { element: 'Team', ref: teamRef, text: 'platform' });
  await client.call('browser_click', { element: 'Sign in', ref: signInBtn });

  const snap2 = await client.call('browser_snapshot', {});
  const tasksNav = findRef(snap2, 'button', 'Tasks');
  await client.call('browser_click', { element: 'Tasks nav', ref: tasksNav });

  const snap3 = await client.call('browser_snapshot', {});
  assertVisible(snap3, 'Review pending deployments');
  assertVisible(snap3, 'Audit Q2 access logs');
  assertVisible(snap3, 'Rotate Vault credentials');

  const searchField = findRef(snap3, 'searchbox', 'Search tasks…');
  await client.call('browser_type', { element: 'Search', ref: searchField, text: 'Vault' });

  const snap4 = await client.call('browser_snapshot', {});
  assertVisible(snap4, 'Rotate Vault credentials');
  assertNotVisible(snap4, 'Review pending deployments');
  assertNotVisible(snap4, 'Audit Q2 access logs');

  const clearBtn = findRef(snap4, 'button', 'Clear');
  await client.call('browser_click', { element: 'Clear', ref: clearBtn });

  const snap5 = await client.call('browser_snapshot', {});
  assertVisible(snap5, 'Review pending deployments');
  assertVisible(snap5, 'Audit Q2 access logs');
}
