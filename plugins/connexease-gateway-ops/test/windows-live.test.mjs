import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runWindowsNative } from '../src/windows-native.mjs';

test('Windows PowerShell helper round-trips a DPAPI-protected token', { skip: process.platform !== 'win32' }, async () => {
  const isolatedAppData = await mkdtemp(join(tmpdir(), 'gateway-ai-windows-test-'));
  const spawnInIsolatedAppData = (command, args, options) => spawn(command, args, {
    ...options,
    env: { ...process.env, LOCALAPPDATA: isolatedAppData },
  });
  const native = (action, payload) => runWindowsNative(action, payload, { spawnImpl: spawnInIsolatedAppData });

  try {
    assert.equal(await native('token-read'), null);
    assert.equal(await native('token-write', { token: 'test-only-refresh-token' }), null);
    assert.equal(await native('token-read'), 'test-only-refresh-token');

    const protectedFile = await readFile(join(isolatedAppData, 'Connexease', 'GatewayAI', 'refresh.dpapi'));
    assert.equal(protectedFile.includes(Buffer.from('test-only-refresh-token')), false);

    assert.equal(await native('token-delete'), null);
    assert.equal(await native('token-read'), null);
  } finally {
    await rm(isolatedAppData, { recursive: true, force: true });
  }
});
