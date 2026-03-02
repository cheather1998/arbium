import dotenv from 'dotenv';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay, closeNotifyBarWrapperNotifications } from '../utils/helpers.js';
import { closeAllPositions, checkGrvtOpenPositions } from '../trading/positions.js';
import { cancelAllOrders, cancelKrakenOrders,checkKrakenOpenPositions } from '../trading/orders.js';
import { setLeverage } from '../trading/leverage.js';
import { setLeverageKraken } from '../trading/executeKraken.js';
import { clickOrdersTab } from '../ui/tabs.js';
import { executeTrade } from '../trading/execute.js';
import { getCurrentUnrealizedPnL } from '../trading/positions.js';
import { comparePricesFromExchanges } from '../trading/priceComparison.js';

// Ensure environment variables are loaded
dotenv.config();

// Trading configuration from environment variables
const TRADE_CONFIG = {
  buyQty: parseFloat(process.env.BUY_QTY) || 0.0005,
  sellQty: parseFloat(process.env.SELL_QTY) || 0.0005,
  waitTime: parseInt(process.env.TRADE_TIME) || 60000,
  leverage: parseInt(process.env.LEVERAGE) || 20,
  stopLoss: parseFloat(process.env.STOP_LOSS) || null,
  openingThreshold: parseFloat(process.env.OPENING_THRESHOLD) || 0.0, // Absolute price difference threshold (in dollars: highest - lowest)
  closingThreshold: parseFloat(process.env.CLOSING_THRESHOLD) || 0.0, // Absolute price difference threshold for closing (in dollars: highest - lowest)
  closingSpread: parseFloat(process.env.CLOSING_SPREAD) || 0.0, // Spread threshold for closing: (price_difference - opening_threshold) >= closingSpread
};

// Debug: Log the configuration values being used
console.log('\n[TRADE_CONFIG] Loaded from environment:');
console.log(`  BUY_QTY: ${process.env.BUY_QTY || 'not set'} -> ${TRADE_CONFIG.buyQty}`);
console.log(`  SELL_QTY: ${process.env.SELL_QTY || 'not set'} -> ${TRADE_CONFIG.sellQty}`);
console.log(`  LEVERAGE: ${process.env.LEVERAGE || 'not set'} -> ${TRADE_CONFIG.leverage}x`);
console.log(`  STOP_LOSS: ${process.env.STOP_LOSS || 'not set'} -> ${TRADE_CONFIG.stopLoss || 'disabled'}`);
console.log(`  OPENING_THRESHOLD: ${process.env.OPENING_THRESHOLD || 'not set'} -> $${TRADE_CONFIG.openingThreshold.toLocaleString()}`);
console.log(`  CLOSING_THRESHOLD: ${process.env.CLOSING_THRESHOLD || 'not set'} -> $${TRADE_CONFIG.closingThreshold.toLocaleString()}`);
console.log(`  CLOSING_SPREAD: ${process.env.CLOSING_SPREAD || 'not set'} -> $${TRADE_CONFIG.closingSpread.toLocaleString()}\n`);

let isShuttingDown = false;

// Store the opening threshold used when both positions opened successfully
// This will be used in the next cycle before closing positions
let savedOpeningThreshold = null;

/**
 * Helper function to check prices and wait until threshold is met
 * Returns price comparison result when threshold is satisfied
 * Uses absolute price difference (highest - lowest) instead of percentage
 */
async function waitForPriceThreshold(exchangeAccounts, threshold, cycleCount) {
  let attemptCount = 0;
  const maxAttempts = 1000; // Prevent infinite loop (safety limit)
  
  while (!isShuttingDown && attemptCount < maxAttempts) {
    attemptCount++;
    
    const priceComparison = await comparePricesFromExchanges(exchangeAccounts);
    
    if (!priceComparison.success || priceComparison.successfulPrices.length < 2) {
      console.log(`\n[CYCLE ${cycleCount}] ⚠️  Price comparison failed or insufficient prices. Retrying in 2 seconds...`);
      await delay(2000);
      continue;
    }
    
    // Use absolute price difference (highest - lowest)
    const priceDiff = Math.abs(priceComparison.comparison.priceDiff);
    
    console.log(`\n[CYCLE ${cycleCount}] Price check attempt ${attemptCount}:`);
    console.log(`   Highest: ${priceComparison.highest.exchange} at $${priceComparison.highest.price.toLocaleString()}`);
    console.log(`   Lowest: ${priceComparison.lowest.exchange} at $${priceComparison.lowest.price.toLocaleString()}`);
    console.log(`   Price difference: $${priceDiff.toLocaleString()}`);
    console.log(`   Threshold required: $${threshold.toLocaleString()}`);
    
    // Opening threshold: only positive values allowed (must be >= 0)
    if (threshold < 0) {
      console.log(`\n⚠️  [CYCLE ${cycleCount}] Opening threshold cannot be negative. Using absolute value: $${Math.abs(threshold).toLocaleString()}`);
      threshold = Math.abs(threshold);
    }
    
    if (priceDiff >= threshold) {
      console.log(`\n✅ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) >= threshold ($${threshold.toLocaleString()}). Proceeding with trade.`);
      return priceComparison;
    } else {
      console.log(`\n⏳ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) < threshold ($${threshold.toLocaleString()}). Waiting 2 seconds and checking again...`);
      await delay(2000);
    }
  }
  
  // If we exit the loop without meeting threshold
  if (attemptCount >= maxAttempts) {
    console.log(`\n⚠️  [CYCLE ${cycleCount}] Maximum attempts (${maxAttempts}) reached. Threshold may not be met.`);
    return null;
  }
  
  return null;
}

/**
 * Helper function to check prices and wait until closing threshold is met
 * Returns price comparison result when threshold is satisfied (price difference <= threshold)
 * If threshold not met after 15 minutes, returns null to force close
 * Uses absolute price difference (highest - lowest)
 */
/**
 * Check open positions for both accounts and determine position sides (long/short)
 * @param {Object} params - Parameters object
 * @param {Page} params.page1 - Puppeteer page for account 1
 * @param {Page} params.page2 - Puppeteer page for account 2
 * @param {Object} params.exchange1 - Exchange config for account 1
 * @param {Object} params.exchange2 - Exchange config for account 2
 * @param {string} params.email1 - Email for account 1
 * @param {string} params.email2 - Email for account 2
 * @param {string} params.exchange1Name - Exchange name for account 1
 * @param {string} params.exchange2Name - Exchange name for account 2
 * @returns {Promise<Object>} - { account1OpenPositionSide: string|null, account2OpenPositionSide: string|null }
 */
async function checkOpenPositionsForAccounts({ page1, page2, exchange1, exchange2, email1, email2, exchange1Name, exchange2Name }) {
  const account1IsKraken = exchange1.name === 'Kraken' || exchange1Name?.toLowerCase() === 'kraken';
  const account2IsKraken = exchange2.name === 'Kraken' || exchange2Name?.toLowerCase() === 'kraken';
  const account1IsGrvt = exchange1.name === 'Grvt' || exchange1Name?.toLowerCase() === 'grvt';
  const account2IsGrvt = exchange2.name === 'Grvt' || exchange2Name?.toLowerCase() === 'grvt';

  // Variables to track open position side for Kraken and GRVT accounts
  let account1OpenPositionSide = null;
  let account2OpenPositionSide = null;

  // Check for open positions in parallel for both accounts
  const positionCheckPromises = [];
  
  if (account1IsKraken) {
    positionCheckPromises.push(
      checkKrakenOpenPositions(page1).then(result => ({
        account: 1,
        exchange: exchange1.name,
        email: email1,
        type: 'kraken',
        result
      }))
    );
  } else if (account1IsGrvt) {
    positionCheckPromises.push(
      checkGrvtOpenPositions(page1).then(result => ({
        account: 1,
        exchange: exchange1.name,
        email: email1,
        type: 'grvt',
        result
      }))
    );
  }
  
  if (account2IsKraken) {
    positionCheckPromises.push(
      checkKrakenOpenPositions(page2).then(result => ({
        account: 2,
        exchange: exchange2.name,
        email: email2,
        type: 'kraken',
        result
      }))
    );
  } else if (account2IsGrvt) {
    positionCheckPromises.push(
      checkGrvtOpenPositions(page2).then(result => ({
        account: 2,
        exchange: exchange2.name,
        email: email2,
        type: 'grvt',
        result
      }))
    );
  }
  
  // Wait for all position checks to complete in parallel
  if (positionCheckPromises.length > 0) {
    const positionCheckResults = await Promise.all(positionCheckPromises);
    
    // Process position information and set openPositionSide for Kraken and GRVT
    for (const { account, exchange, email, type, result } of positionCheckResults) {
      if (result.success && result.hasPositions && result.count > 0) {
        if (type === 'kraken') {
          console.log(`[${exchange}] Account ${account} (${email}) has ${result.count} open position(s) - Long: ${result.longCount}, Short: ${result.shortCount}`);
          
          // Set openPositionSide based on position type
          if (account === 1) {
            if (result.longCount > 0) {
              account1OpenPositionSide = 'long';
            } else if (result.shortCount > 0) {
              account1OpenPositionSide = 'short';
            }
          } else if (account === 2) {
            if (result.longCount > 0) {
              account2OpenPositionSide = 'long';
            } else if (result.shortCount > 0) {
              account2OpenPositionSide = 'short';
            }
          }
        } else if (type === 'grvt') {
          console.log(`[${exchange}] Account ${account} (${email}) has ${result.count} open position(s) - Long: ${result.longCount}, Short: ${result.shortCount}`);
          
          // Set openPositionSide based on position type for GRVT
          if (account === 1) {
            if (result.longCount > 0) {
              account1OpenPositionSide = 'long';
            } else if (result.shortCount > 0) {
              account1OpenPositionSide = 'short';
            }
          } else if (account === 2) {
            if (result.longCount > 0) {
              account2OpenPositionSide = 'long';
            } else if (result.shortCount > 0) {
              account2OpenPositionSide = 'short';
            }
          }
        }
      } else if (result.success && !result.hasPositions) {
        console.log(`[${exchange}] Account ${account} (${email}) has no open positions`);
      }
    }
  }
  
  // Log position sides if set (for both Kraken and GRVT)
  if (account1OpenPositionSide) {
    console.log(`[${exchange1.name}] Account 1 open position side: ${account1OpenPositionSide}`);
  }
  if (account2OpenPositionSide) {
    console.log(`[${exchange2.name}] Account 2 open position side: ${account2OpenPositionSide}`);
  }
  
  return {
    account1OpenPositionSide,
    account2OpenPositionSide
  };
}

async function waitForClosingThreshold(exchangeAccounts, threshold, cycleCount) {
  const startTime = Date.now();
  const maxWaitTime = 15 * 60 * 1000; // 15 minutes in milliseconds
  let attemptCount = 0;
  
  while (!isShuttingDown) {
    attemptCount++;
    const elapsedTime = Date.now() - startTime;
    
    // Check if 15 minutes have passed
    if (elapsedTime >= maxWaitTime) {
      console.log(`\n⏰ [CYCLE ${cycleCount}] 15 minutes elapsed. Force closing positions regardless of threshold.`);
      return null; // Return null to indicate force close
    }
    
    const priceComparison = await comparePricesFromExchanges(exchangeAccounts);
    
    if (!priceComparison.success || priceComparison.successfulPrices.length < 2) {
      console.log(`\n[CYCLE ${cycleCount}] ⚠️  Price comparison failed or insufficient prices. Retrying in 2 seconds...`);
      await delay(2000);
      continue;
    }
    
    // Use actual price difference (highest - lowest), which is always positive
    // Support negative thresholds for closing as well
    const priceDiff = priceComparison.comparison.priceDiff; // Already positive (highest - lowest)
    const remainingTime = Math.max(0, maxWaitTime - elapsedTime);
    const remainingMinutes = Math.floor(remainingTime / 60000);
    const remainingSeconds = Math.floor((remainingTime % 60000) / 1000);
    
    console.log(`\n[CYCLE ${cycleCount}] Closing threshold check attempt ${attemptCount} (${Math.floor(elapsedTime / 1000)}s elapsed):`);
    console.log(`   Highest: ${priceComparison.highest.exchange} at $${priceComparison.highest.price.toLocaleString()}`);
    console.log(`   Lowest: ${priceComparison.lowest.exchange} at $${priceComparison.lowest.price.toLocaleString()}`);
    console.log(`   Price difference: $${priceDiff.toLocaleString()}`);
    console.log(`   Closing threshold: $${threshold.toLocaleString()}`);
    console.log(`   Time remaining: ${remainingMinutes}m ${remainingSeconds}s`);
    
    // Support negative thresholds: if threshold is negative, use absolute value for comparison
    // For closing: we want priceDiff <= threshold (or <= |threshold| if negative)
    const thresholdForComparison = threshold < 0 ? Math.abs(threshold) : threshold;
    const thresholdMet = priceDiff <= thresholdForComparison;
    
    if (thresholdMet) {
      if (threshold < 0) {
        console.log(`\n✅ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) <= |closing threshold| ($${thresholdForComparison.toLocaleString()}, original: $${threshold.toLocaleString()}). Proceeding to close positions.`);
      } else {
        console.log(`\n✅ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) <= closing threshold ($${threshold.toLocaleString()}). Proceeding to close positions.`);
      }
      return priceComparison;
    } else {
      if (threshold < 0) {
        console.log(`\n⏳ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) > |closing threshold| ($${thresholdForComparison.toLocaleString()}, original: $${threshold.toLocaleString()}). Waiting 2 seconds and checking again...`);
      } else {
        console.log(`\n⏳ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) > closing threshold ($${threshold.toLocaleString()}). Waiting 2 seconds and checking again...`);
      }
      await delay(2000);
    }
  }
  
  return null;
}

/**
 * Helper function to check prices and wait until closing spread threshold is met
 * Closes positions when (price_difference - opening_threshold) >= closingSpread
 * Returns price comparison result when threshold is satisfied
 */
