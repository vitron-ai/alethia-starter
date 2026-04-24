import { findRef, assertVisible } from './shared.mjs';

// CRUD: sign in, go to Tasks, add a task, verify. Matches __alethia__/crud-flow.alethia.
export default async function crud(client, target) {
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
  const newTaskField = findRef(snap3, 'textbox', 'What needs to happen next?');
  const addBtn = findRef(snap3, 'button', 'Add task');

  await client.call('browser_type', {
    element: 'New task field', ref: newTaskField, text: 'Write v0.2 release notes',
  });
  await client.call('browser_click', { element: 'Add task button', ref: addBtn });

  const snap4 = await client.call('browser_snapshot', {});
  assertVisible(snap4, 'Write v0.2 release notes');
}
