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
 * Extended Exchange specific trade execution logic
 */

/**
 * Set leverage for Extended Exchange (modal-based)
 */
export async function setLeverageExtended(page, leverage, exchange) {
  console.log(`[${exchange.name}] Setting leverage using modal...`);
  const leverageValue = String(leverage);
  
  // Find and click leverage button
  const leverageButtonClicked = await page.evaluate(() => {
    const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
    const leverageBtn = allButtons.find(btn => {
      const text = btn.textContent?.trim();
      const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
      return isVisible && /^\d+x$/i.test(text);
    });
    
    if (leverageBtn) {
      leverageBtn.click();
      return true;
    }
    return false;
  });
  
  if (leverageButtonClicked) {
    console.log(`[${exchange.name}] ✅ Clicked leverage button`);
    await delay(2000);
    
    // Find leverage input in modal
    const leverageInputFound = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
      if (!modal) return null;
      
      const inputs = Array.from(modal.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])'));
      const leverageInput = inputs.find(input => {
        return !input.disabled && !input.readOnly && input.offsetParent !== null;
      });
      
      if (leverageInput) {
        return {
          id: leverageInput.id,
          className: leverageInput.className,
          type: leverageInput.type
        };
      }
      return null;
    });
    
    if (leverageInputFound) {
      // Find input using Puppeteer
      let inputElement = null;
      if (leverageInputFound.id) {
        inputElement = await page.$(`#${leverageInputFound.id}`);
      }
      
      if (!inputElement) {
        const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
        for (const input of inputs) {
          const isVisible = await input.evaluate(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
          if (isVisible) {
            inputElement = input;
            break;
          }
        }
      }
      
      if (inputElement) {
        // Click and focus the input
        await inputElement.click({ delay: 100 });
        await delay(200);
        
        // Clear existing value
        await inputElement.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await delay(100);
        
        // Type the leverage value
        await inputElement.type(leverageValue, { delay: 50 });
        await delay(200);
        
        // Press Enter
        await page.keyboard.press('Enter');
        await delay(500);
        
        console.log(`[${exchange.name}] ✅ Entered leverage value: ${leverageValue} and pressed Enter`);
        
        // Check if leverage modal is still open
        const leverageModalStillOpen = await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
          return modal !== null;
        });
        
        // Find and click Confirm or Cancel button
        const leverageSet = await page.evaluate((modalStillOpen) => {
          const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
          if (!modal) return { success: false, reason: 'No modal found' };
          
          const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
          
          if (modalStillOpen) {
            const cancelBtn = buttons.find(btn => {
              const text = btn.textContent?.trim().toLowerCase();
              const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
              return isVisible && (text === 'cancel' || text === 'close' || text === 'x');
            });
            
            if (cancelBtn) {
              cancelBtn.click();
              return { success: true, cancelled: true };
            }
          }
          
          const confirmBtn = buttons.find(btn => {
            const text = btn.textContent?.trim().toLowerCase();
            const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
            return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
          });
          
          if (confirmBtn) {
            confirmBtn.click();
            return { success: true, confirmed: true };
          }
          
          return { success: false, reason: 'Confirm/Cancel button not found' };
        }, leverageModalStillOpen);
        
        if (leverageSet.success) {
          console.log(`[${exchange.name}] ✅ Leverage modal handled: ${leverageSet.cancelled ? 'Cancelled (unchanged)' : 'Confirmed'}`);
          await delay(1000);
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not handle leverage modal: ${leverageSet.reason || 'unknown'}`);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Could not find leverage input element`);
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find leverage input in modal`);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find leverage button`);
  }
}

/**
 * Find confirm button for Extended Exchange
 * Special handling for sell side (uses "Sell" button in right 40% of screen)
 */