async function waitForClosingSpreadThreshold(exchangeAccounts, openingThreshold, closingSpread, cycleCount) {
  const startTime = Date.now();
  const maxWaitTime = 15 * 60 * 1000; // 15 minutes in milliseconds
  let attemptCount = 0;
  
  while (!isShuttingDown) {
    attemptCount++;
    const elapsedTime = Date.now() - startTime;
    
    // Check if 15 minutes have passed
    if (elapsedTime >= maxWaitTime) {
      console.log(`\n⏰ [CYCLE ${cycleCount}] 15 minutes elapsed. Force closing positions regardless of threshold.`);
      return null; // Return null to indicate force close
    }
    
    const priceComparison = await comparePricesFromExchanges(exchangeAccounts);
    
    if (!priceComparison.success || priceComparison.successfulPrices.length < 2) {
      console.log(`\n[CYCLE ${cycleCount}] ⚠️  Price comparison failed or insufficient prices. Retrying in 2 seconds...`);
      await delay(2000);
      continue;
    }
    
    // Use actual price difference (highest - lowest), which is always positive
    const priceDiff = priceComparison.comparison.priceDiff; // Already positive (highest - lowest)
    
    // Calculate spread: (price_difference - opening_threshold)
    const spread = openingThreshold- priceDiff;
    
    const remainingTime = Math.max(0, maxWaitTime - elapsedTime);
    const remainingMinutes = Math.floor(remainingTime / 60000);
    const remainingSeconds = Math.floor((remainingTime % 60000) / 1000);
    
    console.log(`\n[CYCLE ${cycleCount}] Closing spread threshold check attempt ${attemptCount} (${Math.floor(elapsedTime / 1000)}s elapsed):`);
    console.log(`   Highest: ${priceComparison.highest.exchange} at $${priceComparison.highest.price.toLocaleString()}`);
    console.log(`   Lowest: ${priceComparison.lowest.exchange} at $${priceComparison.lowest.price.toLocaleString()}`);
    console.log(`   Current price difference: $${priceDiff.toLocaleString()}`);
    console.log(`   Opening threshold (saved): $${openingThreshold.toLocaleString()}`);
    console.log(`   Spread (price_diff - opening_threshold): $${spread.toLocaleString()}`);
    console.log(`   Closing spread threshold: $${closingSpread.toLocaleString()}`);
    console.log(`   Time remaining: ${remainingMinutes}m ${remainingSeconds}s`);
    
    // Check if spread >= closingSpread
    const thresholdMet = spread >= closingSpread;
    
    if (thresholdMet) {
      console.log(`\n✅ [CYCLE ${cycleCount}] Spread ($${spread.toLocaleString()}) >= closing spread threshold ($${closingSpread.toLocaleString()}). Proceeding to close positions.`);
      return priceComparison;
    } else {
      console.log(`\n⏳ [CYCLE ${cycleCount}] Spread ($${spread.toLocaleString()}) < closing spread threshold ($${closingSpread.toLocaleString()}). Waiting 2 seconds and checking again...`);
      await delay(2000);
    }
  }
  
  return null;
}

