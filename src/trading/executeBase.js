import { delay, findByText, findByExactText } from '../utils/helpers.js';
import { verifyOrderPlaced } from './orders.js';
import { safeClick, safeType, safeClearAndType } from '../utils/safeActions.js';

/**
 * Shared base functions for trade execution across all exchanges
 */

/**
 * Fetch current market price from the page
 */
export async function getCurrentMarketPrice(page, exchangeConfig = null) {
  const exchangeName = exchangeConfig?.name || 'Unknown Exchange';
  console.log(`[${exchangeName}] Fetching current market price...`);

  try {
    // First, check if any modal is open and blocking the page
    const modalOpen = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
      if (modal) {
        const style = window.getComputedStyle(modal);
        const isVisible = modal.offsetParent !== null && 
                         style.display !== 'none' && 
                         style.visibility !== 'hidden';
        return isVisible;
      }
      return false;
    });
    
    if (modalOpen) {
      console.log(`[${exchangeName}] ⚠️  Modal detected on page - attempting to close before fetching price...`);
      // Try to close modal
      const closed = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
        if (modal) {
          const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
          const cancelBtn = buttons.find(btn => {
            const text = btn.textContent?.trim().toLowerCase();
            return text === 'cancel' || text === 'close' || text === 'x' || text === '×';
          });
          if (cancelBtn) {
            cancelBtn.click();
            return true;
          }
        }
        return false;
      });
      
      if (closed) {
        console.log(`[${exchangeName}] ✅ Clicked Cancel/Close button to close modal`);
        await delay(1000); // Wait for modal to close
      } else {
        console.log(`[${exchangeName}] ⚠️  Could not find Cancel/Close button in modal, trying Escape key...`);
        await page.keyboard.press('Escape');
        await delay(1000);
      }
    }

    // Try to get the current price from the page
    const price = await page.evaluate(() => {
      // Look for price displays - common patterns on trading interfaces
      const priceSelectors = [
        // Try to find the main price ticker
        '[class*="price"]',
        '[class*="ticker"]',
        '[class*="mark-price"]',
        '[class*="last-price"]',
        '[data-testid*="price"]',
      ];

      // Check all possible price elements
      for (const selector of priceSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim();
          // Look for USD prices (format: $XX,XXX.XX or XX,XXX.XX)
          const match = text?.match(
            /\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/
          );
          if (match) {
            const priceStr = match[1].replace(/,/g, "");
            const price = parseFloat(priceStr);
            // Validate it's a reasonable BTC price (between $1,000 and $500,000)
            if (price >= 1000 && price <= 500000) {
              return price;
            }
          }
        }
      }

      // Fallback: look for any large number that looks like a BTC price
      const allText = document.body.innerText;
      const priceMatches = allText.match(
        /\$?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)/g
      );
      if (priceMatches) {
        for (const match of priceMatches) {
          const priceStr = match.replace(/[$,]/g, "");
          const price = parseFloat(priceStr);
          if (price >= 1000 && price <= 500000) {
            return price;
          }
        }
      }

      return null;
    });

    if (price) {
      console.log(`[${exchangeName}] ✓ Current market price: $${price.toLocaleString()}`);
      return price;
    } else {
      console.log(`[${exchangeName}] ⚠ Could not find market price on page`);
      return null;
    }
  } catch (error) {
    console.error(`[${exchangeName}] Error fetching market price:`, error.message);
    return null;
  }
}

/**
 * Fetch best bid and best ask prices from the exchange order book.
 * Used for GRVT to place limit orders at best bid (buy) or best ask (sell) for Maker rebates.
 * Returns { bestBid, bestAsk, mid } or null if order book cannot be detected.
 */
