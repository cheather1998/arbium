import { delay } from '../utils/helpers.js';
import { findByText, findByExactText } from '../utils/helpers.js';
import {
  getCurrentMarketPrice,
  selectBuyOrSell,
  selectOrderType,
  findSizeAndPriceInputs,
  enterPrice,
  enterSize,
  clickConfirmButton,
  verifyOrderPlacement
} from './executeBase.js';

/**
 * Kraken specific trade execution logic
 */

/**
 * Set leverage for Kraken
 * TODO: Implement Kraken-specific leverage setting after UI inspection
 */
export async function setLeverageKraken(page, leverage, exchange) {
  console.log(`[${exchange.name}] Setting leverage...`);
  // TODO: Implement Kraken-specific leverage setting logic
  // This will be implemented after inspecting Kraken UI
  console.log(`[${exchange.name}] ⚠️  Leverage setting not yet implemented for Kraken`);
  await delay(1000);
}

/**
 * Find confirm button for Kraken
 * Uses standard logic - can be overridden if Kraken has special requirements
 */
export async function findConfirmButtonKraken(page, side, exchange) {
  let confirmText = side === "buy" ? exchange.selectors.confirmBuy : exchange.selectors.confirmSell;
  
  console.log(`[${exchange.name}] Looking for "${confirmText}" button...`);
  
  let confirmBtn = null;
  
  // Method 1: Try findByExactText first (more specific)
  confirmBtn = await findByExactText(page, confirmText, ["button", "div", "span"]);
  
  if (confirmBtn) {
    const buttonCheck = await page.evaluate((el) => {
      const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      if (!isVisible) return { isVisible: false };
      
      const rect = el.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const isInViewport = rect.top >= 0 && 
                          rect.left >= 0 && 
                          rect.bottom <= viewportHeight && 
                          rect.right <= window.innerWidth;
      const isNearFooter = rect.bottom > viewportHeight * 0.8;
      
      return {
        isVisible: true,
        x: rect.x,
        y: rect.y,
        isInViewport,
        isNearFooter,
        viewportHeight
      };
    }, confirmBtn);
    
    if (!buttonCheck) {
      console.log(`[${exchange.name}] ⚠️  Found "${confirmText}" button but it's not visible, trying fallback...`);
      confirmBtn = null;
    } else {
      console.log(`[${exchange.name}] ✓ Found "${confirmText}" button at (${Math.round(buttonCheck.x || 0)}, ${Math.round(buttonCheck.y || 0)})`);
      if (buttonCheck.isNearFooter) {
        console.log(`[${exchange.name}] ⚠️  Button is near footer (bottom ${Math.round((buttonCheck.y + 100) / buttonCheck.viewportHeight * 100)}% of viewport), will scroll into view before clicking`);
      }
    }
  }
  
  // Method 2: Fallback to findByText if exact match failed
  if (!confirmBtn) {
    console.log(`[${exchange.name}] Exact text match failed, trying partial match...`);
    confirmBtn = await findByText(page, confirmText, ["button"]);
    
    if (confirmBtn) {
      const buttonCheck = await page.evaluate((el) => {
        const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        if (!isVisible) return { isVisible: false };
        
        const rect = el.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const isInViewport = rect.top >= 0 && 
                            rect.left >= 0 && 
                            rect.bottom <= viewportHeight && 
                            rect.right <= window.innerWidth;
        const isNearFooter = rect.bottom > viewportHeight * 0.8;
        
        return {
          isVisible: true,
          x: rect.x,
          y: rect.y,
          isInViewport,
          isNearFooter,
          viewportHeight
        };
      }, confirmBtn);
      
      if (buttonCheck.isVisible) {
        console.log(`[${exchange.name}] ✓ Found "${confirmText}" button via partial match at (${Math.round(buttonCheck.x || 0)}, ${Math.round(buttonCheck.y || 0)})`);
        if (buttonCheck.isNearFooter) {
          console.log(`[${exchange.name}] ⚠️  Button is near footer (bottom ${Math.round((buttonCheck.y + 100) / buttonCheck.viewportHeight * 100)}% of viewport), will scroll into view before clicking`);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Found button but it's not visible`);
        confirmBtn = null;
      }
    }
  }
  
  // Method 3: Try case-insensitive search in evaluate with viewport and footer checking
  if (!confirmBtn) {
    console.log(`[${exchange.name}] Partial match failed, trying case-insensitive search...`);
    const foundBtn = await page.evaluate((searchText) => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
      const searchLower = searchText.toLowerCase();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      
      // Score buttons: prefer buttons that are in viewport and not near footer
      const scoredButtons = [];
      
      for (const btn of buttons) {
        const btnText = btn.textContent?.trim() || '';
        const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
        const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true' || 
                          btn.classList.contains('disabled') || btn.style.pointerEvents === 'none';
        
        if (isVisible && !isDisabled && btnText.toLowerCase().includes(searchLower)) {
          const rect = btn.getBoundingClientRect();
        
          // Check if button is in viewport
          const isInViewport = rect.top >= 0 && 
                              rect.left >= 0 && 
                              rect.bottom <= viewportHeight && 
                              rect.right <= viewportWidth;
          
          // Check if button is near footer (bottom 20% of viewport)
          const isNearFooter = rect.bottom > viewportHeight * 0.8;
          
          // Check if button is covered by another element at its center
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const elementAtPoint = document.elementFromPoint(centerX, centerY);
          const isCovered = elementAtPoint && 
                           !btn.contains(elementAtPoint) && 
                           elementAtPoint !== btn &&
                           !elementAtPoint.closest('button, [role="button"]');
          
          // Calculate score: higher is better
          let score = 0;
          if (isInViewport) score += 100;
          if (!isNearFooter) score += 50;
          if (!isCovered) score += 30;
          // Prefer buttons in upper/middle viewport (not near bottom)
          if (rect.top < viewportHeight * 0.7) score += 20;
          
          scoredButtons.push({
            text: btnText,
            x: rect.x,
            y: rect.y,
            score,
            isInViewport,
            isNearFooter,
            isCovered
          });
        }
      }

      // Sort by score (highest first) and return the best match
      scoredButtons.sort((a, b) => b.score - a.score);
      
      if (scoredButtons.length > 0) {
        const best = scoredButtons[0];
        console.log(`Found ${scoredButtons.length} matching buttons, best score: ${best.score} (isInViewport: ${best.isInViewport}, isNearFooter: ${best.isNearFooter}, isCovered: ${best.isCovered})`);
        return {
          found: true,
          text: best.text,
          x: best.x,
          y: best.y
        };
      }
      return { found: false };
    }, confirmText);
    
    if (foundBtn.found) {
      console.log(`[${exchange.name}] ✓ Found button via case-insensitive search: "${foundBtn.text}" at (${Math.round(foundBtn.x)}, ${Math.round(foundBtn.y)})`);
      // Try to find it again using Puppeteer
      confirmBtn = await findByText(page, foundBtn.text, ["button"]);
    }
  }
  
  return { confirmBtn, confirmText };
}