export async function findConfirmButtonExtended(page, side, exchange) {
  let confirmText = side === "buy" ? exchange.selectors.confirmBuy : exchange.selectors.confirmSell;
  
  // Extended Exchange uses "Sell" button directly (no "Confirm Sell")
  if (side === 'sell') {
    confirmText = "Sell";
    console.log(`[${exchange.name}] ✓ Extended Exchange detected - using "Sell" button instead of "Confirm Sell"`);
  }
  
  let confirmBtn = null;
  
  // CRITICAL: Special logic for Extended Exchange sell side
  if (side === 'sell') {
    console.log(`[${exchange.name}] ✅ Entering Extended Exchange Sell button finding logic...`);
    console.log(`[${exchange.name}] Looking for "Sell" button in right 40% of screen (last 40%)...`);
    
    // Method 1: Find "Sell" button in the right 40% of screen (from 60% to 100%)
    const screenWidth = await page.evaluate(() => window.innerWidth);
    const rightSideThreshold = screenWidth * 0.6; // Start from 60% (last 40% of screen)
    console.log(`[${exchange.name}] Method 1: Screen width: ${screenWidth}, Right threshold (60%): ${rightSideThreshold}`);
    
    const allButtons = await page.$$('button, div[role="button"], span[role="button"], a[role="button"]');
    console.log(`[${exchange.name}] Method 1: Checking ${allButtons.length} buttons for "Sell" text in right 40%...`);
    
    let sellButtonsOnRight = [];
    for (const btn of allButtons) {
      const btnText = await page.evaluate((el) => el.textContent?.trim(), btn);
      const rect = await btn.boundingBox();
      const isVisible = await page.evaluate((el) => {
        return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      }, btn);
      
      // Check if it's the "Sell" button, visible, and in the right 40% of screen
      if (btnText === "Sell" && isVisible && rect && rect.x >= rightSideThreshold) {
        // Check if button is near footer
        const buttonInfo = await page.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const viewportHeight = window.innerHeight;
          return {
            isNearFooter: rect.bottom > viewportHeight * 0.8,
            viewportHeight
          };
        }, btn);
        const isDisabled = await page.evaluate((el) => {
          return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                 el.classList.contains('disabled') || el.style.pointerEvents === 'none';
        }, btn);
        
        sellButtonsOnRight.push({
          text: btnText,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          onRight: true,
          disabled: isDisabled,
          isNearFooter: buttonInfo.isNearFooter
        });
        
        if (!isDisabled) {
          confirmBtn = btn;
          console.log(`[${exchange.name}] ✓ Method 1 SUCCESS: Found Sell button at (${Math.round(rect.x)}, ${Math.round(rect.y)}) in right 40%`);
          if (buttonInfo.isNearFooter) {
            console.log(`[${exchange.name}] ⚠️  Button is near footer, will scroll into view before clicking`);
          }
          break;
        }
      }
    }
    
    if (!confirmBtn && sellButtonsOnRight.length > 0) {
      console.log(`[${exchange.name}] Method 1: Found ${sellButtonsOnRight.length} "Sell" button(s) in right 40% but all disabled:`, JSON.stringify(sellButtonsOnRight, null, 2));
    } else if (sellButtonsOnRight.length === 0) {
      console.log(`[${exchange.name}] Method 1: No "Sell" buttons found in right 40% of screen`);
    }
    
    // Method 2: Fallback - try findByExactText and filter by right 40%
    if (!confirmBtn) {
      console.log(`[${exchange.name}] Method 2: Trying findByExactText("Sell") and filtering by right 40%...`);
      const foundBtn = await findByExactText(page, "Sell", ["button", "div", "span"]);
      if (foundBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, foundBtn);
        const rect = await foundBtn.boundingBox();
        
        console.log(`[${exchange.name}] Method 2: Found button - visible: ${isVisible}, x: ${Math.round(rect?.x || 0)}, threshold: ${rightSideThreshold}`);
        
        if (isVisible && rect && rect.x >= rightSideThreshold) {
          const isDisabled = await page.evaluate((el) => {
            return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                   el.classList.contains('disabled') || el.style.pointerEvents === 'none';
          }, foundBtn);
          
          if (!isDisabled) {
            confirmBtn = foundBtn;
            console.log(`[${exchange.name}] ✓ Method 2 SUCCESS: Found Sell button via findByExactText at (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
          } else {
            console.log(`[${exchange.name}] Method 2: Found button but it's disabled`);
          }
        } else {
          console.log(`[${exchange.name}] Method 2: Found button but not visible or not in right 40%`);
        }
      } else {
        console.log(`[${exchange.name}] Method 2: findByExactText returned null`);
      }
    }
    
    // Method 3: Final fallback to findByText and filter by right 40%
    if (!confirmBtn) {
      console.log(`[${exchange.name}] Method 3: Trying findByText("Sell") and filtering by right 40%...`);
      confirmBtn = await findByText(page, "Sell", ["button"]);
      if (confirmBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, confirmBtn);
        if (!isVisible) {
          console.log(`[${exchange.name}] Method 3: Found button but it's not visible`);
          confirmBtn = null;
        } else {
          const rect = await confirmBtn.boundingBox();
          
          // Check if it's in the right 40%
          if (rect && rect.x >= rightSideThreshold) {
            const isDisabled = await page.evaluate((el) => {
              return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                     el.classList.contains('disabled') || el.style.pointerEvents === 'none';
            }, confirmBtn);
            
            if (!isDisabled) {
              console.log(`[${exchange.name}] ✓ Method 3 SUCCESS: Found Sell button via findByText at (${Math.round(rect.x)}, ${Math.round(rect.y)}) in right 40%`);
            } else {
              console.log(`[${exchange.name}] Method 3: Found button but it's disabled`);
              confirmBtn = null;
            }
          } else {
            console.log(`[${exchange.name}] Method 3: Found Sell button but it's not in right 40% (x: ${Math.round(rect?.x || 0)}, threshold: ${rightSideThreshold}), skipping...`);
            confirmBtn = null;
          }
        }
      } else {
        console.log(`[${exchange.name}] Method 3: findByText returned null`);
      }
    }
    
    // Final check: if we found the button, log it
    if (confirmBtn) {
      console.log(`[${exchange.name}] ✅ Sell button found and ready to click!`);
    } else {
      console.log(`[${exchange.name}] ❌ FAILED to find Sell button after all methods`);
    }
  } else {
    // For buy side, use standard method
    console.log(`[${exchange.name}] Looking for "${confirmText}" button...`);
    
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
  }
  
  return { confirmBtn, confirmText };
}

/**
 * Execute trade for Extended Exchange
 */
export async function executeTradeExtended(
  page,
  { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
  exchange
) {
  console.log(`\n=== Executing Trade on ${exchange.name} ===`);

  // Set leverage first if requested
  if (setLeverageFirst && leverage) {
    await setLeverageExtended(page, leverage, exchange);
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

  // NOTE: Extended Exchange does NOT have TP/SL handling

  // 4. Find and click Confirm button
  const { confirmBtn, confirmText } = await findConfirmButtonExtended(page, side, exchange);

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
