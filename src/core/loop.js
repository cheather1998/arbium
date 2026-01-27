import dotenv from 'dotenv';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay } from '../utils/helpers.js';
import { closeAllPositions } from '../trading/positions.js';
import { cancelAllOrders } from '../trading/orders.js';
import { setLeverage } from '../trading/leverage.js';
import { clickOrdersTab } from '../ui/tabs.js';
import { executeTrade } from '../trading/execute.js';
import { getCurrentUnrealizedPnL } from '../trading/positions.js';

// Ensure environment variables are loaded
dotenv.config();

// Trading configuration from environment variables
const TRADE_CONFIG = {
  buyQty: parseFloat(process.env.BUY_QTY) || 0.0005,
  sellQty: parseFloat(process.env.SELL_QTY) || 0.0005,
  waitTime: parseInt(process.env.TRADE_TIME) || 60000,
  leverage: parseInt(process.env.LEVERAGE) || 20,
  stopLoss: parseFloat(process.env.STOP_LOSS) || null,
};

// Debug: Log the configuration values being used
console.log('\n[TRADE_CONFIG] Loaded from environment:');
console.log(`  BUY_QTY: ${process.env.BUY_QTY || 'not set'} -> ${TRADE_CONFIG.buyQty}`);
console.log(`  SELL_QTY: ${process.env.SELL_QTY || 'not set'} -> ${TRADE_CONFIG.sellQty}`);
console.log(`  LEVERAGE: ${process.env.LEVERAGE || 'not set'} -> ${TRADE_CONFIG.leverage}x`);
console.log(`  STOP_LOSS: ${process.env.STOP_LOSS || 'not set'} -> ${TRADE_CONFIG.stopLoss || 'disabled'}\n`);

let isShuttingDown = false;

async function automatedTradingLoop(account1Result, account2Result) {
    const { page: page1, email: email1, exchange: exchange1Name } = account1Result;
    const { page: page2, email: email2, exchange: exchange2Name } = account2Result;
    
    // Get exchange configs - handle both string names and undefined
    // Map exchange names to config keys: "Extended Exchange" -> "extended", "Paradex" -> "paradex"
    const getExchangeKey = (exchangeName) => {
      if (!exchangeName) return 'paradex';
      const nameLower = exchangeName.toLowerCase();
      if (nameLower.includes('extended')) return 'extended';
      if (nameLower.includes('paradex')) return 'paradex';
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
    
    // Only cleanup Paradex accounts (Extended Exchange already cleaned up in clickOrdersTab)
    if (exchange1Name !== 'Extended Exchange') {
      cleanupPromises.push((async () => {
        console.log(`\n[${email1}] Checking for open positions and orders...`);
        const closeResult = await closeAllPositions(page1, 100, exchange1);
        const cancelResult = await cancelAllOrders(page1);
        return { email: email1, close: closeResult, cancel: cancelResult };
      })());
    } else {
      console.log(`\n[${email1}] Skipping cleanup - already done in clickOrdersTab() during login`);
    }
    
    if (exchange2Name !== 'Extended Exchange') {
      cleanupPromises.push((async () => {
        console.log(`\n[${email2}] Checking for open positions and orders...`);
        const closeResult = await closeAllPositions(page2, 100, exchange2);
        const cancelResult = await cancelAllOrders(page2);
        return { email: email2, close: closeResult, cancel: cancelResult };
      })());
    } else {
      console.log(`\n[${email2}] Skipping cleanup - already done in clickOrdersTab() during login`);
    }
  
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
        const result = await setLeverage(page1, TRADE_CONFIG.leverage);
        return { email: email1, result };
      })());
    } else {
      console.log(`[${email1}] Skipping leverage - already set in clickOrdersTab() during login`);
    }
    
    if (exchange2Name !== 'Extended Exchange') {
      leveragePromises.push((async () => {
        const result = await setLeverage(page2, TRADE_CONFIG.leverage);
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

  export { automatedTradingLoop, closeAllPositionsOnShutdown };