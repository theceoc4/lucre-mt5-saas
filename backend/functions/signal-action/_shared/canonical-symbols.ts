// v1.0.12 — master canonical symbol list for broker symbol mapping.

export type AssetClass = "fx" | "metal" | "index" | "crypto";

export interface CanonicalSymbol {
  symbol: string;
  asset_class: AssetClass;
}

const FX_MAJORS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF", "USDJPY"];

const FX_CROSSES = [
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCHF", "AUDCAD", "AUDNZD",
  "NZDJPY", "NZDCHF", "NZDCAD",
  "CADJPY", "CADCHF",
  "CHFJPY",
];

const METALS = ["XAUUSD", "XAGUSD", "XPTUSD", "XPDUSD"];

const INDICES = [
  "US30", "US500", "USTEC", "UK100", "GER40", "FRA40", "EU50", "JP225", "AUS200", "HK50",
];

const CRYPTO = [
  "BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD", "BCHUSD", "ADAUSD", "SOLUSD", "DOGEUSD", "DOTUSD", "BNBUSD",
];

export const CANONICAL_SYMBOLS: CanonicalSymbol[] = [
  ...FX_MAJORS.map((symbol) => ({ symbol, asset_class: "fx" as const })),
  ...FX_CROSSES.map((symbol) => ({ symbol, asset_class: "fx" as const })),
  ...METALS.map((symbol) => ({ symbol, asset_class: "metal" as const })),
  ...INDICES.map((symbol) => ({ symbol, asset_class: "index" as const })),
  ...CRYPTO.map((symbol) => ({ symbol, asset_class: "crypto" as const })),
];