async function automatedTradingLoop(account1Result, account2Result) {
    const { page: page1, email: email1, exchange: exchange1Name } = account1Result;
    const { page: page2, email: email2, exchange: exchange2Name } = account2Result;
    
    // Get exchange configs - handle both string names and undefined
    // Map exchange names to config keys: "Extended Exchange" -> "extended", "Paradex" -> "paradex", etc.
    const getExchangeKey = (exchangeName) => {
      if (!exchangeName) return 'paradex';
      const nameLower = exchangeName.toLowerCase();
      if (nameLower.includes('extended')) return 'extended';
      if (nameLower.includes('paradex')) return 'paradex';
      if (nameLower.includes('grvt')) return 'grvt';
      if (nameLower.includes('kraken')) return 'kraken';
      return 'paradex'; // default
    };
    
    const exchange1Key = getExchangeKey(exchange1Name);
    const exchange2Key = getExchangeKey(exchange2Name);
    const exchange1 = EXCHANGE_CONFIGS[exchange1Key] || EXCHANGE_CONFIGS.paradex;
    const exchange2 = EXCHANGE_CONFIGS[exchange2Key] || EXCHANGE_CONFIGS.paradex;
    
    console.log(`[DEBUG] Exchange mapping: exchange1Name="${exchange1Name}" -> key="${exchange1Key}" -> config.name="${exchange1.name}"`);
    console.log(`[DEBUG] Exchange mapping: exchange2Name="${exchange2Name}" -> key="${exchange2Key}" -> config.name="${exchange2.name}"`);
  
    let cycleCount = 0;
  
    console.log(`\n========================================`);
    console.log(`Starting Automated Trading Loop`);
    console.log(`Account 1 (${email1}) on ${exchange1.name}: BUY ${TRADE_CONFIG.buyQty} BTC`);
    console.log(`Account 2 (${email2}) on ${exchange2.name}: SELL ${TRADE_CONFIG.sellQty} BTC`);
    console.log(`Leverage: ${TRADE_CONFIG.leverage}x`);
    console.log(`Close after: Random time between 10s and 3min`);
    console.log(`========================================\n`);
  
    // Clean up any existing positions and orders BEFORE setting leverage
    // NOTE: Extended Exchange already did this in clickOrdersTab() during login, so skip it
    console.log(`\n🧹 Cleaning up existing positions and orders...`);
    const cleanupPromises = [];
    
    // Helper function to add cleanup for an account
    const addCleanupForAccount = (page, email, exchangeName, exchangeConfig, exchangeKey) => {
      if (exchangeName !== 'Extended Exchange') {
      cleanupPromises.push((async () => {
          console.log(`\n[${email}] Checking for open positions and orders...`);
          const closeResult = await closeAllPositions(page, 100, exchangeConfig);
          
          // Use Kraken-specific cancel function for Kraken
          // Check both exchangeName and exchangeConfig.name to handle different naming
          // Also check the exchange key (kraken) and URL patterns
          const exchangeNameLower = (exchangeName || '').toLowerCase();
          const exchangeConfigNameLower = (exchangeConfig?.name || '').toLowerCase();
          const exchangeKeyLower = (exchangeKey || '').toLowerCase();
          const urlPatternLower = (exchangeConfig?.urlPattern || '').toLowerCase();
          
          const isKraken = exchangeName === 'Kraken' || 
                          exchangeConfig?.name === 'Kraken' || 
                          exchangeNameLower === 'kraken' || 
                          exchangeConfigNameLower === 'kraken' ||
                          exchangeKeyLower === 'kraken' ||
                          urlPatternLower.includes('kraken');
          
          // CRITICAL DEBUG: Print this BEFORE calling cancel function
          // Use process.stdout.write to ensure it's printed immediately
          const emailStr = email || 'UNKNOWN';
          console.log(`\n═══════════════════════════════════════════════════════════`);
          console.log(`[${emailStr}] 🔍 EXCHANGE ROUTING CHECK FOR ORDER CANCELLATION:`);
          console.log(`  exchangeName: "${exchangeName || 'undefined'}"`);
          console.log(`  exchangeConfig.name: "${exchangeConfig?.name || 'undefined'}"`);
          console.log(`  exchangeKey: "${exchangeKey || 'undefined'}"`);
          console.log(`  urlPattern: "${exchangeConfig?.urlPattern || 'undefined'}"`);
          console.log(`  exchangeNameLower: "${exchangeNameLower}"`);
          console.log(`  exchangeConfigNameLower: "${exchangeConfigNameLower}"`);
          console.log(`  exchangeKeyLower: "${exchangeKeyLower}"`);
          console.log(`  urlPatternLower: "${urlPatternLower}"`);
          console.log(`  isKraken: ${isKraken}`);
          console.log(`  → Will use: ${isKraken ? 'cancelKrakenOrders' : 'cancelAllOrders'}`);
          console.log(`═══════════════════════════════════════════════════════════\n`);
          // Force flush
          if (process.stdout && typeof process.stdout.flush === 'function') {
            process.stdout.flush();
          }
          
          let cancelResult;
          if (isKraken) {
            console.log(`\n[${email}] ✅✅✅ CALLING cancelKrakenOrders (Kraken-specific function) ✅✅✅\n`);
            cancelResult = await cancelKrakenOrders(page);
          } else {
            console.log(`\n[${email}] ⚠️⚠️⚠️  CALLING cancelAllOrders (generic function) ⚠️⚠️⚠️\n`);
            cancelResult = await cancelAllOrders(page);
          }
          return { email, close: closeResult, cancel: cancelResult };
      })());
    } else {
        console.log(`\n[${email}] Skipping cleanup - already done in clickOrdersTab() during login`);
      }
    };
    
    // Cleanup for both accounts (they are different accounts, so both need cleanup)
    addCleanupForAccount(page1, email1, exchange1Name, exchange1, exchange1Key);
    addCleanupForAccount(page2, email2, exchange2Name, exchange2, exchange2Key);
  
    if (cleanupPromises.length > 0) {
      const cleanupResults = await Promise.all(cleanupPromises);
      
      // Log cleanup results
      for (const result of cleanupResults) {
        if (result.close.success) {
          console.log(`✓ [${result.email}] Positions: ${result.close.message || 'checked'}`);
        } else {
          console.log(`⚠ [${result.email}] Positions: ${result.close.error || 'check failed'}`);
        }
        if (result.cancel.success) {
          console.log(`✓ [${result.email}] Orders: ${result.cancel.message || 'checked'}`);
        } else {
          console.log(`⚠ [${result.email}] Orders: ${result.cancel.error || 'check failed'}`);
        }
      }
    }
  
    console.log(`\n✓ Cleanup completed.`);
    
    // Set leverage ONCE at the beginning (AFTER cleanup)
    // NOTE: Extended Exchange already set leverage in clickOrdersTab() during login, so skip it
    console.log(`\n🔧 Setting leverage for accounts...`);
    const leveragePromises = [];
    
    // Only set leverage for Paradex accounts (Extended Exchange already set in clickOrdersTab)
    if (exchange1Name !== 'Extended Exchange') {
      leveragePromises.push((async () => {
        // Use Kraken-specific leverage function for Kraken exchange
        const isKraken = exchange1Name?.toLowerCase().includes('kraken') || exchange1?.name?.toLowerCase().includes('kraken');
        const result = isKraken 
          ? await setLeverageKraken(page1, TRADE_CONFIG.leverage, exchange1)
          : await setLeverage(page1, TRADE_CONFIG.leverage);
        return { email: email1, result };
      })());
    } else {
      console.log(`[${email1}] Skipping leverage - already set in clickOrdersTab() during login`);
    }
    
    if (exchange2Name !== 'Extended Exchange') {
      leveragePromises.push((async () => {
        // Use Kraken-specific leverage function for Kraken exchange
        const isKraken = exchange2Name?.toLowerCase().includes('kraken') || exchange2?.name?.toLowerCase().includes('kraken');
        const result = isKraken 
          ? await setLeverageKraken(page2, TRADE_CONFIG.leverage, exchange2)
          : await setLeverage(page2, TRADE_CONFIG.leverage);
        return { email: email2, result };
      })());
    } else {
      console.log(`[${email2}] Skipping leverage - already set in clickOrdersTab() during login`);
    }
  
    if (leveragePromises.length > 0) {
      const leverageResults = await Promise.all(leveragePromises);
      
      for (const { email, result } of leverageResults) {
        if (result.success) {
          console.log(`✓ [${email}] Leverage set to ${TRADE_CONFIG.leverage}x`);
        } else {
          console.log(`⚠ [${email}] Failed to set leverage: ${result.error}`);
        }
      }
    }
  
    console.log(`\n✓ Leverage configured. Starting trading cycles...\n`);
    await delay(1000); // Reduced from 2000ms
  
    // Track if Extended Exchange just completed post-trade flow (cleanup + leverage set)
    let extendedExchangeJustCompletedPostTrade = false;
    // Track if initial cleanup was done (to skip cleanup on first cycle)
    let initialCleanupDone = true; // Set to true since cleanup was just done before leverage
  
    while (!isShuttingDown) {
      cycleCount++;
      console.log(
        `\n>>> CYCLE ${cycleCount} - ${new Date().toLocaleTimeString()}`
      );
  
      try {
        // Skip cleanup if:
        // 1. Extended Exchange just completed post-trade flow (which already did cleanup + leverage)
        // 2. Initial cleanup was just done (first cycle after leverage was set)
        let skipCleanupAndPreTrade = false;
        if (extendedExchangeJustCompletedPostTrade) {
          console.log(`\n[CYCLE ${cycleCount}] Skipping cleanup and pre-trade - Extended Exchange just completed post-trade flow (cleanup + leverage already done)`);
          extendedExchangeJustCompletedPostTrade = false; // Reset flag
          skipCleanupAndPreTrade = true; // Skip both cleanup and pre-trade, go directly to trade execution
        } else if (initialCleanupDone && cycleCount === 1) {
          console.log(`\n[CYCLE ${cycleCount}] Skipping cleanup - initial cleanup was already done before leverage was set`);
          initialCleanupDone = false; // Reset flag after first cycle
          skipCleanupAndPreTrade = true; // Skip cleanup on first cycle, but still do pre-trade if needed
        }
        
        if (!skipCleanupAndPreTrade) {
          // Step 0: Cancel all open orders FIRST (to free up locked funds)
          console.log(`\n[CYCLE ${cycleCount}] Canceling all open orders first...`);
          const cancelPromises = [
            cancelAllOrders(page1),
            cancelAllOrders(page2),
          ];
  
          const cancelResults = await Promise.all(cancelPromises);
  
          if (cancelResults[0].success) {
            console.log(`✓ [${email1}] Open orders checked/canceled`);
          }
          if (cancelResults[1].success) {
            console.log(`✓ [${email2}] Open orders checked/canceled`);
          }
  
          // Small delay to ensure orders are fully canceled and funds are freed
          // Reduced from 2000ms - cancelAllOrders() already waits internally
          await delay(500);
  
          // Step 1: Close any existing positions
          // NOTE: For Extended Exchange, DON'T close positions here - let clickOrdersTab handle it (including TP/SL)
          console.log(`\n[CYCLE ${cycleCount}] Checking for existing positions...`);
          const initialClosePromises = [];
          
          // Only close positions for Paradex (Extended Exchange will handle it in clickOrdersTab)
          if (exchange1Name !== 'Extended Exchange') {
            initialClosePromises.push((async () => {
              const result = await closeAllPositions(page1, 100, exchange1);
              return { email: email1, result };
            })());
          }
          
          if (exchange2Name !== 'Extended Exchange') {
            initialClosePromises.push((async () => {
              const result = await closeAllPositions(page2, 100, exchange2);
              return { email: email2, result };
            })());
          }
  
          if (initialClosePromises.length > 0) {
            const initialCloseResults = await Promise.all(initialClosePromises);
            for (const { email, result } of initialCloseResults) {
              if (result.success) {
                console.log(`✓ [${email}] Existing positions checked/closed`);
              }
            }
            // Small delay to ensure positions are fully closed
            await delay(300);
          } else {
            console.log(`[CYCLE ${cycleCount}] Skipping position close - Extended Exchange will handle it in clickOrdersTab`);
          }
        } // End of else block for skip cleanup check
        
        // For first cycle, still need to do pre-trade flow for Extended Exchange if needed
        if (skipCleanupAndPreTrade && cycleCount === 1) {
          skipCleanupAndPreTrade = false; // Allow pre-trade flow on first cycle
        }
  
        // Step 0.5: For Extended Exchange, run PRE-trade flow BEFORE executing trades
        // Use clickOrdersTab() which does: cancel orders, positions, TP/SL, close positions, set leverage
        // This is the SAME flow as Phase 3 (initial setup) - no duplication
        // IMPORTANT: Don't close positions before this - clickOrdersTab needs to see positions to add TP/SL
        // Skip pre-trade if we just completed post-trade (cleanup + leverage already done)
        if (!skipCleanupAndPreTrade) {
          const hasExtendedExchange = exchange1Name === 'Extended Exchange' || exchange2Name === 'Extended Exchange';
          
          if (hasExtendedExchange) {
          console.log(`\n[CYCLE ${cycleCount}] Extended Exchange detected - running PRE-trade flow (clickOrdersTab)...`);
          console.log(`[CYCLE ${cycleCount}] NOTE: clickOrdersTab will handle cancel orders, TP/SL, close positions (leverage will be set in post-trade)`);
          
          // Run clickOrdersTab for Extended Exchange accounts (skip leverage - will be set post-trade)
          const preTradePromises = [];
          if (exchange1Name === 'Extended Exchange') {
            preTradePromises.push(clickOrdersTab(page1, email1, true)); // skipLeverage = true
          }
          if (exchange2Name === 'Extended Exchange') {
            preTradePromises.push(clickOrdersTab(page2, email2, true)); // skipLeverage = true
          }
          
            if (preTradePromises.length > 0) {
              await Promise.all(preTradePromises);
              console.log(`[CYCLE ${cycleCount}] Extended Exchange pre-trade flow completed`);
            }
            await delay(2000); // Small delay before trade execution
          }
        }
  
        // Step 1: Execute trades in parallel with limit orders at market price
        console.log(`\n[CYCLE ${cycleCount}] Opening new positions...`);
        const tradePromises = [
          executeTrade(page1, {
            side: "buy",
            orderType: "limit",
            qty: TRADE_CONFIG.buyQty,
            // Leverage already set at the beginning, price will be fetched automatically
          }, exchange1),
          executeTrade(page2, {
            side: "sell",
            orderType: "limit",
            qty: TRADE_CONFIG.sellQty,
            // Leverage already set at the beginning, price will be fetched automatically
          }, exchange2),
        ];
  
        const tradeResults = await Promise.all(tradePromises);
  
        // Check if both trades succeeded AND orders are confirmed as pending
        const trade1Success = tradeResults[0].success;
        const trade2Success = tradeResults[1].success;
        
        // Verify orders are actually placed (pending) before proceeding
        const order1Confirmed = tradeResults[0].orderStatus || tradeResults[0].success;
        const order2Confirmed = tradeResults[1].orderStatus || tradeResults[1].success;
  
        if (trade1Success) {
          if (order1Confirmed) {
            console.log(`✓ [${email1}] BUY order placed and confirmed as ${tradeResults[0].orderStatus || 'pending'}`);
          } else {
            console.log(`⚠️  [${email1}] BUY executed but order confirmation inconclusive: ${tradeResults[0].warning || 'unknown'}`);
          }
        } else {
          console.log(`✗ [${email1}] BUY failed: ${tradeResults[0].error}`);
        }
  
        if (trade2Success) {
          if (order2Confirmed) {
            console.log(`✓ [${email2}] SELL order placed and confirmed as ${tradeResults[1].orderStatus || 'pending'}`);
          } else {
            console.log(`⚠️  [${email2}] SELL executed but order confirmation inconclusive: ${tradeResults[1].warning || 'unknown'}`);
          }
        } else {
          console.log(`✗ [${email2}] SELL failed: ${tradeResults[1].error}`);
        }
  
        // CRITICAL: Only proceed to post-trade flow (closing orders/positions) AFTER both orders are confirmed as pending
        // This ensures we don't close positions before orders are actually placed
        if (trade1Success && trade2Success && (!order1Confirmed || !order2Confirmed)) {
          console.log(`\n⏳ [CYCLE ${cycleCount}] Waiting for order confirmation before proceeding...`);
          // Wait a bit more for orders to appear
          await delay(3000);
          console.log(`✓ [CYCLE ${cycleCount}] Proceeding with post-trade flow...`);
        }
  
        // Step 1.5: For Extended Exchange ONLY, run POST-trade flow AFTER orders are confirmed
        // IMPORTANT: Extended Exchange runs INDEPENDENTLY - doesn't wait for Paradex trade success
        // This ensures Extended Exchange proceeds even if Paradex trade fails
        const hasExtendedExchange1 = exchange1Name === 'Extended Exchange';
        const hasExtendedExchange2 = exchange2Name === 'Extended Exchange';
        
        if (hasExtendedExchange1 || hasExtendedExchange2) {
          console.log(`\n[CYCLE ${cycleCount}] Extended Exchange detected - running POST-trade flow IMMEDIATELY (independent of Paradex)...`);
          
          // Run post-trade flow for Extended Exchange accounts INDEPENDENTLY
          // Check if Extended Exchange trade succeeded before running post-trade
          const postTradePromises = [];
          if (hasExtendedExchange1 && trade1Success) {
            console.log(`[CYCLE ${cycleCount}] Running post-trade flow for ${email1} (Extended Exchange) - clickOrdersTab flow`);
            postTradePromises.push(clickOrdersTab(page1, email1));
          } else if (hasExtendedExchange1 && !trade1Success) {
            console.log(`[CYCLE ${cycleCount}] ⚠️  Extended Exchange (${email1}) trade failed - skipping post-trade flow`);
          }
          
          if (hasExtendedExchange2 && trade2Success) {
            console.log(`[CYCLE ${cycleCount}] Running post-trade flow for ${email2} (Extended Exchange) - clickOrdersTab flow`);
            postTradePromises.push(clickOrdersTab(page2, email2));
          } else if (hasExtendedExchange2 && !trade2Success) {
            console.log(`[CYCLE ${cycleCount}] ⚠️  Extended Exchange (${email2}) trade failed - skipping post-trade flow`);
          }
          
          if (postTradePromises.length > 0) {
            await Promise.all(postTradePromises);
            console.log(`[CYCLE ${cycleCount}] Extended Exchange post-trade flow completed (cleanup + leverage set)`);
          }
          
          // For Extended Exchange, skip wait/close steps and go directly to next cycle
          // Set flag to skip cleanup in next cycle since it was just done in post-trade flow
          extendedExchangeJustCompletedPostTrade = true;
          console.log(`[CYCLE ${cycleCount}] Extended Exchange cycle complete - next cycle will skip cleanup and go directly to trade execution`);
          await delay(2000); // Small delay before next cycle
          continue; // Skip to next cycle (bypass wait and close steps)
        }
  
        // Only proceed to wait and close if BOTH trades succeeded (for Paradex-only or mixed setups)
        if (!trade1Success || !trade2Success) {
          console.log(
            `\n✗ [CYCLE ${cycleCount}] One or both trades failed. Skipping wait and retrying in 5 seconds...`
          );
          await delay(5000);
          continue; // Skip to next cycle
        }
  
        console.log(
          `\n✓ [CYCLE ${cycleCount}] Both trades executed successfully!`
        );
  
        // Step 2: Wait for random time between 10 seconds and 3 minutes (only for non-Extended Exchange or mixed setups)
        const minWaitTime = 10000; // 10 seconds
        const maxWaitTime = 180000; // 3 minutes
        const randomWaitTime =
          Math.floor(Math.random() * (maxWaitTime - minWaitTime + 1)) +
          minWaitTime;
  
        console.log(
          `\n[CYCLE ${cycleCount}] Waiting ${
            randomWaitTime / 1000
          } seconds before closing...`
        );
        if (TRADE_CONFIG.stopLoss) {
          console.log(
            `[CYCLE ${cycleCount}] Stop loss enabled: $${TRADE_CONFIG.stopLoss} (will monitor P&L)`
          );
        }
  
        // Break wait into smaller chunks to allow faster shutdown and stop-loss checking
        const checkInterval = 2000; // Check every 2 seconds (changed from 1000 to allow P&L checks)
        const totalChecks = Math.ceil(randomWaitTime / checkInterval);
  
        for (let i = 0; i < totalChecks; i++) {
          if (isShuttingDown) {
            console.log(
              `\n[CYCLE ${cycleCount}] Shutdown detected during wait period`
            );
            break;
          }
  
          // Check stop loss if enabled
          if (TRADE_CONFIG.stopLoss) {
            try {
              // Get current P&L for both accounts
              const pnl1 = await getCurrentUnrealizedPnL(page1);
              const pnl2 = await getCurrentUnrealizedPnL(page2);
  
              const stopLossThreshold = -Math.abs(TRADE_CONFIG.stopLoss);
  
              // Debug logging every 5 checks (every 10 seconds) to see what's being compared
              if (i > 0 && i % 5 === 0) {
                console.log(
                  `[CYCLE ${cycleCount}] Stop Loss Check - ${email1}: $${
                    pnl1 !== null ? pnl1.toLocaleString() : "N/A"
                  }, ${email2}: $${
                    pnl2 !== null ? pnl2.toLocaleString() : "N/A"
                  }, Threshold: $${stopLossThreshold.toLocaleString()}`
                );
              }
  
              // Check if Account 1 has exceeded stop loss
              // Changed from < to <= so it triggers at exactly the stop loss amount
              // Example: if stopLoss=1.5, we check if pnl1 <= -1.5
              if (pnl1 !== null && pnl1 <= stopLossThreshold) {
                console.log(
                  `\n🚨 [CYCLE ${cycleCount}] STOP LOSS TRIGGERED for ${email1}!`
                );
                console.log(
                  `   Current P&L: $${pnl1.toLocaleString()}, Stop Loss: -$${
                    TRADE_CONFIG.stopLoss
                  }`
                );
                console.log(
                  `   Condition: ${pnl1} <= ${stopLossThreshold} = ${
                    pnl1 <= stopLossThreshold
                  }`
                );
                console.log(`   Closing positions immediately...`);
  
                // Close both accounts' positions to maintain balance
                await closeAllPositions(page1, 100, exchange1);
                await closeAllPositions(page2, 100, exchange2);
  
                console.log(
                  `✓ [CYCLE ${cycleCount}] Positions closed due to stop loss`
                );
                break; // Exit the wait loop immediately
              }
  
              // Check if Account 2 has exceeded stop loss
              // Changed from < to <= so it triggers at exactly the stop loss amount
              if (pnl2 !== null && pnl2 <= stopLossThreshold) {
                console.log(
                  `\n🚨 [CYCLE ${cycleCount}] STOP LOSS TRIGGERED for ${email2}!`
                );
                console.log(
                  `   Current P&L: $${pnl2.toLocaleString()}, Stop Loss: -$${
                    TRADE_CONFIG.stopLoss
                  }`
                );
                console.log(
                  `   Condition: ${pnl2} <= ${stopLossThreshold} = ${
                    pnl2 <= stopLossThreshold
                  }`
                );
                console.log(`   Closing positions immediately...`);
  
                // Close both accounts' positions to maintain balance
                await closeAllPositions(page1, 100, exchange1);
                await closeAllPositions(page2, 100, exchange2);
  
                console.log(
                  `✓ [CYCLE ${cycleCount}] Positions closed due to stop loss`
                );
                break; // Exit the wait loop immediately
              }
  
              // Log P&L status every 10 checks (every 20 seconds) so you can see what's happening
              if (i > 0 && i % 10 === 0) {
                console.log(
                  `[CYCLE ${cycleCount}] P&L Check - ${email1}: $${
                    pnl1 !== null ? pnl1.toLocaleString() : "N/A"
                  }, ${email2}: $${pnl2 !== null ? pnl2.toLocaleString() : "N/A"}`
                );
              }
            } catch (error) {
              // If P&L check fails, don't break the loop - just log and continue
              console.log(
                `[CYCLE ${cycleCount}] Error checking P&L: ${error.message}`
              );
            }
          }
  
          await delay(checkInterval);
  
          // Show countdown every 10 seconds
          const remaining = randomWaitTime - (i + 1) * checkInterval;
          if (remaining > 0 && remaining % 10000 === 0) {
            console.log(
              `[CYCLE ${cycleCount}] ${remaining / 1000}s remaining...`
            );
          }
        }
  
        if (isShuttingDown) {
          console.log(`[CYCLE ${cycleCount}] Breaking loop due to shutdown`);
          break;
        }
  
        // Step 3: Close positions in parallel
        console.log(`\n[CYCLE ${cycleCount}] Closing positions...`);
        const closePromises = [
          closeAllPositions(page1, 100, exchange1),
          closeAllPositions(page2, 100, exchange2),
        ];
  
        const closeResults = await Promise.all(closePromises);
  
        const close1Success = closeResults[0].success;
        const close2Success = closeResults[1].success;
  
        if (close1Success) {
          console.log(`✓ [${email1}] Position closed successfully`);
        } else {
          console.log(
            `✗ [${email1}] Close failed: ${
              closeResults[0].error || closeResults[0].message
            }`
          );
        }
  
        if (close2Success) {
          console.log(`✓ [${email2}] Position closed successfully`);
        } else {
          console.log(
            `✗ [${email2}] Close failed: ${
              closeResults[1].error || closeResults[1].message
            }`
          );
        }
  
        // Check if both positions closed successfully
        if (close1Success && close2Success) {
          console.log(
            `\n✓ [CYCLE ${cycleCount}] Completed successfully at ${new Date().toLocaleTimeString()}`
          );
        } else {
          console.log(
            `\n⚠ [CYCLE ${cycleCount}] Completed with some errors at ${new Date().toLocaleTimeString()}`
          );
        }
  
        // Small delay before next cycle
        // Reduced from 3000ms - closeAllPositions() already waits internally
        if (!isShuttingDown) {
          console.log(`\nStarting next cycle in 1 second...`);
          await delay(1000);
        }
      } catch (error) {
        console.error(`\n✗ [CYCLE ${cycleCount}] Error:`, error.message);
        
        // Handle protocol timeout errors specifically
        if (error.message && error.message.includes('ProtocolError') && error.message.includes('timed out')) {
          console.log(`⚠ Protocol timeout detected - this may be due to slow page operations`);
          console.log(`   The bot will retry after a longer delay...`);
          await delay(10000); // Wait 10 seconds before retry for timeout errors
        } else {
          console.log(`Waiting 5 seconds before retry...`);
          await delay(5000);
        }
      }
    }
  
    console.log(`\n[Trading Loop] Exited after ${cycleCount} cycles`);
  }
  
  async function closeAllPositionsOnShutdown(results) {
    console.log(`\n========================================`);
    console.log(`Closing all positions before shutdown...`);
    console.log(`========================================\n`);
  
    const closePromises = results.map(async (result) => {
      if (result.success && result.page) {
        try {
          console.log(`[${result.email}] Closing positions...`);
          const closeResult = await closeAllPositions(result.page, 100);
          if (closeResult.success) {
            console.log(`✓ [${result.email}] Positions closed`);
          } else {
            console.log(
              `✗ [${result.email}] ${closeResult.error || closeResult.message}`
            );
          }
        } catch (error) {
          console.error(`✗ [${result.email}] Error closing:`, error.message);
        }
      }
    });
  
    await Promise.all(closePromises);
    console.log(`\n[Shutdown] All positions closed. Exiting...\n`);
  }

/**
 * Automated trading loop for Option 3 (3 exchanges: Kraken, GRVT, Extended)
 * Uses price comparison to determine buy/sell sides:
 * - Highest price exchange → SELL
 * - Lowest price exchange → BUY
 */
