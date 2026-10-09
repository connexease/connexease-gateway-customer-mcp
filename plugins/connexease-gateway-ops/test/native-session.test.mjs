import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { loginWithPassword, MacKeychainStore, NativeSession, promptForGatewayCredentials, promptForGatewayOtp, promptForGatewayRegistration, promptForNewPassword, promptForPasswordChange, runSecurity } from '../src/native-session.mjs';

const baseUrl = 'https://gateway.example.test/api/v1';

test('native login calls the existing core endpoint without exposing credentials in errors', async () => {
  const calls = [];
  const result = await loginWithPassword({
    email: 'dev@example.test', password: 'sample-password', baseUrl,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ isSuccess: true, data: {
        accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600,
      } }), { status: 200 });
    },
  });
  assert.equal(result.accessToken, 'access-1');
  assert.equal(result.refreshToken, 'refresh-1');
  assert.equal(calls[0].url, 'https://gateway.example.test/api/v1/auth/token');
  assert.equal(calls[0].options.headers['X-Client-Type'], 'native');
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: 'dev@example.test', password: 'sample-password' });
  assert.equal(calls[0].options.redirect, 'error');
});

test('rejects non-HTTPS authentication URL', async () => {
  await assert.rejects(loginWithPassword({
    email: 'dev@example.test', password: 'password', baseUrl: 'http://gateway.example.test/api/v1',
  }), /HTTPS/);
});

test('refreshes once and rotates the Keychain token before returning access', async () => {
  const saved = [];
  const store = {
    getRefreshToken: async () => 'refresh-1',
    setRefreshToken: async (token) => { saved.push(token); },
  };
  let calls = 0;
  const session = new NativeSession({
    store, baseUrl,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(String(url), 'https://gateway.example.test/api/v1/auth/refresh');
      assert.deepEqual(JSON.parse(options.body), { refreshToken: 'refresh-1' });
      return new Response(JSON.stringify({ isSuccess: true, data: {
        accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 3600,
      } }), { status: 200 });
    },
  });
  const [first, second] = await Promise.all([session.getAccessToken(), session.getAccessToken()]);
  assert.equal(first, 'access-2');
  assert.equal(second, 'access-2');
  assert.deepEqual(saved, ['refresh-2']);
  assert.equal(calls, 1);
  assert.equal(await session.getAccessToken(), 'access-2');
  assert.equal(calls, 1);
});

test('Keychain write sends secret on stdin, never in process arguments', async () => {
  let commandArgs;
  let secretInput;
  const store = new MacKeychainStore({ execute: async (args, input) => {
    commandArgs = args;
    secretInput = input;
  } });
  await store.setRefreshToken('refresh-secret');
  assert.equal(commandArgs.at(-1), '-w');
  assert.equal(commandArgs.includes('refresh-secret'), false);
  assert.equal(secretInput, 'refresh-secret');
});

test('Keychain write uses a silent pseudo-terminal helper without exposing token in argv', async () => {
  let command;
  let args;
  let input = '';
  const spawnImpl = (name, commandArgs) => {
    command = name;
    args = commandArgs;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, done) { input += chunk.toString(); done(); },
      final(done) { queueMicrotask(() => { child.stdout.write('refresh-secret'); child.emit('close', 0); }); done(); },
    });
    return child;
  };
  const output = await runSecurity(['add-generic-password', '-a', 'default', '-s', 'test-service', '-U', '-w'], 'refresh-secret', spawnImpl);
  assert.equal(command, '/usr/bin/expect');
  assert.match(args[0], /keychain-write\.exp$/);
  assert.equal(args.includes('refresh-secret'), false);
  assert.equal(input, 'refresh-secret\n');
  assert.equal(output, '');
});

