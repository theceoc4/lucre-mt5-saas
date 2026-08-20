# Changelog — LucreHubEA (MT5 Expert Advisor)

## v1.0.18 — Single-file build for VPS compatibility (2026-08-20)

**Packaging-only release — no trading logic changed.**

### Why
The EA previously shipped as `LucreHubEA.mq5` plus five sibling
`.mqh` include files (`EASync`, `CalendarSync`, `EAStream`, `SymbolMap`,
`PriceReporter`) that had to be copied into `MQL5/Include` alongside the
main file in `MQL5/Experts`. MetaTrader VPS hosting does not reliably sync
sibling `.mq5`/`.mqh` source files onto the VPS — it's built around syncing
compiled `.ex5` files, not their include dependencies — so a VPS install
following the old multi-file layout could fail to compile, or run against
stale/missing includes if a file was dropped or updated out of sync with
its `.mq5`.

### What changed
- All five `.mqh` modules are now inlined directly into `LucreHubEA.mq5`.
  MQL5's `#include` is plain text substitution, so the resulting compiled
  `.ex5` is byte-for-byte equivalent to compiling the old five-file layout
  — this is purely a packaging change.
- Each module's original header/doc comments are preserved verbatim in
  place, wrapped in `BEGIN inlined module: X.mqh` / `END inlined module:
  X.mqh` banner comments for navigation.
- A duplicate `#property strict` directive from each module was removed
  (one now covers the whole file, as it always implicitly would have).
- `#property version` bumped `"1.17"` → `"1.18"` to mark this packaging
  build.
- Setup is now one file: copy `LucreHubEA.mq5` into `MQL5/Experts/`,
  compile, attach. Nothing to copy into `MQL5/Include` anymore.

### Not changed
- No behavior, timers, network calls, or command handling changed. This
  is the same v1.0.17 logic (execution client, calendar sync, WebSocket
  push, symbol mapping, price reporting) — see the prior
  `LucreHubEA-v1.0.17--Install-Bundle` CHANGELOG for the functional history
  of each module.

---

## Prior history

See `LucreHubEA-v1.0.17--Install-Bundle.zip` and earlier bundles for the
full functional changelog (execution client, filling-mode fallback,
strategy attribution, stuck-command recovery, economic calendar ingestion,
WebSocket command push, broker symbol mapping, price bar reporting for the
strategy-signal-engine, and the OnTradeTransaction immediate-sync hook).
