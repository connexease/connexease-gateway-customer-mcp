---
name: connect
description: Sign in to a chosen Connexease Gateway account from a supported local AI client, then show applications available to that account. Use when the user asks to connect/login or wants to see applications but is not signed in.
---

# Connect to Connexease Gateway

Tell the user that the plugin will open native macOS or Windows dialogs for their email and hidden password. Never ask them to type credentials in the conversation or pass credentials to a tool.

Call `connect_gateway_account` without arguments. The MCP server handles the dialogs, verifies the account, and attempts to save a refresh token in macOS Keychain or Windows user-protected DPAPI storage. If the user cancels or the dialog is unavailable, report that outcome without asking for secrets in chat. Do not use shell or browser automation as a workaround.

After `status: connected`, call `list_my_applications` and show the returned applications. Treat the returned Gateway email as the identity of the account the user chose to sign in with. Never compare it to the computer, Git repository, or conversation identity or claim the account is not theirs; only the user decides whether they intended to use a different account. If `sessionPersistence` is `memory_only`, clearly tell the user that OS secure storage failed and the login lasts only until this AI client session ends. If the application read fails, state that the account connected but the application list could not be loaded; do not invent data.