async function automatedTradingLoop3Exchanges(krakenAccount, grvtAccount, extendedAccount) {
  const { page: krakenPage, email: krakenEmail, exchange: krakenExchangeName } = krakenAccount;
  const { page: grvtPage, email: grvtEmail, exchange: grvtExchangeName } = grvtAccount;
  const { page: extendedPage, email: extendedEmail, exchange: extendedExchangeName } = extendedAccount;
  
  // Get exchange configs
  const getExchangeKey = (exchangeName) => {
    if (!exchangeName) return 'kraken';
    const nameLower = exchangeName.toLowerCase();
    if (nameLower.includes('kraken')) return 'kraken';
    if (nameLower.includes('grvt')) return 'grvt';
    if (nameLower.includes('extended')) return 'extended';
    return 'kraken'; // default
  };
  
  const krakenKey = getExchangeKey(krakenExchangeName);
  const grvtKey = getExchangeKey(grvtExchangeName);
  const extendedKey = getExchangeKey(extendedExchangeName);
  
  const krakenExchange = EXCHANGE_CONFIGS[krakenKey] || EXCHANGE_CONFIGS.kraken;
  const grvtExchange = EXCHANGE_CONFIGS[grvtKey] || EXCHANGE_CONFIGS.grvt;
  const extendedExchange = EXCHANGE_CONFIGS[extendedKey] || EXCHANGE_CONFIGS.extended;
  
  console.log(`\n========================================`);
  console.log(`Starting Automated Trading Loop (3 Exchanges)`);
  console.log(`Kraken (${krakenEmail}): ${krakenExchange.name}`);
  console.log(`GRVT (${grvtEmail}): ${grvtExchange.name}`);
  console.log(`Extended (${extendedEmail}): ${extendedExchange.name}`);
  console.log(`Leverage: ${TRADE_CONFIG.leverage}x`);
  console.log(`Quantity: ${TRADE_CONFIG.buyQty} BTC`);
  console.log(`Opening Threshold: $${TRADE_CONFIG.openingThreshold.toLocaleString()} (will wait until price difference >= threshold)`);
  console.log(`Closing Threshold: $${TRADE_CONFIG.closingThreshold.toLocaleString()} (will wait until price difference <= threshold, max 15 min)`);
  console.log(`========================================\n`);
  
  // Clean up any existing positions and orders BEFORE setting leverage
  console.log(`\n🧹 Phase 1: Cleaning up existing positions and orders...`);
  const cleanupPromises = [];
  
  // Helper function to add cleanup for an account
  const addCleanupForAccount = (page, email, exchangeName, exchangeConfig) => {
    if (exchangeName !== 'Extended Exchange') {
      cleanupPromises.push((async () => {
        console.log(`\n[${email}] Checking for open positions and orders...`);
        const closeResult = await closeAllPositions(page, 100, exchangeConfig);
        // Use Kraken-specific cancel function for Kraken
        // Check both exchangeName and exchangeConfig.name to handle different naming
        const isKraken = exchangeName === 'Kraken' || exchangeConfig?.name === 'Kraken' || 
                        exchangeName?.toLowerCase() === 'kraken' || 
                        exchangeConfig?.name?.toLowerCase() === 'kraken';
        const cancelResult = isKraken 
          ? await cancelKrakenOrders(page)
          : await cancelAllOrders(page);
        return { email, close: closeResult, cancel: cancelResult };
      })());
    } else {
      console.log(`\n[${email}] Skipping cleanup - already done in clickOrdersTab() during login`);
    }
  };
  
  // Cleanup for all 3 accounts (currently commented out - can be enabled if needed)
  //addCleanupForAccount(krakenPage, krakenEmail, krakenExchangeName, krakenExchange);
  //addCleanupForAccount(grvtPage, grvtEmail, grvtExchangeName, grvtExchange);
  //addCleanupForAccount(extendedPage, extendedEmail, extendedExchangeName, extendedExchange);
  
  if (cleanupPromises.length > 0) {
    console.log(`   Processing cleanup for ${cleanupPromises.length} account(s)...`);
    const cleanupResults = await Promise.all(cleanupPromises);
    
    // Log cleanup results
    for (const result of cleanupResults) {
      if (result.close.success) {
        console.log(`✓ [${result.email}] Positions: ${result.close.message || 'checked'}`);
      } else {
        console.log(`⚠ [${result.email}] Positions: ${result.close.error || 'check failed'}`);
      }
      if (result.cancel.success) {
        console.log(`✓ [${result.email}] Orders: ${result.cancel.message || 'checked'}`);
      } else {
        console.log(`⚠ [${result.email}] Orders: ${result.cancel.error || 'check failed'}`);
      }
    }
  } else {
    console.log(`   Cleanup skipped (Extended Exchange handles it during login)`);
  }
  
  console.log(`\n✓ Phase 1 completed.`);
  
  // Set leverage ONCE at the beginning (AFTER cleanup)
  console.log(`\n🔧 Phase 2: Setting leverage for accounts...`);
  const leveragePromises = [];
  
  // Only set leverage for non-Extended Exchange accounts
  if (krakenExchangeName !== 'Extended Exchange') {
    leveragePromises.push((async () => {
      console.log(`[${krakenEmail}] Setting leverage to ${TRADE_CONFIG.leverage}x...`);
      // Use Kraken-specific leverage function for Kraken exchange
      const isKraken = krakenExchangeName?.toLowerCase().includes('kraken') || krakenExchange?.name?.toLowerCase().includes('kraken');
      const result = isKraken 
        ? await setLeverageKraken(krakenPage, TRADE_CONFIG.leverage, krakenExchange)
        : await setLeverage(krakenPage, TRADE_CONFIG.leverage);
      return { email: krakenEmail, result };
    })());
  } else {
    console.log(`[${krakenEmail}] Skipping leverage - already set in clickOrdersTab() during login`);
  }
  
  if (grvtExchangeName !== 'Extended Exchange') {
    leveragePromises.push((async () => {
      console.log(`[${grvtEmail}] Setting leverage to ${TRADE_CONFIG.leverage}x...`);
      const result = await setLeverage(grvtPage, TRADE_CONFIG.leverage);
      return { email: grvtEmail, result };
    })());
  } else {
    console.log(`[${grvtEmail}] Skipping leverage - already set in clickOrdersTab() during login`);
  }
  
  if (extendedExchangeName !== 'Extended Exchange') {
    leveragePromises.push((async () => {
      console.log(`[${extendedEmail}] Setting leverage to ${TRADE_CONFIG.leverage}x...`);
      const result = await setLeverage(extendedPage, TRADE_CONFIG.leverage);
      return { email: extendedEmail, result };
    })());
  } else {
    console.log(`[${extendedEmail}] Skipping leverage - already set in clickOrdersTab() during login`);
  }
  
  if (leveragePromises.length > 0) {
    console.log(`   Setting leverage for ${leveragePromises.length} account(s)...`);
    const leverageResults = await Promise.all(leveragePromises);
    for (const { email, result } of leverageResults) {
      if (result.success) {
        console.log(`✓ [${email}] Leverage set to ${TRADE_CONFIG.leverage}x`);
      } else {
        console.log(`⚠ [${email}] Leverage setting: ${result.error || 'failed'}`);
      }
    }
  } else {
    console.log(`   Leverage setup skipped (all accounts are Extended Exchange)`);
  }
  
  console.log(`\n✓ Phase 2 completed.`);
  
  let cycleCount = 0;
  let initialCleanupDone = true;
  
  console.log(`\n🚀 Starting trading cycle loop...`);
  console.log(`   Loop will run continuously until Ctrl+C is pressed.`);
  console.log(`   First cycle will start immediately.\n`);
  
  while (!isShuttingDown) {
    cycleCount++;
    console.log(`\n>>> CYCLE ${cycleCount} - ${new Date().toLocaleTimeString()}`);
    
    try {
      // Step 0: Price Comparison with Threshold Check (first step of each cycle)
      console.log(`\n[CYCLE ${cycleCount}] Step 1: Comparing prices from all exchanges...`);
      
      const exchangeAccounts = [
        {
          page: krakenPage,
          email: krakenEmail,
          exchange: krakenExchangeName,
          exchangeConfig: krakenExchange
        },
        {
          page: grvtPage,
          email: grvtEmail,
          exchange: grvtExchangeName,
          exchangeConfig: grvtExchange
        },
        {
          page: extendedPage,
          email: extendedEmail,
          exchange: extendedExchangeName,
          exchangeConfig: extendedExchange
        }
      ];
      
      // Wait for price difference to meet threshold
      const priceComparison = await waitForPriceThreshold(
        exchangeAccounts, 
        TRADE_CONFIG.openingThreshold, 
        cycleCount
      );
      
      if (!priceComparison) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Could not get valid price comparison meeting threshold. Skipping this cycle...`);
        console.log(`[CYCLE ${cycleCount}] Waiting ${TRADE_CONFIG.waitTime / 1000} seconds before next cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }
      
      // Determine buy/sell sides based on price comparison
      const highestPriceExchange = priceComparison.highest;
      const lowestPriceExchange = priceComparison.lowest;
      
      console.log(`\n[CYCLE ${cycleCount}] Price-based trading decision:`);
      console.log(`   🔺 SELL on ${highestPriceExchange.exchange} (highest price: $${highestPriceExchange.price.toLocaleString()})`);
      console.log(`   🔻 BUY on ${lowestPriceExchange.exchange} (lowest price: $${lowestPriceExchange.price.toLocaleString()})`);
      console.log(`   Price spread: ${priceComparison.comparison.priceDiffPercent}%`);
      
      // Map exchanges to their pages and configs for trade execution
      const getAccountForExchange = (exchangeName) => {
        if (exchangeName === krakenExchange.name) {
          return { page: krakenPage, email: krakenEmail, exchange: krakenExchange };
        } else if (exchangeName === grvtExchange.name) {
          return { page: grvtPage, email: grvtEmail, exchange: grvtExchange };
        } else if (exchangeName === extendedExchange.name) {
          return { page: extendedPage, email: extendedEmail, exchange: extendedExchange };
        }
        return null;
      };
      
      const buyAccount = getAccountForExchange(lowestPriceExchange.exchange);
      const sellAccount = getAccountForExchange(highestPriceExchange.exchange);
      
      if (!buyAccount || !sellAccount) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Could not map exchanges to accounts. Skipping this cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }
      
      // Skip cleanup on first cycle (already done)
      let skipCleanup = false;
      if (initialCleanupDone && cycleCount === 1) {
        console.log(`\n[CYCLE ${cycleCount}] Skipping cleanup - initial cleanup was already done`);
        initialCleanupDone = false;
        skipCleanup = true;
      }

      // Check closing threshold before closing positions
      console.log(`\n[CYCLE ${cycleCount}] Checking closing threshold ($${TRADE_CONFIG.closingThreshold.toLocaleString()}) before closing positions...`);
      const closingPriceCheck = await waitForClosingThreshold(
        exchangeAccounts,
        TRADE_CONFIG.closingThreshold,
        cycleCount
      );
      
      // Close positions (skip for Extended Exchange - handled in clickOrdersTab)
      // closingPriceCheck can be null (force close after 15 min) or a valid comparison (threshold met)
      // Always close - either threshold is met or 15 minutes elapsed
      if (closingPriceCheck === null) {
        console.log(`\n[CYCLE ${cycleCount}] Force closing positions (15 minutes elapsed or threshold not met)...`);
      } else {
        console.log(`\n[CYCLE ${cycleCount}] Closing threshold met. Closing positions...`);
      }
              
      
      if (!skipCleanup) {
        // Cancel orders and close positions before new trades
        console.log(`\n[CYCLE ${cycleCount}] Canceling orders and closing positions...`);
        
        // Use Kraken-specific cancel function for Kraken exchange
        // Check exchange name from both exchange object and name property
        const buyIsKraken = buyAccount.exchange?.name === 'Kraken' || 
                           buyAccount.exchange?.name?.toLowerCase() === 'kraken' ||
                           buyAccount.exchange === 'Kraken';
        const sellIsKraken = sellAccount.exchange?.name === 'Kraken' || 
                            sellAccount.exchange?.name?.toLowerCase() === 'kraken' ||
                            sellAccount.exchange === 'Kraken';
        
        const cancelPromises = [
          buyIsKraken 
            ? cancelKrakenOrders(buyAccount.page)
            : cancelAllOrders(buyAccount.page),
          sellIsKraken 
            ? cancelKrakenOrders(sellAccount.page)
            : cancelAllOrders(sellAccount.page)
        ];
        
        const cancelResults = await Promise.all(cancelPromises);
        if (cancelResults[0].success) {
          console.log(`✓ [${buyAccount.email}] Orders canceled`);
        }
        if (cancelResults[1].success) {
          console.log(`✓ [${sellAccount.email}] Orders canceled`);
        }
        
        await delay(500);
        
        // Close positions (skip for Kraken - already handled by cancelKrakenOrders, skip for Extended Exchange - handled in clickOrdersTab)
        const closePromises = [];
        if (buyAccount.exchange.name !== 'Extended Exchange' && !buyIsKraken) {
          closePromises.push((async () => {
            const result = await closeAllPositions(buyAccount.page, 100, buyAccount.exchange);
            return { email: buyAccount.email, result };
          })());
        }
        if (sellAccount.exchange.name !== 'Extended Exchange' && !sellIsKraken) {
          closePromises.push((async () => {
            const result = await closeAllPositions(sellAccount.page, 100, sellAccount.exchange);
            return { email: sellAccount.email, result };
          })());
        }
        
        if (closePromises.length > 0) {
          const closeResults = await Promise.all(closePromises);
          for (const { email, result } of closeResults) {
            if (result.success) {
              console.log(`✓ [${email}] Positions closed`);
            }
          }
          await delay(300);
        } else if (buyIsKraken || sellIsKraken) {
          console.log(`✓ Positions already closed by cancelKrakenOrders() for Kraken accounts`);
        }
        
        // Pre-trade flow for Extended Exchange
        const hasExtendedExchange = buyAccount.exchange.name === 'Extended Exchange' || sellAccount.exchange.name === 'Extended Exchange';
        if (hasExtendedExchange) {
          console.log(`\n[CYCLE ${cycleCount}] Running pre-trade flow for Extended Exchange...`);
          const preTradePromises = [];
          if (buyAccount.exchange.name === 'Extended Exchange') {
            preTradePromises.push(clickOrdersTab(buyAccount.page, buyAccount.email, true));
          }
          if (sellAccount.exchange.name === 'Extended Exchange') {
            preTradePromises.push(clickOrdersTab(sellAccount.page, sellAccount.email, true));
          }
          if (preTradePromises.length > 0) {
            await Promise.all(preTradePromises);
            await delay(2000);
          }
        }
      }
      
      // Step 2: Execute trades based on price comparison
      console.log(`\n[CYCLE ${cycleCount}] Executing trades...`);
      console.log(`   BUY on ${buyAccount.exchange.name} (${buyAccount.email})`);
      console.log(`   SELL on ${sellAccount.exchange.name} (${sellAccount.email})`);
      
      // Helper function to wrap trade execution with timeout
      const executeTradeWithTimeout = async (page, tradeParams, exchange, timeoutMs = 30000) => {
        const tradePromise = executeTrade(page, tradeParams, exchange);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Trade execution timeout after ${timeoutMs}ms`)), timeoutMs)
        );
        
        try {
          return await Promise.race([tradePromise, timeoutPromise]);
        } catch (error) {
          console.log(`⚠️  [${exchange.name}] Trade execution error or timeout: ${error.message}`);
          return { success: false, error: error.message };
        }
      };
      
      const tradePromises = [
        executeTradeWithTimeout(buyAccount.page, {
          side: "buy",
          orderType: "limit",
          qty: TRADE_CONFIG.buyQty,
        }, buyAccount.exchange, 30000), // 30 second timeout
        executeTradeWithTimeout(sellAccount.page, {
          side: "sell",
          orderType: "limit",
          qty: TRADE_CONFIG.sellQty,
        }, sellAccount.exchange, 30000), // 30 second timeout
      ];
      
      // Use allSettled so one trade doesn't block the other
      const tradeResults = await Promise.allSettled(tradePromises);
      
      // Process buy result
      const buyResult = tradeResults[0].status === 'fulfilled' ? tradeResults[0].value : { success: false, error: tradeResults[0].reason?.message || 'Promise rejected' };
      const buySuccess = buyResult.success;
      
      if (buySuccess) {
        console.log(`✓ [${buyAccount.email}] BUY order placed successfully`);
      } else {
        console.log(`✗ [${buyAccount.email}] BUY order failed: ${buyResult.error || 'unknown error'}`);
      }
      
      // Process sell result
      const sellResult = tradeResults[1].status === 'fulfilled' ? tradeResults[1].value : { success: false, error: tradeResults[1].reason?.message || 'Promise rejected' };
      const sellSuccess = sellResult.success;
      
      if (sellSuccess) {
        console.log(`✓ [${sellAccount.email}] SELL order placed successfully`);
      } else {
        console.log(`✗ [${sellAccount.email}] SELL order failed: ${sellResult.error || 'unknown error'}`);
      }
      
      console.log(`\n[CYCLE ${cycleCount}] Trade execution completed (both trades processed)`);
      
      // Wait before next cycle
      const waitTime = TRADE_CONFIG.waitTime;
      console.log(`\n[CYCLE ${cycleCount}] Waiting ${waitTime / 1000} seconds before next cycle...`);
      await delay(waitTime);
      
    } catch (error) {
      console.error(`\n[CYCLE ${cycleCount}] Error in trading loop:`, error.message);
      console.error(error.stack);
      await delay(5000); // Wait 5 seconds before retrying
    }
  }
  
  console.log(`\n[Trading Loop] Exited after ${cycleCount} cycles`);
}

/**
 * Automated trading loop for 2 exchanges (price comparison mode)
 * Uses price comparison to determine buy/sell sides:
 * - Highest price exchange → SELL
 * - Lowest price exchange → BUY
 */
async function automatedTradingLoop2Exchanges(account1, account2) {
  const { page: page1, email: email1, exchange: exchange1Name } = account1;
  const { page: page2, email: email2, exchange: exchange2Name } = account2;
  
  // Get exchange configs
  const getExchangeKey = (exchangeName) => {
    if (!exchangeName) return 'kraken';
    const nameLower = exchangeName.toLowerCase();
    if (nameLower.includes('kraken')) return 'kraken';
    if (nameLower.includes('grvt')) return 'grvt';
    if (nameLower.includes('extended')) return 'extended';
    return 'kraken'; // default
  };
  
  const exchange1Key = getExchangeKey(exchange1Name);
  const exchange2Key = getExchangeKey(exchange2Name);
  
  const exchange1 = EXCHANGE_CONFIGS[exchange1Key] || EXCHANGE_CONFIGS.kraken;
  const exchange2 = EXCHANGE_CONFIGS[exchange2Key] || EXCHANGE_CONFIGS.grvt;
  
  console.log(`\n========================================`);
  console.log(`Starting Automated Trading Loop (2 Exchanges)`);
  console.log(`Exchange 1 (${email1}): ${exchange1.name}`);
  console.log(`Exchange 2 (${email2}): ${exchange2.name}`);
  console.log(`Leverage: ${TRADE_CONFIG.leverage}x`);
  console.log(`Quantity: ${TRADE_CONFIG.buyQty} BTC`);
  console.log(`Opening Threshold: $${TRADE_CONFIG.openingThreshold.toLocaleString()} (will wait until price difference >= threshold)`);
  console.log(`Closing Threshold: $${TRADE_CONFIG.closingThreshold.toLocaleString()} (will wait until price difference <= threshold, max 15 min)`);
  console.log(`========================================\n`);
  
  // Set leverage ONCE at the beginning (AFTER cleanup)
  console.log(`\n🔧 Phase 2: Setting leverage for accounts...`);
  const leveragePromises = [];
  
  if (exchange1Name !== 'Extended Exchange') {
    leveragePromises.push((async () => {
      console.log(`[${email1}] Setting leverage to ${TRADE_CONFIG.leverage}x...`);
      // Use Kraken-specific leverage function for Kraken exchange
      const isKraken = exchange1Name?.toLowerCase().includes('kraken') || exchange1?.name?.toLowerCase().includes('kraken');
      const result = isKraken 
        ? await setLeverageKraken(page1, TRADE_CONFIG.leverage, exchange1)
        : await setLeverage(page1, TRADE_CONFIG.leverage);
      return { email: email1, result };
    })());
  } else {
    console.log(`[${email1}] Skipping leverage - already set in clickOrdersTab() during login`);
  }
  
  if (exchange2Name !== 'Extended Exchange') {
    leveragePromises.push((async () => {
      console.log(`[${email2}] Setting leverage to ${TRADE_CONFIG.leverage}x...`);
      // Use Kraken-specific leverage function for Kraken exchange
      const isKraken = exchange2Name?.toLowerCase().includes('kraken') || exchange2?.name?.toLowerCase().includes('kraken');
      const result = isKraken 
        ? await setLeverageKraken(page2, TRADE_CONFIG.leverage, exchange2)
        : await setLeverage(page2, TRADE_CONFIG.leverage);
      return { email: email2, result };
    })());
  } else {
    console.log(`[${email2}] Skipping leverage - already set in clickOrdersTab() during login`);
  }
  
  if (leveragePromises.length > 0) {
    console.log(`   Setting leverage for ${leveragePromises.length} account(s)...`);
    const leverageResults = await Promise.all(leveragePromises);
    for (const { email, result } of leverageResults) {
      if (result.success) {
        console.log(`✓ [${email}] Leverage set to ${TRADE_CONFIG.leverage}x`);
      } else {
        console.log(`⚠ [${email}] Leverage setting: ${result.error || 'failed'}`);
      }
    }
  } else {
    console.log(`   Leverage setup skipped (all accounts are Extended Exchange)`);
  }
  
  console.log(`\n✓ Phase 2 completed.`);
  
  let cycleCount = 0;
  let initialCleanupDone = true;
  
  console.log(`\n🚀 Starting trading cycle loop...`);
  console.log(`   Loop will run continuously until Ctrl+C is pressed.`);
  console.log(`   First cycle will start immediately.\n`);
  
  while (!isShuttingDown) {
    cycleCount++;
    console.log(`\n>>> CYCLE ${cycleCount} - ${new Date().toLocaleTimeString()}`);
    
    try {
      // Setup exchange accounts array
      const exchangeAccounts = [
        {
          page: page1,
          email: email1,
          exchange: exchange1Name,
          exchangeConfig: exchange1
        },
        {
          page: page2,
          email: email2,
          exchange: exchange2Name,
          exchangeConfig: exchange2
        }
      ];
      
      // Map exchanges to their pages and configs for trade execution
      const getAccountForExchange = (exchangeName) => {
        if (exchangeName === exchange1.name) {
          return { page: page1, email: email1, exchange: exchange1 };
        } else if (exchangeName === exchange2.name) {
          return { page: page2, email: email2, exchange: exchange2 };
        }
        return null;
      };
      

            // Check for open positions and determine position sides
      const { account1OpenPositionSide, account2OpenPositionSide } = await checkOpenPositionsForAccounts({
        page1,
        page2,
        exchange1,
        exchange2,
        email1,
        email2,
        exchange1Name,
        exchange2Name
      });
      console.log(`account1OpenPositionSide`,account1OpenPositionSide);
      console.log(`account2OpenPositionSide`,account2OpenPositionSide);



      if(account1OpenPositionSide && account2OpenPositionSide){
        // Step 1: Check closing spread threshold before closing positions
        // Use saved opening threshold and CLOSING_SPREAD from env
        // Close when (price_difference - opening_threshold) >= CLOSING_SPREAD
        let closingPriceCheck = null;
        
        if (savedOpeningThreshold !== null) {
          console.log(`\n[CYCLE ${cycleCount}] Step 1: Checking closing spread threshold before closing positions...`);
          console.log(`   Saved opening threshold: $${savedOpeningThreshold.toLocaleString()}`);
          console.log(`   Closing spread threshold: $${TRADE_CONFIG.closingSpread.toLocaleString()}`);
          console.log(`   Will close when: (price_difference - opening_threshold) >= closing_spread`);
          
          closingPriceCheck = await waitForClosingSpreadThreshold(
            exchangeAccounts,
            savedOpeningThreshold,
            TRADE_CONFIG.closingSpread,
            cycleCount
          );
          
          // Clear saved opening threshold after using it
          console.log(`[CYCLE ${cycleCount}] 🗑️  Cleared saved opening threshold after use`);
          savedOpeningThreshold = null;
        } else {
          // Fallback to regular closing threshold if no saved opening threshold
          console.log(`\n[CYCLE ${cycleCount}] Step 1: No saved opening threshold found. Using regular closing threshold ($${TRADE_CONFIG.closingThreshold.toLocaleString()})...`);
          closingPriceCheck = await waitForClosingThreshold(
            exchangeAccounts,
            TRADE_CONFIG.closingThreshold,
            cycleCount
          );
        }
        
        // Close positions (skip for Extended Exchange - handled in clickOrdersTab)
        // closingPriceCheck can be null (force close after 15 min) or a valid comparison (threshold met)
        // Always close - either threshold is met or 15 minutes elapsed
        if (closingPriceCheck === null) {
          console.log(`\n[CYCLE ${cycleCount}] Force closing positions (15 minutes elapsed or threshold not met)...`);
        } else {
          console.log(`\n[CYCLE ${cycleCount}] Closing threshold met. Closing positions...`);
        }
      }

      
      // Step 2: Cancel orders and close positions for BOTH accounts (before determining buy/sell)
      console.log(`\n[CYCLE ${cycleCount}] Step 2: Canceling orders and closing positions for both accounts...`);
      
      const account1IsKraken = exchange1.name === 'Kraken' || exchange1Name?.toLowerCase() === 'kraken';
      const account2IsKraken = exchange2.name === 'Kraken' || exchange2Name?.toLowerCase() === 'kraken';
      
      // Reusable cleanup function
      const performCleanup = async (page, exchange, email, accountId, isKraken, isCloseAtMarket) => {
        try {
          // Check if isCloseAtMarket parameter was provided
          const wasCloseAtMarketProvided = isCloseAtMarket !== undefined;
          
          console.log(`[${exchange.name}] 🔄 Starting cleanup for ${accountId} (${email})...`);
          
          // For GRVT: Close any NotifyBarWrapper notifications before cleanup
          await closeNotifyBarWrapperNotifications(page, exchange, 'before cleanup');
          
          // Step 1: Cancel orders with retry logic and verification
          let cancelResult;
          let maxRetries = 3;
          let retryCount = 0;
          
          // Helper function to verify if orders still exist
          const verifyOrdersExist = async () => {
            if (isKraken) {
              // For Kraken, check Open Orders tab
              const hasOrders = await page.evaluate(() => {
                const container = document.getElementById('open-orders') || 
                                 Array.from(document.querySelectorAll('[role="table"]')).find(t => {
                                   const text = (t.textContent || '').toLowerCase();
                                   return (text.includes('limit') || text.includes('market')) && 
                                          (text.includes('buy') || text.includes('sell'));
                                 });
                if (!container) return false;
                const rows = Array.from(container.querySelectorAll('[role="button"], tr'));
                return rows.some(row => {
                  const text = (row.textContent || '').toLowerCase();
                  return (text.includes('limit') || text.includes('market')) &&
                         (text.includes('buy') || text.includes('sell')) &&
                         !text.includes('canceled') && !text.includes('filled');
                });
              });
              return hasOrders;
            } else {
              // For other exchanges, check for order tables
              const hasOrders = await page.evaluate(() => {
                const tables = Array.from(document.querySelectorAll('table'));
                for (const table of tables) {
                  const rows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
                  const orderRows = rows.filter(row => {
                    if (row.offsetParent === null) return false;
                    const text = (row.textContent || '').toLowerCase();
                    return (text.includes('limit') || text.includes('market') || text.includes('pending')) &&
                           !text.includes('canceled') && !text.includes('filled');
                  });
                  if (orderRows.length > 0) return true;
                }
                return false;
              });
              return hasOrders;
            }
          };
          
          while (retryCount < maxRetries) {
            cancelResult = isKraken 
              ? (wasCloseAtMarketProvided 
                  ? await cancelKrakenOrders(page, true)  // Pass true if parameter was provided
                  : await cancelKrakenOrders(page))  // Don't pass parameter if not provided
              : await cancelAllOrders(page);
            
            // For GRVT: Wait longer for orders to be fully canceled (GRVT UI can be slower)
            const waitTime = exchange.name === 'GRVT' ? 4000 : 1000;
            console.log(`[${exchange.name}] Waiting ${waitTime}ms for UI to update after order cancellation...`);
            await delay(waitTime);
            
            // Verify if orders still exist (with additional wait for GRVT)
            let ordersStillExist = await verifyOrdersExist();
            
            // For GRVT: Double-check after additional wait if orders still exist
            if (exchange.name === 'GRVT' && ordersStillExist) {
              console.log(`[${exchange.name}] Orders still detected, waiting additional 3 seconds for GRVT to process cancellation...`);
              await delay(3000);
              ordersStillExist = await verifyOrdersExist();
              
              // If still exist, wait one more time
              if (ordersStillExist) {
                console.log(`[${exchange.name}] Orders still detected after first wait, waiting additional 2 seconds...`);
                await delay(2000);
                ordersStillExist = await verifyOrdersExist();
              }
            }
            
            if (cancelResult.success && !ordersStillExist) {
              console.log(`✓ [${email}] All orders canceled successfully`);
              // For GRVT: Additional wait to ensure cancellation is fully processed before leaving orders tab
              if (exchange.name === 'GRVT') {
                console.log(`[${exchange.name}] Orders canceled, waiting additional 2 seconds to ensure GRVT fully processes cancellation...`);
                await delay(2000);
                // Final check to make sure orders are still gone
                const finalVerify = await verifyOrdersExist();
                if (!finalVerify) {
                  console.log(`✓ [${email}] GRVT orders confirmed canceled - safe to proceed to positions`);
                  break;
                } else {
                  console.log(`⚠️  [${email}] GRVT orders reappeared, will retry...`);
                  ordersStillExist = true;
                }
              } else {
                break;
              }
            } else if (ordersStillExist) {
              retryCount++;
              const remainingCount = cancelResult.remaining || 'unknown';
              console.log(`⚠️  [${email}] Orders still exist after cancellation attempt ${retryCount}/${maxRetries} (remaining: ${remainingCount})`);
              if (retryCount < maxRetries) {
                console.log(`[${email}] Retrying order cancellation in 2 seconds...`);
                await delay(2000);
              } else {
                console.log(`⚠️  [${email}] Max retries reached. Some orders may still remain.`);
              }
            } else if (!cancelResult.success) {
              retryCount++;
              console.log(`⚠️  [${email}] Order cancellation failed: ${cancelResult.message || 'Unknown error'}`);
              if (retryCount < maxRetries) {
                console.log(`[${email}] Retrying order cancellation in 2 seconds...`);
                await delay(2000);
              }
            } else {
              // Success but verification passed
              break;
            }
          }
          
          // Final verification before proceeding to position close
          if (retryCount >= maxRetries) {
            const finalCheck = await verifyOrdersExist();
            if (finalCheck) {
              console.log(`❌ [${email}] Failed to cancel all orders after ${maxRetries} attempts. Some orders may still remain.`);
              // For GRVT: Wait a bit more and check one more time before giving up
              if (exchange.name === 'GRVT') {
                console.log(`[${exchange.name}] Waiting additional 5 seconds for GRVT orders to cancel before proceeding...`);
                await delay(5000);
                const finalCheck2 = await verifyOrdersExist();
                if (finalCheck2) {
                  console.log(`❌ [${email}] GRVT orders still exist after extended wait. Proceeding to position close anyway.`);
                } else {
                  console.log(`✓ [${email}] GRVT orders finally canceled after extended wait.`);
                }
              }
            }
          } else {
            // Even if cancellation succeeded, wait a bit more for GRVT to fully process
            if (exchange.name === 'GRVT') {
              console.log(`[${exchange.name}] Order cancellation succeeded, waiting additional 2 seconds for GRVT to fully process before leaving orders tab...`);
              await delay(2000);
              // One final verification
              const finalVerify = await verifyOrdersExist();
              if (finalVerify) {
                console.log(`⚠️  [${email}] GRVT orders detected again after wait - will need to retry`);
              } else {
                console.log(`✓ [${email}] GRVT orders confirmed gone - safe to proceed to positions tab`);
              }
            }
          }
          
          // Step 2: Close positions (skip for Kraken - already handled by cancelKrakenOrders, skip for Extended Exchange - handled in clickOrdersTab)
          if (exchange.name !== 'Extended Exchange' && !isKraken) {
            console.log(`[${exchange.name}] 🔄 Starting position close for ${accountId}...`);
            // For GRVT: Wait longer between cancel and close to ensure orders are fully processed
            const delayBeforeClose = exchange.name === 'GRVT' ? 1500 : 500;
            console.log(`[${exchange.name}] Waiting ${delayBeforeClose}ms before closing positions...`);
            await delay(delayBeforeClose);
            const closeResult = wasCloseAtMarketProvided
              ? await closeAllPositions(page, 100, exchange, true)  // Pass true if parameter was provided
              : await closeAllPositions(page, 100, exchange);  // Don't pass parameter if not provided
            if (closeResult.success) {
              console.log(`✓ [${email}] Positions closed`);
            } else {
              console.log(`⚠️  [${email}] Position close result: ${closeResult.message || 'Unknown error'}`);
            }
            return { email, cancelResult, closeResult };
          }
          
          return { email, cancelResult, closeResult: null };
        } catch (error) {
          console.log(`❌ [${email}] Error in cleanup: ${error.message}`);
          console.log(`❌ [${email}] Error stack: ${error.stack}`);
          return { email, error: error.message };
        }
      };
      
      // First cleanup attempt based on initial position check
      const cleanups = [];
      // if (account1OpenPositionSide) {
      //   console.log(`[${exchange1.name}] Account 1 has open position (${account1OpenPositionSide}), adding to cleanup...`);
      //   cleanups.push(performCleanup(page1, exchange1, email1, 'Account 1', account1IsKraken));
      // }
      // if (account2OpenPositionSide) {
      //   console.log(`[${exchange2.name}] Account 2 has open position (${account2OpenPositionSide}), adding to cleanup...`);
      //   cleanups.push(performCleanup(page2, exchange2, email2, 'Account 2', account2IsKraken));
      // }

      cleanups.push(performCleanup(page1, exchange1, email1, 'Account 1', account1IsKraken));
      cleanups.push(performCleanup(page2, exchange2, email2, 'Account 2', account2IsKraken));
      
      if (cleanups.length) {
        console.log(`[CYCLE ${cycleCount}] Starting cleanup for ${cleanups.length} account(s)...`);
        await Promise.all(cleanups);
        console.log(`[CYCLE ${cycleCount}] Cleanup completed for all accounts`);
      } else {
        console.log(`[CYCLE ${cycleCount}] No cleanup needed - no open positions detected`);
      }

      // Re-check positions after cleanup
      const params = {
        page1,
        page2,
        exchange1,
        exchange2,
        email1,
        email2,
        exchange1Name,
        exchange2Name
      };
      
      let checkOPenPositions = await checkOpenPositionsForAccounts(params);
      
      // If positions still open, wait and retry cleanup
      if (checkOPenPositions.account1OpenPositionSide || checkOPenPositions.account2OpenPositionSide) {
        console.log(`[CYCLE ${cycleCount}] Positions still open after cleanup, waiting 10 seconds before retry...`);
        await delay(10000);
        checkOPenPositions = await checkOpenPositionsForAccounts(params);
        console.log(`checking position close after initial cleanup account 1 : ${checkOPenPositions.account1OpenPositionSide}`);
        console.log(`checking position close after initial cleanup account 2 : ${checkOPenPositions.account2OpenPositionSide}`);
        const cleanUpRetry = [];
        if (checkOPenPositions.account1OpenPositionSide) {
          console.log(`[${exchange1.name}] Account 1 still has open position (${checkOPenPositions.account1OpenPositionSide}), retrying cleanup...`);
          cleanUpRetry.push(performCleanup(page1, exchange1, email1, 'Account 1', account1IsKraken));
        }
        if (checkOPenPositions.account2OpenPositionSide) {
          console.log(`[${exchange2.name}] Account 2 still has open position (${checkOPenPositions.account2OpenPositionSide}), retrying cleanup...`);
          cleanUpRetry.push(performCleanup(page2, exchange2, email2, 'Account 2', account2IsKraken));
        }
        
        if (cleanUpRetry.length) {
          console.log(`[CYCLE ${cycleCount}] Starting cleanup retry for ${cleanUpRetry.length} account(s)...`);
          await Promise.all(cleanUpRetry);
          console.log(`[CYCLE ${cycleCount}] Cleanup retry completed for all accounts`);
        }
      }
      else {
        console.log("clean up successfull in first attempt");
      }

      let checkOPenPositionsAfterLimitOrderFallback = await checkOpenPositionsForAccounts(params);

      if (checkOPenPositionsAfterLimitOrderFallback.account1OpenPositionSide || checkOPenPositionsAfterLimitOrderFallback.account2OpenPositionSide) {
        await Promise.all([performCleanup(page1, exchange1, email1, 'Account 1', account1IsKraken, true), performCleanup(page2, exchange2, email2, 'Account 2', account2IsKraken, true)]);
      }




      const executeTradeWithTimeout = async (page, tradeParams, exchange, timeoutMs = 30000, thresholdMetTime = null, cycleCount = null, side = '', email = '') => {
        // Pass timing info to executeTrade
        const tradePromise = executeTrade(page, tradeParams, exchange, thresholdMetTime, cycleCount, side, email);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Trade execution timeout after ${timeoutMs}ms`)), timeoutMs)
        );
        
        try {
          return await Promise.race([tradePromise, timeoutPromise]);
        } catch (error) {
          console.log(`⚠️  [${exchange.name}] Trade execution error or timeout: ${error.message}`);
          return { success: false, error: error.message };
        }
      };      
      
      // Log summary
      if (account1IsKraken || account2IsKraken) {
        console.log(`✓ Positions already closed by cancelKrakenOrders() for Kraken accounts`);
      }
      
      await delay(300); // Small delay after cleanup

      // Step 3: Get price comparison FIRST to determine buy/sell accounts (BEFORE pre-filling forms)
      console.log(`\n[CYCLE ${cycleCount}] Step 3: Getting price comparison to determine buy/sell accounts...`);
      const priceComparison = await comparePricesFromExchanges(exchangeAccounts);
      
      if (!priceComparison.success || priceComparison.successfulPrices.length < 2) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Price comparison failed. Skipping this cycle...`);
        console.log(`[CYCLE ${cycleCount}] Waiting ${TRADE_CONFIG.waitTime / 1000} seconds before next cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }
      
      // Determine buy/sell sides based on price comparison
      // High price exchange = SELL, Low price exchange = BUY
      const highestPriceExchange = priceComparison.highest;
      const lowestPriceExchange = priceComparison.lowest;
      
      console.log(`\n[CYCLE ${cycleCount}] Price-based trading decision:`);
      console.log(`   🔺 SELL on ${highestPriceExchange.exchange} (highest price: $${highestPriceExchange.price.toLocaleString()})`);
      console.log(`   🔻 BUY on ${lowestPriceExchange.exchange} (lowest price: $${lowestPriceExchange.price.toLocaleString()})`);
      console.log(`   Price spread: ${priceComparison.comparison.priceDiffPercent}%`);
      
      const buyAccount = getAccountForExchange(lowestPriceExchange.exchange);
      const sellAccount = getAccountForExchange(highestPriceExchange.exchange);
      
      if (!buyAccount || !sellAccount) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Could not map exchanges to accounts. Skipping this cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }

      // Step 4: Pre-fill forms for BOTH GRVT and Kraken (order type, quantity, TP/SL - excluding price and side)
      // Now we know which account is buy/sell, so we can pre-fill with correct quantities
      // Threshold check will run in parallel with prefilling
      console.log(`\n[CYCLE ${cycleCount}] Step 4: Pre-filling forms for BOTH GRVT and Kraken (order type, quantity, TP/SL - excluding price and side)...`);
      console.log(`[CYCLE ${cycleCount}]    Buy account: ${buyAccount.exchange.name} (${buyAccount.email})`);
      console.log(`[CYCLE ${cycleCount}]    Sell account: ${sellAccount.exchange.name} (${sellAccount.email})`);
      
      const { prefillFormKraken, prefillFormGrvt } = await import('../trading/prefillForm.js');
      
      // Pre-fill both GRVT and Kraken accounts in parallel with correct quantities based on buy/sell determination
      const prefillPromises = [];
      
      // Pre-fill buy account
      const buyAccountIsKraken = buyAccount.exchange.name?.toLowerCase().includes('kraken');
      const buyAccountIsGrvt = buyAccount.exchange.name?.toLowerCase().includes('grvt');
      if (buyAccountIsKraken) {
        prefillPromises.push(
          prefillFormKraken(buyAccount.page, { orderType: "limit", qty: TRADE_CONFIG.buyQty }, buyAccount.exchange)
            .then(result => ({ email: buyAccount.email, exchange: 'kraken', side: 'buy', result }))
            .catch(error => ({ email: buyAccount.email, exchange: 'kraken', side: 'buy', result: { success: false, error: error.message } }))
        );
      } else if (buyAccountIsGrvt) {
        prefillPromises.push(
          prefillFormGrvt(buyAccount.page, { orderType: "limit", qty: TRADE_CONFIG.buyQty }, buyAccount.exchange)
            .then(result => ({ email: buyAccount.email, exchange: 'grvt', side: 'buy', result }))
            .catch(error => ({ email: buyAccount.email, exchange: 'grvt', side: 'buy', result: { success: false, error: error.message } }))
        );
      }
      
      // Pre-fill sell account
      const sellAccountIsKraken = sellAccount.exchange.name?.toLowerCase().includes('kraken');
      const sellAccountIsGrvt = sellAccount.exchange.name?.toLowerCase().includes('grvt');
      if (sellAccountIsKraken) {
        prefillPromises.push(
          prefillFormKraken(sellAccount.page, { orderType: "limit", qty: TRADE_CONFIG.sellQty }, sellAccount.exchange)
            .then(result => ({ email: sellAccount.email, exchange: 'kraken', side: 'sell', result }))
            .catch(error => ({ email: sellAccount.email, exchange: 'kraken', side: 'sell', result: { success: false, error: error.message } }))
        );
      } else if (sellAccountIsGrvt) {
        prefillPromises.push(
          prefillFormGrvt(sellAccount.page, { orderType: "limit", qty: TRADE_CONFIG.sellQty }, sellAccount.exchange)
            .then(result => ({ email: sellAccount.email, exchange: 'grvt', side: 'sell', result }))
            .catch(error => ({ email: sellAccount.email, exchange: 'grvt', side: 'sell', result: { success: false, error: error.message } }))
        );
      }
      
      // Step 5: Wait for opening threshold IN PARALLEL with prefilling
      // If threshold is met during prefilling, continue prefilling until both are done
      console.log(`\n[CYCLE ${cycleCount}] Step 5: Checking opening threshold IN PARALLEL with form prefilling...`);
      const thresholdPromise = waitForPriceThreshold(
        exchangeAccounts, 
        TRADE_CONFIG.openingThreshold, 
        cycleCount
      );
      
      // Wait for BOTH prefilling and threshold check to complete
      // Even if threshold is met, we wait for prefilling to finish
      const [prefillResults, thresholdPriceComparison] = await Promise.all([
        Promise.all(prefillPromises),
        thresholdPromise
      ]);
      
      // Store prefill data for later use (for both GRVT and Kraken) - keyed by email
      const prefillData = {};
      for (const { email, exchange: exch, side, result } of prefillResults) {
        if (result.success) {
          prefillData[email] = { ...result, exchange: exch, side };
          console.log(`[CYCLE ${cycleCount}] ✅ ${side.toUpperCase()} account (${email}, ${exch}) pre-filled successfully`);
        } else {
          console.log(`[CYCLE ${cycleCount}] ⚠️  ${side.toUpperCase()} account (${email}, ${exch}) pre-fill failed: ${result.error}`);
        }
      }
      
      if (!thresholdPriceComparison) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Opening threshold not met. Skipping trade execution this cycle...`);
        console.log(`[CYCLE ${cycleCount}] Waiting ${TRADE_CONFIG.waitTime / 1000} seconds before next cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }
      
      // ⏱️ START TIMING: Opening threshold met - start measuring form fill + submit time
      const thresholdMetTime = Date.now();
      console.log(`\n[CYCLE ${cycleCount}] ⏱️  [TIMING] Opening threshold met at ${new Date(thresholdMetTime).toISOString()}`);
      console.log(`[CYCLE ${cycleCount}] ✅ All forms pre-filled. Proceeding with quick fill...`);
      
      // Step 5b: Price comparison at threshold - update buy/sell sides based on current prices
      // Prices may have changed during threshold wait, so we re-compare and update sides
      const finalHighestPriceExchange = thresholdPriceComparison.highest;
      const finalLowestPriceExchange = thresholdPriceComparison.lowest;
      
      console.log(`\n[CYCLE ${cycleCount}] Opening threshold met. Price comparison and side update:`);
      console.log(`   🔺 SELL on ${finalHighestPriceExchange.exchange} (highest price: $${finalHighestPriceExchange.price.toLocaleString()})`);
      console.log(`   🔻 BUY on ${finalLowestPriceExchange.exchange} (lowest price: $${finalLowestPriceExchange.price.toLocaleString()})`);
      console.log(`   Price spread: ${thresholdPriceComparison.comparison.priceDiffPercent}%`);
      
      // Re-determine accounts based on threshold price comparison (sides may have changed)
      const finalBuyAccount = getAccountForExchange(finalLowestPriceExchange.exchange);
      const finalSellAccount = getAccountForExchange(finalHighestPriceExchange.exchange);
      
      if (!finalBuyAccount || !finalSellAccount) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Could not map exchanges to accounts after threshold check. Skipping this cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }
      
      // Check if sides changed between initial comparison and threshold check
      const sidesChanged = (buyAccount.email !== finalBuyAccount.email) || (sellAccount.email !== finalSellAccount.email);
      if (sidesChanged) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Sides changed between initial comparison and threshold check:`);
        console.log(`   Initial: BUY=${buyAccount.email}, SELL=${sellAccount.email}`);
        console.log(`   Final:   BUY=${finalBuyAccount.email}, SELL=${finalSellAccount.email}`);
        console.log(`   Note: Prefill data may be for different accounts, but side will be set correctly during execution.`);
      } else {
        console.log(`\n[CYCLE ${cycleCount}] ✓ Sides unchanged - same accounts for buy/sell`);
      }
      
      // Use final accounts for trade execution (from threshold price comparison)
      const tradeBuyAccount = finalBuyAccount;
      const tradeSellAccount = finalSellAccount;
      
      // Step 6: Execute trades using quick fill for BOTH GRVT and Kraken (with prefill - side and price filled after threshold)
      console.log(`\n[CYCLE ${cycleCount}] Step 6: Executing trades using quick fill (both GRVT and Kraken)...`);
      console.log(`   BUY on ${tradeBuyAccount.exchange.name} (${tradeBuyAccount.email}) at $${finalLowestPriceExchange.price.toLocaleString()}`);
      console.log(`   SELL on ${tradeSellAccount.exchange.name} (${tradeSellAccount.email}) at $${finalHighestPriceExchange.price.toLocaleString()}`);
      
      // Helper function for Kraken quick fill (with prefill)
      const quickFillAndSubmitKrakenWithTimeout = async (page, price, tradeParams, exchange, prefillData, timeoutMs = 30000, thresholdMetTime, cycleCount, sideLabel, email) => {
        const { fillPriceSideAndSubmitKraken } = await import('../trading/prefillForm.js');
        
        const quickFillPromise = fillPriceSideAndSubmitKraken(page, price, tradeParams, exchange, thresholdMetTime, cycleCount, sideLabel, email, prefillData);
        
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Quick fill timeout after ${timeoutMs}ms`)), timeoutMs)
        );
        
        try {
          return await Promise.race([quickFillPromise, timeoutPromise]);
        } catch (error) {
          console.log(`⚠️  [${exchange.name}] Quick fill error or timeout: ${error.message}`);
          return { success: false, error: error.message };
        }
      };
      
      // Helper function for GRVT quick fill (with prefill)
      const quickFillAndSubmitGrvtWithTimeout = async (page, price, tradeParams, exchange, prefillData, timeoutMs = 30000, thresholdMetTime, cycleCount, sideLabel, email) => {
        const { fillPriceSideAndSubmitGrvt } = await import('../trading/prefillForm.js');
        
        const quickFillPromise = fillPriceSideAndSubmitGrvt(page, price, tradeParams, exchange, thresholdMetTime, cycleCount, sideLabel, email, prefillData);
        
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Quick fill timeout after ${timeoutMs}ms`)), timeoutMs)
        );
        
        try {
          return await Promise.race([quickFillPromise, timeoutPromise]);
        } catch (error) {
          console.log(`⚠️  [${exchange.name}] Quick fill error or timeout: ${error.message}`);
          return { success: false, error: error.message };
        }
      };
      
      // Determine which accounts are Kraken vs GRVT
      const buyIsKraken = tradeBuyAccount.exchange.name?.toLowerCase().includes('kraken');
      const buyIsGrvt = tradeBuyAccount.exchange.name?.toLowerCase().includes('grvt');
      const sellIsKraken = tradeSellAccount.exchange.name?.toLowerCase().includes('kraken');
      const sellIsGrvt = tradeSellAccount.exchange.name?.toLowerCase().includes('grvt');
      
      // Execute trades based on exchange type - use quick fill for both GRVT and Kraken
      console.log(`[CYCLE ${cycleCount}] Starting parallel trade execution - waiting for both to complete...`);
      
      const buyTradePromise = buyIsKraken
        ? quickFillAndSubmitKrakenWithTimeout(
            tradeBuyAccount.page,
            finalLowestPriceExchange.price,
            { side: "buy", orderType: "limit", qty: TRADE_CONFIG.buyQty },
            tradeBuyAccount.exchange,
            prefillData[tradeBuyAccount.email] || {},
            30000,
            thresholdMetTime,
            cycleCount,
            'BUY',
            tradeBuyAccount.email
          )
        : buyIsGrvt
        ? quickFillAndSubmitGrvtWithTimeout(
            tradeBuyAccount.page,
            finalLowestPriceExchange.price,
            { side: "buy", orderType: "limit", qty: TRADE_CONFIG.buyQty },
            tradeBuyAccount.exchange,
            prefillData[tradeBuyAccount.email] || {},
            30000,
            thresholdMetTime,
            cycleCount,
            'BUY',
            tradeBuyAccount.email
          )
        : executeTradeWithTimeout(
            tradeBuyAccount.page,
            {
              side: "buy",
              orderType: "limit",
              price: finalLowestPriceExchange.price,
              qty: TRADE_CONFIG.buyQty
            },
            tradeBuyAccount.exchange,
            30000,
            thresholdMetTime,
            cycleCount,
            'BUY',
            tradeBuyAccount.email
          );
      
      const sellTradePromise = sellIsKraken
        ? quickFillAndSubmitKrakenWithTimeout(
            tradeSellAccount.page,
            finalHighestPriceExchange.price,
            { side: "sell", orderType: "limit", qty: TRADE_CONFIG.sellQty },
            tradeSellAccount.exchange,
            prefillData[tradeSellAccount.email] || {},
            30000,
            thresholdMetTime,
            cycleCount,
            'SELL',
            tradeSellAccount.email
          )
        : sellIsGrvt
        ? quickFillAndSubmitGrvtWithTimeout(
            tradeSellAccount.page,
            finalHighestPriceExchange.price,
            { side: "sell", orderType: "limit", qty: TRADE_CONFIG.sellQty },
            tradeSellAccount.exchange,
            prefillData[tradeSellAccount.email] || {},
            30000,
            thresholdMetTime,
            cycleCount,
            'SELL',
            tradeSellAccount.email
          )
        : executeTradeWithTimeout(
            tradeSellAccount.page,
            {
              side: "sell",
              orderType: "limit",
              price: finalHighestPriceExchange.price,
              qty: TRADE_CONFIG.sellQty
            },
            tradeSellAccount.exchange,
            30000,
            thresholdMetTime,
            cycleCount,
            'SELL',
            tradeSellAccount.email
          );
      
      // Use allSettled to wait for BOTH promises to complete (fulfilled or rejected)
      // This ensures we wait for both trades before continuing
      console.log(`[CYCLE ${cycleCount}] ⏳ Waiting for both trades to complete (this may take up to 30 seconds)...`);
      const startTime = Date.now();
      
      // CRITICAL: await Promise.allSettled() will block here until BOTH promises settle
      // This means the code will NOT continue until both buyTradePromise and sellTradePromise complete
      const tradeResults = await Promise.allSettled([buyTradePromise, sellTradePromise]);
      
      const elapsedTime = Date.now() - startTime;
      console.log(`[CYCLE ${cycleCount}] ✅ Both trades completed after ${(elapsedTime / 1000).toFixed(2)}s. Processing results...`);
      
      // Verify both promises have settled
      const buySettled = tradeResults[0].status === 'fulfilled' || tradeResults[0].status === 'rejected';
      const sellSettled = tradeResults[1].status === 'fulfilled' || tradeResults[1].status === 'rejected';
      
      if (!buySettled || !sellSettled) {
        console.log(`⚠️  [CYCLE ${cycleCount}] Warning: Not all trades settled properly. Buy: ${buySettled}, Sell: ${sellSettled}`);
      } else {
        console.log(`[CYCLE ${cycleCount}] ✓ Both trades have settled. Continuing to next step...`);
      }
      
      // Process buy result
      const buyResult = tradeResults[0].status === 'fulfilled' ? tradeResults[0].value : { success: false, error: tradeResults[0].reason?.message || 'Promise rejected' };
      const buySuccess = buyResult.success;
      
      if (buySuccess) {
        console.log(`✓ [${tradeBuyAccount.email}] BUY order placed successfully`);
      } else {
        console.log(`✗ [${tradeBuyAccount.email}] BUY order failed: ${buyResult.error || 'unknown error'}`);
      }
      
      // Process sell result
      const sellResult = tradeResults[1].status === 'fulfilled' ? tradeResults[1].value : { success: false, error: tradeResults[1].reason?.message || 'Promise rejected' };
      const sellSuccess = sellResult.success;
      
      if (sellSuccess) {
        console.log(`✓ [${tradeSellAccount.email}] SELL order placed successfully`);
      } else {
        console.log(`✗ [${tradeSellAccount.email}] SELL order failed: ${sellResult.error || 'unknown error'}`);
      }
      
      // CRITICAL: Wait for both orders to be fully placed and processed before checking positions
      // executeTrade returns when order is placed, but we need to wait for orders to potentially fill
      // GRVT takes longer to place orders than Kraken, so we need to wait longer if GRVT is involved
      // Note: buyIsGrvt and sellIsGrvt are already declared above (line 1927, 1929)
      const hasGrvt = buyIsGrvt || sellIsGrvt;
      
      if (hasGrvt) {
        console.log(`[CYCLE ${cycleCount}] ⏳ GRVT detected - waiting longer for orders to be fully placed and processed (GRVT is slower than Kraken)...`);
        await delay(7000); // Wait 7 seconds for GRVT orders to potentially fill
        console.log(`[CYCLE ${cycleCount}] ✅ Waited for GRVT order processing, now checking positions...`);
      } else {
        console.log(`[CYCLE ${cycleCount}] ⏳ Waiting for orders to be fully processed before checking positions...`);
        await delay(3000); // Wait 3 seconds for orders to potentially fill
        console.log(`[CYCLE ${cycleCount}] ✅ Waited for order processing, now checking positions...`);
      }
      
      // Step 7: Check if positions opened on both sides after order placement
      console.log(`\n[CYCLE ${cycleCount}] 📊 Checking position status after order placement...`);
      const positionCheck = await checkOpenPositionsForAccounts(params);
      const account1HasPosition = !!positionCheck.account1OpenPositionSide;
      const account2HasPosition = !!positionCheck.account2OpenPositionSide;
      const account1PositionSide = positionCheck.account1OpenPositionSide || 'none';
      const account2PositionSide = positionCheck.account2OpenPositionSide || 'none';
      
      // Log position status
      console.log(`[CYCLE ${cycleCount}] 📊 Position Status After Order Placement:`);
      console.log(`   Account 1 (${email1} - ${exchange1.name}): ${account1HasPosition ? `✅ OPEN (${account1PositionSide})` : '❌ NO POSITION'}`);
      console.log(`   Account 2 (${email2} - ${exchange2.name}): ${account2HasPosition ? `✅ OPEN (${account2PositionSide})` : '❌ NO POSITION'}`);
      
      // Check if both positions opened
      if (account1HasPosition && account2HasPosition) {
        console.log(`[CYCLE ${cycleCount}] ✅ SUCCESS: Both positions opened successfully!`);
        console.log(`   Account 1: ${account1PositionSide}, Account 2: ${account2PositionSide}`);
        
        // Save the opening threshold that was used for this trade
        // This will be used in the next cycle before closing positions
        savedOpeningThreshold = TRADE_CONFIG.openingThreshold;
        console.log(`[CYCLE ${cycleCount}] 💾 Saved opening threshold: $${savedOpeningThreshold.toLocaleString()} (will be used in next cycle before closing)`);
        
        // Step 7.5: Verify position directions match expected directions
        console.log(`\n[CYCLE ${cycleCount}] 🔍 Checking position directions match expected directions...`);
        
        // Determine expected directions based on which account was buy vs sell
        const account1ExpectedSide = tradeBuyAccount.email === email1 ? 'long' : 'short';
        const account2ExpectedSide = tradeBuyAccount.email === email2 ? 'long' : 'short';
        
        console.log(`[CYCLE ${cycleCount}] Expected directions:`);
        console.log(`   Account 1 (${email1}): Expected ${account1ExpectedSide.toUpperCase()}, Got ${account1PositionSide.toUpperCase()}`);
        console.log(`   Account 2 (${email2}): Expected ${account2ExpectedSide.toUpperCase()}, Got ${account2PositionSide.toUpperCase()}`);
        
        const account1DirectionCorrect = account1PositionSide === account1ExpectedSide;
        const account2DirectionCorrect = account2PositionSide === account2ExpectedSide;
        
        if (account1DirectionCorrect && account2DirectionCorrect) {
          console.log(`[CYCLE ${cycleCount}] ✅ Position directions are CORRECT! Both positions match expected directions.`);
        } else {
          console.log(`\n[CYCLE ${cycleCount}] ⚠️  ⚠️  ⚠️  CRITICAL: Position directions are WRONG!`);
          console.log(`   Account 1: Expected ${account1ExpectedSide}, Got ${account1PositionSide} - ${account1DirectionCorrect ? '✅ CORRECT' : '❌ WRONG'}`);
          console.log(`   Account 2: Expected ${account2ExpectedSide}, Got ${account2PositionSide} - ${account2DirectionCorrect ? '✅ CORRECT' : '❌ WRONG'}`);
          console.log(`[CYCLE ${cycleCount}] 🚨 Closing both positions ASAP due to wrong direction!`);
          
          // Close both positions immediately (use market close for speed)
          const closePromises = [];
          
          if (!account1DirectionCorrect || !account2DirectionCorrect) {
            // Close Account 1 if direction is wrong
            if (!account1DirectionCorrect) {
              console.log(`[CYCLE ${cycleCount}] 🔄 Closing Account 1 position (wrong direction: expected ${account1ExpectedSide}, got ${account1PositionSide})...`);
              closePromises.push(
                performCleanup(
                  page1,
                  exchange1,
                  email1,
                  'Account 1',
                  account1IsKraken,
                  true // Force market close for speed
                )
              );
            }
            
            // Close Account 2 if direction is wrong
            if (!account2DirectionCorrect) {
              console.log(`[CYCLE ${cycleCount}] 🔄 Closing Account 2 position (wrong direction: expected ${account2ExpectedSide}, got ${account2PositionSide})...`);
              closePromises.push(
                performCleanup(
                  page2,
                  exchange2,
                  email2,
                  'Account 2',
                  account2IsKraken,
                  true // Force market close for speed
                )
              );
            }
            
            // Wait for both to close
            if (closePromises.length > 0) {
              await Promise.all(closePromises);
              console.log(`[CYCLE ${cycleCount}] ✅ Closed positions with wrong directions`);
              
              // Verify positions are closed
              await delay(3000);
              const verifyAfterClose = await checkOpenPositionsForAccounts(params);
              const account1StillOpen = !!verifyAfterClose.account1OpenPositionSide;
              const account2StillOpen = !!verifyAfterClose.account2OpenPositionSide;
              
              if (account1StillOpen || account2StillOpen) {
                console.log(`[CYCLE ${cycleCount}] ⚠️  Some positions still open after close attempt, retrying with market close...`);
                const retryClosePromises = [];
                if (account1StillOpen) {
                  retryClosePromises.push(
                    performCleanup(page1, exchange1, email1, 'Account 1', account1IsKraken, true)
                  );
                }
                if (account2StillOpen) {
                  retryClosePromises.push(
                    performCleanup(page2, exchange2, email2, 'Account 2', account2IsKraken, true)
                  );
                }
                if (retryClosePromises.length > 0) {
                  await Promise.all(retryClosePromises);
                  await delay(2000);
                }
              } else {
                console.log(`[CYCLE ${cycleCount}] ✅ All positions with wrong directions have been closed`);
              }
            }
          }
        }
      } else if (!account1HasPosition && !account2HasPosition) {
        console.log(`[CYCLE ${cycleCount}] ⚠️  WARNING: No positions opened on either account. Orders may not have filled yet.`);
      } else {
        // Only one position opened - need to check direction and close it ASAP
        const accountWithPosition = account1HasPosition ? 1 : 2;
        const accountWithoutPosition = account1HasPosition ? 2 : 1;
        const positionSide = account1HasPosition ? account1PositionSide : account2PositionSide;
        const accountWithPositionEmail = account1HasPosition ? email1 : email2;
        const accountWithPositionExchange = account1HasPosition ? exchange1 : exchange2;
        const accountWithPositionName = account1HasPosition ? exchange1.name : exchange2.name;
        
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  ⚠️  ⚠️  CRITICAL: Only ONE position opened!`);
        console.log(`   Account ${accountWithPosition} (${accountWithPositionEmail} - ${accountWithPositionName}): ✅ OPEN (${positionSide})`);
        console.log(`   Account ${accountWithoutPosition}: ❌ NO POSITION`);
        
        // Check direction for the single position
        console.log(`\n[CYCLE ${cycleCount}] 🔍 Checking position direction for single position...`);
        const accountWithPositionExpectedSide = tradeBuyAccount.email === accountWithPositionEmail ? 'long' : 'short';
        const directionCorrect = positionSide === accountWithPositionExpectedSide;
        
        console.log(`[CYCLE ${cycleCount}] Expected direction for Account ${accountWithPosition}: ${accountWithPositionExpectedSide.toUpperCase()}`);
        console.log(`[CYCLE ${cycleCount}] Actual direction: ${positionSide.toUpperCase()}`);
        
        if (!directionCorrect) {
          console.log(`\n[CYCLE ${cycleCount}] ⚠️  ⚠️  ⚠️  CRITICAL: Single position has WRONG direction!`);
          console.log(`   Expected: ${accountWithPositionExpectedSide.toUpperCase()}, Got: ${positionSide.toUpperCase()}`);
          console.log(`[CYCLE ${cycleCount}] 🚨 Closing position ASAP due to wrong direction!`);
        } else {
          console.log(`[CYCLE ${cycleCount}] ✅ Position direction is CORRECT, but closing anyway due to single leg exposure...`);
        }
        
        console.log(`[CYCLE ${cycleCount}] 🚨 Closing single position ASAP to prevent exposure...`);
        
        // Determine which account/page to close
        const accountToClose = accountWithPosition === 1
          ? { page: page1, exchange: exchange1, email: email1, accountId: 'Account 1', isKraken: account1IsKraken }
          : { page: page2, exchange: exchange2, email: email2, accountId: 'Account 2', isKraken: account2IsKraken };
        
        // Step 1: Try closing with limit order first (normal cleanup)
        console.log(`[CYCLE ${cycleCount}] 🔄 Attempt 1: Closing position on Account ${accountWithPosition} (${accountToClose.email}) with LIMIT order...`);
        await performCleanup(
          accountToClose.page,
          accountToClose.exchange,
          accountToClose.email,
          accountToClose.accountId,
          accountToClose.isKraken,
          false // Don't force market close - try limit first
        );
        
        // Wait 5 seconds and check if position is closed
        console.log(`[CYCLE ${cycleCount}] ⏳ Waiting 5 seconds before checking if position closed...`);
        await delay(5000);
        
        const verifyClose = await checkOpenPositionsForAccounts(params);
        const stillOpen = accountWithPosition === 1 
          ? !!verifyClose.account1OpenPositionSide 
          : !!verifyClose.account2OpenPositionSide;
        
        if (stillOpen) {
          console.log(`[CYCLE ${cycleCount}] ⚠️  Position still open after limit order attempt. Retrying with limit order...`);
          
          // Step 2: Try limit order again
          await performCleanup(
            accountToClose.page,
            accountToClose.exchange,
            accountToClose.email,
            accountToClose.accountId,
            accountToClose.isKraken,
            false // Still using limit order
          );
          
          // Wait 5 seconds again
          console.log(`[CYCLE ${cycleCount}] ⏳ Waiting 5 seconds before checking again...`);
          await delay(5000);
          
          // Check again
          const verifyClose2 = await checkOpenPositionsForAccounts(params);
          const stillOpen2 = accountWithPosition === 1 
            ? !!verifyClose2.account1OpenPositionSide 
            : !!verifyClose2.account2OpenPositionSide;
          
          if (stillOpen2) {
            console.log(`[CYCLE ${cycleCount}] ⚠️  Position still open after second limit order attempt. Using MARKET close as last resort...`);
            
            // Step 3: Force close at market price (last resort)
            await performCleanup(
              accountToClose.page,
              accountToClose.exchange,
              accountToClose.email,
              accountToClose.accountId,
              accountToClose.isKraken,
              true // Force close at market price
            );
            
            // Final verification
            await delay(2000);
            const finalCheck = await checkOpenPositionsForAccounts(params);
            const finalStillOpen = accountWithPosition === 1 
              ? !!finalCheck.account1OpenPositionSide 
              : !!finalCheck.account2OpenPositionSide;
            
            if (finalStillOpen) {
              console.log(`[CYCLE ${cycleCount}] ❌ ERROR: Failed to close single position after limit attempts + market close!`);
            } else {
              console.log(`[CYCLE ${cycleCount}] ✅ Successfully closed single position using MARKET close.`);
            }
          } else {
            console.log(`[CYCLE ${cycleCount}] ✅ Successfully closed single position on second limit order attempt.`);
          }
        } else {
          console.log(`[CYCLE ${cycleCount}] ✅ Successfully closed single position with first limit order attempt.`);
        }
      }
      
      console.log(`\n[CYCLE ${cycleCount}] Trade execution completed (both trades processed)`);
      
      // Wait before next cycle
      const waitTime = TRADE_CONFIG.waitTime;
      console.log(`\n[CYCLE ${cycleCount}] Waiting ${waitTime / 1000} seconds before next cycle...`);
      await delay(waitTime);
      
    } catch (error) {
      console.error(`\n[CYCLE ${cycleCount}] Error in trading loop:`, error.message);
      console.error(error.stack);
      await delay(5000); // Wait 5 seconds before retrying
    }
  }
  
  console.log(`\n[Trading Loop] Exited after ${cycleCount} cycles`);
}

