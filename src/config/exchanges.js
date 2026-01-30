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
      // UI selectors - updated for Extended Exchange UI
      selectors: {
        loginButton: null, // Will use text-based search
        buyButton: "Buy",
        sellButton: "Sell",
        marketButton: "Market",
        limitButton: "Limit",
        confirmBuy: "Buy", // Extended Exchange uses "Buy" button, not "Confirm Buy"
        confirmSell: "Sell", // Extended Exchange uses "Sell" button, not "Confirm Sell"
        positionsTab: "Positions",
      }
    },
    grvt: {
      name: "GRVT",
      url: "https://grvt.io/exchange/perpetual/BTC-USDT",
      referralUrl: "https://grvt.io/exchange/perpetual/BTC-USDT",
      urlPattern: "grvt.io/exchange",
      // UI selectors - updated for GRVT UI
      selectors: {
        loginButton: null, // Will use text-based search
        buyButton: "Buy / Long", // GRVT uses "Buy / Long" - this IS the confirm button
        sellButton: "Sell / Short", // GRVT uses "Sell / Short" - this IS the confirm button
        marketButton: "Market",
        limitButton: "Limit",
        confirmBuy: "Buy / Long", // GRVT: Buy/Long button IS the confirm button (no separate confirm)
        confirmSell: "Sell / Short", // GRVT: Sell/Short button IS the confirm button (no separate confirm)
        positionsTab: "Positions",
      }
    },
    kraken: {
      name: "Kraken",
      url: "https://pro.kraken.com/app/trade/futures-btc-usd-perp",
      referralUrl: "https://pro.kraken.com/app/trade/futures-btc-usd-perp",
      urlPattern: "pro.kraken.com/app/trade",
      // UI selectors - will need to be updated after inspecting Kraken UI
      // For now, using generic text-based selectors
      selectors: {
        loginButton: null, // Will use text-based search
        buyButton: "Buy",
        sellButton: "Sell",
        marketButton: "Market",
        limitButton: "Limit",
        confirmBuy: "Buy BTC Perp", // May need to change after UI inspection
        confirmSell: "Sell BTC Perp", // May need to change after UI inspection
        positionsTab: "Positions", // May need to change after UI inspection
      }
    }
  };

  export default EXCHANGE_CONFIGS;