export async function getBestBidAsk(page, exchangeConfig = null) {
  const exchangeName = exchangeConfig?.name || 'Unknown Exchange';
  const isKraken = exchangeName.toLowerCase().includes('kraken');
  console.log(`[${exchangeName}] Fetching best bid/ask from order book...`);

  try {
    const bidAskData = await page.evaluate((isKrakenExchange) => {
      // Strategy 1: Look for order book container with common selectors
      const orderbookSelectors = [
        '[class*="orderbook" i]',
        '[class*="OrderBook"]',
        '[class*="order-book"]',
        '[class*="order_book"]',
        '[data-testid*="orderbook"]',
        '[data-testid*="order-book"]',
        '[data-sentry-element*="OrderBook"]',
        '[class*="depth"]',
        '[id*="orderbook" i]',
        '[class*="book" i]',
      ];

      let orderbookContainer = null;
      for (const selector of orderbookSelectors) {
        try {
          const els = document.querySelectorAll(selector);
          for (const el of els) {
            if (el && el.offsetParent !== null && el.offsetHeight > 80) {
              // Verify it contains price-like numbers
              const text = el.textContent || '';
              if (/\d{2,3},\d{3}/.test(text) || /\d{5,6}/.test(text)) {
                orderbookContainer = el;
                break;
              }
            }
          }
          if (orderbookContainer) break;
        } catch (e) { continue; }
      }

      // Strategy 2: Look for ask/bid sections by text content
      if (!orderbookContainer) {
        const allDivs = document.querySelectorAll('div, section, aside, table');
        for (const div of allDivs) {
          if (div.offsetParent === null || div.offsetHeight < 80 || div.offsetWidth < 50) continue;
          const text = div.textContent || '';
          const hasAsk = text.includes('Ask') || text.includes('Sell');
          const hasBid = text.includes('Bid') || text.includes('Buy');
          const hasPrices = /\d{2,3},\d{3}/.test(text) || /\d{5,6}/.test(text);
          if (hasAsk && hasBid && hasPrices) {
            orderbookContainer = div;
            break;
          }
        }
      }

      // Strategy 3 (Kraken-specific): Find the orderbook by looking for a dense price cluster
      // Kraken Pro uses obfuscated classes but renders a visible orderbook with colored rows
      if (!orderbookContainer && isKrakenExchange) {
        // Look for containers with many elements containing BTC-range prices
        const candidates = document.querySelectorAll('div, section');
        let bestCandidate = null;
        let bestPriceCount = 0;

        for (const div of candidates) {
          if (div.offsetParent === null || div.offsetHeight < 100 || div.offsetWidth < 80) continue;
          // Don't search the entire page or very large containers
          if (div.offsetHeight > 1200 || div.childElementCount > 500) continue;

          const innerText = div.textContent || '';
          const priceMatches = innerText.match(/\b\d{2,3},\d{3}(?:\.\d{1,2})?\b/g);
          if (priceMatches && priceMatches.length >= 6 && priceMatches.length > bestPriceCount) {
            // Check that prices cluster around a similar value (orderbook prices are close together)
            const prices = priceMatches.map(p => parseFloat(p.replace(',', '')));
            const range = Math.max(...prices) - Math.min(...prices);
            const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
            // Orderbook prices should be within ~2% of each other
            if (range / avg < 0.02) {
              bestCandidate = div;
              bestPriceCount = priceMatches.length;
            }
          }
        }
        if (bestCandidate) {
          orderbookContainer = bestCandidate;
        }
      }

      if (!orderbookContainer) {
        return null;
      }

      // Extract all price-like values from the order book
      // BTC prices will be in range $1,000 - $500,000
      const priceRegex = /\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/g;

      // Get all rows/elements that contain prices — broader selectors for styled-component UIs
      const rows = orderbookContainer.querySelectorAll(
        'tr, [class*="row" i], [class*="Row"], [class*="level" i], [class*="Level"], [class*="price" i], li, [role="row"], [role="listitem"]'
      );

      const askPrices = [];
      const bidPrices = [];

      // Helper: check element and ancestors for color signals
      const getColorSignal = (el) => {
        let current = el;
        for (let depth = 0; depth < 4 && current; depth++) {
          const style = window.getComputedStyle(current);
          const color = style.color;
          const bgColor = style.backgroundColor;
          const className = (current.className || '').toString();

          // Check text color - parse RGB values
          const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
          if (rgbMatch) {
            const [, r, g, b] = rgbMatch.map(Number);
            if (r > 150 && g < 100 && b < 100) return 'ask';  // red text
            if (g > 150 && r < 100) return 'bid';               // green text
            if (r > 200 && g < 80) return 'ask';                // strong red
            if (g > 200 && r < 80) return 'bid';                // strong green
          }

          // Check background color
          const bgMatch = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (bgMatch) {
            const [, r, g, b] = bgMatch.map(Number);
            if (r > 100 && g < 60 && b < 60) return 'ask';
            if (g > 100 && r < 60 && b < 60) return 'bid';
          }

          // Check class names
          if (/ask|sell|red|negative|short/i.test(className)) return 'ask';
          if (/bid|buy|green|positive|long/i.test(className)) return 'bid';

          current = current.parentElement;
        }
        return null;
      };

      for (const row of rows) {
        if (!row.offsetParent) continue;

        const text = row.textContent || '';
        const matches = text.match(priceRegex);
        if (!matches) continue;

        for (const match of matches) {
          const priceStr = match.replace(/[$,]/g, '');
          const price = parseFloat(priceStr);
          if (price < 1000 || price > 500000) continue;

          const signal = getColorSignal(row);

          if (signal === 'ask') {
            askPrices.push(price);
          } else if (signal === 'bid') {
            bidPrices.push(price);
          } else {
            // Fallback: Use position in container
            const rect = row.getBoundingClientRect();
            const containerRect = orderbookContainer.getBoundingClientRect();
            const midY = containerRect.top + containerRect.height / 2;

            if (rect.top < midY) {
              askPrices.push(price);
            } else {
              bidPrices.push(price);
            }
          }
        }
      }

      // Strategy 4: If no rows found via selectors, scan all child elements with prices
      // This handles Kraken's hashed class names that don't match any pattern
      if (askPrices.length === 0 && bidPrices.length === 0) {
        const allChildren = orderbookContainer.querySelectorAll('*');
        for (const child of allChildren) {
          if (!child.offsetParent || child.children.length > 3) continue;
          const text = (child.textContent || '').trim();
          // Only look at leaf-ish elements with short text (price cells)
          if (text.length > 30 || text.length < 3) continue;

          const matches = text.match(priceRegex);
          if (!matches) continue;

          for (const match of matches) {
            const priceStr = match.replace(/[$,]/g, '');
            const price = parseFloat(priceStr);
            if (price < 1000 || price > 500000) continue;

            const signal = getColorSignal(child);

            if (signal === 'ask') {
              askPrices.push(price);
            } else if (signal === 'bid') {
              bidPrices.push(price);
            } else {
              const rect = child.getBoundingClientRect();
              const containerRect = orderbookContainer.getBoundingClientRect();
              const midY = containerRect.top + containerRect.height / 2;
              if (rect.top < midY) {
                askPrices.push(price);
              } else {
                bidPrices.push(price);
              }
            }
          }
        }
      }

      if (askPrices.length === 0 && bidPrices.length === 0) {
        return null;
      }

      const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null;
      const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null;

      // If bid >= ask, color/position detection is inverted — reclassify using price gap
      if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) {
        const allPrices = [...new Set([...askPrices, ...bidPrices])].sort((a, b) => a - b);
        if (allPrices.length >= 2) {
          // Find the largest gap between consecutive prices — this is the bid/ask boundary
          let maxGap = 0, gapIdx = 0;
          for (let i = 1; i < allPrices.length; i++) {
            const gap = allPrices[i] - allPrices[i - 1];
            if (gap > maxGap) { maxGap = gap; gapIdx = i; }
          }
          const reBids = allPrices.slice(0, gapIdx);   // lower prices = bids
          const reAsks = allPrices.slice(gapIdx);        // higher prices = asks
          if (reBids.length > 0 && reAsks.length > 0) {
            const newBestBid = Math.max(...reBids);
            const newBestAsk = Math.min(...reAsks);
            if (newBestBid < newBestAsk) {
              return {
                bestBid: newBestBid,
                bestAsk: newBestAsk,
                mid: (newBestBid + newBestAsk) / 2,
                bidCount: reBids.length,
                askCount: reAsks.length,
                reclassified: true,
              };
            }
          }
        }
      }

      const mid = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : null;

      return {
        bestBid,
        bestAsk,
        mid,
        askCount: askPrices.length,
        bidCount: bidPrices.length,
      };
    }, isKraken);

    if (bidAskData && (bidAskData.bestBid || bidAskData.bestAsk)) {
      if (bidAskData.reclassified) {
        console.log(`[${exchangeName}] ⚠️ Order book color/position detection was inverted — reclassified by price gap:`);
      } else {
        console.log(`[${exchangeName}] Order book detected:`);
      }
      console.log(`  Best Bid: $${bidAskData.bestBid?.toLocaleString() || 'N/A'} (${bidAskData.bidCount} levels)`);
      console.log(`  Best Ask: $${bidAskData.bestAsk?.toLocaleString() || 'N/A'} (${bidAskData.askCount} levels)`);
      console.log(`  Mid: $${bidAskData.mid?.toLocaleString() || 'N/A'}`);

      // Sanity check: bid should be less than ask (should be rare after reclassification)
      if (bidAskData.bestBid && bidAskData.bestAsk && bidAskData.bestBid >= bidAskData.bestAsk) {
        console.log(`[${exchangeName}] WARNING: Best bid ($${bidAskData.bestBid}) >= best ask ($${bidAskData.bestAsk}). Reclassification also failed. Returning null.`);
        return null;
      }

      // Sanity check: spread should be reasonable (< 1% of price)
      if (bidAskData.bestBid && bidAskData.bestAsk) {
        const spread = bidAskData.bestAsk - bidAskData.bestBid;
        const spreadPct = spread / bidAskData.bestBid;
        if (spreadPct > 0.01) {
          console.log(`[${exchangeName}] WARNING: Spread is ${(spreadPct * 100).toFixed(2)}% ($${spread.toFixed(2)}). Unusually wide. Returning null.`);
          return null;
        }
      }

      return bidAskData;
    } else {
      console.log(`[${exchangeName}] Could not detect order book bid/ask prices.`);
      return null;
    }
  } catch (error) {
    console.error(`[${exchangeName}] Error fetching bid/ask prices:`, error.message);
    return null;
  }
}

