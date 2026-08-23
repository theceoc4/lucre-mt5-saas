// v1.0.12 — shared EA API-key auth helper.
//
// Extracted verbatim from ea-sync/index.ts (the sha256Hex + terminal lookup
// pattern that every EA-facing function needs) so report-symbols and
// ea-stream don't each hand-roll their own copy. manual-order/signal-action/
// position-action authenticate dashboard users via Supabase JWT instead —
// this helper is only for the x-api-key EA scheme.

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TerminalAuthResult {
  terminal: { id: string; [key: string]: unknown } | null;
  error: "missing_api_key" | "lookup_failed" | "invalid_api_key" | null;
  detail?: string;
}

// deno-lint-ignore no-explicit-any
export async function authenticateTerminal(
  req: Request,
  // deno-lint-ignore no-explicit-any
  admin: any,
  selectColumns = "id",
): Promise<TerminalAuthResult> {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) return { terminal: null, error: "missing_api_key" };

  const keyHash = await sha256Hex(apiKey);
  const { data: terminal, error } = await admin
    .from("mt5_terminals")
    .select(selectColumns)
    .eq("api_key_hash", keyHash)
    .maybeSingle();

  if (error) return { terminal: null, error: "lookup_failed", detail: error.message };
  if (!terminal) return { terminal: null, error: "invalid_api_key" };
  return { terminal, error: null };
}
