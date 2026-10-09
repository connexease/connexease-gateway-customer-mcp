# Distribution and verification status

This Connexease-owned repository contains the local operations server and public-documentation skills in version 0.11.0. The earlier personal `gateway-connexease-ai-plugin` and `gateway-ai-plugin` repositories are not changed or removed. Existing installations of their marketplaces are not migrated automatically.

The Connexease repository is currently **private**. The GitHub install commands require repository access and are not yet a public customer distribution path. No repository visibility change is performed by this code release.

| Surface | This repository provides | Verification boundary |
| --- | --- | --- |
| Claude Code | One `connexease-gateway-ops` installation with `/connexease-gateway-ops:ask` and account tools; optional legacy-name docs-only plugin | Local manifest validation and tests verify packaging. New-version live docs answer and account flow still need manual testing |
| Codex CLI / desktop | Portable `connexease-gateway-ops` plugin with the same bundled local MCP server and five skills; optional docs-only plugin | Static package checks and local MCP probe only. Marketplace install, native login, and live account operations still need manual testing |
| ChatGPT web | No automatic import from the local Git marketplace | Public/workspace distribution is a separate submission or publication process |
| Gemini CLI | Root `gemini-extension.json` with the same bundled local MCP server, five skills, and five slash commands; old docs-only skill remains optional | Static package checks and local MCP probe only. Extension install, native login, and live account operations still need manual testing; an earlier machine's OAuth returned `UNSUPPORTED_CLIENT` |
| Gemini web/app | Manual documentation-skill draft | No verified universal install link and no account-operation tools |

The documentation assistants need access to `docs.gateway.connexease.com` and a live web/URL-reading tool for current answers. Packaging does not guarantee the model opens or cites the correct page. Account tools are scoped separately and require the user's own account and the native confirmation flow for writes. The CLI integrations require macOS with visible dialogs and Node.js 20+. A GitHub push alone does not submit this plugin to any public AI plugin directory.
