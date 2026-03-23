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
import { getAggressivePrice } from '../trading/executeBase.js';

// Ensure environment variables are loaded
dotenv.config();

// Trading configuration from environment variables
const TRADE_CONFIG = {
  buyQty: parseFloat(process.env.BUY_QTY) || 0.0005,
  sellQty: parseFloat(process.env.SELL_QTY) || 0.0005,
  waitTime: parseInt(process.env.TRADE_TIME) || 1800000,
  leverage: parseInt(process.env.LEVERAGE) || 20,
  stopLoss: parseFloat(process.env.STOP_LOSS) || null,
  takeProfit: parseFloat(process.env.TAKE_PROFIT) || null,
  openingThreshold: parseFloat(process.env.OPENING_THRESHOLD) || 0.0, // Absolute price difference threshold (in dollars: highest - lowest)
  closingThreshold: parseFloat(process.env.CLOSING_THRESHOLD) || 0.0, // Absolute price difference threshold for closing (in dollars: highest - lowest)
  closingSpread: parseFloat(process.env.CLOSING_SPREAD) || 0.0, // Spread threshold for closing: (price_difference - opening_threshold) >= closingSpread
  grvtOrderMode: (process.env.GRVT_ORDER_MODE || 'mid').toLowerCase(),
  orderAggressiveness: (process.env.ORDER_AGGRESSIVENESS || '').toLowerCase() || ((process.env.GRVT_ORDER_MODE || 'mid').toLowerCase() === 'best_bidask' ? 'maker' : 'mid'),
};

// Debug: Log the configuration values being used
console.log('\n[TRADE_CONFIG] Loaded from environment:');
console.log(`  BUY_QTY: ${process.env.BUY_QTY || 'not set'} -> ${TRADE_CONFIG.buyQty}`);
console.log(`  SELL_QTY: ${process.env.SELL_QTY || 'not set'} -> ${TRADE_CONFIG.sellQty}`);
console.log(`  LEVERAGE: ${process.env.LEVERAGE || 'not set'} -> ${TRADE_CONFIG.leverage}x`);
console.log(`  STOP_LOSS: ${process.env.STOP_LOSS || 'not set'} -> ${TRADE_CONFIG.stopLoss || 'disabled'}`);
console.log(`  TAKE_PROFIT: ${process.env.TAKE_PROFIT || 'not set'} -> ${TRADE_CONFIG.takeProfit || 'disabled'}`);
console.log(`  OPENING_THRESHOLD: ${process.env.OPENING_THRESHOLD || 'not set'} -> $${TRADE_CONFIG.openingThreshold.toLocaleString()}`);
console.log(`  CLOSING_THRESHOLD: ${process.env.CLOSING_THRESHOLD || 'not set'} -> $${TRADE_CONFIG.closingThreshold.toLocaleString()}`);
console.log(`  CLOSING_SPREAD: ${process.env.CLOSING_SPREAD || 'not set'} -> $${TRADE_CONFIG.closingSpread.toLocaleString()}`);
console.log(`  GRVT_ORDER_MODE: ${process.env.GRVT_ORDER_MODE || 'not set'} -> ${TRADE_CONFIG.grvtOrderMode}`);
console.log(`  ORDER_AGGRESSIVENESS: ${process.env.ORDER_AGGRESSIVENESS || 'not set'} -> ${TRADE_CONFIG.orderAggressiveness}\n`);

let isShuttingDown = false;

// Store the opening threshold used when both positions opened successfully
// This will be used in the next cycle before closing positions
let savedOpeningThreshold = null;
// Store which exchange was the SELL side at opening (for directional spread tracking)
let savedSellExchange = null;

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

  // Variables to track open position side and size for Kraken and GRVT accounts
  let account1OpenPositionSide = null;
  let account2OpenPositionSide = null;
  let account1PositionSize = null;
  let account2PositionSize = null;

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
        console.log(`[${exchange}] Account ${account} (${email}) has ${result.count} open position(s) - Long: ${result.longCount}, Short: ${result.shortCount}`);

        // Determine position side
        let detectedSide = null;
        if (result.longCount > 0) {
          detectedSide = 'long';
        } else if (result.shortCount > 0) {
          detectedSide = 'short';
        } else {
          // FAIL-SAFE: positions found (count > 0) but direction unknown (Long: 0, Short: 0)
          // Treat as 'unknown' to prevent opening NEW positions on top of existing ones.
          console.log(`[${exchange}] ⚠️  Account ${account} (${email}) has ${result.count} position(s) but direction unknown. FAIL-SAFE: assuming position exists.`);
          detectedSide = 'unknown';
        }

        if (account === 1) {
          account1OpenPositionSide = detectedSide;
          account1PositionSize = result.totalSize || null;
        } else if (account === 2) {
          account2OpenPositionSide = detectedSide;
          account2PositionSize = result.totalSize || null;
        }
      } else if (result.success && !result.hasPositions) {
        console.log(`[${exchange}] Account ${account} (${email}) has no open positions`);
      } else if (!result.success) {
        // FAIL-SAFE (Change #41): When position check fails (DOM error, timeout, etc.),
        // assume position is still open to prevent opening NEW positions on top of existing ones.
        // A false positive (assuming open when closed) is safe — just delays next trade.
        // A false negative (assuming closed when open) is dangerous — causes position accumulation.
        console.log(`[${exchange}] ⚠️  Account ${account} (${email}) position check FAILED: ${result.error || 'unknown'}. FAIL-SAFE: assuming position is still open.`);
        if (account === 1) {
          account1OpenPositionSide = 'unknown';
        } else if (account === 2) {
          account2OpenPositionSide = 'unknown';
        }
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
    account2OpenPositionSide,
    account1PositionSize,
    account2PositionSize
  };
}

/**
 * Check if a pending order exists on the given exchange page.
 * Lightweight check — does NOT cancel orders, just detects presence.
 * Used to determine if a "no position" result is due to slow fill (order pending)
 * vs genuine single-leg failure (order rejected/never placed).
 */
async function checkForOpenOrders(page, isKraken, isGrvt) {
  try {
    if (isGrvt) {
      // GRVT: Navigate to "Open orders" tab and check for any order rows
      const hasOrders = await page.evaluate(() => {
        // Strategy 1: Check tab text for count like "Open orders (1)"
        const allSpans = Array.from(document.querySelectorAll('span'));
        for (const span of allSpans) {
          const text = (span.textContent || '').trim().toLowerCase();
          const match = text.match(/^open orders?\s*\((\d+)\)/);
          if (match && parseInt(match[1]) > 0) return true;
        }
        // Strategy 2: Look for Cancel buttons in orders area
        const cancelButtons = Array.from(document.querySelectorAll('button'));
        for (const btn of cancelButtons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'cancel' || text === 'cancel all' || text.startsWith('cancel all orders')) {
            if (btn.offsetParent !== null) return true;
          }
        }
        return false;
      });
      console.log(`[GRVT] Open order check: ${hasOrders ? 'FOUND pending orders' : 'No pending orders'}`);
      return hasOrders;
    } else if (isKraken) {
      // Kraken: Check for open order rows in the orders panel
      const hasOrders = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        // Check for "Open orders" text combined with order indicators
        const hasOpenOrdersSection = bodyText.toLowerCase().includes('open orders');
        if (!hasOpenOrdersSection) return false;
        // Look for order-related elements (Limit/Market indicators, Cancel buttons)
        const allElements = Array.from(document.querySelectorAll('button, div, span'));
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text === 'Cancel' && el.tagName === 'BUTTON' && el.offsetParent !== null) {
            // Found a visible Cancel button — likely an open order
            return true;
          }
        }
        // Fallback: check for order rows with price/qty patterns
        const rows = Array.from(document.querySelectorAll('div[role="row"], tr'));
        for (const row of rows) {
          const rowText = (row.textContent || '').trim();
          if (rowText.includes('Limit') && /\d+\.\d+/.test(rowText) && row.offsetParent !== null) {
            return true;
          }
        }
        return false;
      });
      console.log(`[Kraken] Open order check: ${hasOrders ? 'FOUND pending orders' : 'No pending orders'}`);
      return hasOrders;
    }
    return false;
  } catch (e) {
    console.log(`⚠️  checkForOpenOrders error: ${e.message}`);
    return false;
  }
}

/**
 * Phase 1 helper: Verify exchange page is correct (perps, not spot/margin/deposit)
 */
