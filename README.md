# Connexease Gateway Customer MCP

This Connexease-owned repository combines Gateway account operations and the public-documentation assistant. The `connexease-gateway-ops` package includes both: documentation questions need no Gateway login, while account operations use the user's own Gateway account. Operations version: 0.12.1. The marketplace and Gemini extension are named `connexease-gateway-customer-mcp`; the existing operations skill names stay `connexease-gateway-ops`.

The GitHub repository is currently private. Installing from its URL requires GitHub access to the Connexease repository; public customer distribution is not available until repository access or a separate distribution method is arranged.

## Install in Claude Code

Requires macOS or Windows with a visible desktop session, Node.js 20+, npm, and Claude Code. Authentication uses native dialogs. The refresh token is stored in the current user's macOS Keychain or Windows DPAPI-protected Local AppData.

```bash
claude plugin marketplace add connexease/connexease-gateway-customer-mcp
claude plugin install connexease-gateway-ops@connexease-gateway-customer-mcp
claude
```

For a documentation question, ask normally or use `/connexease-gateway-ops:ask`. It reads the live public Gateway documentation and cites only pages it verifies. To use account operations, run `/connexease-gateway-ops:connect`. The password is entered in a hidden local dialog, not a chat prompt. If protected session persistence fails, the plugin reports that the session is memory-only; if it cannot remove an older stored token, it warns that the older account may return after restart.

Examples:

```text
Gateway sandbox'ta gerçek mesaj göndermeden API isteğini nasıl test ederim? Doküman linkini de ver.
Gateway hesabımdaki uygulamaları ve WhatsApp sağlık durumlarını göster.
Bu uygulamanın webhook durumunu ve onaylı template'lerini listele.
Test numaralarını göster; seçtiğim numaraya mesajı göndermeden önce önizlet.
```

The first example is a read-only public-documentation question. Account-specific reads and writes use the separate scoped tools and existing approval rules. A documentation page is never permission to send a message or change an account.

`/connexease-gateway-ops:panel-ops` explains available account, application, template, webhook, billing, insight, and security operations. `/connexease-gateway-ops:sandbox-ops` walks through a real sandbox send. Writes require explicit approval in chat and a second native macOS or Windows confirmation. Secrets are entered or displayed locally, never passed to Claude in tool arguments or responses. A successful sandbox API response means Gateway accepted the request, not that WhatsApp delivered it.

The `/connexease-gateway-ops:insights` skill maps a named Insight page widget to one API report. It prints only that widget's table, plus a smooth monochrome Unicode line chart for time-series data or a bar chart for category data. The line chart uses braille dots, readable axes and date labels without terminal color codes. `Apps Overview` remains unavailable because the panel still displays mock/Coming Soon data there.

The comparison workflow accepts two explicit date ranges for one Insight widget. It displays period values, B-minus-A differences and percentage changes, with shared-scale line charts for time series. Paginated breakup comparisons load every page or fail rather than reporting partial totals.

## Codex and Gemini CLI

For the legacy `/connexease-gateway-docs:ask` command, this marketplace also contains an optional read-only `connexease-gateway-docs` plugin. New Claude users need only `connexease-gateway-ops`; installing both creates two documentation commands. The earlier [personal operations repository](https://github.com/oguzhannsaritas/gateway-connexease-ai-plugin) and [documentation repository](https://github.com/oguzhannsaritas/gateway-ai-plugin) remain untouched. Existing installations do not migrate or uninstall automatically. If both marketplaces are installed, choose one operations plugin to avoid duplicate skills and tools.

Codex CLI/desktop can install the same operations plugin from this repository's portable marketplace. The optional `connexease-gateway-docs` package remains read-only:

```bash
codex plugin marketplace add connexease/connexease-gateway-customer-mcp
codex plugin add connexease-gateway-ops@connexease-gateway-customer-mcp
codex
```

In Codex, ask naturally (for example, “Gateway hesabıma bağlan ve uygulamalarımı göster”) or invoke an installed skill by name through the Codex skill picker. The operations package supplies `ask`, `connect`, `panel-ops`, `sandbox-ops`, and `insights` skills and the `gateway-account` MCP tools; it is not limited to documentation questions. Codex does not use Claude's `/connexease-gateway-ops:...` command syntax.

For Gemini CLI, install the repository as an extension, not the older docs-only skill:

```bash
gemini extensions install https://github.com/connexease/connexease-gateway-customer-mcp.git
gemini
```

Gemini CLI can answer natural-language requests or use `/connexease-gateway:ask`, `/connexease-gateway:connect`, `/connexease-gateway:panel-ops`, `/connexease-gateway:sandbox-ops`, and `/connexease-gateway:insights`. The extension bundles the same local account server and skills. The operations flow requires macOS or Windows, Node.js 20+, a visible desktop session, the user's Gateway credentials entered locally, explicit chat approval for writes, and a separate native confirmation.

These install paths still need independent end-to-end installation and account testing. ChatGPT web and Gemini web/app do not automatically load local Git plugins; see [distribution status](DISTRIBUTION.md) and the [manual Gemini chat draft](guides/gemini-chat-instructions.md).

For updates:

```bash
claude plugin marketplace update connexease-gateway-customer-mcp
claude plugin update connexease-gateway-ops@connexease-gateway-customer-mcp
```

Restart Claude Code after updating. See [capability matrix](CAPABILITY_MATRIX.md) for supported operations and the separately reported gaps, and [implementation details](plugins/connexease-gateway-ops/README.md) for local validation and security boundaries.

For Codex, refresh the official marketplace with `codex plugin marketplace upgrade connexease-gateway-customer-mcp`, then check `codex plugin list` and start a new Codex session. If the marketplace has not been added yet, use the installation commands above.

The account-operation tools remain a local macOS/Windows integration for Claude Code, Codex, and Gemini CLI, not a ChatGPT/Gemini/Claude web-chat connector. Those surfaces need a separately designed hosted integration and per-user authorization for account actions. Windows CI exercises the real native email, masked-password and confirmation dialogs with synthetic UI Automation, as well as DPAPI token storage. A real Gateway account login and a human-operated Windows desktop acceptance test remain separate.
