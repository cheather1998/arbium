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
      // No dedicated sign-in URL — GRVT opens a modal on the trading page.
      // We click the "Sign In" / "Log In" button to open the modal for the user.
      signInUrl: null,
      signInButtonTexts: ["Sign In", "Log In", "Login", "Sign in", "Log in"],
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
      urlPattern: "pro.kraken.com/app/trade/futures",
      // Kraken's real login page is www.kraken.com/sign-in. pro.kraken.com
      // routes the Sign In button there. We try a list of fallback URLs and
      // pick the first one whose final URL actually contains "sign-in".
      signInUrls: [
        "https://www.kraken.com/sign-in",
        "https://pro.kraken.com/app/sign-in",
      ],
      signInButtonTexts: ["Sign In", "Sign in", "Log In", "Log in", "Login"],
      // UI selectors - will need to be updated after inspecting Kraken UI
      // For now, using generic text-based selectors
      selectors: {
        loginButton: null, // Will use text-based search
        buyButton: "Buy",
        sellButton: "Sell",
        marketButton: "Market",
        limitButton: "Limit",
        confirmBuy: "Long (buy) BTC", // May need to change after UI inspection
        confirmSell: "Short (sell) BTC", // May need to change after UI inspection
        positionsTab: "Positions", // May need to change after UI inspection
      }
    },
    'kraken-margin': {
      name: "Kraken",
      url: "https://pro.kraken.com/app/trade/margin-btc-usd",
      referralUrl: "https://pro.kraken.com/app/trade/margin-btc-usd",
      urlPattern: "pro.kraken.com/app/trade/margin",
      // Same sign-in strategy as futures Kraken — try www.kraken.com first,
      // then pro.kraken.com as a fallback. Also supports click-first.
      signInUrls: [
        "https://www.kraken.com/sign-in",
        "https://pro.kraken.com/app/sign-in",
      ],
      signInButtonTexts: ["Sign In", "Sign in", "Log In", "Log in", "Login"],
      selectors: {
        loginButton: null,
        buyButton: "Buy",
        sellButton: "Sell",
        marketButton: "Market",
        limitButton: "Limit",
        // The actual submit button text is "Buy BTC/USD (10x)" / "Sell BTC/USD (10x)"
        // (the "(10x)" leverage multiplier may vary). Match by the unique prefix
        // "Buy BTC/USD" so we don't confuse it with the nav "Buy" link.
        confirmBuy: "Buy BTC/USD",
        confirmSell: "Sell BTC/USD",
        positionsTab: "Positions",
      }
    }
  };

  export default EXCHANGE_CONFIGS;