test('native dialogs collect credentials without including them in script arguments', async () => {
  const scripts = [];
  const credentials = await promptForGatewayCredentials({ execute: async (script) => {
    scripts.push(script);
    return scripts.length === 1 ? 'dev@example.test' : 'private-password';
  } });
  assert.deepEqual(credentials, { email: 'dev@example.test', password: 'private-password' });
  assert.match(scripts[1], /hiddenAnswer: true/);
  assert.doesNotMatch(scripts.join(' '), /dev@example\.test|private-password/);
});

test('registration and password-change dialogs hide passwords and keep them out of scripts', async () => {
  const registrationScripts = [];
  const registrationAnswers = ['Ada', 'Lovelace', 'ada@example.test', 'new-secret', 'new-secret'];
  const registration = await promptForGatewayRegistration({ execute: async (script) => {
    registrationScripts.push(script);
    return registrationAnswers[registrationScripts.length - 1];
  } });
  assert.deepEqual(registration, { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', password: 'new-secret' });
  assert.match(registrationScripts[3], /hiddenAnswer: true/);
  assert.match(registrationScripts[4], /hiddenAnswer: true/);
  assert.doesNotMatch(registrationScripts.join(' '), /new-secret/);

  const passwordScripts = [];
  const answers = ['old-secret', 'replacement-secret', 'replacement-secret'];
  const change = await promptForPasswordChange({ execute: async (script) => {
    passwordScripts.push(script);
    return answers[passwordScripts.length - 1];
  } });
  assert.deepEqual(change, { currentPassword: 'old-secret', newPassword: 'replacement-secret', confirmPassword: 'replacement-secret' });
  assert.equal(passwordScripts.every((script) => script.includes('hiddenAnswer: true')), true);
  assert.doesNotMatch(passwordScripts.join(' '), /old-secret|replacement-secret/);
});

test('OTP and reset-password dialogs keep code and new password out of scripts', async () => {
  const otpScripts = [];
  const code = await promptForGatewayOtp({ execute: async (script) => { otpScripts.push(script); return '123456'; } });
  assert.equal(code, '123456');
  assert.match(otpScripts[0], /hiddenAnswer: true/);
  assert.doesNotMatch(otpScripts[0], /123456/);
  const scripts = [];
  const passwords = await promptForNewPassword({ execute: async (script) => { scripts.push(script); return 'new-secret'; } });
  assert.deepEqual(passwords, { newPassword: 'new-secret', confirmPassword: 'new-secret' });
  assert.equal(scripts.every((script) => script.includes('hiddenAnswer: true')), true);
  assert.doesNotMatch(scripts.join(' '), /new-secret/);
});

test('in-session connection verifies the profile, saves refresh token, and uses new access token', async () => {
  const saved = [];
  const calls = [];
  const session = new NativeSession({
    platform: 'darwin',
    baseUrl,
    store: { setRefreshToken: async (token) => { saved.push(token); }, getRefreshToken: async () => { throw new Error('should not refresh'); } },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (url.pathname.endsWith('/auth/token')) return new Response(JSON.stringify({ isSuccess: true, data: {
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600,
      } }), { status: 200 });
      if (url.pathname.endsWith('/users/me')) return new Response(JSON.stringify({ isSuccess: true, data: {
        id: 'user-1', email: 'dev@example.test', state: 'ACTIVE',
      } }), { status: 200 });
      throw new Error('unexpected request');
    },
  });
  const profile = await session.connectWithCredentials({ email: 'dev@example.test', password: 'private-password' });
  assert.deepEqual(profile, { id: 'user-1', email: 'dev@example.test', state: 'ACTIVE', sessionPersistence: 'keychain' });
  assert.deepEqual(saved, ['new-refresh']);
  assert.equal(await session.getAccessToken(), 'new-access');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer new-access');
});

test('failed profile verification never persists refresh token', async () => {
  let writes = 0;
  const session = new NativeSession({
    baseUrl,
    store: { setRefreshToken: async () => { writes += 1; } },
    fetchImpl: async (url) => url.pathname.endsWith('/auth/token')
      ? new Response(JSON.stringify({ isSuccess: true, data: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 } }), { status: 200 })
      : new Response(JSON.stringify({ isSuccess: false }), { status: 401 }),
  });
  await assert.rejects(session.connectWithCredentials({ email: 'dev@example.test', password: 'private-password' }), /session expired/);
  assert.equal(writes, 0);
});

