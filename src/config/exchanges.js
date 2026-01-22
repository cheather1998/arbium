// Exchange configurations
const EXCHANGE_CONFIGS = {
    paradex: {
      name: "Paradex",
      url: "https://app.paradex.trade/trade/BTC-USD-PERP",
      referralUrl: "https://app.paradex.trade/r/instantcrypto",
      urlPattern: "app.paradex.trade/trade",
      // UI selectors - using same as current (Paradex-specific)
      selectors: {
        loginButton: 'button[data-dd-action-name="Connect wallet"]',
        buyButton: "Buy",
        sellButton: "Sell",
        marketButton: "Market",
        limitButton: "Limit",
        confirmBuy: "Confirm Buy",
        confirmSell: "Confirm Sell",
        positionsTab: "Positions",
      }
    },
    extended: {
      name: "Extended Exchange",
      url: "https://app.extended.exchange/perp",
      referralUrl: "https://app.extended.exchange/perp",
      urlPattern: "app.extended.exchange/perp",
      // UI selectors - will need to be updated after inspecting Extended Exchange UI
      // For now, using generic text-based selectors (same as Paradex)
      selectors: {
        loginButton: null, // Will use text-based search
        buyButton: "Buy",
        sellButton: "Sell",
        marketButton: "Market",
        limitButton: "Limit",
        confirmBuy: "Confirm Buy", // May need to change
        confirmSell: "Sell", // Extended Exchange uses "Sell" button, not "Confirm Sell"
        positionsTab: "Positions", // May need to change
      }
    }
  };

  export default EXCHANGE_CONFIGS;