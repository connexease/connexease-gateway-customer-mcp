# Connexease Gateway Operations

This is a local macOS/Windows MCP plugin for account operations and public documentation questions in Claude Code, Codex, and Gemini CLI. Version: 0.12.1. It remains separate from the panel repository. See the repository [capability matrix](../../CAPABILITY_MATRIX.md) for feature status and remaining gaps.

Install the combined Claude plugin from this repository's marketplace:

```bash
claude plugin marketplace add connexease/connexease-gateway-customer-mcp
claude plugin install connexease-gateway-ops@connexease-gateway-customer-mcp
```

## Developer setup

Requires macOS or Windows with a visible desktop session, Node.js 20+, npm, and a supported local AI client. macOS additionally requires the system `/usr/bin/expect` utility; Windows uses built-in Windows PowerShell 5.1, Windows Forms, and DPAPI. From this directory:

```bash
npm ci
npm test
npm run probe
npm run build
node scripts/probe.mjs dist/server.mjs
```

Both probes check MCP discovery only; they send no Gateway request. `dist/server.mjs` is a committed single-file bundle so Codex and Gemini extension installs do not require a separate `npm ci`; rebuild it after source edits. To load the Claude checkout without publishing, launch `claude --plugin-dir /absolute/path/to/this/folder`. For marketplace installs, follow the repository README. The Claude `.mcp.json`, Codex `mcp.json`, and root Gemini extension all launch the same local stdio server using `node`.

Inside Claude Code, use `/connexease-gateway-ops:ask` for live public-doc questions without account login. For account operations, use `/connexease-gateway-ops:connect`, then `/connexease-gateway-ops:panel-ops` or `/connexease-gateway-ops:sandbox-ops`. The connect command opens native email and hidden-password dialogs, calls `POST /auth/token`, checks `GET /users/me`, and stores only the refresh token in the current user's macOS Keychain or Windows DPAPI-protected Local AppData when possible. The plugin never reads the panel browser cookie or asks for credentials in chat. If secure saving fails, it keeps the verified account in process memory and attempts to remove any older stored Gateway token. A failed cleanup is explicitly reported. `disconnect_gateway_account` attempts both local token deletion and `POST /auth/logout`, reporting each outcome separately.

For a single Insight page table or chart, use `/connexease-gateway-ops:insights`. It calls only the report underlying the named widget and returns a preformatted terminal table. Time-series widgets include a monochrome Unicode/braille line chart for the selected metric; category widgets include a bar chart. The chart keeps readable numeric axes and date endpoints without ANSI colors, and comparison charts share one y-axis scale. This is not the panel's interactive browser chart. The panel's Apps Overview widget still has mock/Coming Soon data, so the plugin reports it as unavailable rather than fabricating account data.

For a comparison, ask the same skill to compare one widget across two explicit start/end date ranges. It returns A and B totals, B-minus-A absolute and percentage differences, and two shared-scale text line charts for time series. Percentages are undefined when A is zero. The tool warns when date ranges overlap or differ in duration; paginated breakup data must be fully loaded before a result is shown.

## Safety model

Reads use the signed-in user's API session. Application-specific tools check that the application is visible to that account. Account/API writes use explicit tool arguments for non-secret fields, an exact native macOS or Windows confirmation, and a fresh read before the one write request. The client skills ask for chat approval first; the native dialog is the independently enforced approval boundary. Cancelling it makes no write. There is no automatic retry after a write timeout or server error, because the outcome can be unknown. Insights CSV export is a local file write approved through a native save dialog; it will not overwrite an existing file.

Passwords, verification codes, webhook header values, API keys and organization secret values are never returned to the AI client. Passwords/codes and webhook values are entered in hidden native dialogs; newly created keys are displayed once in a local native dialog. Metadata reads omit raw keys and webhook headers. Local file upload uses a native picker so the AI client never supplies a filesystem path. The selected file's identity is checked again before upload.

Sandbox template sends use the Gateway template's internal UUID and revalidate approved status, components, parameters and the app-owned test number immediately before POST. Product and carousel sends are blocked when the current sandbox request cannot represent them safely. Gateway acceptance is not a WhatsApp delivery receipt. Do not put secret parameter values in a template preview.

## Validation limits

The automated suite uses isolated HTTP stubs and does not contact a live account. Authentication and the legacy application-list fallback were manually tested in earlier versions, but the expanded operations require dedicated staging verification. Windows CI exercises the real native email, masked-password and confirmation dialogs with synthetic UI Automation and performs a real DPAPI round-trip; it does not log into Gateway or replace a human-operated desktop acceptance test. Existing routes and request shapes were compared to the panel helpers and locally available core-service source; deployed environments may differ.

The bundled docs skill reads only the live official public documentation and cannot authorize an account mutation. The optional docs-only plugin and legacy Gemini CLI skill in this repository do not expose the operations MCP server; the new root Gemini extension does. Account operations are not a ChatGPT, Gemini, or Claude web-chat connector; a hosted integration with per-user authorization is separate work.
