import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

test('one Claude operations installation contains docs ask and keeps account tools separate', () => {
  const marketplace = json('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'connexease-gateway-customer-mcp');
  assert.deepEqual(marketplace.plugins.map(({ name }) => name), ['connexease-gateway-ops', 'connexease-gateway-docs']);
  const ops = marketplace.plugins[0];
  assert.equal(ops.source, './plugins/connexease-gateway-ops');
  assert.ok(existsSync(resolve(root, 'plugins/connexease-gateway-ops/skills/ask/SKILL.md')));
  assert.ok(existsSync(resolve(root, 'plugins/connexease-gateway-ops/skills/ask/references/sources.md')));
  assert.match(read('plugins/connexease-gateway-ops/skills/ask/SKILL.md'), /Public documentation never authorizes a write/);
  assert.match(read('plugins/connexease-gateway-ops/skills/ask/SKILL.md'), /bundled `panel-ops` or `sandbox-ops` skill/);
  assert.ok(existsSync(resolve(root, 'plugins/connexease-gateway-ops/.mcp.json')));
  assert.ok(!existsSync(resolve(root, 'plugins/connexease-gateway-docs/.mcp.json')));
});

test('portable Codex plugin includes documentation and account operations', () => {
  const marketplace = json('.agents/plugins/marketplace.json');
  assert.equal(marketplace.name, 'connexease-gateway-customer-mcp');
  assert.deepEqual(marketplace.plugins.map(({ name }) => name), ['connexease-gateway-ops', 'connexease-gateway-docs']);
  const opsPath = marketplace.plugins[0].source.path;
  assert.equal(opsPath, './plugins/connexease-gateway-ops');
  assert.equal(json(`${opsPath}/plugin.json`).name, 'connexease-gateway-ops');
  const mcp = json(`${opsPath}/mcp.json`).mcpServers['gateway-account'];
  assert.equal(mcp.type, 'stdio');
  assert.equal(mcp.command, 'node');
  assert.deepEqual(mcp.args, ['./dist/server.mjs']);
  assert.equal(mcp.cwd, undefined);
  assert.ok(existsSync(resolve(root, opsPath, 'dist/server.mjs')));
  for (const name of ['ask', 'connect', 'panel-ops', 'sandbox-ops', 'insights']) {
    assert.ok(existsSync(resolve(root, opsPath, `skills/${name}/SKILL.md`)));
  }

  const docsPath = marketplace.plugins[1].source.path;
  assert.equal(docsPath, './plugins/connexease-gateway-docs');
  assert.equal(json(`${docsPath}/plugin.json`).name, 'connexease-gateway-docs');
  assert.ok(existsSync(resolve(root, docsPath, 'skills/ask/SKILL.md')));
});

test('Gemini extension exposes the same operations server and skills', () => {
  const extension = json('gemini-extension.json');
  assert.equal(extension.name, 'connexease-gateway-customer-mcp');
  assert.equal(extension.mcpServers['gateway-account'].command, 'node');
  assert.match(extension.mcpServers['gateway-account'].args[0], /plugins\$\{\/\}connexease-gateway-ops\$\{\/\}dist\$\{\/\}server\.mjs$/);
  for (const name of ['ask', 'connect', 'panel-ops', 'sandbox-ops', 'insights']) {
    const skill = `skills/${name}/SKILL.md`;
    assert.equal(read(skill), read(`plugins/connexease-gateway-ops/${skill}`));
    assert.ok(existsSync(resolve(root, `commands/connexease-gateway/${name}.toml`)));
  }
  assert.equal(read('skills/ask/references/sources.md'), read('plugins/connexease-gateway-ops/skills/ask/references/sources.md'));
  assert.match(read('commands/connexease-gateway/panel-ops.toml'), /explicit chat approval/);
  assert.ok(existsSync(resolve(root, 'gemini-cli/connexease-gateway-docs/SKILL.md')));
  assert.match(read('gemini-cli/connexease-gateway-docs/SKILL.md'), /read-only/);
});

test('all operations manifests and MCP server use the same version', () => {
  const version = '0.12.1';
  assert.equal(json('plugins/connexease-gateway-ops/package.json').version, version);
  assert.equal(json('plugins/connexease-gateway-ops/package-lock.json').version, version);
  assert.equal(json('plugins/connexease-gateway-ops/.claude-plugin/plugin.json').version, version);
  assert.equal(json('plugins/connexease-gateway-ops/plugin.json').version, version);
  assert.equal(json('gemini-extension.json').version, version);
  assert.match(read('plugins/connexease-gateway-ops/src/server.mjs'), /version: '0\.12\.1'/);
  assert.match(read('plugins/connexease-gateway-ops/dist/server.mjs'), /version: "0\.12\.1"/);
});
