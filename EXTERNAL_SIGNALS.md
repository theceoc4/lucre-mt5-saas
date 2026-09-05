# External signal strategies

External providers propose a direction; they do not place a trade directly.
Every accepted candidate enters the same Lucre pipeline as a native strategy:
session and symbol eligibility, current terminal-owned candles, optional Lucre
indicator confirmations, spread, cooldown, news policy, adaptive policy,
portfolio risk, broker mapping, position capacity, and finally execution mode.

## Dashboard setup

1. Add or edit a strategy and choose **TradingView webhook**, **Generic
   webhook**, or **MT5 custom indicator** as its Signal source.
2. Choose the symbols, timeframe, sessions, direction, risk settings, and
   **Shadow**, **Signal Only**, or **Auto** execution.
3. Optionally add up to four Lucre indicators. For an external strategy these
   are confirmation filters; the external trigger is still required.
4. Save and copy the private webhook URL while it is visible. Lucre stores only
   its SHA-256 hash. Rotate the URL if the original is lost or exposed.
5. Use **Test only** to validate the credential, symbol, timeframe, and side
   without creating a signal or order.

## Webhook contract

Send a JSON `POST` to the private URL:

```json
{
  "event_id": "provider-unique-id",
  "symbol": "EURUSD",
  "timeframe": "M5",
  "side": "buy",
  "source_price": 1.0842,
  "occurred_at": "2026-09-04T21:00:02Z"
}
```

- `event_id` should stay identical when a provider retries the same alert.
- `side` accepts `buy`, `sell`, `long`, `short`, `1`, or `-1`.
- TradingView numeric intervals (`1`, `5`, `15`, `30`, `60`, `240`) and common
  minute aliases (`1m`, `5m`, `15m`, `30m`) are normalized and retained as
  provider metadata.
- The timeframe configured on the Lucre strategy remains authoritative for
  broker candles and confirmation indicators. A TradingView chart interval may
  differ without rejecting the trigger. MT5 indicator adapters stay strict
  because the EA reads the strategy's configured chart series directly.
- The symbol must be enabled on the strategy. An MT5 broker suffix is resolved
  only inside the owning terminal's symbol map.
- `occurred_at` is checked against the strategy's TTL. Use TradingView's
  `{{timenow}}` for this field; `{{time}}` is appropriate for a stable candle
  identity in `event_id`.

Ingress is rate-limited and capped at 16 KB. Accepted requests are stored in
`external_signal_events` before dispatch, deduplicated by endpoint and
`event_id`, retried with a bounded backoff after infrastructure failures, and
kept terminal/user scoped by RLS and composite foreign keys.

## MT5 custom indicators

Install the compiled custom indicator under `MQL5/Indicators`, then configure
its filename and BUY/SELL buffer indexes in the strategy. LucreHubEA v1.49
loads the indicator with its default Inputs, reads only closed candle index 1,
and treats a non-zero, non-`EMPTY_VALUE` buffer value as a candidate. If both
buffers fire on the same candle, the EA rejects the ambiguous event.

The first closed candle observed after startup or reconfiguration is seeded
without being sent. This prevents an old indicator arrow from replaying as a
new trade. A new closed candle whose buffers are not calculated yet remains
pending and is retried on the next timer tick.