/**
 * Execute trade for Kraken
 */
export async function executeTradeKraken(
  page,
  { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
  exchange
) {
  console.log(`\n=== Executing Trade on ${exchange.name} ===`);

  // Set leverage first if requested
  if (setLeverageFirst && leverage) {
    await setLeverageKraken(page, leverage, exchange);
  }

  // If limit order without price, fetch current market price
  if (orderType === "limit" && !price) {
    price = await getCurrentMarketPrice(page, exchange);
    if (!price) {
      console.log(`[${exchange.name}] ❌ Could not fetch market price for limit order`);
      return { success: false, error: "Could not fetch market price" };
    }
  }

  console.log(
    `[${exchange.name}] Side: ${side}, Type: ${orderType}, Price: ${
      price || "market"
    }, Qty: ${qty}`
  );

  // No need to reload - just wait a moment for any previous actions to complete
  await delay(1000);

  // 1. Select Buy or Sell
  await selectBuyOrSell(page, side, exchange);

  // 2. Select Market or Limit order type
  await selectOrderType(page, orderType, exchange);

  await delay(500);

  // 3. Find and fill inputs
  const { sizeInput, priceInput } = await findSizeAndPriceInputs(page, orderType);

  // Enter price (for limit orders)
  await enterPrice(page, priceInput, price, orderType);

  // Enter quantity/size
  const sizeResult = await enterSize(page, sizeInput, qty, exchange);
  if (!sizeResult.success) {
    return sizeResult;
  }

  await delay(500);

  // NOTE: Kraken does NOT have TP/SL handling (can be added if needed)

  // 4. Find and click Confirm button
  const { confirmBtn, confirmText } = await findConfirmButtonKraken(page, side, exchange);

  if (!confirmBtn) {
    // Enhanced error message with debugging info
    console.log(`[${exchange.name}] ❌ Could not find "${confirmText}" button`);
    console.log(`[${exchange.name}]    Exchange: ${exchange.name}, Side: ${side}`);
    
    // Additional debugging: try to find what buttons are available
    const availableButtons = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
      return buttons
        .filter(btn => {
          const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
          return isVisible;
        })
        .map(btn => {
          const text = btn.textContent?.trim();
          const rect = btn.getBoundingClientRect();
          return {
            text: text,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true'
          };
        })
        .filter(btn => btn.text && btn.text.length > 0)
        .slice(0, 10); // Limit to first 10 for readability
    });
    
    console.log(`[${exchange.name}]    Available buttons (first 10):`, JSON.stringify(availableButtons, null, 2));
    
    return { success: false, error: `Confirm button not found. Looking for: "${confirmText}"` };
  }

  // Click confirm button
  await clickConfirmButton(page, confirmBtn, confirmText, exchange, side);

  // Verify order placement
  return await verifyOrderPlacement(page, exchange, side, qty);
}