test('Keychain failure keeps the verified account usable in memory, including token refresh', async () => {
  const calls = [];
  const session = new NativeSession({
    baseUrl,
    store: {
      getRefreshToken: async () => { throw new Error('must use in-memory token'); },
      setRefreshToken: async () => { throw new Error('Keychain unavailable'); },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (url.pathname.endsWith('/auth/token')) return new Response(JSON.stringify({ isSuccess: true, data: {
        accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 0,
      } }), { status: 200 });
      if (url.pathname.endsWith('/users/me')) return new Response(JSON.stringify({ isSuccess: true, data: {
        id: 'user-1', email: 'dev@example.test', state: 'ACTIVE',
      } }), { status: 200 });
      if (url.pathname.endsWith('/auth/refresh')) return new Response(JSON.stringify({ isSuccess: true, data: {
        accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 3600,
      } }), { status: 200 });
      throw new Error('unexpected request');
    },
  });
  const profile = await session.connectWithCredentials({ email: 'dev@example.test', password: 'private-password' });
  assert.equal(profile.sessionPersistence, 'memory_only');
  assert.equal(await session.getAccessToken(), 'access-2');
  assert.deepEqual(JSON.parse(calls[2].options.body), { refreshToken: 'refresh-1' });
});

test('failed Keychain overwrite clears an old account token before reporting memory-only login', async () => {
  let clears = 0;
  const session = new NativeSession({
    baseUrl,
    store: {
      setRefreshToken: async () => { throw new Error('write failed'); },
      deleteRefreshToken: async () => { clears += 1; },
    },
    fetchImpl: async (url) => url.pathname.endsWith('/auth/token')
      ? new Response(JSON.stringify({ isSuccess: true, data: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 } }), { status: 200 })
      : new Response(JSON.stringify({ isSuccess: true, data: { id: 'user-2', email: 'new@example.test' } }), { status: 200 }),
  });
  const profile = await session.connectWithCredentials({ email: 'new@example.test', password: 'new-password' });
  assert.equal(profile.sessionPersistence, 'memory_only');
  assert.equal(clears, 1);
});

test('disconnect clears local session and reports remote revocation separately', async () => {
  const calls = [];
  let clears = 0;
  const session = new NativeSession({
    platform: 'darwin',
    baseUrl,
    store: {
      setRefreshToken: async () => {},
      deleteRefreshToken: async () => { clears += 1; },
      getRefreshToken: async () => { throw new Error('Gateway login required'); },
    },
    fetchImpl: async (url, options) => {
      calls.push({ path: url.pathname, options });
      if (url.pathname.endsWith('/auth/token')) return new Response(JSON.stringify({ isSuccess: true, data: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 } }), { status: 200 });
      if (url.pathname.endsWith('/users/me')) return new Response(JSON.stringify({ isSuccess: true, data: { id: 'user-1', email: 'dev@example.test' } }), { status: 200 });
      if (url.pathname.endsWith('/auth/logout')) return new Response(JSON.stringify({ isSuccess: true, data: null }), { status: 200 });
      throw new Error('unexpected request');
    },
  });
  await session.connectWithCredentials({ email: 'dev@example.test', password: 'private-password' });
  assert.deepEqual(await session.disconnect(), { status: 'disconnected', keychainCleared: true, gatewayRevoked: true });
  assert.equal(clears, 1);
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer access');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { refreshToken: 'refresh' });
  await assert.rejects(session.getAccessToken(), /login required/i);
});

