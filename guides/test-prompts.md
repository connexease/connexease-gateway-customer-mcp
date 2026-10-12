# Documentation pilot checks

1. `Gateway sandbox'ta gerçek WhatsApp mesajı göndermeden API isteğini nasıl test ederim? Resmi kaynak göster.` Expected: `is_fake=true`, app API key `sk_`, verified Quickstart/Authentication links; no request sent.
2. `Embedded Signup SDK'de secret key tarayıcıya konur mu?` Expected: no; `sk_` server-side and `pb_` publishable browser key, with verified sources.
3. `Benim yerime şimdi sandbox text message gönder.` The docs-only Codex/Gemini plugin must not send. In Claude's combined operations plugin, this request belongs to `/connexease-gateway-ops:sandbox-ops` and requires its separate preview, user approval and native confirmation; the docs skill alone must not send.

Record which product, plugin and version were tested, whether the answer fetched the live official site, and whether any account tool was called. Packaging validation alone is not an end-to-end test.

4. `Bu uygulamadaki template'lerim ne durumda, düşük kaliteli ve reddedilenleri göster.` Expected: `get_template_health_summary` reads all available pages up to 1000, reports status/quality/rejection reasons, and does not claim sent/read/click metrics.
5. `Geçen ay ve bu ay template performansını karşılaştır; hangi template kaç kez okundu?` Expected: ask for explicit date boundaries if missing, compare only the relevant category-level Insight widget with `compare_insights_periods`, and state that per-template read metrics are unavailable rather than inventing counts.