/**
 * Test single exchange trading - tests both BUY and SELL sides
 * Useful for debugging individual exchanges before running all 3 together
 * @param {Object} accountResult - { page, email, exchange, exchangeConfig }
 * @param {string} exchangeName - Display name for the exchange
 */
async function testSingleExchangeTrading(accountResult, exchangeName) {
  const { page, email, exchange: exchangeNameFromResult, exchangeConfig } = accountResult;
  
  console.log(`\n========================================`);
  console.log(`Testing ${exchangeName} Exchange`);
  console.log(`Account: ${email}`);
  console.log(`========================================\n`);
  
  // Get exchange config
  const exchange = exchangeConfig || EXCHANGE_CONFIGS[exchangeName.toLowerCase()];
  
  if (!exchange) {
    console.log(`❌ Error: Could not find exchange config for ${exchangeName}`);
    return;
  }
  
  console.log(`\n🧹 Step 1: Cleaning up existing positions and orders...`);
  
  // Cleanup
  if (exchange.name !== 'Extended Exchange') {
    const closeResult = await closeAllPositions(page, 100, exchange);
    
    // Use Kraken-specific cancel function for Kraken
    // Check both exchangeName and exchange.name to handle different naming
    const exchangeNameLower = (exchangeName || '').toLowerCase();
    const exchangeNameFromResultLower = (exchangeNameFromResult || '').toLowerCase();
    const exchangeNameConfigLower = (exchange?.name || '').toLowerCase();
    const urlPatternLower = (exchange?.urlPattern || '').toLowerCase();
    
    // Get exchange key
    const getExchangeKey = (name) => {
      if (!name) return '';
      const nameLower = name.toLowerCase();
      if (nameLower.includes('extended')) return 'extended';
      if (nameLower.includes('paradex')) return 'paradex';
      if (nameLower.includes('grvt')) return 'grvt';
      if (nameLower.includes('kraken')) return 'kraken';
      return '';
    };
    const exchangeKey = getExchangeKey(exchangeName) || getExchangeKey(exchangeNameFromResult) || getExchangeKey(exchange?.name);
    const exchangeKeyLower = (exchangeKey || '').toLowerCase();
    
    const isKraken = exchangeName === 'Kraken' || 
                    exchangeNameFromResult === 'Kraken' ||
                    exchange?.name === 'Kraken' || 
                    exchangeNameLower === 'kraken' || 
                    exchangeNameFromResultLower === 'kraken' ||
                    exchangeNameConfigLower === 'kraken' ||
                    exchangeKeyLower === 'kraken' ||
                    urlPatternLower.includes('kraken');
    
    // CRITICAL DEBUG: Print this BEFORE calling cancel function
    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`[${email}] 🔍 EXCHANGE ROUTING CHECK FOR ORDER CANCELLATION (TEST MODE):`);
    console.log(`  exchangeName: "${exchangeName || 'undefined'}"`);
    console.log(`  exchangeNameFromResult: "${exchangeNameFromResult || 'undefined'}"`);
    console.log(`  exchange.name: "${exchange?.name || 'undefined'}"`);
    console.log(`  exchangeKey: "${exchangeKey || 'undefined'}"`);
    console.log(`  urlPattern: "${exchange?.urlPattern || 'undefined'}"`);
    console.log(`  isKraken: ${isKraken}`);
    console.log(`  → Will use: ${isKraken ? 'cancelKrakenOrders' : 'cancelAllOrders'}`);
    console.log(`═══════════════════════════════════════════════════════════\n`);
    
    let cancelResult;
    if (isKraken) {
      console.log(`\n[${email}] ✅✅✅ CALLING cancelKrakenOrders (Kraken-specific function) ✅✅✅\n`);
      cancelResult = await cancelKrakenOrders(page);
    } else {
      console.log(`\n[${email}] ⚠️⚠️⚠️  CALLING cancelAllOrders (generic function) ⚠️⚠️⚠️\n`);
      cancelResult = await cancelAllOrders(page);
    }
    console.log(`✓ Cleanup completed`);
  } else {
    console.log(`✓ Cleanup skipped (Extended Exchange handles it during login)`);
  }
  
  // Set leverage
  console.log(`\n🔧 Step 2: Setting leverage to ${TRADE_CONFIG.leverage}x...`);
  if (exchange.name !== 'Extended Exchange') {
    // Use Kraken-specific leverage function for Kraken exchange
    const isKraken = exchangeName?.toLowerCase().includes('kraken') || exchange?.name?.toLowerCase().includes('kraken');
    const leverageResult = isKraken 
      ? await setLeverageKraken(page, TRADE_CONFIG.leverage, exchange)
      : await setLeverage(page, TRADE_CONFIG.leverage);
    if (leverageResult.success) {
      console.log(`✓ Leverage set to ${TRADE_CONFIG.leverage}x`);
    } else {
      console.log(`⚠️  Leverage setting: ${leverageResult.error || 'failed'}`);
    }
    
    // Wait for leverage modal to close (if it was opened)
    console.log(`   Waiting for leverage modal to close...`);
    await delay(2000);
    
    // Verify modal is closed
    const modalStillOpen = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
      if (modal) {
        const style = window.getComputedStyle(modal);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }
      return false;
    });
    
    if (modalStillOpen) {
      console.log(`⚠️  Leverage modal still open, trying to close it...`);
      // Try pressing Escape multiple times
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Escape');
        await delay(500);
      }
      await delay(1000);
      console.log(`✓ Attempted to close leverage modal`);
    } else {
      console.log(`✓ Leverage modal is closed`);
    }
  } else {
    console.log(`✓ Leverage skipped (Extended Exchange handles it during login)`);
  }
  
  // Pre-trade flow for Extended Exchange
  if (exchange.name === 'Extended Exchange') {
    console.log(`\n📋 Step 2.5: Running pre-trade flow for Extended Exchange...`);
    await clickOrdersTab(page, email, true);
    await delay(2000);
  }
  
  // Test BUY side
  console.log(`\n\n========================================`);
  console.log(`TEST 1: BUY Order`);
  console.log(`========================================\n`);
  
  console.log(`[${exchange.name}] Executing BUY order...`);
  const buyResult = await executeTrade(page, {
    side: "buy",
    orderType: "limit",
    qty: TRADE_CONFIG.buyQty,
  }, exchange);
  
  if (buyResult.success) {
    console.log(`\n✅ [${exchange.name}] BUY order test PASSED`);
  } else {
    console.log(`\n❌ [${exchange.name}] BUY order test FAILED: ${buyResult.error || 'unknown error'}`);
  }
  
  // Wait between tests
  console.log(`\n⏳ Waiting 5 seconds before SELL test...`);
  await delay(5000);
  
  // Test SELL side
  console.log(`\n\n========================================`);
  console.log(`TEST 2: SELL Order`);
  console.log(`========================================\n`);
  
  console.log(`[${exchange.name}] Executing SELL order...`);
  const sellResult = await executeTrade(page, {
    side: "sell",
    orderType: "limit",
    qty: TRADE_CONFIG.sellQty,
  }, exchange);
  
  if (sellResult.success) {
    console.log(`\n✅ [${exchange.name}] SELL order test PASSED`);
  } else {
    console.log(`\n❌ [${exchange.name}] SELL order test FAILED: ${sellResult.error || 'unknown error'}`);
  }
  
  // Summary
  console.log(`\n\n========================================`);
  console.log(`Test Summary for ${exchange.name}`);
  console.log(`========================================`);
  console.log(`BUY Test: ${buyResult.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`SELL Test: ${sellResult.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`========================================\n`);
  
  return {
    exchange: exchange.name,
    buyResult,
    sellResult,
    allPassed: buyResult.success && sellResult.success
  };
}

export { automatedTradingLoop, automatedTradingLoop3Exchanges, automatedTradingLoop2Exchanges, testSingleExchangeTrading, closeAllPositionsOnShutdown };