/**
 * Get aggressive price based on ORDER_AGGRESSIVENESS config.
 * - taker: BUY at bestAsk (cross spread), SELL at bestBid (cross spread) — fills immediately
 * - maker: BUY at bestBid (passive), SELL at bestAsk (passive) — earns maker rebate
 * - mid: use mid price (legacy)
 * Falls back to mid price if bid/ask detection fails.
 */
export async function getAggressivePrice(page, exchangeConfig, side) {
  const exchangeName = exchangeConfig?.name || 'Unknown';

  try {
    const aggressiveness = (process.env.ORDER_AGGRESSIVENESS || '').toLowerCase();

    // Resolve mode: ORDER_AGGRESSIVENESS takes priority, fallback to GRVT_ORDER_MODE
    let mode;
    if (aggressiveness === 'taker' || aggressiveness === 'maker' || aggressiveness === 'mid') {
      mode = aggressiveness;
    } else {
      const grvtMode = (process.env.GRVT_ORDER_MODE || 'mid').toLowerCase();
      mode = grvtMode === 'best_bidask' ? 'maker' : 'mid';
    }

    if (mode === 'mid') {
      const price = await getCurrentMarketPrice(page, exchangeConfig);
      if (price) console.log(`[${exchangeName}] MID price: $${price.toLocaleString()} (side: ${side})`);
      return price;
    }

    const bidAsk = await getBestBidAsk(page, exchangeConfig);

    if (!bidAsk) {
      console.log(`[${exchangeName}] Bid/Ask detection failed, falling back to mid price...`);
      return await getCurrentMarketPrice(page, exchangeConfig);
    }

    let price;
    if (mode === 'taker') {
      // Cross the spread: BUY at bestAsk (lifts the ask), SELL at bestBid (hits the bid)
      price = side === 'buy' ? bidAsk.bestAsk : bidAsk.bestBid;
      if (price) {
        console.log(`[${exchangeName}] TAKER ${side.toUpperCase()}: $${price.toLocaleString()} (crossing spread, bid=${bidAsk.bestBid}, ask=${bidAsk.bestAsk})`);
      }
    } else {
      // Passive: BUY at bestBid (join the bid), SELL at bestAsk (join the ask)
      price = side === 'buy' ? bidAsk.bestBid : bidAsk.bestAsk;
      if (price) {
        console.log(`[${exchangeName}] MAKER ${side.toUpperCase()}: $${price.toLocaleString()} (passive, bid=${bidAsk.bestBid}, ask=${bidAsk.bestAsk})`);
      }
    }

    if (!price) {
      console.log(`[${exchangeName}] ${mode.toUpperCase()} price not available, falling back to mid...`);
      price = bidAsk.mid || await getCurrentMarketPrice(page, exchangeConfig);
    }

    return price;
  } catch (error) {
    console.error(`[${exchangeName}] Error in getAggressivePrice:`, error.message);
    return await getCurrentMarketPrice(page, exchangeConfig);
  }
}

/**
 * Select Buy or Sell button
 */
export async function selectBuyOrSell(page, side, exchange) {
  if (side === "sell") {
    // Try exact match first
    let sellBtn = await findByExactText(page, exchange.selectors.sellButton, ["button", "div"]);
    
    // If exact match fails, try partial match (for GRVT "Sell / Short")
    if (!sellBtn) {
      sellBtn = await findByText(page, exchange.selectors.sellButton, ["button", "div"]);
    }
    
    // Fallback: Try matching just "Sell" or "Short"
    if (!sellBtn) {
      sellBtn = await findByText(page, "Sell", ["button", "div"]);
      if (!sellBtn) {
        sellBtn = await findByText(page, "Short", ["button", "div"]);
      }
    }
    
    if (sellBtn) {
      await safeClick(page, sellBtn);
      console.log(`[${exchange.name}] Selected SELL`);
      await delay(300);
      return true;
    }
  } else {
    // Try exact match first
    let buyBtn = await findByExactText(page, exchange.selectors.buyButton, ["button", "div"]);
    
    // If exact match fails, try partial match (for GRVT "Buy / Long")
    if (!buyBtn) {
      buyBtn = await findByText(page, exchange.selectors.buyButton, ["button", "div"]);
    }
    
    // Fallback: Try matching just "Buy" or "Long"
    if (!buyBtn) {
      buyBtn = await findByText(page, "Buy", ["button", "div"]);
      if (!buyBtn) {
        buyBtn = await findByText(page, "Long", ["button", "div"]);
      }
    }
    
    if (buyBtn) {
      await safeClick(page, buyBtn);
      console.log(`[${exchange.name}] Selected BUY`);
      await delay(300);
      return true;
    }
  }
  return false;
}

