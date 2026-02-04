import dotenv from 'dotenv';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay } from '../utils/helpers.js';
import { closeAllPositions } from '../trading/positions.js';
import { cancelAllOrders, cancelKrakenOrders } from '../trading/orders.js';
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
};

// Debug: Log the configuration values being used
console.log('\n[TRADE_CONFIG] Loaded from environment:');
console.log(`  BUY_QTY: ${process.env.BUY_QTY || 'not set'} -> ${TRADE_CONFIG.buyQty}`);
console.log(`  SELL_QTY: ${process.env.SELL_QTY || 'not set'} -> ${TRADE_CONFIG.sellQty}`);
console.log(`  LEVERAGE: ${process.env.LEVERAGE || 'not set'} -> ${TRADE_CONFIG.leverage}x`);
console.log(`  STOP_LOSS: ${process.env.STOP_LOSS || 'not set'} -> ${TRADE_CONFIG.stopLoss || 'disabled'}`);
console.log(`  OPENING_THRESHOLD: ${process.env.OPENING_THRESHOLD || 'not set'} -> $${TRADE_CONFIG.openingThreshold.toLocaleString()}`);
console.log(`  CLOSING_THRESHOLD: ${process.env.CLOSING_THRESHOLD || 'not set'} -> $${TRADE_CONFIG.closingThreshold.toLocaleString()}\n`);

