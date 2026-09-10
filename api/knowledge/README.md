# Aurelia Lucre knowledge base

`lucre-system.js` is Aurelia's versioned product playbook. It contains stable product behavior, formulas, defaults, and safety boundaries. It intentionally does not contain customer data or secrets.

The assistant retrieves only the relevant topics for each question. Current customer values come from authenticated, terminal-scoped read-only tools in `api/ai-assistant.js`. A default in this file must never be presented as a customer's saved setting.

When Lucre behavior changes, update the matching topic, bump `LUCRE_KNOWLEDGE_VERSION`, extend `scripts/check-ai-knowledge.mjs`, and update the dashboard changelog. Verify the wording against source code and migrations, especially:

- `supabase/functions/_shared/trend-strength-v3.ts`
- `supabase/functions/strategy-signal-engine/index.ts`
- `supabase/functions/_shared/market-session.ts`
- strategy, risk, external-signal, and notification migrations
- `dashboard/index.html` and `dashboard/main.js`
- `ea/mt5_ea/LucreHubEA.mq5`

Never add terminal keys, webhook tokens, user identifiers, raw webhook payloads, or service credentials here.