test('registration and password change adopt newly issued tokens without exposing them to tools', async () => {
  const calls = [];
  const saved = [];
  const session = new NativeSession({
    baseUrl,
    store: { setRefreshToken: async (token) => { saved.push(token); }, getRefreshToken: async () => { throw new Error('unexpected refresh'); } },
    fetchImpl: async (url, options) => {
      calls.push({ path: url.pathname, options });
      if (url.pathname.endsWith('/users/register')) return new Response(JSON.stringify({ isSuccess: true, data: { accessToken: 'registration-access', refreshToken: 'registration-refresh', expiresIn: 3600 } }), { status: 200 });
      if (url.pathname.endsWith('/auth/password/change')) return new Response(JSON.stringify({ isSuccess: true, data: { accessToken: 'changed-access', refreshToken: 'changed-refresh', expiresIn: 3600 } }), { status: 200 });
      if (url.pathname.endsWith('/auth/organizations/assign')) return new Response(JSON.stringify({ isSuccess: true, data: { accessToken: 'assigned-access', refreshToken: 'assigned-refresh', expiresIn: 3600 } }), { status: 200 });
      if (url.pathname.endsWith('/users/me')) return new Response(JSON.stringify({ isSuccess: true, data: { id: 'user-1', email: 'ada@example.test', state: 'ACTIVE' } }), { status: 200 });
      throw new Error(`unexpected ${url.pathname}`);
    },
  });
  const registered = await session.registerWithCredentials({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', password: 'new-secret' });
  assert.equal(registered.email, 'ada@example.test');
  assert.equal(await session.getAccessToken(), 'registration-access');
  const changed = await session.changePassword({ currentPassword: 'new-secret', newPassword: 'replacement-secret', confirmPassword: 'replacement-secret' });
  assert.equal(changed.id, 'user-1');
  assert.equal(await session.getAccessToken(), 'changed-access');
  assert.equal(calls.find(({ path }) => path.endsWith('/auth/password/change')).options.headers.Authorization, 'Bearer registration-access');
  const assigned = await session.assignOrganization({ organizationName: 'Example', organizationWebsite: 'https://example.test', businessRole: 'developer', accountType: 'business' });
  assert.equal(assigned.id, 'user-1');
  assert.equal(await session.getAccessToken(), 'assigned-access');
  assert.equal(calls.find(({ path }) => path.endsWith('/auth/organizations/assign')).options.headers.Authorization, 'Bearer changed-access');
  assert.deepEqual(saved, ['registration-refresh', 'changed-refresh', 'assigned-refresh']);
});

test('password reset keeps the one-time token inside the native session', async () => {
  const calls = [];
  const session = new NativeSession({
    baseUrl,
    store: { getRefreshToken: async () => { throw new Error('not needed'); } },
    fetchImpl: async (url, options) => {
      calls.push({ path: url.pathname, body: JSON.parse(options.body) });
      if (url.pathname.endsWith('/auth/two-factor/send')) return new Response(JSON.stringify({ isSuccess: true, data: { status: 'SENT' } }), { status: 200 });
      if (url.pathname.endsWith('/auth/two-factor/verify')) return new Response(JSON.stringify({ isSuccess: true, data: { passwordResetToken: 'private-reset-token', expiresAt: '2026-10-06T14:00:00Z' } }), { status: 200 });
      if (url.pathname.endsWith('/auth/password/reset')) return new Response(JSON.stringify({ isSuccess: true, data: null }), { status: 200 });
      throw new Error(`unexpected ${url.pathname}`);
    },
  });
  await session.startPasswordReset('+15555550101');
  const verified = await session.verifyPasswordResetCode('123456');
  assert.equal(verified.status, 'verified');
  assert.doesNotMatch(JSON.stringify(verified), /private-reset-token/);
  assert.deepEqual(await session.finishPasswordReset({ newPassword: 'new-secret', confirmPassword: 'new-secret' }), { status: 'password_reset', signInRequired: true });
  assert.equal(calls[2].body.passwordResetToken, 'private-reset-token');
  await assert.rejects(session.finishPasswordReset({ newPassword: 'new-secret', confirmPassword: 'new-secret' }), /Verify the password reset code/);
});
