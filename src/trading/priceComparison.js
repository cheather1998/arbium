import { getCurrentMarketPrice } from './executeBase.js';
import { delay } from '../utils/helpers.js';

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
      
      // Wait for page to load, especially important for Kraken
      if (exchangeConfig.name === 'Kraken' || exchangeConfig.name === 'GRVT') {
        console.log(`[${exchangeConfig.name}] Waiting for page to fully load...`);
        
        // Wait for page to be ready
        let pageReady = false;
        for (let i = 0; i < 10; i++) {
          pageReady = await page.evaluate(() => {
            return document.readyState === 'complete';
          });
          
          if (pageReady) {
            // Also check if trading elements are visible
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
        
        // Additional wait for Kraken specifically (it might need more time to load price data)
        if (exchangeConfig.name === 'Kraken') {
          console.log(`[${exchangeConfig.name}] Additional wait for Kraken page to stabilize...`);
          await delay(3000);
        } else if (exchangeConfig.name === 'GRVT') {
          await delay(2000);
        }
        
        console.log(`[${exchangeConfig.name}] Page loaded, fetching price...`);
      } else {
        // For other exchanges, just a small delay
        await delay(1000);
      }
      
      const price = await getCurrentMarketPrice(page, exchangeConfig);
      const fetchTime = Date.now() - startTime;
      
      if (price) {
        console.log(`[${exchangeConfig.name}] ✓ Price: $${price.toLocaleString()} (fetched in ${fetchTime}ms)`);
        return {
          exchange: exchangeConfig.name,
          email,
          price,
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
