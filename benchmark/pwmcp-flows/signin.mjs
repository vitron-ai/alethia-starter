import { findRef, assertVisible } from './shared.mjs';

// Sign-in happy path. Matches __alethia__/signin-flow.alethia.
export default async function signin(client, target) {
  await client.call('browser_navigate', { url: target });
  const snap1 = await client.call('browser_snapshot', {});
  const emailRef = findRef(snap1, 'textbox', 'Email');
  const teamRef = findRef(snap1, 'textbox', 'Team');
  const signInBtn = findRef(snap1, 'button', 'Sign in');

  await client.call('browser_type', {
    element: 'Email field', ref: emailRef, text: 'alice@company.com',
  });
  await client.call('browser_type', {
    element: 'Team field', ref: teamRef, text: 'platform',
  });
  await client.call('browser_click', {
    element: 'Sign in button', ref: signInBtn,
  });

  const snap2 = await client.call('browser_snapshot', {});
  assertVisible(snap2, 'Welcome');
  assertVisible(snap2, 'Tasks');
  assertVisible(snap2, 'Settings');
}
