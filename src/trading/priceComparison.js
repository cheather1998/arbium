import { getCurrentMarketPrice, getBestBidAsk } from './executeBase.js';
import { delay } from '../utils/helpers.js';

// Track whether each exchange page has been stabilized (first-call-only flag)
const stabilizedExchanges = new Set();

// Track price history per exchange for staleness detection
// If the exact same price is returned too many times, page might be frozen
const priceHistory = new Map(); // exchangeName -> { price, count, firstSeen }
const STALE_PRICE_THRESHOLD = 20; // Flag after 20 identical consecutive prices

/**
 * Compare prices from multiple exchanges and find highest and lowest
 * @param {Array} exchangeAccounts - Array of { page, email, exchange, exchangeConfig }
 * @returns {Object} - { prices: [...], highest: {...}, lowest: {...}, comparison: {...} }
 */
export async function comparePricesFromExchanges(exchangeAccounts) {
  console.log(`\n========================================`);
  console.log(`Price Comparison: Fetching prices from all exchanges...`);
  console.log(`========================================\n`);

  const startTime = Date.now();
  const priceResults = [];

  // Fetch prices from all exchanges in parallel
  const pricePromises = exchangeAccounts.map(async ({ page, email, exchange, exchangeConfig }) => {
    try {
      console.log(`[${exchangeConfig.name}] Preparing to fetch price for ${email}...`);
      
      // Wait for page to load — FULL stabilization only on first call per exchange
      const isFirstCall = !stabilizedExchanges.has(exchangeConfig.name);

      if (isFirstCall && (exchangeConfig.name === 'Kraken' || exchangeConfig.name === 'GRVT' || exchangeConfig.name === 'Extended Exchange')) {
        console.log(`[${exchangeConfig.name}] First price fetch — waiting for page to fully load...`);

        // Wait for page to be ready
        let pageReady = false;
        for (let i = 0; i < 10; i++) {
          pageReady = await page.evaluate(() => {
            return document.readyState === 'complete';
          });

          if (pageReady) {
            const hasTradingElements = await page.evaluate(() => {
              const text = document.body.innerText.toLowerCase();
              const hasPrice = text.includes('$') || document.querySelectorAll('[class*="price"], [class*="ticker"]').length > 0;
              const hasButtons = Array.from(document.querySelectorAll('button')).some(
                btn => {
                  const btnText = btn.textContent?.trim().toLowerCase();
                  return btnText === 'buy' || btnText === 'sell';
                }
              );
              return hasPrice || hasButtons;
            });

            if (hasTradingElements) {
              console.log(`[${exchangeConfig.name}] ✅ Page loaded and trading elements visible`);
              break;
            } else {
              console.log(`[${exchangeConfig.name}] Page ready but trading elements not visible yet, waiting...`);
              await delay(1000);
            }
          } else {
            await delay(500);
          }
        }

        // Additional wait for specific exchanges (only on first call)
        if (exchangeConfig.name === 'Kraken') {
          console.log(`[${exchangeConfig.name}] First-time stabilization wait for Kraken...`);
          await delay(3000);
        } else if (exchangeConfig.name === 'GRVT') {
          await delay(2000);
        } else if (exchangeConfig.name === 'Extended Exchange') {
          console.log(`[${exchangeConfig.name}] First-time stabilization wait for Extended Exchange...`);
          await delay(2000);
        }

        stabilizedExchanges.add(exchangeConfig.name);
        console.log(`[${exchangeConfig.name}] Page stabilized (subsequent calls will skip long waits)`);
      } else if (isFirstCall) {
        // First call for non-special exchanges
        await delay(500);
        stabilizedExchanges.add(exchangeConfig.name);
      }
      // Subsequent calls: no stabilization delay needed — pages already loaded
      
      // Try bid/ask first for accurate orderbook-based pricing, fall back to DOM price
      let price = null;
      let bidAskData = null;
      const bidAsk = await getBestBidAsk(page, exchangeConfig);
      if (bidAsk && bidAsk.mid) {
        price = bidAsk.mid;
        bidAskData = { bestBid: bidAsk.bestBid, bestAsk: bidAsk.bestAsk };
        console.log(`[${exchangeConfig.name}] ✓ Price from orderbook: mid=$${price.toLocaleString()} (bid=$${bidAsk.bestBid?.toLocaleString()}, ask=$${bidAsk.bestAsk?.toLocaleString()})`);
      } else {
        price = await getCurrentMarketPrice(page, exchangeConfig);
        if (price) {
          console.log(`[${exchangeConfig.name}] ✓ Price from DOM: $${price.toLocaleString()} (orderbook unavailable)`);
        }
      }
      const fetchTime = Date.now() - startTime;

      if (price) {
        // Staleness detection: track if same price repeats too many times
        const histKey = exchangeConfig.name;
        const prev = priceHistory.get(histKey);
        if (prev && prev.price === price) {
          prev.count++;
          if (prev.count >= STALE_PRICE_THRESHOLD && prev.count % STALE_PRICE_THRESHOLD === 0) {
            const staleDuration = ((Date.now() - prev.firstSeen) / 1000).toFixed(0);
            console.log(`[${exchangeConfig.name}] ⚠️  STALE PRICE WARNING: $${price.toLocaleString()} unchanged for ${prev.count} consecutive fetches (${staleDuration}s) — page may be frozen`);
            // Reset stabilization flag to force re-stabilization on next cycle
            stabilizedExchanges.delete(exchangeConfig.name);
          }
        } else {
          priceHistory.set(histKey, { price, count: 1, firstSeen: Date.now() });
        }

        return {
          exchange: exchangeConfig.name,
          email,
          price,
          bidAsk: bidAskData, // null if fell back to DOM price
          fetchTime,
          success: true
        };
      } else {
        console.log(`[${exchangeConfig.name}] ✗ Failed to fetch price`);
        return {
          exchange: exchangeConfig.name,
          email,
          price: null,
          fetchTime,
          success: false,
          error: 'Could not fetch price'
        };
      }
    } catch (error) {
      console.error(`[${exchangeConfig.name}] ✗ Error fetching price:`, error.message);
      return {
        exchange: exchangeConfig.name,
        email,
        price: null,
        fetchTime: Date.now() - startTime,
        success: false,
        error: error.message
      };
    }
  });

  const results = await Promise.all(pricePromises);
  const totalTime = Date.now() - startTime;

  // Filter successful price fetches
  const successfulPrices = results.filter(r => r.success && r.price !== null);
  const failedPrices = results.filter(r => !r.success || r.price === null);
  
  // Log failed exchanges
  if (failedPrices.length > 0) {
    console.log(`\n⚠️  Failed to fetch prices from ${failedPrices.length} exchange(s):`);
    failedPrices.forEach((result) => {
      console.log(`   ✗ ${result.exchange} (${result.email}): ${result.error || 'Could not fetch price'}`);
    });
  }
  
  if (successfulPrices.length === 0) {
    console.log(`\n❌ No prices could be fetched from any exchange`);
    return {
      success: false,
      error: 'No prices fetched',
      prices: results,
      totalTime
    };
  }

  // Find highest and lowest prices
  const sortedPrices = [...successfulPrices].sort((a, b) => b.price - a.price);
  const highest = sortedPrices[0];
  const lowest = sortedPrices[sortedPrices.length - 1];

  // Calculate differences
  const priceDiff = highest.price - lowest.price;
  const priceDiffPercent = ((priceDiff / lowest.price) * 100).toFixed(2);

  console.log(`\n========================================`);
  console.log(`Price Comparison Results:`);
  console.log(`========================================`);
  successfulPrices.forEach((result, index) => {
    const isHighest = result === highest;
    const isLowest = result === lowest;
    const marker = isHighest ? '🔺 HIGHEST' : isLowest ? '🔻 LOWEST' : '  ';
    console.log(`${marker} ${result.exchange}: $${result.price.toLocaleString()} (${result.email})`);
  });
  
  if (failedPrices.length > 0) {
    console.log(`\n⚠️  Missing prices from:`);
    failedPrices.forEach((result) => {
      console.log(`   ✗ ${result.exchange} (${result.email})`);
    });
  }
  
  console.log(`\n📊 Price Spread:`);
  console.log(`   Difference: $${priceDiff.toLocaleString()} (${priceDiffPercent}%)`);
  console.log(`   Highest: ${highest.exchange} at $${highest.price.toLocaleString()}`);
  console.log(`   Lowest: ${lowest.exchange} at $${lowest.price.toLocaleString()}`);
  console.log(`\n⏱️  Total fetch time: ${totalTime}ms`);
  console.log(`========================================\n`);

  return {
    success: true,
    prices: results,
    successfulPrices,
    highest,
    lowest,
    comparison: {
      priceDiff,
      priceDiffPercent: parseFloat(priceDiffPercent),
      totalTime
    },
    totalTime
  };
}
