import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { prepareDaemonLaunchConfig } from './session-mgr.js';

test('prepareDaemonLaunchConfig defers storage state load when profile is also provided', async () => {
  const prepared = await prepareDaemonLaunchConfig(
    {
      session: 'sess_1',
      runtime: 'camoufox',
      profile: '/tmp/profile-path',
      sessionName: 'acct_1',
      storageState: { cookies: [], origins: [] },
      proxy: {
        server: 'http://proxy.local:8080',
      },
      userAgent: 'ua',
      headless: false,
    },
    '/tmp/agent-browser-test-sockets'
  );

  assert.equal(prepared.env.AGENT_BROWSER_SESSION, 'sess_1');
  assert.equal(prepared.env.AGENT_BROWSER_SOCKET_DIR, '/tmp/agent-browser-test-sockets');
  assert.equal(prepared.env.AGENT_BROWSER_RUNTIME, 'camoufox');
  assert.equal(prepared.env.AGENT_BROWSER_PROFILE, '/tmp/profile-path');
  assert.equal(prepared.env.AGENT_BROWSER_SESSION_NAME, 'acct_1');
  assert.equal(prepared.env.AGENT_BROWSER_PROXY, 'http://proxy.local:8080/');
  assert.equal(prepared.env.AGENT_BROWSER_USER_AGENT, 'ua');
  assert.equal(prepared.env.AGENT_BROWSER_HEADED, '1');
  assert.equal(prepared.env.AGENT_BROWSER_STATE, undefined);
  assert.equal(prepared.deferStorageStateLoad, true);
  assert.ok(prepared.stateLoadPath);
  assert.ok(prepared.transientStorageStatePath);
  assert.deepEqual(JSON.parse(readFileSync(prepared.stateLoadPath!, 'utf8')), {
    cookies: [],
    origins: [],
  });

  prepared.cleanup();
});

test('prepareDaemonLaunchConfig passes through string storageState paths', async () => {
  const prepared = await prepareDaemonLaunchConfig(
    {
      session: 'sess_2',
      storageState: '/tmp/existing-state.json',
    },
    '/tmp/agent-browser-test-sockets'
  );

  assert.equal(prepared.env.AGENT_BROWSER_STATE, '/tmp/existing-state.json');
  assert.equal(prepared.stateLoadPath, '/tmp/existing-state.json');
  assert.equal(prepared.transientStorageStatePath, undefined);
  assert.equal(prepared.deferStorageStateLoad, false);
  prepared.cleanup();
});

test.after(() => {
  rmSync('/tmp/agent-browser-test-sockets', { recursive: true, force: true });
});