async function verifyExchangePage(page, exchange, email) {
  const name = exchange.name || '';
  const currentUrl = page.url();

  try {
    if (name === 'Kraken') {
      // Kraken: must be on futures-btc-usd-perp page
      if (!currentUrl.includes('pro.kraken.com/app/trade')) {
        console.log(`   [${name}] ⚠️  Not on Kraken trading page: ${currentUrl}`);
        console.log(`   [${name}] Navigating to perps page...`);
        await page.goto(exchange.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
        const newUrl = page.url();
        if (!newUrl.includes('pro.kraken.com/app/trade')) {
          return { success: false, error: `${name} (${email}): Failed to navigate to trading page. Current URL: ${newUrl}` };
        }
      }
      if (!currentUrl.includes('futures-')) {
        console.log(`   [${name}] ⚠️  Not on futures/perps page (may be spot/margin): ${currentUrl}`);
        console.log(`   [${name}] Navigating to perps page...`);
        await page.goto(exchange.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
        const newUrl = page.url();
        if (!newUrl.includes('futures-')) {
          return { success: false, error: `${name} (${email}): Not on futures/perps page after navigation. Current URL: ${newUrl}` };
        }
      }
      console.log(`   [${name}] ✅ Verified on perps page (${email})`);
    } else {
      // GRVT or other: check not on deposit/withdraw
      if (currentUrl.includes('/deposit') || currentUrl.includes('/withdraw')) {
        console.log(`   [${name}] ⚠️  On deposit/withdraw page: ${currentUrl}`);
        console.log(`   [${name}] Navigating to trading page...`);
        await page.goto(exchange.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
      }
      console.log(`   [${name}] ✅ Verified on trading page (${email})`);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: `${name} (${email}): Page verification error: ${error.message}` };
  }
}

/**
 * Phase 1 helper: Check account balance via DOM scraping
 * Returns { success, balance, minRequired, exchange, email }
 * - balance=null means couldn't detect (not a failure — proceed with caution)
 * - success=false only when balance IS detected and IS insufficient
 */
async function checkAccountBalance(page, exchange, email, isKraken) {
  const name = exchange.name || '';
  const qty = TRADE_CONFIG.buyQty;
  const leverage = TRADE_CONFIG.leverage;

  try {
    const balanceInfo = await page.evaluate((isKrakenExchange) => {
      // Search for balance/equity-related text elements
      const keywords = ['balance', 'equity', 'available', 'addable', 'margin', 'portfolio value', 'account value'];
      const allElements = Array.from(document.querySelectorAll('*'));
      const candidates = [];

      for (const el of allElements) {
        if (el.children.length > 5) continue; // skip containers
        if (el.offsetParent === null) continue; // skip hidden
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.length > 200) continue; // skip large blocks

        for (const kw of keywords) {
          if (text.includes(kw)) {
            // Look for dollar amounts near this element
            const fullText = (el.textContent || '').trim();
            // Match patterns like $1,234.56 or 1,234.56 USD or 1234.56
            const matches = fullText.match(/\$?\s*([\d,]+\.?\d*)\s*(usd|usdt|usdc)?/gi);
            if (matches) {
              for (const match of matches) {
                const numStr = match.replace(/[$,\s]|usd[tc]?/gi, '');
                const num = parseFloat(numStr);
                if (num > 0 && num < 10000000) { // reasonable balance range
                  candidates.push({ keyword: kw, value: num, text: fullText.substring(0, 100) });
                }
              }
            }
            break;
          }
        }
      }

      // For Kraken, also try specific selectors
      if (isKrakenExchange) {
        // Look for portfolio/equity in header area
        const headerTexts = Array.from(document.querySelectorAll('[class*="header"] *, [class*="account"] *, [class*="portfolio"] *, [class*="balance"] *'));
        for (const el of headerTexts) {
          if (el.children.length > 0) continue;
          const text = (el.textContent || '').trim();
          const match = text.match(/^\$?\s*([\d,]+\.?\d+)\s*$/);
          if (match) {
            const num = parseFloat(match[1].replace(/,/g, ''));
            if (num > 0 && num < 10000000) {
              candidates.push({ keyword: 'header-amount', value: num, text });
            }
          }
        }
      }

      return candidates;
    }, isKraken);

    if (!balanceInfo || balanceInfo.length === 0) {
      return { success: true, balance: null, exchange: name, email };
    }

    // Debug: log top candidates (limit to 5 to avoid log spam from "margin" keyword matching position table rows)
    if (balanceInfo.length > 0) {
      const topCandidates = balanceInfo.filter(c => c.value >= 5).slice(0, 5);
      console.log(`   [${name}] Balance candidates (${balanceInfo.length} total, top ${topCandidates.length}): ${JSON.stringify(topCandidates.map(c => ({ kw: c.keyword, val: c.value, txt: c.text.substring(0, 60) })))}`);
    }

    // Filter out noise: values < $5 are likely account numbers, percentages, etc.
    const filtered = balanceInfo.filter(c => c.value >= 5);

    // Pick the most likely balance value (prefer "available" or "equity" keywords)
    // For each keyword, pick the LARGEST value (avoids "1" from "TradingAccount1" etc.)
    const priorityOrder = ['available', 'equity', 'balance', 'addable', 'portfolio value', 'account value', 'margin', 'header-amount'];
    let bestCandidate = null;
    for (const kw of priorityOrder) {
      const matches = filtered.filter(c => c.keyword === kw);
      if (matches.length > 0) {
        bestCandidate = matches.reduce((a, b) => a.value > b.value ? a : b);
        break;
      }
    }
    if (!bestCandidate && filtered.length > 0) bestCandidate = filtered.reduce((a, b) => a.value > b.value ? a : b);
    if (!bestCandidate) bestCandidate = balanceInfo[0]; // fallback to unfiltered if all < $5

    const balance = bestCandidate.value;

    // Estimate minimum required: position value / leverage, with 20% buffer
    // Approximate BTC price ~$70,000
    const estimatedPrice = 70000;
    const positionValue = qty * estimatedPrice;
    const minRequired = (positionValue / leverage) * 1.2; // 20% buffer for fees/margin

    if (balance < minRequired) {
      return { success: false, balance, minRequired, exchange: name, email };
    }

    return { success: true, balance, minRequired, exchange: name, email };
  } catch (error) {
    console.log(`   [${name}] ⚠️  Balance check error: ${error.message}`);
    return { success: true, balance: null, exchange: name, email };
  }
}

/**
 * Check if both positions still exist across exchanges.
 * Returns { bothOpen: true } if both positions exist,
 * or { bothOpen: false, closedExchange, openExchange } if one side closed (e.g. TP/SL triggered).
 */
async function checkBothPositionsExist(exchangeAccounts) {
  const results = await Promise.all(exchangeAccounts.map(async (acc) => {
    const name = (acc.exchangeConfig?.name || acc.exchange || '').toLowerCase();
    try {
      if (name.includes('kraken')) {
        const result = await checkKrakenOpenPositions(acc.page);
        // On error (success: false), assume position is still open (fail-safe)
        // Prevents false one-sided close detection from Runtime.callFunctionOn timeouts
        const hasPosition = result.success ? (result.hasPositions && result.count > 0) : true;
        if (!result.success) {
          console.log(`[${acc.exchangeConfig?.name || acc.exchange}] ⚠️  Position check failed (${result.message || 'unknown error'}) — assuming position still open (fail-safe)`);
        }
        return { exchange: acc.exchangeConfig?.name || acc.exchange, hasPosition };
      } else if (name.includes('grvt')) {
        const result = await checkGrvtOpenPositions(acc.page);
        // On error (success: false), assume position is still open (fail-safe)
        const hasPosition = result.success ? (result.hasPositions && result.count > 0) : true;
        if (!result.success) {
          console.log(`[${acc.exchangeConfig?.name || acc.exchange}] ⚠️  Position check failed (${result.message || 'unknown error'}) — assuming position still open (fail-safe)`);
        }
        return { exchange: acc.exchangeConfig?.name || acc.exchange, hasPosition };
      }
      return { exchange: acc.exchangeConfig?.name || acc.exchange, hasPosition: true }; // assume open for unknown exchanges
    } catch (err) {
      console.log(`[${acc.exchangeConfig?.name || acc.exchange}] Position check error: ${err.message}`);
      return { exchange: acc.exchangeConfig?.name || acc.exchange, hasPosition: true }; // assume open on error
    }
  }));

  const closed = results.find(r => !r.hasPosition);
  const open = results.find(r => r.hasPosition);

  if (closed) {
    return { bothOpen: false, closedExchange: closed.exchange, openExchange: open?.exchange || 'unknown' };
  }
  return { bothOpen: true };
}

async function waitForClosingThreshold(exchangeAccounts, threshold, cycleCount) {
  const startTime = Date.now();
  const maxWaitTime = 60 * 60 * 1000; // 60 minutes in milliseconds
  let attemptCount = 0;
  let consecutivePosFailures = 0; // Change #91: require 3 consecutive failures before closing

  while (!isShuttingDown) {
    attemptCount++;
    const elapsedTime = Date.now() - startTime;

    // Check if 60 minutes have passed
    if (elapsedTime >= maxWaitTime) {
      console.log(`\n⏰ [CYCLE ${cycleCount}] 60 minutes elapsed. Force closing positions regardless of threshold.`);
      return null; // Return null to indicate force close
    }

    // Every 6th attempt (~6s): check if both positions still exist
    // Change #91: Require 3 consecutive failures (~18s) before confirming one-sided close
    // Single failure may be web page scraping false negative (DOM not fully loaded)
    if (attemptCount % 6 === 0) {
      const posCheck = await checkBothPositionsExist(exchangeAccounts);
      if (!posCheck.bothOpen) {
        consecutivePosFailures++;
        if (consecutivePosFailures >= 3) {
          console.log(`\n⚠️  [CYCLE ${cycleCount}] One-sided close CONFIRMED (${consecutivePosFailures} consecutive detections)! ${posCheck.closedExchange} position closed (TP/SL triggered). Closing ${posCheck.openExchange}.`);
          return null; // Return null to trigger cleanup of remaining position
        } else {
          console.log(`\n⚠️  [CYCLE ${cycleCount}] Position check: ${posCheck.closedExchange} appears closed (${consecutivePosFailures}/3 consecutive). May be false negative, rechecking...`);
        }
      } else {
        if (consecutivePosFailures > 0) {
          console.log(`\n✅ [CYCLE ${cycleCount}] Position check recovered — both positions confirmed open (was ${consecutivePosFailures}/3 failures). Resetting counter.`);
        }
        consecutivePosFailures = 0;
      }
    }

    const priceComparison = await comparePricesFromExchanges(exchangeAccounts);

    if (!priceComparison.success || priceComparison.successfulPrices.length < 2) {
      console.log(`\n[CYCLE ${cycleCount}] ⚠️  Price comparison failed or insufficient prices. Retrying in 1 second...`);
      await delay(1000);
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
        console.log(`\n⏳ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) > |closing threshold| ($${thresholdForComparison.toLocaleString()}, original: $${threshold.toLocaleString()}). Waiting 1 second and checking again...`);
      } else {
        console.log(`\n⏳ [CYCLE ${cycleCount}] Price difference ($${priceDiff.toLocaleString()}) > closing threshold ($${threshold.toLocaleString()}). Waiting 1 second and checking again...`);
      }
      await delay(1000);
    }
  }

  return null;
}

/**
 * Helper function to check prices and wait until earned spread >= closingSpread.
 * Tracks DIRECTIONAL spread (which exchange was sell vs buy) so spread reversal counts as profit.
 *
 * Formula: earnedSpread = openingSpread - currentDirectionalSpread
 *   where currentDirectionalSpread = currentSellExchangePrice - currentBuyExchangePrice
 *
 * Example: Opened SELL Kraken $70,500, BUY GRVT $70,470 → openingSpread = $30
 *   Later: Kraken $70,490, GRVT $70,510 → directionalSpread = -$20
 *   earnedSpread = $30 - (-$20) = $50 >= $35 target → CLOSE ✓
 *
 * @param {Array} exchangeAccounts - Array of exchange account objects
 * @param {number} openingSpread - Directional spread at opening (sellPrice - buyPrice, always positive)
 * @param {number} closingSpread - Target earned spread to close (e.g., $35)
 * @param {string} sellExchange - Name of the exchange where we SOLD at opening
 * @param {number} cycleCount - Current cycle number for logging
 */
async function waitForClosingSpreadThreshold(exchangeAccounts, openingSpread, closingSpread, sellExchange, cycleCount) {
  const startTime = Date.now();
  const maxWaitTime = 60 * 60 * 1000; // 60 minutes in milliseconds
  let attemptCount = 0;
  let consecutivePosFailures = 0; // Change #91: require 3 consecutive failures before closing

  while (!isShuttingDown) {
    attemptCount++;
    const elapsedTime = Date.now() - startTime;

    // Check if 60 minutes have passed
    if (elapsedTime >= maxWaitTime) {
      console.log(`\n⏰ [CYCLE ${cycleCount}] 60 minutes elapsed. Force closing positions regardless of spread.`);
      return null; // Return null to indicate force close
    }

    // Every 6th attempt (~6s): check if both positions still exist
    // Change #91: Require 3 consecutive failures (~18s) before confirming one-sided close
    // Single failure may be web page scraping false negative (DOM not fully loaded)
    if (attemptCount % 6 === 0) {
      const posCheck = await checkBothPositionsExist(exchangeAccounts);
      if (!posCheck.bothOpen) {
        consecutivePosFailures++;
        if (consecutivePosFailures >= 3) {
          console.log(`\n⚠️  [CYCLE ${cycleCount}] One-sided close CONFIRMED (${consecutivePosFailures} consecutive detections)! ${posCheck.closedExchange} position closed (TP/SL triggered). Closing ${posCheck.openExchange}.`);
          return null; // Return null to trigger cleanup of remaining position
        } else {
          console.log(`\n⚠️  [CYCLE ${cycleCount}] Position check: ${posCheck.closedExchange} appears closed (${consecutivePosFailures}/3 consecutive). May be false negative, rechecking...`);
        }
      } else {
        if (consecutivePosFailures > 0) {
          console.log(`\n✅ [CYCLE ${cycleCount}] Position check recovered — both positions confirmed open (was ${consecutivePosFailures}/3 failures). Resetting counter.`);
        }
        consecutivePosFailures = 0;
      }
    }

    const priceComparison = await comparePricesFromExchanges(exchangeAccounts);

    if (!priceComparison.success || priceComparison.successfulPrices.length < 2) {
      console.log(`\n[CYCLE ${cycleCount}] ⚠️  Price comparison failed or insufficient prices. Retrying in 1 second...`);
      await delay(1000);
      continue;
    }

    // Find the current prices for our SELL exchange and BUY exchange (by name)
    const sellExchangePrice = priceComparison.successfulPrices.find(p => p.exchange === sellExchange);
    const buyExchangePrice = priceComparison.successfulPrices.find(p => p.exchange !== sellExchange);

    if (!sellExchangePrice || !buyExchangePrice) {
      console.log(`\n[CYCLE ${cycleCount}] ⚠️  Could not find prices for sell/buy exchanges. Retrying in 1 second...`);
      await delay(1000);
      continue;
    }

    // Change #91: Use bid/ask for spread calculation — matches actual execution prices at close
    // Sell exchange: SHORT position → close by buying back → cost = bestAsk
    // Buy exchange: LONG position → close by selling → proceeds = bestBid
    // This is more conservative than mid-price (earnedSpread ~$3-5 smaller) but honest
    let sellCurrentPrice = sellExchangePrice.price;
    let buyCurrentPrice = buyExchangePrice.price;
    if (sellExchangePrice.bidAsk && buyExchangePrice.bidAsk) {
      sellCurrentPrice = sellExchangePrice.bidAsk.bestAsk;
      buyCurrentPrice = buyExchangePrice.bidAsk.bestBid;
    }

    // Directional spread: positive = sell exchange still higher, negative = spread reversed (good!)
    const currentDirectionalSpread = sellCurrentPrice - buyCurrentPrice;

    // Earned spread: how much we've earned from spread movement
    // When spread narrows: earned > 0
    // When spread reverses: earned > openingSpread (even more profit!)
    const earnedSpread = openingSpread - currentDirectionalSpread;

    const remainingTime = Math.max(0, maxWaitTime - elapsedTime);
    const remainingMinutes = Math.floor(remainingTime / 60000);
    const remainingSeconds = Math.floor((remainingTime % 60000) / 1000);

    const spreadReversed = currentDirectionalSpread < 0;

    const hasBidAsk = !!(sellExchangePrice.bidAsk && buyExchangePrice.bidAsk);

    // Change #91: Throttle verbose logging to every 10th attempt (~10s) to reduce log spam with 1s intervals
    // Always print full detail when threshold is met or on first attempt
    if (attemptCount % 10 === 1 || attemptCount === 1) {
      console.log(`\n[CYCLE ${cycleCount}] Closing spread check attempt ${attemptCount} (${Math.floor(elapsedTime / 1000)}s elapsed):`);
      console.log(`   SELL exchange: ${sellExchangePrice.exchange} at $${sellCurrentPrice.toLocaleString()}${hasBidAsk ? ' (bestAsk — close cost)' : ' (DOM price)'}`);
      console.log(`   BUY exchange: ${buyExchangePrice.exchange} at $${buyCurrentPrice.toLocaleString()}${hasBidAsk ? ' (bestBid — close proceeds)' : ' (DOM price)'}`);
      console.log(`   Opening spread: $${openingSpread.toFixed(2)} (${sellExchange} was higher)`);
      console.log(`   Current directional spread: $${currentDirectionalSpread.toFixed(2)}${spreadReversed ? ' ← REVERSED!' : ''}`);
      console.log(`   💰 Earned spread: $${earnedSpread.toFixed(2)} / $${closingSpread} target`);
      console.log(`   Time remaining: ${remainingMinutes}m ${remainingSeconds}s`);
    }

    if (earnedSpread >= closingSpread) {
      console.log(`\n✅ [CYCLE ${cycleCount}] Earned spread $${earnedSpread.toFixed(2)} >= $${closingSpread} target! Closing positions.`);
      if (spreadReversed) {
        console.log(`   📈 Spread fully reversed! Extra profit from reversal: $${Math.abs(currentDirectionalSpread).toFixed(2)}`);
      }
      return priceComparison;
    } else {
      const remaining = closingSpread - earnedSpread;
      // Compact log for non-verbose iterations
      if (attemptCount % 10 !== 1) {
        console.log(`[CYCLE ${cycleCount}] #${attemptCount} earned=$${earnedSpread.toFixed(2)}/$${closingSpread} spread=$${currentDirectionalSpread.toFixed(2)} ${remainingMinutes}m${remainingSeconds}s left`);
      }
      await delay(1000);
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
  
          // Wait for exchange backend to fully process cancellations.
          // 500ms was too short — stale orders could fill alongside new orders (Change #86).
          await delay(2000);
  
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
  
        // Step 2: Hold positions for TRADE_TIME (from env, default 30 min)
        // Holding longer allows spread convergence for better trading PnL
        const randomWaitTime = TRADE_CONFIG.waitTime;

        console.log(
          `\n[CYCLE ${cycleCount}] Holding positions for ${
            randomWaitTime / 1000 / 60
          } minutes (TRADE_TIME)...`
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
  console.log(`Closing Spread: $${TRADE_CONFIG.closingSpread.toLocaleString()} (close when spread narrows by this amount, max 60 min)`);
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
  console.log(`Closing Spread: $${TRADE_CONFIG.closingSpread.toLocaleString()} (close when spread narrows by this amount, max 60 min)`);
  console.log(`========================================\n`);
  
  // Cache exchange type checks (reused throughout startup and cycle)
  const ex1IsKraken = exchange1.name === 'Kraken' || exchange1Name?.toLowerCase() === 'kraken';
  const ex2IsKraken = exchange2.name === 'Kraken' || exchange2Name?.toLowerCase() === 'kraken';
  const ex1IsGrvt = exchange1.name?.toLowerCase().includes('grvt');
  const ex2IsGrvt = exchange2.name?.toLowerCase().includes('grvt');

  // Phase 1: Pre-trade validation (page verification + balance check) — run FIRST
  console.log(`\n🔍 Phase 1: Running pre-trade validation checks...`);
  const validationChecks = [
    verifyExchangePage(page1, exchange1, email1),
    verifyExchangePage(page2, exchange2, email2),
  ];

  const pageCheckResults = await Promise.all(validationChecks);
  const pageCheckFailed = pageCheckResults.some(r => !r.success);
  if (pageCheckFailed) {
    const failedChecks = pageCheckResults.filter(r => !r.success);
    for (const fail of failedChecks) {
      console.log(`❌ [Phase 1] ${fail.error}`);
    }
    console.log(`\n❌ Phase 1 FAILED: Page verification failed. Fix the issue and restart the bot.`);
    process.exit(1);
  }

  // Check B: Verify sufficient balance on both exchanges
  const balanceChecks = await Promise.all([
    checkAccountBalance(page1, exchange1, email1, ex1IsKraken),
    checkAccountBalance(page2, exchange2, email2, ex2IsKraken),
  ]);

  for (const result of balanceChecks) {
    if (result.balance !== null) {
      console.log(`   [${result.exchange}] Balance: $${result.balance.toFixed(2)} (${result.email})`);
    }
    if (!result.success && result.balance !== null) {
      console.log(`❌ [${result.exchange}] Insufficient balance: $${result.balance.toFixed(2)}`);
      console.log(`   Minimum required (approx): $${result.minRequired?.toFixed(2) || '?'} (qty=${TRADE_CONFIG.buyQty} × leverage=${TRADE_CONFIG.leverage})`);
      console.log(`\n❌ Phase 1 FAILED: Insufficient balance. Deposit funds and restart the bot.`);
      process.exit(1);
    }
    if (result.balance === null) {
      console.log(`   [${result.exchange}] ⚠️  Could not detect balance (${result.email}) — proceeding with caution`);
    }
  }

  console.log(`✓ Phase 1 completed. Pre-trade validation passed.\n`);

  // Phase 2: Set leverage ONCE at the beginning
  console.log(`\n🔧 Phase 2: Setting leverage for accounts...`);
  const leveragePromises = [];

  if (exchange1Name !== 'Extended Exchange') {
    leveragePromises.push((async () => {
      console.log(`[${email1}] Setting leverage to ${TRADE_CONFIG.leverage}x...`);
      const result = ex1IsKraken
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
      const result = ex2IsKraken
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

  // Phase 3: Clean up leftover orders + positions from previous session
  console.log(`\n🧹 Phase 3: Cleaning up leftover positions and orders...`);

  // 3a: Close any leftover positions FIRST (they still have TP/SL protection)
  // If we cancel orders first, TP/SL gets removed and positions are unprotected.
  console.log(`   Checking for leftover positions...`);
  const startupParams = { page1, page2, exchange1, exchange2, email1, email2, exchange1Name: exchange1.name, exchange2Name: exchange2.name };
  const startupPosCheck = await checkOpenPositionsForAccounts(startupParams);

  if (startupPosCheck.account1OpenPositionSide || startupPosCheck.account2OpenPositionSide) {
    if (startupPosCheck.account1OpenPositionSide) console.log(`   ⚠️  Account 1 (${email1}): ${startupPosCheck.account1OpenPositionSide}`);
    if (startupPosCheck.account2OpenPositionSide) console.log(`   ⚠️  Account 2 (${email2}): ${startupPosCheck.account2OpenPositionSide}`);

    let allClosed = false;
    for (let attempt = 1; attempt <= 4 && !allClosed; attempt++) {
      const posNow = attempt === 1 ? startupPosCheck : await checkOpenPositionsForAccounts(startupParams);
      const closeTasks = [];
      if (posNow.account1OpenPositionSide) {
        closeTasks.push(ex1IsKraken
          ? cancelKrakenOrders(page1, false).catch(e => console.log(`   ⚠ ${e.message}`))
          : closeAllPositions(page1, 100, exchange1, false).catch(e => console.log(`   ⚠ ${e.message}`)));
      }
      if (posNow.account2OpenPositionSide) {
        closeTasks.push(ex2IsKraken
          ? cancelKrakenOrders(page2, false).catch(e => console.log(`   ⚠ ${e.message}`))
          : closeAllPositions(page2, 100, exchange2, false).catch(e => console.log(`   ⚠ ${e.message}`)));
      }
      if (closeTasks.length === 0) { allClosed = true; break; }
      console.log(`   Limit close attempt ${attempt}/4...`);
      await Promise.all(closeTasks);
      await delay(2000);
      const afterCheck = await checkOpenPositionsForAccounts(startupParams);
      allClosed = !afterCheck.account1OpenPositionSide && !afterCheck.account2OpenPositionSide;
    }

    if (!allClosed) {
      console.log(`   ⚠️  Limit failed → Market close...`);
      const remaining = await checkOpenPositionsForAccounts(startupParams);
      const marketTasks = [];
      if (remaining.account1OpenPositionSide) {
        marketTasks.push(ex1IsKraken
          ? cancelKrakenOrders(page1, true).catch(e => console.log(`   ⚠ ${e.message}`))
          : closeAllPositions(page1, 100, exchange1, true).catch(e => console.log(`   ⚠ ${e.message}`)));
      }
      if (remaining.account2OpenPositionSide) {
        marketTasks.push(ex2IsKraken
          ? cancelKrakenOrders(page2, true).catch(e => console.log(`   ⚠ ${e.message}`))
          : closeAllPositions(page2, 100, exchange2, true).catch(e => console.log(`   ⚠ ${e.message}`)));
      }
      if (marketTasks.length > 0) await Promise.all(marketTasks);
    }
    console.log(`   ✓ Leftover positions cleaned up.`);
  } else {
    console.log(`   ✓ No leftover positions.`);
  }

  // 3b: Cancel remaining open orders AFTER positions are closed
  // TP/SL orders auto-cancel when position closes, but cancel any other leftovers
  console.log(`   Canceling leftover orders...`);
  const cancelPromises = [];
  if (ex1IsKraken) {
    cancelPromises.push(cancelKrakenOrders(page1, false).then(() => console.log(`   ✓ [${email1}] Orders cleared`)).catch(e => console.log(`   ⚠ [${email1}] Cancel: ${e.message}`)));
  } else {
    cancelPromises.push(cancelAllOrders(page1).then(() => console.log(`   ✓ [${email1}] Orders cleared`)).catch(e => console.log(`   ⚠ [${email1}] Cancel: ${e.message}`)));
  }
  if (ex2IsKraken) {
    cancelPromises.push(cancelKrakenOrders(page2, false).then(() => console.log(`   ✓ [${email2}] Orders cleared`)).catch(e => console.log(`   ⚠ [${email2}] Cancel: ${e.message}`)));
  } else {
    cancelPromises.push(cancelAllOrders(page2).then(() => console.log(`   ✓ [${email2}] Orders cleared`)).catch(e => console.log(`   ⚠ [${email2}] Cancel: ${e.message}`)));
  }
  await Promise.all(cancelPromises);

  console.log(`✓ Phase 3 completed.`);

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
      let { account1OpenPositionSide, account2OpenPositionSide } = await checkOpenPositionsForAccounts({
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



      // Handle single-leg position: one side open, other side closed
      if ((account1OpenPositionSide && !account2OpenPositionSide) || (!account1OpenPositionSide && account2OpenPositionSide)) {
        const staleAccount = account1OpenPositionSide ? 1 : 2;
        const staleSide = account1OpenPositionSide || account2OpenPositionSide;
        const stalePage = staleAccount === 1 ? page1 : page2;
        const staleExchange = staleAccount === 1 ? exchange1 : exchange2;
        const staleEmail = staleAccount === 1 ? email1 : email2;
        const staleIsKraken = staleAccount === 1
          ? (exchange1.name === 'Kraken' || exchange1Name?.toLowerCase() === 'kraken')
          : (exchange2.name === 'Kraken' || exchange2Name?.toLowerCase() === 'kraken');

        // If we recently opened positions (savedOpeningThreshold exists), this might be a
        // false negative from position polling — re-check before treating as stale
        if (savedOpeningThreshold !== null) {
          console.log(`\n[CYCLE ${cycleCount}] ⚠️  Single-leg detected but savedOpeningThreshold exists — possible false negative from position polling.`);
          console.log(`[CYCLE ${cycleCount}] Re-checking positions before treating as stale...`);
          await delay(5000); // Wait 5s for exchange UI to update

          const recheck = await checkOpenPositionsForAccounts({ page1, page2, exchange1, exchange2, email1, email2, exchange1Name, exchange2Name });
          const recheck1 = !!recheck.account1OpenPositionSide;
          const recheck2 = !!recheck.account2OpenPositionSide;

          if (recheck1 && recheck2) {
            console.log(`[CYCLE ${cycleCount}] ✅ Re-check: BOTH positions found! Previous check was a false negative. Proceeding to closing spread wait.`);
            account1OpenPositionSide = recheck.account1OpenPositionSide;
            account2OpenPositionSide = recheck.account2OpenPositionSide;
            // Fall through to the closing spread wait below
          } else if (!recheck1 && !recheck2) {
            console.log(`[CYCLE ${cycleCount}] Re-check: No positions found at all. Skipping cleanup.`);
            savedOpeningThreshold = null;
            savedSellExchange = null;
            continue;
          } else {
            // Re-check confirmed single-leg — update stale account info from recheck
            const confirmStaleAccount = recheck1 ? 1 : 2;
            console.log(`[CYCLE ${cycleCount}] Re-check: Still single-leg on Account ${confirmStaleAccount}. Confirmed stale — closing.`);
            // Fall through to unified close below (stale variables already set correctly if same account)
          }
        }

        // Unified stale close: cancel orders on empty side, close position with 4x Limit + Market fallback
        if (!(account1OpenPositionSide && account2OpenPositionSide)) {
          // Re-determine stale info (may have changed after recheck)
          const closeAccount = account1OpenPositionSide ? 1 : 2;
          const closePage = closeAccount === 1 ? page1 : page2;
          const closeExchange = closeAccount === 1 ? exchange1 : exchange2;
          const closeEmail = closeAccount === 1 ? email1 : email2;
          const closeIsKraken = closeAccount === 1
            ? (exchange1.name === 'Kraken' || exchange1Name?.toLowerCase() === 'kraken')
            : (exchange2.name === 'Kraken' || exchange2Name?.toLowerCase() === 'kraken');
          const emptyPage = closeAccount === 1 ? page2 : page1;
          const emptyExchange = closeAccount === 1 ? exchange2 : exchange1;
          const emptyIsKraken = closeAccount === 1
            ? (exchange2.name === 'Kraken' || exchange2Name?.toLowerCase() === 'kraken')
            : (exchange1.name === 'Kraken' || exchange1Name?.toLowerCase() === 'kraken');

          console.log(`[CYCLE ${cycleCount}] Canceling orders on empty side and closing stale position on Account ${closeAccount} (${closeEmail})...`);

          // Cancel orders on the empty side
          if (emptyIsKraken) {
            await cancelKrakenOrders(emptyPage, false).catch(e => console.log(`[CYCLE ${cycleCount}] Empty-side cancel error: ${e.message}`));
          } else {
            await cancelAllOrders(emptyPage).catch(e => console.log(`[CYCLE ${cycleCount}] Empty-side cancel error: ${e.message}`));
          }

          // Close stale position: 4x Limit + Market fallback (same strategy as single-leg close)
          const maxStaleAttempts = 4;
          let staleClosed = false;

          for (let attempt = 1; attempt <= maxStaleAttempts && !staleClosed; attempt++) {
            console.log(`[CYCLE ${cycleCount}] Stale close attempt ${attempt}/${maxStaleAttempts}: LIMIT...`);
            if (closeIsKraken) {
              await cancelKrakenOrders(closePage, false);
            } else {
              await closeAllPositions(closePage, 100, closeExchange, false);
            }
            await delay(2000);

            const verifyStale = await checkOpenPositionsForAccounts({ page1, page2, exchange1, exchange2, email1, email2, exchange1Name, exchange2Name });
            const stillOpen = closeAccount === 1 ? !!verifyStale.account1OpenPositionSide : !!verifyStale.account2OpenPositionSide;
            if (!stillOpen) {
              console.log(`[CYCLE ${cycleCount}] ✅ Stale position closed with LIMIT on attempt ${attempt}.`);
              staleClosed = true;
            } else if (attempt < maxStaleAttempts) {
              console.log(`[CYCLE ${cycleCount}] Stale position still open, retrying...`);
            }
          }

          if (!staleClosed) {
            console.log(`[CYCLE ${cycleCount}] ⚠️ 4 LIMIT attempts failed. Final attempt: MARKET close...`);
            if (closeIsKraken) {
              await cancelKrakenOrders(closePage, true);
            } else {
              await closeAllPositions(closePage, 100, closeExchange, true);
            }
            await delay(2000);
            const finalVerify = await checkOpenPositionsForAccounts({ page1, page2, exchange1, exchange2, email1, email2, exchange1Name, exchange2Name });
            const finalStillOpen = closeAccount === 1 ? !!finalVerify.account1OpenPositionSide : !!finalVerify.account2OpenPositionSide;
            if (finalStillOpen) {
              console.log(`[CYCLE ${cycleCount}] ❌ ERROR: Failed to close stale position after all attempts (4 Limit + 1 Market)!`);
            } else {
              console.log(`[CYCLE ${cycleCount}] ✅ Stale position closed using MARKET (last resort).`);
              staleClosed = true;
            }
          }

          console.log(`[CYCLE ${cycleCount}] ${staleClosed ? '✅' : '⚠️'} Stale position cleanup ${staleClosed ? 'complete' : 'incomplete'}.`);
          savedOpeningThreshold = null;
          savedSellExchange = null;
          continue;
        }
      }

      if(account1OpenPositionSide && account2OpenPositionSide){
        // Step 1: Wait for spread to narrow by CLOSING_SPREAD amount before closing
        let closingPriceCheck = null;

        if (savedOpeningThreshold !== null && savedSellExchange !== null) {
          console.log(`\n[CYCLE ${cycleCount}] Step 1: Waiting for earned spread >= $${TRADE_CONFIG.closingSpread}...`);
          console.log(`   Opening spread: $${savedOpeningThreshold.toLocaleString()} (SELL on ${savedSellExchange})`);
          console.log(`   Target earned spread: $${TRADE_CONFIG.closingSpread.toLocaleString()}`);
          console.log(`   Strategy: Close when spread narrows/reverses enough to earn $${TRADE_CONFIG.closingSpread} (or 60 min timeout)`);

          closingPriceCheck = await waitForClosingSpreadThreshold(
            exchangeAccounts,
            savedOpeningThreshold,
            TRADE_CONFIG.closingSpread,
            savedSellExchange,
            cycleCount
          );

          console.log(`[CYCLE ${cycleCount}] 🗑️  Cleared saved opening spread after use`);
          savedOpeningThreshold = null;
          savedSellExchange = null;
        } else {
          // No saved opening threshold (e.g., bot restarted with existing positions)
          // Close immediately — we don't know the original opening spread, so waiting is pointless.
          // These are likely leftover positions from a previous session.
          console.log(`\n[CYCLE ${cycleCount}] Step 1: No saved opening threshold — closing leftover positions immediately (bot was restarted).`);
          closingPriceCheck = null; // null = force close
        }
        
        // Close positions (skip for Extended Exchange - handled in clickOrdersTab)
        // closingPriceCheck can be null (force close after 60 min) or a valid comparison (threshold met)
        // Always close - either threshold is met or 60 minutes elapsed
        if (closingPriceCheck === null) {
          console.log(`\n[CYCLE ${cycleCount}] Force closing positions (60 minutes elapsed or threshold not met)...`);
        } else {
          console.log(`\n[CYCLE ${cycleCount}] Closing threshold met. Closing positions...`);
        }
      }

      
      // Step 2: Cancel orders and close positions for BOTH accounts (before determining buy/sell)
      console.log(`\n[CYCLE ${cycleCount}] Step 2: Canceling orders and closing positions for both accounts...`);

      const account1IsKraken = ex1IsKraken;
      const account2IsKraken = ex2IsKraken;
      
      // Reusable cleanup function
      const performCleanup = async (page, exchange, email, accountId, isKraken, isCloseAtMarket, skipOrderCancel = false) => {
        try {
          // Check if isCloseAtMarket parameter was provided
          const wasCloseAtMarketProvided = isCloseAtMarket !== undefined;

          console.log(`[${exchange.name}] 🔄 Starting cleanup for ${accountId} (${email})${skipOrderCancel ? ' (skip order cancel — preserve TP/SL)' : ''}...`);

          // For GRVT: Close any NotifyBarWrapper notifications before cleanup
          await closeNotifyBarWrapperNotifications(page, exchange, 'before cleanup');

          // Skip order cancellation — preserve TP/SL as safety net while closing position.
          // TP/SL auto-cancels when the position closes on the exchange.
          if (skipOrderCancel) {
            if (exchange.name !== 'Extended Exchange' && !isKraken) {
              console.log(`[${exchange.name}] 🔄 Closing position directly (no order cancel — preserve TP/SL)...`);
              const closeResult = wasCloseAtMarketProvided
                ? await closeAllPositions(page, 100, exchange, isCloseAtMarket)
                : await closeAllPositions(page, 100, exchange);
              if (closeResult.success) {
                console.log(`✓ [${email}] Positions closed`);
              } else {
                console.log(`⚠️  [${email}] Position close result: ${closeResult.message || 'Unknown error'}`);
              }
              return { email, cancelResult: { success: true }, closeResult };
            } else if (isKraken) {
              // For Kraken: cancelKrakenOrders handles both cancel + close in one flow
              // Pass skipOrderCancel=true to preserve TP/SL orders
              const cancelResult = wasCloseAtMarketProvided
                ? await cancelKrakenOrders(page, isCloseAtMarket, true)
                : await cancelKrakenOrders(page, false, true);
              console.log(`✓ [${email}] Kraken close attempt completed`);
              return { email, cancelResult, closeResult: null };
            }
            return { email, cancelResult: { success: true }, closeResult: null };
          }

          // Step 1: Cancel orders once, verify once
          // If orders still exist, next cycle's cleanup will handle it
          const cancelResult = isKraken
            ? (wasCloseAtMarketProvided
                ? await cancelKrakenOrders(page, isCloseAtMarket)
                : await cancelKrakenOrders(page))
            : await cancelAllOrders(page);

          // Wait for UI to update after order cancellation
          await delay(1000);

          if (cancelResult.success) {
            console.log(`✓ [${email}] Orders canceled`);
          } else {
            console.log(`⚠️  [${email}] Order cancellation: ${cancelResult.message || 'may have partially failed'} — proceeding to position close`);
          }
          
          // Step 2: Close positions (skip for Kraken - already handled by cancelKrakenOrders, skip for Extended Exchange - handled in clickOrdersTab)
          if (exchange.name !== 'Extended Exchange' && !isKraken) {
            console.log(`[${exchange.name}] 🔄 Starting position close for ${accountId}...`);
            await delay(500);
            const closeResult = wasCloseAtMarketProvided
              ? await closeAllPositions(page, 100, exchange, isCloseAtMarket)
              : await closeAllPositions(page, 100, exchange);
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
      
      // Position check params
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

      // 4x Limit close attempts, then Market as last resort (minimize market orders)
      const maxLimitAttempts = 4;
      let allClosed = false;

      for (let closeAttempt = 1; closeAttempt <= maxLimitAttempts && !allClosed; closeAttempt++) {
        const closeTasks = [];
        // Only close accounts that still have open positions
        const posCheck = closeAttempt === 1
          ? { account1OpenPositionSide, account2OpenPositionSide }
          : await checkOpenPositionsForAccounts(params);

        // Always skip order cancel during close — TP/SL orders auto-cancel when position closes.
        // Canceling orders first removes TP/SL safety net, leaving positions unprotected if close fails.
        const skipCancel = true;

        if (posCheck.account1OpenPositionSide) {
          console.log(`[${exchange1.name}] Account 1 has open position (${posCheck.account1OpenPositionSide}), LIMIT close attempt ${closeAttempt}/${maxLimitAttempts}...`);
          closeTasks.push(performCleanup(page1, exchange1, email1, 'Account 1', account1IsKraken, false, skipCancel));
        }
        if (posCheck.account2OpenPositionSide) {
          console.log(`[${exchange2.name}] Account 2 has open position (${posCheck.account2OpenPositionSide}), LIMIT close attempt ${closeAttempt}/${maxLimitAttempts}...`);
          closeTasks.push(performCleanup(page2, exchange2, email2, 'Account 2', account2IsKraken, false, skipCancel));
        }

        if (closeTasks.length === 0) {
          console.log(`[CYCLE ${cycleCount}] ✅ All positions already closed.`);
          allClosed = true;
          break;
        }

        console.log(`[CYCLE ${cycleCount}] LIMIT close attempt ${closeAttempt}/${maxLimitAttempts} for ${closeTasks.length} account(s)...`);
        await Promise.all(closeTasks);
        await delay(1000); // Brief wait for exchange to process the close order

        const afterCheck = await checkOpenPositionsForAccounts(params);
        if (!afterCheck.account1OpenPositionSide && !afterCheck.account2OpenPositionSide) {
          console.log(`[CYCLE ${cycleCount}] ✅ All positions closed with LIMIT on attempt ${closeAttempt}.`);
          allClosed = true;
        } else if (closeAttempt < maxLimitAttempts) {
          console.log(`[CYCLE ${cycleCount}] Positions still open after LIMIT attempt ${closeAttempt}. Retrying...`);
        }
      }

      // Market fallback: if 4 Limit attempts failed
      if (!allClosed) {
        console.log(`[CYCLE ${cycleCount}] ⚠️ 4 LIMIT close attempts failed. Final attempt: MARKET close...`);
        const marketTasks = [];
        const remainingPos = await checkOpenPositionsForAccounts(params);
        if (remainingPos.account1OpenPositionSide) {
          marketTasks.push(performCleanup(page1, exchange1, email1, 'Account 1', account1IsKraken, true, true));
        }
        if (remainingPos.account2OpenPositionSide) {
          marketTasks.push(performCleanup(page2, exchange2, email2, 'Account 2', account2IsKraken, true, true));
        }
        if (marketTasks.length > 0) {
          await Promise.all(marketTasks);
          await delay(2000);
          const finalCheck = await checkOpenPositionsForAccounts(params);
          if (!finalCheck.account1OpenPositionSide && !finalCheck.account2OpenPositionSide) {
            console.log(`[CYCLE ${cycleCount}] ✅ All positions closed with MARKET (last resort).`);
          } else {
            console.log(`[CYCLE ${cycleCount}] ERROR: Failed to close all positions after 4 Limit + 1 Market attempts!`);
          }
        }
      }

      // Post-close verification: ensure BOTH positions are fully closed before opening new ones
      if (account1OpenPositionSide || account2OpenPositionSide) {
        console.log(`\n[CYCLE ${cycleCount}] 🔍 Post-close verification: ensuring positions are fully settled...`);
        const postCloseCheck = await checkOpenPositionsForAccounts(params);
        if (postCloseCheck.account1OpenPositionSide || postCloseCheck.account2OpenPositionSide) {
          const still1 = postCloseCheck.account1OpenPositionSide ? `Account 1: ${postCloseCheck.account1OpenPositionSide}` : '';
          const still2 = postCloseCheck.account2OpenPositionSide ? `Account 2: ${postCloseCheck.account2OpenPositionSide}` : '';
          console.log(`[CYCLE ${cycleCount}] ⚠️  Positions still detected after close! ${[still1, still2].filter(Boolean).join(', ')}`);
          console.log(`[CYCLE ${cycleCount}] Waiting 3s for settlement...`);
          await delay(3000);
          const finalPostCloseCheck = await checkOpenPositionsForAccounts(params);
          if (finalPostCloseCheck.account1OpenPositionSide || finalPostCloseCheck.account2OpenPositionSide) {
            console.log(`[CYCLE ${cycleCount}] ❌ Positions STILL open after post-close wait. Restarting cycle to handle cleanup...`);
            continue;
          }
          console.log(`[CYCLE ${cycleCount}] ✅ Positions confirmed closed after extended wait.`);
        } else {
          console.log(`[CYCLE ${cycleCount}] ✅ Both positions confirmed fully closed.`);
        }
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

      // Step 3: Pre-fill forms for BOTH accounts (order type, quantity, TP/SL — excluding price and side)
      // Pre-fill doesn't need buy/sell direction — uses exchange type directly
      // Forms are prepared while waiting for threshold, saving execution time
      console.log(`\n[CYCLE ${cycleCount}] Step 3: Pre-filling forms for both accounts (order type, quantity, TP/SL)...`);
      console.log(`[CYCLE ${cycleCount}]    Account 1: ${exchange1.name} (${email1})`);
      console.log(`[CYCLE ${cycleCount}]    Account 2: ${exchange2.name} (${email2})`);

      const { prefillFormKraken, prefillFormGrvt } = await import('../trading/prefillForm.js');

      const prefillPromises = [];
      // Pre-fill uses max of buyQty/sellQty since direction is unknown at this point
      // Quick-fill will re-verify quantity after side is determined
      const prefillQty = Math.max(TRADE_CONFIG.buyQty, TRADE_CONFIG.sellQty);

      // Pre-fill Account 1
      if (ex1IsKraken) {
        prefillPromises.push(
          prefillFormKraken(page1, { orderType: "limit", qty: prefillQty }, exchange1)
            .then(result => ({ email: email1, exchange: 'kraken', result }))
            .catch(error => ({ email: email1, exchange: 'kraken', result: { success: false, error: error.message } }))
        );
      } else if (ex1IsGrvt) {
        prefillPromises.push(
          prefillFormGrvt(page1, { orderType: "limit", qty: prefillQty }, exchange1)
            .then(result => ({ email: email1, exchange: 'grvt', result }))
            .catch(error => ({ email: email1, exchange: 'grvt', result: { success: false, error: error.message } }))
        );
      }

      // Pre-fill Account 2
      if (ex2IsKraken) {
        prefillPromises.push(
          prefillFormKraken(page2, { orderType: "limit", qty: prefillQty }, exchange2)
            .then(result => ({ email: email2, exchange: 'kraken', result }))
            .catch(error => ({ email: email2, exchange: 'kraken', result: { success: false, error: error.message } }))
        );
      } else if (ex2IsGrvt) {
        prefillPromises.push(
          prefillFormGrvt(page2, { orderType: "limit", qty: prefillQty }, exchange2)
            .then(result => ({ email: email2, exchange: 'grvt', result }))
            .catch(error => ({ email: email2, exchange: 'grvt', result: { success: false, error: error.message } }))
        );
      }

      // Step 4: Wait for opening threshold IN PARALLEL with pre-filling
      // Threshold wait includes price comparison — determines buy/sell sides when met
      console.log(`\n[CYCLE ${cycleCount}] Step 4: Checking opening threshold IN PARALLEL with form pre-filling...`);
      const thresholdPromise = waitForPriceThreshold(
        exchangeAccounts,
        TRADE_CONFIG.openingThreshold,
        cycleCount
      );

      // Wait for BOTH pre-filling and threshold check to complete
      const [prefillResults, thresholdPriceComparison] = await Promise.all([
        Promise.all(prefillPromises),
        thresholdPromise
      ]);

      // Store prefill data keyed by email
      const prefillData = {};
      for (const { email, exchange: exch, result } of prefillResults) {
        if (result.success) {
          prefillData[email] = { ...result, exchange: exch };
          console.log(`[CYCLE ${cycleCount}] ✅ ${exch} account (${email}) pre-filled successfully`);
        } else {
          console.log(`[CYCLE ${cycleCount}] ⚠️  ${exch} account (${email}) pre-fill failed: ${result.error}`);
        }
      }

      if (!thresholdPriceComparison) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Opening threshold not met. Skipping trade execution this cycle...`);
        console.log(`[CYCLE ${cycleCount}] Waiting ${TRADE_CONFIG.waitTime / 1000} seconds before next cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }

      // ⏱️ START TIMING: Opening threshold met
      const thresholdMetTime = Date.now();
      console.log(`\n[CYCLE ${cycleCount}] ⏱️  [TIMING] Opening threshold met at ${new Date(thresholdMetTime).toISOString()}`);
      console.log(`[CYCLE ${cycleCount}] ✅ All forms pre-filled. Proceeding with quick fill...`);

      // Determine buy/sell accounts from threshold price comparison
      const finalHighestPriceExchange = thresholdPriceComparison.highest;
      const finalLowestPriceExchange = thresholdPriceComparison.lowest;

      console.log(`\n[CYCLE ${cycleCount}] Opening threshold met. Trading decision:`);
      console.log(`   🔺 SELL on ${finalHighestPriceExchange.exchange} (highest price: $${finalHighestPriceExchange.price.toLocaleString()})`);
      console.log(`   🔻 BUY on ${finalLowestPriceExchange.exchange} (lowest price: $${finalLowestPriceExchange.price.toLocaleString()})`);
      console.log(`   Price spread: ${thresholdPriceComparison.comparison.priceDiffPercent}%`);

      const tradeBuyAccount = getAccountForExchange(finalLowestPriceExchange.exchange);
      const tradeSellAccount = getAccountForExchange(finalHighestPriceExchange.exchange);

      if (!tradeBuyAccount || !tradeSellAccount) {
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Could not map exchanges to accounts. Skipping this cycle...`);
        await delay(TRADE_CONFIG.waitTime);
        continue;
      }
      
      // Pre-execution safety check: abort if either exchange already has an open position.
      // Prevents position accumulation (0.002 → 0.004 BTC) from leftover orders filling
      // between post-close verification and now (can be 3-4 minutes during threshold wait).
      console.log(`\n[CYCLE ${cycleCount}] Pre-execution position check...`);
      const preExecCheck = await checkOpenPositionsForAccounts(params);
      if (preExecCheck.account1OpenPositionSide || preExecCheck.account2OpenPositionSide) {
        console.log(`[CYCLE ${cycleCount}] ❌ ABORT: Open positions detected before trade execution!`);
        console.log(`   Account 1 (${email1}): ${preExecCheck.account1OpenPositionSide || 'none'}`);
        console.log(`   Account 2 (${email2}): ${preExecCheck.account2OpenPositionSide || 'none'}`);
        console.log(`[CYCLE ${cycleCount}] Restarting cycle — Step 0 will handle cleanup...`);
        await delay(2000);
        continue;
      }
      console.log(`[CYCLE ${cycleCount}] ✅ No existing positions — safe to execute.`);

      // Change #86: Check for stale pending orders on GRVT before placing new orders.
      // A stale order that fills alongside the new order causes double position (0.004 BTC).
      const grvtPageForCheck = ex1IsGrvt ? page1 : ex2IsGrvt ? page2 : null;
      if (grvtPageForCheck) {
        try {
          const hasStaleOrder = await checkForOpenOrders(grvtPageForCheck, false, true);
          if (hasStaleOrder) {
            console.log(`[CYCLE ${cycleCount}] ⚠️  STALE ORDER on GRVT! Cancelling before proceeding...`);
            await cancelAllOrders(grvtPageForCheck);
            await delay(1000);
            const stillHasOrder = await checkForOpenOrders(grvtPageForCheck, false, true);
            if (stillHasOrder) {
              console.log(`[CYCLE ${cycleCount}] ❌ ABORT: Could not cancel stale GRVT order. Skipping cycle.`);
              await delay(3000);
              continue;
            }
            console.log(`[CYCLE ${cycleCount}] ✅ Stale GRVT order cancelled successfully.`);
          }
        } catch (e) {
          console.log(`[CYCLE ${cycleCount}] ⚠️  GRVT order check error: ${e.message} — proceeding anyway.`);
        }
      }

      // QA fix: Also check for stale pending orders on Kraken before placing new orders.
      // Same risk as GRVT — a stale Kraken order filling alongside new order causes 0.004 BTC position.
      const krakenPageForCheck = ex1IsKraken ? page1 : ex2IsKraken ? page2 : null;
      if (krakenPageForCheck) {
        try {
          const hasStaleOrder = await checkForOpenOrders(krakenPageForCheck, true, false);
          if (hasStaleOrder) {
            console.log(`[CYCLE ${cycleCount}] ⚠️  STALE ORDER on Kraken! Cancelling before proceeding...`);
            await cancelKrakenOrders(krakenPageForCheck);
            await delay(1000);
            const stillHasOrder = await checkForOpenOrders(krakenPageForCheck, true, false);
            if (stillHasOrder) {
              console.log(`[CYCLE ${cycleCount}] ❌ ABORT: Could not cancel stale Kraken order. Skipping cycle.`);
              await delay(3000);
              continue;
            }
            console.log(`[CYCLE ${cycleCount}] ✅ Stale Kraken order cancelled successfully.`);
          }
        } catch (e) {
          console.log(`[CYCLE ${cycleCount}] ⚠️  Kraken order check error: ${e.message} — proceeding anyway.`);
        }
      }

      // Step 5: Execute trades using quick fill for BOTH GRVT and Kraken (side and price filled after threshold)
      console.log(`\n[CYCLE ${cycleCount}] Step 5: Executing trades using quick fill (both GRVT and Kraken)...`);
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
      
      // Adjust prices for aggressiveness (taker mode crosses the spread for guaranteed fills)
      let buyPrice = finalLowestPriceExchange.price;
      let sellPrice = finalHighestPriceExchange.price;

      const aggressivenessMode = (process.env.ORDER_AGGRESSIVENESS || '').toLowerCase();
      if (aggressivenessMode === 'taker' || aggressivenessMode === 'maker') {
        console.log(`[CYCLE ${cycleCount}] Fetching ${aggressivenessMode.toUpperCase()} prices from order books...`);
        const [aggressiveBuyPrice, aggressiveSellPrice] = await Promise.all([
          getAggressivePrice(tradeBuyAccount.page, tradeBuyAccount.exchange, 'buy'),
          getAggressivePrice(tradeSellAccount.page, tradeSellAccount.exchange, 'sell')
        ]);
        if (aggressiveBuyPrice) buyPrice = aggressiveBuyPrice;
        if (aggressiveSellPrice) sellPrice = aggressiveSellPrice;
        console.log(`[CYCLE ${cycleCount}] Trade prices: BUY=$${buyPrice.toLocaleString()}, SELL=$${sellPrice.toLocaleString()}`);
      }

      // CRITICAL: Validate execution spread before placing orders
      // Prevents wrong-direction entries when prices move between threshold check and execution
      const executionSpread = sellPrice - buyPrice;
      if (executionSpread <= 0) {
        console.log(`[CYCLE ${cycleCount}] ❌ ABORT: Spread flipped! SELL=$${sellPrice.toLocaleString()} <= BUY=$${buyPrice.toLocaleString()} (spread: $${executionSpread.toFixed(2)}). Skipping cycle.`);
        await delay(2000);
        continue;
      }
      if (executionSpread < TRADE_CONFIG.openingThreshold * 0.5) {
        console.log(`[CYCLE ${cycleCount}] ❌ ABORT: Execution spread $${executionSpread.toFixed(2)} too small (< 50% of $${TRADE_CONFIG.openingThreshold} threshold). Price moved since threshold check. Skipping cycle.`);
        await delay(2000);
        continue;
      }
      console.log(`[CYCLE ${cycleCount}] ✅ Execution spread validated: $${executionSpread.toFixed(2)} (threshold: $${TRADE_CONFIG.openingThreshold})`);

      // Execute trades based on exchange type - use quick fill for both GRVT and Kraken
      console.log(`[CYCLE ${cycleCount}] Starting parallel trade execution - waiting for both to complete...`);

      const buyTradePromise = buyIsKraken
        ? quickFillAndSubmitKrakenWithTimeout(
            tradeBuyAccount.page,
            buyPrice,
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
            buyPrice,
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
              price: buyPrice,
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
            sellPrice,
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
            sellPrice,
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
              price: sellPrice,
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
      
      // ALWAYS poll for positions — even if a trade function reports failure,
      // the order may have actually been placed (e.g., GRVT button clicked twice, first click succeeded)
      //
      // With ORDER_AGGRESSIVENESS=maker, orders are passive limit (BUY at bestBid, SELL at bestAsk).
      // They sit in the order book and fill when someone takes the other side.
      // BTC perpetuals are liquid — most maker fills happen within 5-15s.
      // 30s total wait gives ample time; if unfilled by then, price has moved away.
      const maxPositionWait = 120000; // 120s max wait
      const pollInterval = 3000;      // Check every 3s for faster fill detection
      const orderCheckStart = 15000;  // Start checking orders after 15s (give taker fills time)
      const minWaitBeforeSingleLeg = 90000; // Min 90s before declaring single-leg (Change #87)
      const positionWaitStart = Date.now();

      let positionCheck = null;
      let account1HasPosition = false;
      let account2HasPosition = false;
      let orderGone = false; // Track if pending order disappeared (cancelled/expired/rejected)
      let orderGoneDetectedAt = null; // When order disappearance was first detected

      if (!buySuccess || !sellSuccess) {
        const failedSide = !buySuccess ? 'BUY' : 'SELL';
        console.log(`\n[CYCLE ${cycleCount}] ⚠️  ${failedSide} trade reported failure — but order may have been placed. Polling to verify...`);
      }
      console.log(`\n[CYCLE ${cycleCount}] 📊 Waiting for orders to fill (polling every ${pollInterval / 1000}s, max ${maxPositionWait / 1000}s)...`);

      await delay(2000); // Initial wait before first check (orders need a moment to appear)

      while (Date.now() - positionWaitStart < maxPositionWait) {
        positionCheck = await checkOpenPositionsForAccounts(params);
        account1HasPosition = !!positionCheck.account1OpenPositionSide;
        account2HasPosition = !!positionCheck.account2OpenPositionSide;

        const elapsed = ((Date.now() - positionWaitStart) / 1000).toFixed(1);
        const elapsedMs = Date.now() - positionWaitStart;

        if (account1HasPosition && account2HasPosition) {
          console.log(`[CYCLE ${cycleCount}] ✅ Both positions filled after ${elapsed}s — pairing successful!`);
          break;
        }

        if (account1HasPosition || account2HasPosition) {
          const filledExchange = account1HasPosition ? exchange1.name : exchange2.name;
          const waitingExchange = account1HasPosition ? exchange2.name : exchange1.name;

          // After orderCheckStart, check if the empty exchange still has a pending order
          if (elapsedMs >= orderCheckStart) {
            const emptyPage = account1HasPosition ? page2 : page1;
            const emptyIsKraken = account1HasPosition ? account2IsKraken : account1IsKraken;
            const emptyIsGrvt = account1HasPosition ? (exchange2.name === 'Grvt' || exchange2.name?.toLowerCase() === 'grvt') : (exchange1.name === 'Grvt' || exchange1.name?.toLowerCase() === 'grvt');

            let hasPendingOrder = false;
            try {
              hasPendingOrder = await checkForOpenOrders(emptyPage, emptyIsKraken, emptyIsGrvt);
            } catch (e) {
              hasPendingOrder = true; // Assume order still exists on check failure
            }

            if (!hasPendingOrder) {
              // Order disappeared — could be filled (position now exists) or cancelled/expired
              // Do one more position check before declaring single-leg
              const recheck = await checkOpenPositionsForAccounts(params);
              account1HasPosition = !!recheck.account1OpenPositionSide;
              account2HasPosition = !!recheck.account2OpenPositionSide;
              positionCheck = recheck;

              if (account1HasPosition && account2HasPosition) {
                console.log(`[CYCLE ${cycleCount}] ✅ Order on ${waitingExchange} was filled! Both positions open after ${elapsed}s.`);
                break; // Success — both legs filled
              }

              // Change #87: Don't immediately declare single-leg when order disappears.
              // Kraken orders can fill but position takes seconds to appear in UI.
              // Wait until minWaitBeforeSingleLeg (90s) before giving up.
              if (!orderGoneDetectedAt) {
                orderGoneDetectedAt = Date.now();
                console.log(`[CYCLE ${cycleCount}] ⚠️  No pending order on ${waitingExchange} at ${elapsed}s — but waiting until ${minWaitBeforeSingleLeg / 1000}s before declaring single-leg...`);
              }

              if (elapsedMs >= minWaitBeforeSingleLeg) {
                console.log(`[CYCLE ${cycleCount}] ⚠️  No pending order AND no position on ${waitingExchange} after ${elapsed}s — declaring single-leg.`);
                orderGone = true;
                break;
              }

              console.log(`[CYCLE ${cycleCount}] ⏳ ${filledExchange} filled, ${waitingExchange} no order but waiting... (${elapsed}s / ${minWaitBeforeSingleLeg / 1000}s min)`);
            } else {
              console.log(`[CYCLE ${cycleCount}] ⏳ ${filledExchange} filled, ${waitingExchange} order pending... (${elapsed}s / ${maxPositionWait / 1000}s)`);
            }
          } else {
            console.log(`[CYCLE ${cycleCount}] ⏳ ${filledExchange} filled, waiting for ${waitingExchange} to fill... (${elapsed}s / ${maxPositionWait / 1000}s)`);
          }
        } else {
          console.log(`[CYCLE ${cycleCount}] ⏳ No fills yet — orders pending... (${elapsed}s / ${maxPositionWait / 1000}s)`);
        }

        await delay(pollInterval);
      }

      // Final check if loop timed out
      if (!positionCheck || (!account1HasPosition && !account2HasPosition) || (account1HasPosition !== (!!positionCheck.account1OpenPositionSide))) {
        positionCheck = await checkOpenPositionsForAccounts(params);
        account1HasPosition = !!positionCheck.account1OpenPositionSide;
        account2HasPosition = !!positionCheck.account2OpenPositionSide;
      }

      const account1PositionSide = positionCheck.account1OpenPositionSide || 'none';
      const account2PositionSide = positionCheck.account2OpenPositionSide || 'none';
      
      // Log position status
      console.log(`[CYCLE ${cycleCount}] 📊 Position Status After Order Placement:`);
      console.log(`   Account 1 (${email1} - ${exchange1.name}): ${account1HasPosition ? `✅ OPEN (${account1PositionSide})` : '❌ NO POSITION'}`);
      console.log(`   Account 2 (${email2} - ${exchange2.name}): ${account2HasPosition ? `✅ OPEN (${account2PositionSide})` : '❌ NO POSITION'}`);
      
      // Total position creation time: from trade execution start to position fill
      const totalPositionTime = ((Date.now() - startTime) / 1000).toFixed(2);

      // Check if both positions opened
      if (account1HasPosition && account2HasPosition) {
        console.log(`[CYCLE ${cycleCount}] ✅ SUCCESS: Both positions opened successfully! (total: ${totalPositionTime}s = ${(elapsedTime / 1000).toFixed(2)}s order + ${((Date.now() - startTime - elapsedTime) / 1000).toFixed(2)}s fill wait)`);
        console.log(`   Account 1: ${account1PositionSide}, Account 2: ${account2PositionSide}`);

        // Change #86: Validate position sizes — detect double orders (0.004 instead of 0.002)
        const acc1Size = positionCheck.account1PositionSize;
        const acc2Size = positionCheck.account2PositionSize;
        if (acc1Size || acc2Size) {
          const acc1Expected = tradeBuyAccount.email === email1 ? parseFloat(TRADE_CONFIG.buyQty) : parseFloat(TRADE_CONFIG.sellQty);
          const acc2Expected = tradeBuyAccount.email === email2 ? parseFloat(TRADE_CONFIG.buyQty) : parseFloat(TRADE_CONFIG.sellQty);
          const acc1Double = acc1Size && acc1Size > acc1Expected * 1.5;
          const acc2Double = acc2Size && acc2Size > acc2Expected * 1.5;
          if (acc1Double) {
            console.log(`[CYCLE ${cycleCount}] ⚠️  ⚠️  DOUBLE POSITION on ${exchange1.name}: ${acc1Size} BTC (expected ${acc1Expected} BTC)`);
          }
          if (acc2Double) {
            console.log(`[CYCLE ${cycleCount}] ⚠️  ⚠️  DOUBLE POSITION on ${exchange2.name}: ${acc2Size} BTC (expected ${acc2Expected} BTC)`);
          }
          // QA fix: If double position detected, abort cycle immediately.
          // Step 0 of next cycle will detect the oversized position and close it.
          if (acc1Double || acc2Double) {
            console.log(`[CYCLE ${cycleCount}] ❌ ABORT: Double position detected! Restarting cycle — Step 0 will handle cleanup.`);
            savedOpeningThreshold = null;
            savedSellExchange = null;
            await delay(2000);
            continue;
          }
        }

        // Save the ACTUAL opening spread using EXECUTION prices (sellPrice - buyPrice),
        // not market mid-prices. Execution prices reflect taker fills (buyPrice = bestAsk,
        // sellPrice = bestBid in taker mode), so the spread is tighter than market spread.
        // Using market spread would overestimate earned spread → premature close.
        const actualOpeningSpread = sellPrice - buyPrice;
        savedOpeningThreshold = actualOpeningSpread;
        savedSellExchange = finalHighestPriceExchange.exchange;
        console.log(`[CYCLE ${cycleCount}] 💾 Saved opening spread: $${actualOpeningSpread.toLocaleString()} (execution prices: SELL=$${sellPrice.toLocaleString()}, BUY=$${buyPrice.toLocaleString()}, SELL on ${savedSellExchange}, close when earned >= $${TRADE_CONFIG.closingSpread})`);
        
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
          console.log(`[CYCLE ${cycleCount}] 🚨 Closing BOTH positions ASAP due to wrong direction!`);

          // Close BOTH positions immediately — even the correct-direction side must close
          // because keeping one side open = unhedged exposure
          console.log(`[CYCLE ${cycleCount}] 🔄 Closing Account 1 (${account1DirectionCorrect ? 'correct direction' : 'wrong direction'})...`);
          console.log(`[CYCLE ${cycleCount}] 🔄 Closing Account 2 (${account2DirectionCorrect ? 'correct direction' : 'wrong direction'})...`);
          await Promise.all([
            performCleanup(page1, exchange1, email1, 'Account 1', account1IsKraken, true),
            performCleanup(page2, exchange2, email2, 'Account 2', account2IsKraken, true)
          ]);
          console.log(`[CYCLE ${cycleCount}] ✅ Closed BOTH positions due to wrong direction`);

          // Reset saved spread data — no valid hedge exists
          savedOpeningThreshold = null;
          savedSellExchange = null;

          await delay(3000);
          continue; // Skip to next cycle
        }
      } else if (!account1HasPosition && !account2HasPosition) {
        console.log(`[CYCLE ${cycleCount}] ⚠️  WARNING: No positions opened on either account.`);

        // CRITICAL: Cancel any unfilled orders on BOTH exchanges before continuing
        // Without this, unfilled limit orders accumulate across cycles (e.g., 2+ open orders on GRVT)
        console.log(`[CYCLE ${cycleCount}] 🧹 Canceling any unfilled orders on both exchanges...`);
        const cancelPromises = [];
        if (account1IsKraken) {
          cancelPromises.push(cancelKrakenOrders(page1, false).catch(e => console.log(`[${exchange1.name}] Cancel error: ${e.message}`)));
        } else {
          cancelPromises.push(cancelAllOrders(page1).catch(e => console.log(`[${exchange1.name}] Cancel error: ${e.message}`)));
        }
        if (account2IsKraken) {
          cancelPromises.push(cancelKrakenOrders(page2, false).catch(e => console.log(`[${exchange2.name}] Cancel error: ${e.message}`)));
        } else {
          cancelPromises.push(cancelAllOrders(page2).catch(e => console.log(`[${exchange2.name}] Cancel error: ${e.message}`)));
        }
        await Promise.all(cancelPromises);
        console.log(`[CYCLE ${cycleCount}] ✅ Unfilled orders canceled. Skipping to next cycle.`);

        await delay(5000); // Brief pause before retry
        continue; // Skip the 60-min wait, jump straight to next cycle
      } else {
        // Only one position opened — single-leg scenario
        // The unified 120s wait above already checked for pending orders.
        // If we're here, either: (a) 120s expired, (b) order disappeared, or (c) no order was found after 15s.
        const emptyAccount = account1HasPosition ? 2 : 1;
        const emptyPage = account1HasPosition ? page2 : page1;
        const emptyExchange = account1HasPosition ? exchange2 : exchange1;
        const emptyIsKraken = account1HasPosition ? account2IsKraken : account1IsKraken;
        const emptyEmail = account1HasPosition ? email2 : email1;
        const filledAccount = account1HasPosition ? 1 : 2;
        const filledEmail = account1HasPosition ? email1 : email2;
        const filledExchangeName = account1HasPosition ? exchange1.name : exchange2.name;
        const totalWaitElapsed = ((Date.now() - positionWaitStart) / 1000).toFixed(1);

        console.log(`\n[CYCLE ${cycleCount}] ⚠️  Only one position after ${totalWaitElapsed}s wait${orderGone ? ' (order disappeared)' : ' (timeout)'}.`);
        console.log(`   Account ${filledAccount} (${filledEmail} - ${filledExchangeName}): ✅ POSITION`);
        console.log(`   Account ${emptyAccount} (${emptyEmail} - ${emptyExchange.name}): ❌ No position`);

        {
        // Confirmed single-leg: one position, no pending order on other exchange
        const accountWithPosition = account1HasPosition ? 1 : 2;
        const accountWithoutPosition = account1HasPosition ? 2 : 1;
        const positionSide = account1HasPosition ? account1PositionSide : account2PositionSide;
        const accountWithPositionEmail = account1HasPosition ? email1 : email2;
        const accountWithPositionExchange = account1HasPosition ? exchange1 : exchange2;
        const accountWithPositionName = account1HasPosition ? exchange1.name : exchange2.name;

        console.log(`\n[CYCLE ${cycleCount}] ⚠️  ⚠️  ⚠️  CONFIRMED SINGLE-LEG: Only ONE position, no pending order.`);
        console.log(`   Account ${accountWithPosition} (${accountWithPositionEmail} - ${accountWithPositionName}): ✅ OPEN (${positionSide})`);
        console.log(`   Account ${accountWithoutPosition}: ❌ NO POSITION, NO ORDER`);

        // CHANGE #90: Cancel orders on BOTH exchanges before closing position.
        // Previously only canceled orders on the empty side. Now cancels on both sides first.
        const noPositionPage = account1HasPosition ? page2 : page1;
        const noPositionExchange = account1HasPosition ? exchange2 : exchange1;
        const noPositionIsKraken = account1HasPosition ? account2IsKraken : account1IsKraken;
        const noPositionEmail = account1HasPosition ? email2 : email1;
        const positionPage = account1HasPosition ? page1 : page2;
        const positionExchange = account1HasPosition ? exchange1 : exchange2;
        const positionIsKraken = account1HasPosition ? account1IsKraken : account2IsKraken;

        console.log(`[CYCLE ${cycleCount}] 🧹 Step 1: Canceling orders on BOTH exchanges...`);

        // Cancel orders on the empty side
        console.log(`[CYCLE ${cycleCount}] 🧹 Canceling orders on empty side: Account ${accountWithoutPosition} (${noPositionEmail} - ${noPositionExchange.name})...`);
        try {
          if (noPositionIsKraken) {
            await cancelKrakenOrders(noPositionPage, false);
          } else {
            await cancelAllOrders(noPositionPage);
          }
          console.log(`[CYCLE ${cycleCount}] ✅ Orders canceled on empty side (${noPositionExchange.name}).`);
        } catch (e) {
          console.log(`[CYCLE ${cycleCount}] ⚠️  Cancel on empty side failed: ${e.message}. Continuing...`);
        }

        // Cancel orders on the position side (including TP/SL — they'll interfere with manual close)
        console.log(`[CYCLE ${cycleCount}] 🧹 Canceling orders on position side: Account ${accountWithPosition} (${accountWithPositionEmail} - ${positionExchange.name})...`);
        try {
          if (positionIsKraken) {
            await cancelKrakenOrders(positionPage, false);
          } else {
            await cancelAllOrders(positionPage);
          }
          console.log(`[CYCLE ${cycleCount}] ✅ Orders canceled on position side (${positionExchange.name}).`);
        } catch (e) {
          console.log(`[CYCLE ${cycleCount}] ⚠️  Cancel on position side failed: ${e.message}. Continuing...`);
        }

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

        {
          // 4x Limit close attempts, then Market as last resort (minimize market orders)
          const maxLimitAttempts = 4;
          let closed = false;

          for (let attempt = 1; attempt <= maxLimitAttempts && !closed; attempt++) {
            console.log(`[CYCLE ${cycleCount}] Attempt ${attempt}/${maxLimitAttempts}: Closing single-leg with LIMIT order...`);
            await performCleanup(
              accountToClose.page,
              accountToClose.exchange,
              accountToClose.email,
              accountToClose.accountId,
              accountToClose.isKraken,
              false, // Always Limit
              true   // Skip order cancel — orders already canceled above (Change #90)
            );

            await delay(2000);
            const check = await checkOpenPositionsForAccounts(params);
            const stillOpen = accountWithPosition === 1
              ? !!check.account1OpenPositionSide
              : !!check.account2OpenPositionSide;

            if (!stillOpen) {
              console.log(`[CYCLE ${cycleCount}] ✅ Closed single position with LIMIT on attempt ${attempt}.`);
              closed = true;
            } else if (attempt < maxLimitAttempts) {
              console.log(`[CYCLE ${cycleCount}] Position still open. Retrying LIMIT (${attempt}/${maxLimitAttempts})...`);
            }
          }

          if (!closed) {
            console.log(`[CYCLE ${cycleCount}] ⚠️ 4 LIMIT attempts failed. Final attempt: MARKET close...`);
            await performCleanup(accountToClose.page, accountToClose.exchange, accountToClose.email, accountToClose.accountId, accountToClose.isKraken, true, true);

            await delay(2000);
            const finalCheck = await checkOpenPositionsForAccounts(params);
            const finalStillOpen = accountWithPosition === 1
              ? !!finalCheck.account1OpenPositionSide
              : !!finalCheck.account2OpenPositionSide;

            if (finalStillOpen) {
              console.log(`[CYCLE ${cycleCount}] ERROR: Failed to close single position after all attempts (4 Limit + 1 Market)!`);
            } else {
              console.log(`[CYCLE ${cycleCount}] ✅ Closed single position using MARKET close (last resort).`);
            }
          }
        }

        // Orphan check: the unfilled order may have filled during the single-leg close process
        // (close takes ~10-15s with 4x Limit + Market). If so, we now have an orphan position
        // on the "empty" exchange that needs to be closed immediately.
        console.log(`[CYCLE ${cycleCount}] 🔍 Orphan check: verifying ${noPositionExchange.name} didn't fill during close...`);
        const orphanCheck = await checkOpenPositionsForAccounts(params);
        const orphanOnEmpty = accountWithoutPosition === 1
          ? !!orphanCheck.account1OpenPositionSide
          : !!orphanCheck.account2OpenPositionSide;

        if (orphanOnEmpty) {
          console.log(`[CYCLE ${cycleCount}] ⚠️  ORPHAN DETECTED: ${noPositionExchange.name} order filled during single-leg close!`);
          console.log(`[CYCLE ${cycleCount}] 🚨 Closing orphan position on ${noPositionExchange.name} immediately (MARKET)...`);
          try {
            await performCleanup(noPositionPage, noPositionExchange, noPositionEmail, `Account ${accountWithoutPosition}`, noPositionIsKraken, true, false);
            console.log(`[CYCLE ${cycleCount}] ✅ Orphan position closed on ${noPositionExchange.name}.`);
          } catch (e) {
            console.log(`[CYCLE ${cycleCount}] ⚠️  Failed to close orphan: ${e.message}. Next cycle will handle it.`);
          }
        } else {
          console.log(`[CYCLE ${cycleCount}] ✅ No orphan position — ${noPositionExchange.name} is clean.`);
        }

        // Reset saved spread data — no valid hedge exists after single-leg close
        savedOpeningThreshold = null;
        savedSellExchange = null;

        await delay(3000);
        continue; // Skip to next cycle — don't fall through to "completed"
        } // end of single-leg block
      } // end of single-position else block

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