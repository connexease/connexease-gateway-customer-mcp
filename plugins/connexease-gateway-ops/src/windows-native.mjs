import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';

const WINDOWS_HELPER = fileURLToPath(new URL('../scripts/windows-native.ps1', import.meta.url));
const ACTIONS = new Set(['prompt', 'confirm', 'open-file', 'save-file', 'token-read', 'token-write', 'token-delete']);
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Pass secrets only through pipes, never through argv, environment variables or project files. */
export function runWindowsNative(action, payload = {}, { spawnImpl = spawn, systemRoot = process.env.SystemRoot } = {}) {
  if (!ACTIONS.has(action)) throw new Error('Unknown Windows native action');
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('Windows system directory is unavailable');
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_HELPER, '-Action', action];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let size = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error('Windows native dialog or protected session store is unavailable'));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > MAX_OUTPUT_BYTES) {
        child.kill();
        fail();
      } else output += chunk;
    });
    // PowerShell errors can include secret-bearing input. Never return stderr to the AI client.
    child.stderr.resume();
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return fail();
      try {
        const response = JSON.parse(output.trim());
        if (response?.status === 'ok') {
          settled = true;
          resolve(response.value ?? null);
        } else if (response?.status === 'cancelled' || response?.status === 'missing') {
          settled = true;
          resolve(null);
        } else fail();
      } catch { fail(); }
    });
    child.stdin.on('error', fail);
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function promptWindowsAnswer(label, hidden = false, native = runWindowsNative) {
  const value = await native('prompt', { label, hidden });
  if (value === null) throw new Error('Gateway native prompt cancelled');
  if (typeof value !== 'string') throw new Error('Gateway native prompt returned an invalid answer');
  return value;
}
