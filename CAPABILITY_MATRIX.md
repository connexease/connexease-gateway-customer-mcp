# Gateway panel capability matrix (0.12.1)

Scope: the local Claude Code, Codex, and Gemini CLI packages run the same Connexease Gateway MCP server, which calls only existing API routes. Its tool inventory is not proof that every route is deployed in a particular environment. Automated HTTP-stub contract tests and MCP discovery run locally; account-specific writes below have not been executed against a live Gateway account in this version.

| Panel area | Plugin capability | Boundary |
| --- | --- | --- |
| Public documentation | Live, read-only answers with verified official links through the `ask` skill; optional docs-only packages remain | No Gateway login needed; documentation content does not authorize account actions. New-version installs are not yet end-to-end verified |
| Account | Sign in, sign out, register, change/reset password, phone-code verification, onboarding organization assignment, profile and organization reads | Passwords and codes use native macOS or Windows dialogs; signing out reports local Keychain or DPAPI-protected store cleanup and remote revocation separately |
| Applications | List/detail, WhatsApp and Instagram health, WhatsApp business profile, Instagram profile, rename, contact update, WhatsApp username and suggestions | Mutations check application ownership and require native approval |
| WhatsApp templates | Paginated list/detail, template library/search/filters/detail, create/update/delete, media upload via native file picker | Submission is not Meta approval; media handle is returned to Claude, but local file path is not an AI argument |
| Sandbox | List/add/rename/delete test numbers; preview/send text or supported approved template; webhook test | Real sends are never automatic and have no automatic retry; product/carousel template sends are blocked |
| Webhooks | Read status, URL/events update, one native-entered secret header update, delete, test, sandbox webhook test | Header values never enter AI arguments/results; server receives one allowlisted write after approval |
| API keys and organization secrets | List redacted metadata, create with one-time local disclosure, revoke application API keys | No raw key is returned to Claude; organization-secret deletion is not exposed by the current panel helper |
| Organization and billing | Organization contact, allowed origins add/delete, wallet balance, billing account read/upsert, card metadata, invoices, coupon validation | No full card number or payment credential is returned |
| Insights | Summary, messages, categories, cost, cost by app, breakup pagination, raw export rows and panel-format CSV save; one named Insight widget at a time with a terminal table and monochrome Unicode line/bar chart; two explicit date ranges compared on the same widget with absolute/percentage deltas | CSV destination uses a native save dialog; existing files are not overwritten. Apps Overview remains mock/Coming Soon in the panel |

## Not completed by a local API-only plugin

- **New WhatsApp or Instagram connection:** the panel's Meta Embedded Signup is a browser OAuth flow with user interaction and a short-lived code. Calling only the final `connect` API is not a safe substitute. A browser handoff and supported authorization design are needed; backend changes may also be needed for a distributable multi-user integration.
- **Payment method setup and wallet top-up:** the existing API can create a Stripe SetupIntent or PaymentIntent, but the user still must complete Stripe Elements / 3-D Secure in a browser. The plugin deliberately does not initiate or confirm a charge blindly. Coupon validation and billing reads are available.
- **Full template send coverage:** current sandbox API/request validation cannot safely provide catalog/product selections for single/multi-product and carousel templates. Those sends stay blocked. Template creation and update submission are available, subject to backend/Meta validation.
- **Cross-AI web chat installation:** these packages use a local stdio MCP server. ChatGPT/Gemini/Claude browser chat needs a hosted HTTPS MCP service with per-user OAuth; packaging the same local code is insufficient.
- **Live confidence:** registration, mutations, uploads, and payment-adjacent reads have local contract tests only. Verify against a dedicated staging account before promising production parity. Sandbox send success is Gateway acceptance, not delivery confirmation.
- **Windows acceptance:** Windows CI opens the real email, masked-password and confirmation dialogs and clicks them through UI Automation using synthetic values; DPAPI token storage also has a live Windows round-trip test. A real-account login, restart persistence, logout, file picker and CSV save still need human-operated Windows desktop acceptance before customer rollout.

The plugin does not bypass existing API authorization or invent backend endpoints. If a route returns 404/422 in staging or production, treat that as an environment/API gap, not as a reason to call an undocumented endpoint.
