// The assets the testnet stack lists, with the prices it starts them at. Real deployments read their universe from
// the vault's mandate instead.

export const LISTINGS = [
  { symbol: "USDG", name: "Global Dollar", decimals: 6, price: 1, profile: "USD stablecoin; no price risk", stable: true },
  { symbol: "TSLA", name: "Tesla", decimals: 18, price: 250, profile: "EV and energy maker; very volatile" },
  { symbol: "AAPL", name: "Apple", decimals: 18, price: 230, profile: "consumer hardware and services; steady large-cap" },
  { symbol: "NVDA", name: "NVIDIA", decimals: 18, price: 180, profile: "AI and data-centre chips; volatile, high growth" },
  { symbol: "SPY", name: "S&P 500 ETF", decimals: 18, price: 660, profile: "broad US market index fund; diversified" },
] as const;
