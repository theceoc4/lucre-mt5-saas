export type TradingSession = "asia" | "london" | "overlap" | "ny";
export type MarketSession = TradingSession | "off_session";

// Session calendar v2. UTC keeps one broker event classified the same way for
// every user timezone. Broker tradability remains authoritative in MT5.
export function marketSessionFor(at: Date): MarketSession {
  const day = at.getUTCDay(); // Sunday=0, Friday=5, Saturday=6.
  const hour = at.getUTCHours();
  const weekendClosed = day === 6 || (day === 5 && hour >= 21) || (day === 0 && hour < 21);
  if (weekendClosed) return "off_session";
  if (hour < 7 || hour >= 21) return "asia";
  if (hour < 12) return "london";
  if (hour < 16) return "overlap";
  return "ny";
}

export function isTradingSession(session: MarketSession): session is TradingSession {
  return session !== "off_session";
}

export const SESSION_DEFINITION_VERSION = "utc-v2-weekend-aware";
