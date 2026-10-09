import readline from 'node:readline/promises';
import { GatewayApiClient, DEFAULT_API_BASE_URL } from '../src/gateway-api.mjs';
import { loginWithPassword, MacKeychainStore, WindowsDpapiStore } from '../src/native-session.mjs';

async function hiddenInput(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('Run this command in an interactive terminal');
  }
  process.stdout.write(label);
  let value = '';
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      function onData(buffer) {
        for (const char of buffer.toString('utf8')) {
          if (char === '\r' || char === '\n') {
            process.stdin.off('data', onData);
            resolve(value);
            return;
          }
          if (char === '\u0003') {
            process.stdin.off('data', onData);
            reject(new Error('Login cancelled'));
            return;
          }
          if (char === '\u007f') value = value.slice(0, -1);
          else value += char;
        }
      }
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
  }
}

if (!['darwin', 'win32'].includes(process.platform)) {
  throw new Error('This local login command requires macOS or Windows');
}

process.stdout.write(`Connexease Gateway login: ${new URL(DEFAULT_API_BASE_URL).origin}\n`);
process.stdout.write('Credentials are entered in this terminal, never through an AI chat.\n');
const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
const email = (await prompt.question('Email: ')).trim();
prompt.close();
const password = await hiddenInput('Password (hidden): ');

try {
  const store = process.platform === 'win32' ? new WindowsDpapiStore() : new MacKeychainStore();
  const session = await loginWithPassword({ email, password });
  const gateway = new GatewayApiClient({
    accessTokenProvider: { getAccessToken: async () => session.accessToken },
  });
  const profile = await gateway.getMyProfile();
  await store.setRefreshToken(session.refreshToken);
  process.stdout.write(`Connected as ${profile.email}. Refresh token stored in ${process.platform === 'win32' ? 'Windows user-protected storage' : 'macOS Keychain'}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Login failed'}\n`);
  process.exitCode = 1;
}
