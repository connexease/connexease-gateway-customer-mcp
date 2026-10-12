---
name: insights
description: Show one Connexease Gateway Insight table/chart, compare the same widget across two date ranges, or summarize broad WhatsApp template performance in a local AI terminal.
---

# One Insight widget at a time

Use the bundled `gateway-account` MCP tools. If sign-in is required, use the `connect` skill and its native-dialog login tool. When the user names **one** Insight page table or chart, call `get_insights_view` exactly once for that widget. Do not fetch all Insight reports, call `get_insights_export_rows`, or show neighboring cards merely because they share an API response. If the name is unclear, use `list_insights_views` and ask the user which one they mean.

Map the panel labels to `view`:

- `Mesaj Dağılımı` / `Messages Breakup` → `messagesBreakup`
- `Şablon Dağılımı` / `Template Breakup` → `templateBreakup`
- `Mesajlar` / `Messages` (time-series line chart) → `messagesOverTime`
- `Kategoriye Göre Mesajlar` / `Messages by Category` → `messagesByCategory`
- `Zaman İçinde Mesajlaşma Maliyeti` / `Messaging Cost Over Time` → `messagingCostOverTime`
- `Zaman İçinde Mesaj Sayısı` / `Messaging Count Over Time` → `messagingCountOverTime`
- `Özet` / `Summary` → `summary`
- `Uygulama Genel Bakışı` / `Apps Overview` → `appsOverview`; this panel widget is still mock/Coming Soon, so the tool does **not** fetch or invent real data.

Pass the requested date range, application, granularity and metric only when specified. If no date range is given, say the Gateway default applies. For breakup tables, `pageNumber`/`pageSize` select only that table's page; any line chart is based on exactly those returned rows. For other time-series widgets, the default granularity is daily, as in the panel. The `metric` parameter selects a single plotted series; the table still shows all columns of the **same** widget. If metric is omitted, the tool picks the primary series.

Show the tool's `terminalDisplay` verbatim in a monospace code block. It already contains the selected table and a monochrome Unicode line chart for time-series data or a bar chart for category data. Do not render another table/chart from the structured rows unless the user asks. Do not call `get_insights_report` to supplement the selected widget. Never imply that the terminal plot is the panel's interactive browser chart or that unavailable mock data is live.

## Compare two periods

When the user asks how one table/chart changed between two date ranges, use `compare_insights_periods` for that same `view`, not two ad-hoc `get_insights_view` calls. Require both explicit start/end dates; ask for missing dates rather than comparing to an implicit Gateway default. Keep the same application and granularity for both periods. The first range is A (baseline); the second is B. The reported delta is B minus A, and percent change uses A as the denominator. A zero baseline has no defined percentage, shown as `n/a`.

The tool compares every numeric metric in that widget unless the user selects one. For category tables, it also matches category names across periods and treats a missing category as zero. For the paginated Messages Breakup table, the tool loads all pages for both periods, with a safety limit; if the full table cannot be loaded, it fails instead of presenting a partial total. Time-series comparisons include two monochrome Unicode line charts using the same y-axis scale. Explain warnings about overlapping or unequal-length periods; do not claim the periods are directly comparable when their durations differ. Show the tool's `terminalDisplay` verbatim and do not add other Insight widgets.

## Broad template performance questions

When the user asks generally how their WhatsApp templates are performing, rather than naming one Insight widget, use `get_template_health_summary` for template status, quality, rejections and category changes. Use only the relevant `get_insights_report` reports (`summary`, `categories`, `messagingCost`) for category-level message volume and cost; do not fetch unrelated widgets. If the user supplies two explicit date ranges, use `compare_insights_periods` for the relevant same named widget in both periods. If they name one widget, keep the one-widget workflow above instead of expanding into a broad report.

Always distinguish template health from messaging performance: “Veriler kategori bazındadır, tek tek template’lere ait gönderilme/okunma/tıklanma değerleri bu araçla alınamaz.” Do not infer per-template metrics from category totals or health status.