let isShuttingDown = false;

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
    
    // Use absolute price difference (highest - lowest)
    const priceDiff = Math.abs(priceComparison.comparison.priceDiff);
    const remainingTime = Math.max(0, maxWaitTime - elapsedTime);
    const remainingMinutes = Math.floor(remainingTime / 60000);
    const remainingSeconds = Math.floor((remainingTime % 60000) / 1000);
    
    console.log(`\n[CYCLE ${cycleCount}] Closing threshold check attempt ${attemptCount} (${Math.floor(elapsedTime / 1000)}s elapsed):`);
    console.log(`   Highest: ${priceComparison.highest.exchange} at $${priceComparison.highest.price.toLocaleString()}`);
    console.log(`   Lowest: ${priceComparison.lowest.exchange} at $${priceComparison.lowest.price.toLocaleString()}`);
    console.log(`   Price difference: $${priceDiff.toLocaleString()}`);
    console.log(`   Closing threshold: $${threshold.toLocaleString()}`);
    console.log(`   Time remaining: ${remainingMinutes}m ${remainingSeconds}s`);
    
    if (priceDiff <= threshold) {
      console.log(`\n✅ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) <= closing threshold ($${threshold.toLocaleString()}). Proceeding to close positions.`);
      return priceComparison;
    } else {
      console.log(`\n⏳ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) > closing threshold ($${threshold.toLocaleString()}). Waiting 2 seconds and checking again...`);
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
      console.log(`\n[CYCLE ${cycleCount}] Checking closing threshold before closing positions...`);
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
      
      // Create account objects for both exchanges
      const account1Obj = { page: page1, email: email1, exchange: exchange1 };
      const account2Obj = { page: page2, email: email2, exchange: exchange2 };
      
      // Step 1: Check closing threshold before closing positions
      console.log(`\n[CYCLE ${cycleCount}] Step 1: Checking closing threshold before closing positions...`);
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
      
      // Step 2: Cancel orders and close positions for BOTH accounts (before determining buy/sell)
      console.log(`\n[CYCLE ${cycleCount}] Step 2: Canceling orders and closing positions for both accounts...`);
      
      const account1IsKraken = exchange1.name === 'Kraken' || exchange1Name?.toLowerCase() === 'kraken';
      const account2IsKraken = exchange2.name === 'Kraken' || exchange2Name?.toLowerCase() === 'kraken';
      
      const cancelPromises = [
        account1IsKraken 
          ? cancelKrakenOrders(page1)
          : cancelAllOrders(page1),
        account2IsKraken 
          ? cancelKrakenOrders(page2)
          : cancelAllOrders(page2)
      ];
      
      // YES - it waits for cancelKrakenOrders to complete all its work (cancels orders AND closes positions)
      const cancelResults = await Promise.all(cancelPromises);
      if (cancelResults[0].success) {
        console.log(`✓ [${email1}] Orders canceled`);
      }
      if (cancelResults[1].success) {
        console.log(`✓ [${email2}] Orders canceled`);
      }
      
      await delay(500);
      
      // Close positions (skip for Kraken - already handled by cancelKrakenOrders, skip for Extended Exchange - handled in clickOrdersTab)
      const closePromises = [];
      if (exchange1.name !== 'Extended Exchange' && !account1IsKraken) {
        closePromises.push((async () => {
          const result = await closeAllPositions(page1, 100, exchange1);
          return { email: email1, result };
        })());
      }
      if (exchange2.name !== 'Extended Exchange' && !account2IsKraken) {
        closePromises.push((async () => {
          const result = await closeAllPositions(page2, 100, exchange2);
          return { email: email2, result };
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
      } else if (account1IsKraken || account2IsKraken) {
        console.log(`✓ Positions already closed by cancelKrakenOrders() for Kraken accounts`);
      }
      
      // Step 3: Get price comparison to determine buy/sell accounts (AFTER closing positions)
      console.log(`\n[CYCLE ${cycleCount}] Step 3: Getting price comparison to determine buy/sell accounts...`);
      const priceComparison = await comparePricesFromExchanges(exchangeAccounts);
      
      if (!priceComparison.success || priceComparison.successfulPrices.length < 2) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Price comparison failed. Skipping this cycle...`);
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
      
      const buyAccount = getAccountForExchange(lowestPriceExchange.exchange);
      const sellAccount = getAccountForExchange(highestPriceExchange.exchange);
      
      if (!buyAccount || !sellAccount) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Could not map exchanges to accounts. Skipping this cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
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
      
      // Step 4: Wait for opening threshold (AFTER determining buy/sell) before placing new trades
      console.log(`\n[CYCLE ${cycleCount}] Step 4: Checking opening threshold before placing new trades...`);
      const thresholdPriceComparison = await waitForPriceThreshold(
        exchangeAccounts, 
        TRADE_CONFIG.openingThreshold, 
        cycleCount
      );
      
      if (!thresholdPriceComparison) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Opening threshold not met. Skipping trade execution this cycle...`);
        console.log(`[CYCLE ${cycleCount}] Waiting ${TRADE_CONFIG.waitTime / 1000} seconds before next cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }
      
      // Verify buy/sell accounts are still correct (prices may have changed during threshold wait)
      const finalHighestPriceExchange = thresholdPriceComparison.highest;
      const finalLowestPriceExchange = thresholdPriceComparison.lowest;
      
      console.log(`\n[CYCLE ${cycleCount}] Opening threshold met. Final price-based trading decision:`);
      console.log(`   🔺 SELL on ${finalHighestPriceExchange.exchange} (highest price: $${finalHighestPriceExchange.price.toLocaleString()})`);
      console.log(`   🔻 BUY on ${finalLowestPriceExchange.exchange} (lowest price: $${finalLowestPriceExchange.price.toLocaleString()})`);
      console.log(`   Price spread: ${thresholdPriceComparison.comparison.priceDiffPercent}%`);
      
      // Re-determine accounts in case prices changed during threshold wait
      const finalBuyAccount = getAccountForExchange(finalLowestPriceExchange.exchange);
      const finalSellAccount = getAccountForExchange(finalHighestPriceExchange.exchange);
      
      if (!finalBuyAccount || !finalSellAccount) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Could not map exchanges to accounts after threshold check. Skipping this cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }
      
      // Use final accounts for trade execution
      const tradeBuyAccount = finalBuyAccount;
      const tradeSellAccount = finalSellAccount;
      
      // Step 5: Execute trades based on price comparison
      console.log(`\n[CYCLE ${cycleCount}] Executing trades...`);
      console.log(`   BUY on ${tradeBuyAccount.exchange.name} (${tradeBuyAccount.email})`);
      console.log(`   SELL on ${tradeSellAccount.exchange.name} (${tradeSellAccount.email})`);
      
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
        executeTradeWithTimeout(tradeBuyAccount.page, {
          side: "buy",
          orderType: "limit",
          qty: TRADE_CONFIG.buyQty,
        }, tradeBuyAccount.exchange, 30000),
        executeTradeWithTimeout(tradeSellAccount.page, {
          side: "sell",
          orderType: "limit",
          qty: TRADE_CONFIG.sellQty,
        }, tradeSellAccount.exchange, 30000),
      ];
      
      // Use allSettled so one trade doesn't block the other
      const tradeResults = await Promise.allSettled(tradePromises);
      
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