/**
 * Select Market or Limit order type
 */
export async function selectOrderType(page, orderType, exchange) {
  console.log(`[${exchange.name}] selectOrderType: Looking for ${orderType.toUpperCase()} button...`);
  try {
    if (orderType === "limit") {
      console.log(`[${exchange.name}] Searching for Limit button with text: "${exchange.selectors.limitButton}"`);
      const limitBtn = await findByExactText(page, exchange.selectors.limitButton, ["button", "div"]);
      if (limitBtn) {
        // Safety check: Verify it's not a deposit/link button before clicking
        const buttonInfo = await page.evaluate((el) => {
          const text = (el.textContent || '').trim().toLowerCase();
          const href = el.getAttribute('href') || '';
          const isLink = el.tagName === 'A' || href !== '';
          return {
            text: text,
            isLink: isLink,
            href: href,
            containsDeposit: text.includes('deposit') || text.includes('withdraw')
          };
        }, limitBtn);
        
        if (buttonInfo.isLink) {
          console.log(`[${exchange.name}] ⚠️  Found button but it's a link (href: ${buttonInfo.href}), skipping to avoid navigation...`);
        } else if (buttonInfo.containsDeposit) {
          console.log(`[${exchange.name}] ⚠️  Found button but text contains deposit/withdraw (${buttonInfo.text}), skipping to avoid navigation...`);
        } else {
          console.log(`[${exchange.name}] Found Limit button, clicking...`);
          await safeClick(page, limitBtn);
          console.log(`[${exchange.name}] Selected LIMIT order`);
          await delay(300);
          
          // Verify we're still on trading page (not navigated away)
          const currentUrl = page.url();
          if (currentUrl.includes('/deposit') || currentUrl.includes('/withdraw')) {
            console.log(`[${exchange.name}] ⚠️  Navigation detected to ${currentUrl}, going back...`);
            await page.goBack();
            await delay(1000);
            return false; // Failed due to navigation
          }
          return true;
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Limit button not found`);
      }
    } else {
      console.log(`[${exchange.name}] Searching for Market button with text: "${exchange.selectors.marketButton}"`);
      const marketBtn = await findByExactText(page, exchange.selectors.marketButton, ["button", "div"]);
      if (marketBtn) {
        // Safety check: Verify it's not a deposit/link button before clicking
        const buttonInfo = await page.evaluate((el) => {
          const text = (el.textContent || '').trim().toLowerCase();
          const href = el.getAttribute('href') || '';
          const isLink = el.tagName === 'A' || href !== '';
          return {
            text: text,
            isLink: isLink,
            href: href,
            containsDeposit: text.includes('deposit') || text.includes('withdraw')
          };
        }, marketBtn);
        
        if (buttonInfo.isLink) {
          console.log(`[${exchange.name}] ⚠️  Found button but it's a link (href: ${buttonInfo.href}), skipping to avoid navigation...`);
        } else if (buttonInfo.containsDeposit) {
          console.log(`[${exchange.name}] ⚠️  Found button but text contains deposit/withdraw (${buttonInfo.text}), skipping to avoid navigation...`);
        } else {
          console.log(`[${exchange.name}] Found Market button, clicking...`);
          await safeClick(page, marketBtn);
          console.log(`[${exchange.name}] Selected MARKET order`);
          await delay(300);
          
          // Verify we're still on trading page (not navigated away)
          const currentUrl = page.url();
          if (currentUrl.includes('/deposit') || currentUrl.includes('/withdraw')) {
            console.log(`[${exchange.name}] ⚠️  Navigation detected to ${currentUrl}, going back...`);
            await page.goBack();
            await delay(1000);
            return false; // Failed due to navigation
          }
          return true;
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Market button not found`);
      }
    }
  } catch (error) {
    console.log(`[${exchange.name}] ⚠️  Error in selectOrderType: ${error.message}`);
  }
  return false;
}

/**
 * Find size and price input fields
 */
export async function findSizeAndPriceInputs(page, orderType) {
  const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type])');
  let sizeInput = null;
  let priceInput = null;

  console.log(`Found ${inputs.length} text input elements on page`);

  for (const input of inputs) {
    // Minimize-safe: use DOM-level visibility check instead of boundingBox coordinates
    const isInputVisible = await page.evaluate(el => el.offsetParent !== null && !el.disabled, input);
    if (!isInputVisible) continue;

    const inputInfo = await page.evaluate((el) => {
      // Get all text content around this input
      let parent = el.parentElement;
      let parentText = "";
      let labelText = "";
      let siblingText = "";

      // Check for label using multiple methods
      const labels = document.querySelectorAll("label");
      for (const label of labels) {
        // Method 1: label.control points to input
        if (label.control === el) {
          labelText = label.textContent?.trim() || "";
          break;
        }
        // Method 2: label's 'for' attribute matches input id
        if (label.getAttribute('for') === el.id && el.id) {
          labelText = label.textContent?.trim() || "";
          break;
        }
        // Method 3: label contains the input
        if (label.contains(el)) {
          labelText = label.textContent?.trim() || "";
          break;
        }
      }

      // Check previous sibling for label text (Kraken uses this pattern)
      let prevSibling = el.previousElementSibling;
      for (let i = 0; i < 3 && prevSibling; i++) {
        const text = prevSibling.textContent?.trim() || "";
        if (text && (text.toLowerCase().includes('quantity') || text.toLowerCase().includes('size'))) {
          siblingText = text;
          break;
        }
        prevSibling = prevSibling.previousElementSibling;
      }

      // Get parent text (more thorough search)
      for (let i = 0; i < 7 && parent; i++) {
        if (parent.innerText) {
          parentText = parent.innerText;
          break;
        }
        parent = parent.parentElement;
      }

      return {
        placeholder: el.placeholder || "",
        value: el.value || "",
        id: el.id || "",
        name: el.name || "",
        parentText: parentText,
        labelText: labelText,
        siblingText: siblingText,
      };
    }, input);

    console.log(`  ID: "${inputInfo.id}", Name: "${inputInfo.name}", Placeholder: "${inputInfo.placeholder}"`);
    console.log(`  Label: "${inputInfo.labelText}", Sibling: "${inputInfo.siblingText}", Parent: "${inputInfo.parentText.substring(0, 60)}"`);

    console.log(`  Current value: "${inputInfo.value}"`);

    // Check if this is the Size input (case-insensitive for better matching)
    // For GRVT: placeholder is "Quantity"
    // For Kraken: label/sibling text is "Quantity"
    const parentTextLower = inputInfo.parentText.toLowerCase();
    const labelTextLower = inputInfo.labelText.toLowerCase();
    const siblingTextLower = inputInfo.siblingText.toLowerCase();
    const placeholderLower = inputInfo.placeholder.toLowerCase();
    const idLower = inputInfo.id.toLowerCase();
    const nameLower = inputInfo.name.toLowerCase();
    
    const isSizeInput =
      parentTextLower.includes("size") ||
      labelTextLower.includes("size") ||
      siblingTextLower.includes("size") ||
      placeholderLower.includes("size") ||
      idLower.includes("size") ||
      nameLower.includes("size") ||
      // Also check for "quantity" (GRVT uses "Quantity" placeholder, Kraken uses "Quantity" label)
      parentTextLower.includes("quantity") ||
      labelTextLower.includes("quantity") ||
      siblingTextLower.includes("quantity") ||
      placeholderLower.includes("quantity") ||
      placeholderLower === "quantity" || // Exact match for GRVT
      labelTextLower === "quantity" || // Exact match for Kraken label
      siblingTextLower === "quantity" || // Exact match for Kraken sibling
      idLower.includes("quantity") ||
      nameLower.includes("quantity");

    // Check if this is the Price input
    // For GRVT: Also check for "Price" in lowercase and variations
    // For GRVT: Price input has "Mid" in value or parent text (similar to "BTC" for quantity)
    const isPriceInput =
      inputInfo.parentText.toLowerCase().includes("price") ||
      inputInfo.labelText.toLowerCase().includes("price") ||
      inputInfo.placeholder.toLowerCase().includes("price") ||
      inputInfo.id.toLowerCase().includes("price") ||
      inputInfo.name.toLowerCase().includes("price") ||
      // For GRVT: Check for "Mid" in value or parent text
      inputInfo.value.toLowerCase().includes("mid") ||
      inputInfo.parentText.toLowerCase().includes("mid") ||
      inputInfo.siblingText.toLowerCase().includes("mid") ||
      // Also check for price-like patterns (numbers with $ or commas)
      (inputInfo.value && inputInfo.value.match(/^\$?[0-9,]+(\.[0-9]+)?$/)) ||
      // Check if input is near "Price" text
      (inputInfo.siblingText.toLowerCase().includes("price"));

    if (isSizeInput && !sizeInput) {
      sizeInput = input;
      console.log("✓ Found size input!");
    } else if (isPriceInput && !priceInput && orderType === "limit") {
      priceInput = input;
      console.log("✓ Found price input!");
    }
  }
  
  // For GRVT: If we found size input but not price input, search by placeholder/label
  if (sizeInput && !priceInput && orderType === "limit") {
    console.log("⚠️  Price input not found via text search, trying placeholder/label search...");
    for (const input of inputs) {
      if (input === sizeInput) continue;
      const info = await page.evaluate(el => ({
        visible: el.offsetParent !== null && !el.disabled && !el.readOnly,
        ph: (el.placeholder || '').toLowerCase(),
        label: (() => {
          const labels = document.querySelectorAll('label');
          for (const l of labels) {
            if (l.control === el || l.contains(el)) return (l.textContent || '').toLowerCase();
          }
          return '';
        })(),
        value: (el.value || '').toLowerCase()
      }), input);
      if (!info.visible) continue;
      if (info.ph.includes('price') || info.label.includes('price') || info.value.includes('mid')) {
        priceInput = input;
        console.log("✓ Found price input via placeholder/label search!");
        break;
      }
    }
    // Last resort: take first visible non-size input
    if (!priceInput) {
      for (const input of inputs) {
        if (input === sizeInput) continue;
        const isEnabled = await page.evaluate(el => el.offsetParent !== null && !el.disabled && !el.readOnly, input);
        if (isEnabled) {
          priceInput = input;
          console.log("✓ Found price input (first available non-size input)!");
          break;
        }
      }
    }
  }

  // Fallback 1: If size input not found, look for input with "BTC" in value or nearby text
  if (!sizeInput) {
    console.log("⚠️  Size input not found with standard methods, trying fallback 1 (looking for input with BTC)...");
    for (const input of inputs) {
      const isVisible = await page.evaluate(el => el.offsetParent !== null && !el.disabled, input);
      if (!isVisible) continue;

      const inputInfo = await page.evaluate((el) => {
        const value = el.value || "";
        const placeholder = el.placeholder || "";
        let parent = el.parentElement;
        let parentText = "";
        let prevSibling = el.previousElementSibling;
        let siblingText = "";
        
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.innerText) {
            parentText = parent.innerText;
            break;
          }
          parent = parent.parentElement;
        }
        
        if (prevSibling) {
          siblingText = prevSibling.textContent?.trim() || "";
        }
        
        return {
          value: value,
          placeholder: placeholder,
          parentText: parentText,
          siblingText: siblingText,
          hasBtc: value.toLowerCase().includes("btc") || 
                  placeholder.toLowerCase().includes("btc") ||
                  parentText.toLowerCase().includes("btc") ||
                  siblingText.toLowerCase().includes("btc")
        };
      }, input);

      // If input has BTC in value or nearby, and it's not the price input, it's likely the size input
      if (inputInfo.hasBtc && !inputInfo.value.match(/^\$?[0-9,]+(\.[0-9]+)?$/)) {
        // Not a price format (price would be like $84,742.3)
        sizeInput = input;
        console.log("✓ Found size input via BTC fallback!");
        
        // After finding size input, try to find price input (for GRVT)
        if (!priceInput && orderType === "limit") {
          for (const otherInput of inputs) {
            if (otherInput === sizeInput) continue;
            const otherInfo = await page.evaluate(el => ({
              visible: el.offsetParent !== null && !el.disabled && !el.readOnly,
              ph: (el.placeholder || '').toLowerCase(),
              label: (() => {
                const labels = document.querySelectorAll('label');
                for (const l of labels) {
                  if (l.control === el || l.contains(el)) return (l.textContent || '').toLowerCase();
                }
                return '';
              })()
            }), otherInput);
            if (!otherInfo.visible) continue;
            if (otherInfo.ph.includes('price') || otherInfo.label.includes('price')) {
              priceInput = otherInput;
              console.log("✓ Found price input via text search (from BTC fallback)!");
              break;
            }
          }
        }
        break;
      }
    }
  }

  // Fallback 2: If still not found, search ALL inputs without position filter (for Kraken)
  if (!sizeInput) {
    console.log("⚠️  Size input still not found, trying fallback 2 (searching all inputs without position filter)...");
    for (const input of inputs) {
      const isVisible = await page.evaluate(el => el.offsetParent !== null && !el.disabled, input);
      if (!isVisible) continue;

      const inputInfo = await page.evaluate((el) => {
        const value = el.value || "";
        const placeholder = el.placeholder || "";
        let parent = el.parentElement;
        let parentText = "";
        let labelText = "";
        let prevSibling = el.previousElementSibling;
        let siblingText = "";
        
        // Check for label
        const labels = document.querySelectorAll("label");
        for (const label of labels) {
          if (label.control === el || label.getAttribute('for') === el.id || label.contains(el)) {
            labelText = label.textContent?.trim() || "";
            break;
          }
        }
        
        if (prevSibling) {
          siblingText = prevSibling.textContent?.trim() || "";
        }
        
        for (let i = 0; i < 7 && parent; i++) {
          if (parent.innerText) {
            parentText = parent.innerText;
            break;
          }
          parent = parent.parentElement;
        }
        
        const allText = (value + " " + placeholder + " " + labelText + " " + siblingText + " " + parentText).toLowerCase();
        
        return {
          value: value,
          placeholder: placeholder,
          labelText: labelText,
          siblingText: siblingText,
          parentText: parentText,
          hasQuantity: allText.includes("quantity"),
          hasSize: allText.includes("size"),
          hasBtc: allText.includes("btc"),
          isNumeric: /^[0-9.,]+$/.test(value.replace(/[^0-9.,]/g, ""))
        };
      }, input);

      // Check if this looks like a size/quantity input
      if ((inputInfo.hasQuantity || inputInfo.hasSize || inputInfo.hasBtc) && 
          inputInfo.isNumeric && 
          !inputInfo.value.match(/^\$?[0-9,]+(\.[0-9]+)?$/)) {
        // Has quantity/size/BTC text and numeric value, not a price format
        sizeInput = input;
        console.log(`✓ Found size input via fallback 2! (hasQuantity: ${inputInfo.hasQuantity}, hasSize: ${inputInfo.hasSize}, hasBtc: ${inputInfo.hasBtc})`);
        break;
      }
    }
  }

  return { sizeInput, priceInput };
}

/**
 * Enter price into price input field
 */
export async function enterPrice(page, priceInput, price, orderType) {
  if (orderType === "limit" && price) {
    if (priceInput) {
      const priceStr = String(price);
      console.log(`Entering price: ${priceStr}`);

      // Method 1: Select all + type (replaces selected text, works with React controlled inputs)
      // IMPORTANT: No delays or extra steps between select and type — React re-renders can clear the selection
      await page.evaluate(el => { el.focus(); el.select(); }, priceInput);
      await page.keyboard.type(priceStr, { delay: 50 });
      await delay(200);

      let finalValue = await page.evaluate((el) => el.value || '', priceInput);

      // Verify: value should match what we typed
      if (finalValue !== priceStr) {
        console.log(`⚠️  Price mismatch: got "${finalValue}", expected "${priceStr}". Trying React native setter...`);
        // Method 2: React native value setter (bypasses React controlled component)
        await page.evaluate((el, val) => {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, priceInput, priceStr);
        await delay(200);

        finalValue = await page.evaluate((el) => el.value || '', priceInput);
        if (finalValue !== priceStr) {
          console.log(`⚠️  React setter also failed: got "${finalValue}". Trying Cmd/Ctrl+A + type...`);
          // Method 3: Keyboard select-all + type (Meta on macOS, Control on others)
          const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
          await page.evaluate(el => el.focus(), priceInput);
          await page.keyboard.down(modKey);
          await page.keyboard.press('a');
          await page.keyboard.up(modKey);
          await page.keyboard.type(priceStr, { delay: 50 });
          await delay(200);
          finalValue = await page.evaluate((el) => el.value || '', priceInput);
          if (finalValue !== priceStr) {
            console.log(`⚠️  Method 3 also failed: got "${finalValue}", expected "${priceStr}"`);
          }
        }
      }

      console.log(`✅ Price entered: ${finalValue}`);
    } else {
      console.log(`⚠️  Price input not provided, trying fallback...`);
      // Fallback: find price input by placeholder (minimize-safe, no boundingBox)
      const allInputs = await page.$$("input");
      for (const inp of allInputs) {
        const ph = await page.evaluate(el => (el.placeholder || '').toLowerCase(), inp);
        if (ph.includes('price') || ph.includes('mid')) {
          // Use select+type to replace content (works with React controlled inputs)
          await page.evaluate(el => { el.focus(); el.select(); }, inp);
          await delay(100);
          await page.keyboard.type(String(price), { delay: 50 });
          await delay(200);
          const fallbackValue = await page.evaluate(el => el.value || '', inp);
          if (fallbackValue !== String(price)) {
            // React native setter fallback
            await page.evaluate((el, val) => {
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, inp, String(price));
          }
          console.log(`Entered price: ${price} (fallback)`);
          break;
        }
      }
    }
    await delay(300);
  }
}

/**
 * Enter size/quantity into size input field
 */
export async function enterSize(page, sizeInput, qty, exchange) {
  if (!sizeInput) {
    console.log(`[${exchange.name}] ❌ Size input not found! Cannot proceed with trade.`);
    return { success: false, error: "Size input field not found" };
  }

  console.log(`\n[${exchange.name}] === Entering Size ===`);
  console.log(`[${exchange.name}] Target size from env: ${qty}`);

  const desiredQtyStr = String(qty).trim();
  const desiredQtyNum = parseFloat(desiredQtyStr);
  
  // Get current value before clearing
  const currentValue = await page.evaluate((el) => el.value || '', sizeInput);
  console.log(`[${exchange.name}] Current size value in input: "${currentValue}"`);

  // Method 1: Select all + Backspace + Type new value (minimize-safe)
  console.log(`[${exchange.name}] Method 1: Select all + Backspace + Type new value...`);
  await page.evaluate(el => el.focus(), sizeInput);
  await delay(200);

  // Select all text (minimize-safe: DOM-level)
  await page.evaluate(el => { el.focus(); el.select(); }, sizeInput);
  await delay(200);

  // Press Backspace to delete selected text
  await page.keyboard.press("Backspace");
  await delay(200);
  
  // Verify it's cleared
  let clearedValue = await page.evaluate((el) => el.value || '', sizeInput);
  console.log(`[${exchange.name}] Value after triple click + Backspace: "${clearedValue}"`);
  
  // If not cleared, try JavaScript clear
  if (clearedValue && clearedValue.trim() !== '') {
    console.log(`[${exchange.name}] Input not fully cleared, using JavaScript clear...`);
    await page.evaluate((el) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sizeInput);
    await delay(200);
    clearedValue = await page.evaluate((el) => el.value || '', sizeInput);
    console.log(`[${exchange.name}] Value after JavaScript clear: "${clearedValue}"`);
  }
  
  // Type the new value from env (minimize-safe)
  console.log(`[${exchange.name}] Typing new size value: "${desiredQtyStr}"...`);
  await page.evaluate(el => el.focus(), sizeInput);
  await page.keyboard.type(desiredQtyStr, { delay: 50 });
  await delay(300);
  
  // Trigger input/change events to ensure UI updates
  await page.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }, sizeInput);
  await delay(300);

  // Verify the value was set correctly
  let actualValue = await page.evaluate((el) => el.value || '', sizeInput);
  console.log(`[${exchange.name}] Size input value after typing: "${actualValue}"`);
  
  // Check if value matches (allowing for small floating point differences)
  const actualValueNum = parseFloat(actualValue.replace(/,/g, ''));
  const isMatch = actualValueNum && !isNaN(actualValueNum) && 
                  Math.abs(actualValueNum - desiredQtyNum) < 0.0001;
  
  // If value wasn't set properly, try alternative method
  if (!isMatch) {
    console.log(`[${exchange.name}] ⚠️  First attempt failed (expected: "${desiredQtyStr}", got: "${actualValue}"), trying alternative method...`);

    // Method 2: Focus, clear with JS, then type (minimize-safe)
    await page.evaluate(el => el.focus(), sizeInput);
    await delay(200);

    // Clear using JavaScript
    await page.evaluate((el) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sizeInput);
    await delay(200);

    // Select all + Backspace (minimize-safe)
    await page.evaluate(el => { el.focus(); el.select(); }, sizeInput);
    await delay(100);
    await page.keyboard.press("Backspace");
    await delay(100);

    // Type again (minimize-safe)
    await page.evaluate(el => el.focus(), sizeInput);
    await page.keyboard.type(desiredQtyStr, { delay: 50 });
    await delay(300);
    
    // Trigger events
    await page.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sizeInput);
    await delay(300);

    actualValue = await page.evaluate((el) => el.value || '', sizeInput);
    const actualValueNum2 = parseFloat(actualValue.replace(/,/g, ''));
    const isMatch2 = actualValueNum2 && !isNaN(actualValueNum2) && 
                     Math.abs(actualValueNum2 - desiredQtyNum) < 0.0001;
    console.log(`[${exchange.name}] Size input value after second attempt: "${actualValue}" (match: ${isMatch2})`);
    
    if (!isMatch2) {
      // Method 3: Direct value assignment as last resort
      console.log(`[${exchange.name}] Second attempt failed, using direct assignment...`);

      await page.evaluate(
        (el, value) => {
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        },
        sizeInput,
        desiredQtyStr
      );
      await delay(500);

      actualValue = await page.evaluate((el) => el.value || '', sizeInput);
      const actualValueNum3 = parseFloat(actualValue.replace(/,/g, ''));
      const isMatch3 = actualValueNum3 && !isNaN(actualValueNum3) && 
                       Math.abs(actualValueNum3 - desiredQtyNum) < 0.0001;
      console.log(`[${exchange.name}] Size input value after direct assignment: "${actualValue}" (match: ${isMatch3})`);
      
      if (!isMatch3) {
        console.log(`[${exchange.name}] ❌ Failed to set size value after all methods!`);
        return { success: false, error: `Failed to enter size value. Expected: "${desiredQtyStr}", got: "${actualValue}"` };
      }
    }
  }

  // Final verification
  const finalValue = await page.evaluate((el) => el.value || '', sizeInput);
  const finalValueNum = parseFloat(finalValue.replace(/,/g, ''));
  if (!finalValue || finalValue.trim() === "" || !finalValueNum || isNaN(finalValueNum)) {
    console.log(`[${exchange.name}] ❌ Failed to set size value! Final value: "${finalValue}"`);
    return { success: false, error: "Failed to enter size value" };
  }
  
  console.log(`[${exchange.name}] ✅ Successfully set size to: "${finalValue}" (target: "${desiredQtyStr}")`);
  return { success: true };
}

/**
 * Click confirm button (generic implementation)
 */
export async function clickConfirmButton(page, confirmBtn, confirmText, exchange, side) {
  // Log which exchange and button before clicking
  console.log(`[${exchange.name}] 🖱️  Clicking "${confirmText}" button now...`);
  
  // Scroll button into view and ensure it's not hidden behind footer
  const buttonInfo = await page.evaluate((btn) => {
    const rect = btn.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    
    // Check if button is in viewport
    const isInViewport = rect.top >= 0 && 
                        rect.left >= 0 && 
                        rect.bottom <= viewportHeight && 
                        rect.right <= viewportWidth;
    
    // Check if button might be covered by footer (in bottom 15% of viewport)
    const isNearFooter = rect.bottom > viewportHeight * 0.85;
    
    // Get element at button's center point to check if something is covering it
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    
    // Check if the element at the point is the button itself or inside it
    const isCovered = elementAtPoint && 
                    !btn.contains(elementAtPoint) && 
                    elementAtPoint !== btn &&
                    !elementAtPoint.closest('button, [role="button"]');
    
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      isInViewport,
      isNearFooter,
      isCovered,
      viewportHeight,
      viewportWidth,
      centerX,
      centerY
    };
  }, confirmBtn);
  
  console.log(`Button position: (${Math.round(buttonInfo.x)}, ${Math.round(buttonInfo.y)}), Viewport: ${buttonInfo.viewportWidth}x${buttonInfo.viewportHeight}`);
  
  // Scroll button into view if needed
  if (!buttonInfo.isInViewport || buttonInfo.isNearFooter) {
    console.log(`📜 Scrolling button into view (isInViewport: ${buttonInfo.isInViewport}, isNearFooter: ${buttonInfo.isNearFooter})...`);
    await confirmBtn.evaluate((btn) => {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    });
    await delay(500); // Wait for scroll to complete
    
    // Re-check position after scroll
    const newButtonInfo = await page.evaluate((btn) => {
      const rect = btn.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      return {
        y: rect.y,
        bottom: rect.bottom,
        viewportHeight,
        isInViewport: rect.top >= 0 && rect.bottom <= viewportHeight
      };
    }, confirmBtn);
    
    console.log(`After scroll: y=${Math.round(newButtonInfo.y)}, bottom=${Math.round(newButtonInfo.bottom)}, viewport=${newButtonInfo.viewportHeight}`);
    
    // If still too close to footer, scroll up a bit more
    if (newButtonInfo.bottom > newButtonInfo.viewportHeight * 0.9) {
      console.log(`⚠️  Button still too close to footer, scrolling up more...`);
      await page.evaluate(() => {
        window.scrollBy(0, -100); // Scroll up 100px
      });
      await delay(300);
    }
  }
  
  // Check if button is covered by another element
  if (buttonInfo.isCovered) {
    console.log(`⚠️  Button might be covered by another element, trying to click anyway...`);
  }
  
  // Use DOM-level click (minimize-safe — no coordinate dependency)
  // NO RETRY — if page.evaluate throws after btn.click() executed (e.g., DOM changed by GRVT
  // processing the order), retrying would click again and place a DUPLICATE order.
  // DOM-level btn.click() is reliable; errors come from Puppeteer communication, not the click itself.
  await page.evaluate(btn => {
    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    btn.click();
  }, confirmBtn);
  console.log(`✓ Successfully clicked "${confirmText}" button`);
  await delay(500); // Wait for order submission to process
}

/**
 * Verify order was placed successfully
 */
export async function verifyOrderPlacement(page, exchange, side, qty) {
  // Check for error messages first (filter out false positives from non-error UI elements)
  const errorMsg = await page.evaluate(() => {
    const errors = document.querySelectorAll(
      '[class*="error"], [class*="Error"]'
    );
    for (const err of errors) {
      const text = (err.textContent || '').trim();
      // Skip short texts (< 8 chars) — likely UI labels like "Mid|" not real errors
      if (!text || text.length < 8) continue;
      // Skip if element is not visible (minimize-safe: use offsetParent fallback)
      const rect = err.getBoundingClientRect();
      if ((rect.width === 0 || rect.height === 0) && err.offsetParent === null) continue;
      // Skip known non-error patterns (price labels, separators)
      if (/^(bid|ask|mid|last|mark)[\s|]/i.test(text)) continue;
      // Skip HTML5 form validation messages (browser-native tooltips, not real trade errors)
      if (/^please (complete|fill|match|enter)/i.test(text)) continue;
      return text;
    }
    return null;
  });

  if (errorMsg) {
    console.log(`[${exchange.name}] Trade error:`, errorMsg);
    return { success: false, error: errorMsg };
  }

  // Verify order was placed and is pending
  console.log(`[${exchange.name}] Verifying order placement...`);
  // Use shorter timeout for Extended Exchange (3 seconds) since it confirms quickly
  const timeout = exchange.name?.toLowerCase().includes('extended') ? 3000 : 10000;
  const orderVerified = await verifyOrderPlaced(page, exchange, side, qty, timeout);
  
  if (orderVerified.success) {
    console.log(`[${exchange.name}] ✓ Order confirmed as ${orderVerified.status || 'pending'}`);
    console.log(`[${exchange.name}] Order verification completed, returning success...`);
    return { success: true, message: "Trade submitted and order confirmed", orderStatus: orderVerified.status };
  } else {
    console.log(`[${exchange.name}] ⚠️  Order verification: ${orderVerified.reason || 'Could not verify order placement'}`);
    // Still return success if no error was found (order might be placed but not yet visible)
    console.log(`[${exchange.name}] Order verification inconclusive, returning success anyway...`);
    return { success: true, message: "Trade submitted (verification inconclusive)", warning: orderVerified.reason };
  }
}
