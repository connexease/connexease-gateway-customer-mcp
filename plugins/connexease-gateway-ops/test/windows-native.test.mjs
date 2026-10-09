import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runWindowsNative } from '../src/windows-native.mjs';
import { WindowsDpapiStore, NativeSession, promptForGatewayCredentials, promptForGatewayOtp, promptForWebhookHeaderValue } from '../src/native-session.mjs';
import { confirmGatewayAction, showGatewaySecret } from '../src/native-confirm.mjs';
import { selectGatewayCsvDestination, selectGatewayUploadFile } from '../src/native-file.mjs';

function fakePowerShell(response, calls, code = 0) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    let input = '';
    child.stdin = new Writable({
      write(chunk, _encoding, done) { input += chunk.toString('utf8'); done(); },
      final(done) {
        queueMicrotask(() => {
          calls.push({ command, args, options, input });
          child.stdout.end(JSON.stringify(response));
          child.emit('close', code);
        });
        done();
      },
    });
    return child;
  };
}

test('Windows helper keeps a refresh token in stdin, not argv or environment', async () => {
  const calls = [];
  const value = await runWindowsNative('token-write', { token: 'private-refresh-token' }, {
    systemRoot: 'C:\\Windows', spawnImpl: fakePowerShell({ status: 'ok', value: null }, calls),
  });
  assert.equal(value, null);
  assert.match(calls[0].command, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(calls[0].args.at(-1), 'token-write');
  assert.equal(calls[0].args.includes('private-refresh-token'), false);
  assert.equal(calls[0].options.env, undefined);
  assert.deepEqual(JSON.parse(calls[0].input), { token: 'private-refresh-token' });
});

test('Windows helper fails closed without echoing PowerShell errors', async () => {
  const calls = [];
  await assert.rejects(runWindowsNative('token-read', {}, {
    systemRoot: 'C:\\Windows', spawnImpl: fakePowerShell({ status: 'error', value: 'private-refresh-token' }, calls, 1),
  }), (error) => !error.message.includes('private-refresh-token'));
  assert.throws(() => runWindowsNative('unknown', {}, { systemRoot: 'C:\\Windows' }), /Unknown Windows native action/);
});

test('Windows credentials and OTP use hidden native prompts without chat arguments', async () => {
  const calls = [];
  const answers = ['dev@example.test', 'private-password', '123456', 'secret-header'];
  const windowsNative = async (action, payload) => {
    calls.push({ action, payload });
    return answers.shift();
  };
  assert.deepEqual(await promptForGatewayCredentials({ platform: 'win32', windowsNative }), {
    email: 'dev@example.test', password: 'private-password',
  });
  assert.equal(await promptForGatewayOtp({ platform: 'win32', windowsNative }), '123456');
  assert.equal(await promptForWebhookHeaderValue({ platform: 'win32', windowsNative }), 'secret-header');
  assert.deepEqual(calls.map(({ payload }) => payload.hidden), [false, true, true, true]);
  assert.equal(JSON.stringify(calls).includes('private-password'), false);
});

test('Windows protected store reads, writes and deletes with platform-scoped actions', async () => {
  const calls = [];
  const store = new WindowsDpapiStore({ platform: 'win32', execute: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'token-read' ? 'saved-refresh' : null;
  } });
  await store.setRefreshToken('new-refresh');
  assert.equal(await store.getRefreshToken(), 'saved-refresh');
  await store.deleteRefreshToken();
  assert.deepEqual(calls.map(({ action }) => action), ['token-write', 'token-read', 'token-delete']);
  assert.deepEqual(calls[0].payload, { token: 'new-refresh' });
  await assert.rejects(store.setRefreshToken('bad\ntoken'), /Invalid Gateway refresh token/);
});

test('Windows account session reports protected storage instead of Keychain', async () => {
  const saved = [];
  const session = new NativeSession({
    platform: 'win32',
    store: {
      setRefreshToken: async (token) => { saved.push(token); },
      getRefreshToken: async () => 'refresh-1',
      deleteRefreshToken: async () => {},
    },
    baseUrl: 'https://gateway.example.test/api/v1',
    fetchImpl: async (url) => {
      if (url.pathname.endsWith('/auth/token')) return new Response(JSON.stringify({ isSuccess: true, data: {
        accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600,
      } }), { status: 200 });
      if (url.pathname.endsWith('/users/me')) return new Response(JSON.stringify({ isSuccess: true, data: {
        id: 'user-1', email: 'dev@example.test',
      } }), { status: 200 });
      if (url.pathname.endsWith('/auth/logout')) return new Response(JSON.stringify({ isSuccess: true, data: null }), { status: 200 });
      throw new Error('unexpected request');
    },
  });
  const profile = await session.connectWithCredentials({ email: 'dev@example.test', password: 'secret' });
  assert.equal(profile.sessionPersistence, 'windows_dpapi');
  assert.deepEqual(saved, ['refresh-1']);
  assert.deepEqual(await session.disconnect(), { status: 'disconnected', windowsProtectedStoreCleared: true, gatewayRevoked: true });
});

test('Windows native confirmation and file dialogs preserve cancel and preview boundaries', async () => {
  const calls = [];
  const windowsNative = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'open-file') return 'C:\\Users\\Dev\\picture.png';
    if (action === 'save-file') return 'C:\\Users\\Dev\\insights_2026-10-01_2026-10-02.csv';
    return null;
  };
  assert.equal(await confirmGatewayAction({ kind: 'send_sandbox_text', preview: {
    applicationId: 'app-1', phoneNumber: '+905551234567', testNumber: 'QA', message: 'Real message',
  } }, { platform: 'win32', windowsNative }), false);
  assert.equal(calls[0].action, 'confirm');
  assert.equal(calls[0].payload.value, 'Real message');
  assert.equal(await selectGatewayUploadFile(undefined, { platform: 'win32', windowsNative }), 'C:\\Users\\Dev\\picture.png');
  assert.equal(await selectGatewayCsvDestination('insights_2026-10-01_2026-10-02.csv', undefined, { platform: 'win32', windowsNative }),
    'C:\\Users\\Dev\\insights_2026-10-01_2026-10-02.csv');
  assert.equal(await showGatewaySecret({ label: 'New key', secret: 'private-key' }, { platform: 'win32', windowsNative }), false);
  assert.equal(calls.at(-1).payload.value, 'private-key');
});

test('bundled Windows helper uses masked input, read-only confirmation and per-user DPAPI', async () => {
  const script = await readFile(new URL('../scripts/windows-native.ps1', import.meta.url), 'utf8');
  assert.match(script, /UseSystemPasswordChar/);
  assert.match(script, /ReadOnly = \$true/);
  assert.match(script, /DataProtectionScope\]::CurrentUser/);
  assert.match(script, /OverwritePrompt = \$true/);
});
