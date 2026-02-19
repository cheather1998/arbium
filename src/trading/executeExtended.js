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
import dotenv from 'dotenv';

dotenv.config();

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
  
  // Extended Exchange uses "Buy" button directly (no "Confirm Buy") for buy side
  // Extended Exchange uses "Sell" button directly (no "Confirm Sell") for sell side
  if (side === 'buy') {
    confirmText = "Buy";
    console.log(`[${exchange.name}] ✓ Extended Exchange detected - using "Buy" button instead of "Confirm Buy"`);
  } else if (side === 'sell') {
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
 * Handle TP/SL for Extended Exchange
 * Extended Exchange has a checkbox with label "Take profit / Stop loss"
 * and two inputs: "TP Price" and "SL Price"
 * 
 * TP = price + (price * (TAKE_PROFIT/10) / 100)
 * SL = price - (price * (STOP_LOSS/10) / 100)
 */
export async function handleTpSlExtended(page, exchange, price = null, side = 'buy') {
  console.log(`[${exchange.name}] Handling TP/SL for Extended Exchange (side: ${side})...`);
  
  const takeProfitPercent = process.env.TAKE_PROFIT || '';
  const stopLossPercent = process.env.STOP_LOSS || '';
  
  if (!takeProfitPercent && !stopLossPercent) {
    console.log(`[${exchange.name}] ⚠️  TAKE_PROFIT and STOP_LOSS env variables not set, skipping TP/SL`);
    return { success: false, error: 'TAKE_PROFIT and STOP_LOSS not set' };
  }
  
  // Validate price is provided
  if (!price || isNaN(price)) {
    console.log(`[${exchange.name}] ⚠️  Price not provided or invalid, skipping TP/SL calculation`);
    return { success: false, error: 'Price not provided or invalid' };
  }
  
  console.log(`[${exchange.name}] Using price value: ${price} for TP/SL calculation (side: ${side})`);
  
  // Calculate TP and SL values based on formulas and order side
  let calculatedTakeProfit = null;
  let calculatedStopLoss = null;
  const isSell = side.toLowerCase() === 'sell';
  
  if (takeProfitPercent) {
    const takeProfitNum = parseFloat(takeProfitPercent);
    if (!isNaN(takeProfitNum) && price) {
      const percentage = (takeProfitNum / 10) / 100;
      const adjustment = price * percentage;
      
      if (isSell) {
        // For SELL: TP = price - (price * (TAKE_PROFIT/10) / 100)
        calculatedTakeProfit = price - adjustment;
        console.log(`[${exchange.name}] TP Calculation (SELL): ${price} - (${price} * (${takeProfitNum}/10) / 100) = ${calculatedTakeProfit.toFixed(2)}`);
      } else {
        // For BUY: TP = price + (price * (TAKE_PROFIT/10) / 100)
        calculatedTakeProfit = price + adjustment;
        console.log(`[${exchange.name}] TP Calculation (BUY): ${price} + (${price} * (${takeProfitNum}/10) / 100) = ${calculatedTakeProfit.toFixed(2)}`);
      }
      
      // Validate TP based on side
      if (isSell && calculatedTakeProfit >= price) {
        console.log(`[${exchange.name}] ❌ ERROR: For SELL, calculated TP (${calculatedTakeProfit.toFixed(2)}) should be LESS than price (${price})!`);
        calculatedTakeProfit = null;
      } else if (!isSell && calculatedTakeProfit <= price) {
        console.log(`[${exchange.name}] ❌ ERROR: For BUY, calculated TP (${calculatedTakeProfit.toFixed(2)}) should be GREATER than price (${price})!`);
        calculatedTakeProfit = null;
      } else {
        console.log(`[${exchange.name}] ✅ TP calculation validated for ${side.toUpperCase()}`);
      }
    }
  }
  
  if (stopLossPercent) {
    const stopLossNum = parseFloat(stopLossPercent);
    if (!isNaN(stopLossNum) && price) {
      const percentage = (stopLossNum / 10) / 100;
      const adjustment = price * percentage;
      
      if (isSell) {
        // For SELL: SL = price + (price * (STOP_LOSS/10) / 100)
        calculatedStopLoss = price + adjustment;
        console.log(`[${exchange.name}] SL Calculation (SELL): ${price} + (${price} * (${stopLossNum}/10) / 100) = ${calculatedStopLoss.toFixed(2)}`);
      } else {
        // For BUY: SL = price - (price * (STOP_LOSS/10) / 100)
        calculatedStopLoss = price - adjustment;
        console.log(`[${exchange.name}] SL Calculation (BUY): ${price} - (${price} * (${stopLossNum}/10) / 100) = ${calculatedStopLoss.toFixed(2)}`);
      }
      
      // Validate SL based on side
      if (isSell && calculatedStopLoss <= price) {
        console.log(`[${exchange.name}] ❌ ERROR: For SELL, calculated SL (${calculatedStopLoss.toFixed(2)}) should be GREATER than price (${price})!`);
        calculatedStopLoss = null;
      } else if (!isSell && calculatedStopLoss >= price) {
        console.log(`[${exchange.name}] ❌ ERROR: For BUY, calculated SL (${calculatedStopLoss.toFixed(2)}) should be LESS than price (${price})!`);
        calculatedStopLoss = null;
      } else if (calculatedStopLoss <= 0) {
        console.log(`[${exchange.name}] ❌ ERROR: Calculated SL (${calculatedStopLoss.toFixed(2)}) is negative or zero!`);
        calculatedStopLoss = null;
      } else {
        console.log(`[${exchange.name}] ✅ SL calculation validated for ${side.toUpperCase()}`);
      }
    }
  }
  
  if (!calculatedTakeProfit && !calculatedStopLoss) {
    console.log(`[${exchange.name}] ⚠️  Could not calculate TP/SL values, skipping`);
    return { success: false, error: 'Could not calculate TP/SL values' };
  }
  
  // Step 1: Find and check if "Take profit / Stop loss" checkbox is already checked
  console.log(`[${exchange.name}] Looking for TP/SL checkbox...`);
  
  // Find checkbox using Puppeteer element handles
  let checkboxElement = null;
  let isChecked = false;
  
  // Method 1: Find via labels
  const labels = await page.$$('label');
  for (const label of labels) {
    const labelText = await page.evaluate((el) => el.textContent?.trim().toLowerCase() || '', label);
    if (labelText.includes('take profit') && labelText.includes('stop loss')) {
      // Try to find checkbox in label
      checkboxElement = await label.$('input[type="checkbox"]');
      if (checkboxElement) {
        isChecked = await page.evaluate((el) => el.checked, checkboxElement);
        break;
      }
      // Try to find by 'for' attribute
      const labelFor = await page.evaluate((el) => el.getAttribute('for'), label);
      if (labelFor) {
        checkboxElement = await page.$(`#${labelFor}[type="checkbox"]`);
        if (checkboxElement) {
          isChecked = await page.evaluate((el) => el.checked, checkboxElement);
          break;
        }
      }
    }
  }
  
  // Method 2: Fallback - find all checkboxes and check parent text
  if (!checkboxElement) {
    const allCheckboxes = await page.$$('input[type="checkbox"]');
    for (const checkbox of allCheckboxes) {
      const isVisible = await checkbox.evaluate((el) => {
        return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      });
      
      if (!isVisible) continue;
      
      // Check parent elements for text
      const hasTpSlText = await checkbox.evaluate((el) => {
        let parent = el.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const parentText = parent.textContent?.toLowerCase() || '';
          if (parentText.includes('take profit') && parentText.includes('stop loss')) {
            return true;
          }
          parent = parent.parentElement;
        }
        return false;
      });
      
      if (hasTpSlText) {
        checkboxElement = checkbox;
        isChecked = await page.evaluate((el) => el.checked, checkboxElement);
        break;
      }
    }
  }
  
  if (checkboxElement) {
    if (isChecked) {
      console.log(`[${exchange.name}] ✅ TP/SL checkbox is already checked, skipping click`);
      await delay(500); // Small delay to ensure inputs are visible
    } else {
      console.log(`[${exchange.name}] TP/SL checkbox is not checked, clicking it...`);
      // Click using Puppeteer's click method for reliability
      await checkboxElement.click();
      await delay(1000); // Wait for inputs to appear after checkbox is clicked
      console.log(`[${exchange.name}] ✅ TP/SL checkbox clicked successfully`);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find TP/SL checkbox, continuing anyway...`);
    // Continue anyway - might not be critical
  }
  
  // Track the last filled input element for Enter key press
  let lastFilledInput = null;
  
  // Step 2: Find and fill TP Price input
  if (calculatedTakeProfit) {
    console.log(`[${exchange.name}] Looking for TP Price input...`);
    
    // Method 1: Find input near "TP Price" text label
    let tpInputElement = await page.evaluateHandle(() => {
      // Find all text nodes or elements containing "TP Price"
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent?.trim().toLowerCase() || '';
        if (text.includes('tp price') || (text.includes('tp') && text.includes('price'))) {
          // Found "TP Price" text, now find nearby input
          let parent = node.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            // Look for input in this container
            const inputs = parent.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])');
            for (const input of inputs) {
              const isVisible = input.offsetParent !== null && !input.disabled && !input.readOnly;
              if (isVisible) {
                return input;
              }
            }
            parent = parent.parentElement;
          }
        }
      }
      return null;
    });
    
    if (tpInputElement && tpInputElement.asElement()) {
      tpInputElement = tpInputElement.asElement();
    } else {
      tpInputElement = null;
    }
    
    // Method 2: Fallback - Find TP Price input using page.$$ with improved search
    if (!tpInputElement) {
      console.log(`[${exchange.name}] Method 1 failed, trying Method 2...`);
      const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      
      for (const input of allInputs) {
        const isVisible = await input.evaluate(el => {
          return el.offsetParent !== null && !el.disabled && !el.readOnly;
        });
        if (!isVisible) continue;
        
        const inputInfo = await page.evaluate((el) => {
          const placeholder = (el.placeholder || '').toLowerCase();
          const name = (el.name || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          
          // Check for associated label
          let labelText = '';
          const labels = document.querySelectorAll('label');
          for (const label of labels) {
            if (label.control === el || label.getAttribute('for') === el.id) {
              labelText = (label.textContent || '').toLowerCase();
              break;
            }
          }
          
          // Check parent and sibling text more thoroughly
          let parent = el.parentElement;
          let parentText = '';
          let siblingText = '';
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.textContent) {
              parentText = parent.textContent.toLowerCase();
              // Check siblings
              if (parent.previousElementSibling) {
                siblingText = (parent.previousElementSibling.textContent || '').toLowerCase();
              }
              if (parent.nextElementSibling) {
                siblingText += ' ' + (parent.nextElementSibling.textContent || '').toLowerCase();
              }
              break;
            }
            parent = parent.parentElement;
          }
          
          return { placeholder, name, id, labelText, parentText, siblingText };
        }, input);
        
        // More flexible matching
        if (inputInfo.placeholder.includes('tp') || inputInfo.placeholder.includes('take profit') ||
            inputInfo.name.includes('tp') || inputInfo.name.includes('take profit') ||
            inputInfo.id.includes('tp') || inputInfo.id.includes('take profit') ||
            inputInfo.labelText.includes('tp') || inputInfo.labelText.includes('take profit') ||
            inputInfo.parentText.includes('tp price') || inputInfo.parentText.includes('take profit') ||
            inputInfo.siblingText.includes('tp price') || inputInfo.siblingText.includes('take profit')) {
          tpInputElement = input;
          console.log(`[${exchange.name}] Found TP input via Method 2`);
          break;
        }
      }
    }
    
    if (tpInputElement) {
      const tpValueStr = calculatedTakeProfit.toFixed(2);
      console.log(`[${exchange.name}] ✅ Found TP Price input, filling calculated value: ${tpValueStr}`);
      
      // Clear the input first using multiple methods to ensure it's empty
      await tpInputElement.focus();
      await delay(200);
      
      // Method 1: Triple-click to select all
      await tpInputElement.click({ clickCount: 3 });
      await delay(100);
      
      // Method 2: Ctrl+A and Delete
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await delay(100);
      await page.keyboard.press('Delete');
      await delay(100);
      
      // Method 3: JavaScript clear
      await page.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, tpInputElement);
      await delay(200);
      
      // Verify it's cleared
      const clearedValue = await page.evaluate((el) => el.value || '', tpInputElement);
      if (clearedValue && clearedValue.trim() !== '') {
        // More aggressive clear
        await page.evaluate((el) => {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, tpInputElement);
        await delay(200);
      }
      
      // Check input attributes to understand expected format
      const inputInfo = await page.evaluate((el) => {
        return {
          type: el.type || '',
          step: el.step || '',
          min: el.min || '',
          max: el.max || '',
          pattern: el.pattern || '',
          inputMode: el.inputMode || '',
          acceptsDecimals: el.step === 'any' || el.step === '' || (el.step && parseFloat(el.step) < 1)
        };
      }, tpInputElement);
      
      console.log(`[${exchange.name}] TP Input info: type="${inputInfo.type}", step="${inputInfo.step}", acceptsDecimals=${inputInfo.acceptsDecimals}`);
      
      const valueNum = parseFloat(tpValueStr);
      // Use Math.ceil() for TP to ensure it's at least the calculated value (round up)
      const intValue = Math.ceil(valueNum).toString();
      
      // Based on logs, the UI treats decimal point as thousands separator
      // So we'll use integer values for TP/SL inputs
      console.log(`[${exchange.name}] Using integer value (rounded up): ${intValue} (original: ${tpValueStr})`);
      
      // Now set the new value
      await tpInputElement.focus();
      await delay(200);
      await page.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, tpInputElement, intValue);
      
      await delay(500); // Wait for UI to process
      
      // Verify the value was set correctly
      const actualValue = await page.evaluate((el) => el.value || '', tpInputElement);
      // Remove thousands separators (commas) and spaces for comparison
      const actualValueNum = parseFloat(actualValue.replace(/,/g, '').replace(/ /g, ''));
      const expectedValueNum = parseInt(intValue, 10);
      
      console.log(`[${exchange.name}] After setting: actualValue="${actualValue}", actualValueNum=${actualValueNum}, expectedValueNum=${expectedValueNum}`);
      
      if (actualValue && actualValue.trim() !== '' && !isNaN(actualValueNum) && actualValueNum === expectedValueNum) {
        console.log(`[${exchange.name}] ✅ TP Price filled successfully. Expected: ${intValue}, Actual: ${actualValue}`);
      } else {
        console.log(`[${exchange.name}] ⚠️  TP Price value mismatch. Expected: ${intValue} (${expectedValueNum}), Actual: "${actualValue}" (${actualValueNum})`);
        console.log(`[${exchange.name}] ⚠️  Retrying by typing the value...`);
        
        try {
          // Retry with aggressive clearing
          await tpInputElement.focus();
          await delay(200);
          
          // Aggressive clear: Triple-click + Ctrl+A + Delete
          await tpInputElement.click({ clickCount: 3 });
          await delay(100);
          await page.keyboard.down('Control');
          await page.keyboard.press('a');
          await page.keyboard.up('Control');
          await delay(100);
          await page.keyboard.press('Delete');
          await delay(100);
          await page.keyboard.press('Backspace');
          await delay(100);
          
          // JavaScript clear
          await page.evaluate((el) => {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, tpInputElement);
          await delay(200);
          
          // Verify cleared
          const clearedCheck = await page.evaluate((el) => el.value || '', tpInputElement);
          if (clearedCheck && clearedCheck.trim() !== '') {
            // Still not cleared, try one more time
            await page.evaluate((el) => {
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, tpInputElement);
            await delay(200);
          }
          
          // Now type the value
          await tpInputElement.focus();
          await delay(200);
          await tpInputElement.type(intValue, { delay: 50 });
          await delay(500);
          
          await page.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
          }, tpInputElement);
          await delay(300);
          
          const finalValue = await page.evaluate((el) => el.value || '', tpInputElement);
          const finalValueNum = parseFloat(finalValue.replace(/,/g, '').replace(/ /g, ''));
          if (finalValueNum === expectedValueNum) {
            console.log(`[${exchange.name}] ✅ TP Price filled successfully after retry. Expected: ${intValue}, Actual: ${finalValue}`);
          } else {
            console.log(`[${exchange.name}] ⚠️  TP Price still incorrect after retry. Expected: ${intValue}, Actual: ${finalValue}`);
            // Last resort: Direct assignment after one more clear
            console.log(`[${exchange.name}] Attempting direct value assignment as last resort...`);
            await page.evaluate((el) => {
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, tpInputElement);
            await delay(200);
            await page.evaluate((el, value) => {
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            }, tpInputElement, intValue);
            await delay(500);
          }
        } catch (error) {
          console.log(`[${exchange.name}] ⚠️  Error during TP Price retry: ${error.message}`);
          // Continue anyway - value might still be set
        }
      }
      // Track TP input as last filled
      lastFilledInput = tpInputElement;
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find TP Price input`);
      // Debug: Log all visible inputs
      const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      console.log(`[${exchange.name}] Debug: Found ${allInputs.length} total inputs on page`);
      for (let i = 0; i < Math.min(allInputs.length, 10); i++) {
        const inputInfo = await page.evaluate((el) => {
          return {
            placeholder: el.placeholder || '',
            name: el.name || '',
            id: el.id || '',
            value: el.value || '',
            visible: el.offsetParent !== null
          };
        }, allInputs[i]);
        console.log(`[${exchange.name}]   Input ${i}: placeholder="${inputInfo.placeholder}", name="${inputInfo.name}", id="${inputInfo.id}", value="${inputInfo.value}", visible=${inputInfo.visible}`);
      }
    }
  }
  
  // Step 3: Find and fill SL Price input
  if (calculatedStopLoss) {
    console.log(`[${exchange.name}] Looking for SL Price input...`);
    
    // Method 1: Find input near "SL Price" text label
    let slInputElement = await page.evaluateHandle(() => {
      // Find all text nodes or elements containing "SL Price"
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent?.trim().toLowerCase() || '';
        if (text.includes('sl price') || (text.includes('sl') && text.includes('price') && !text.includes('tp'))) {
          // Found "SL Price" text, now find nearby input
          let parent = node.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            // Look for input in this container
            const inputs = parent.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])');
            for (const input of inputs) {
              const isVisible = input.offsetParent !== null && !input.disabled && !input.readOnly;
              if (isVisible) {
                return input;
              }
            }
            parent = parent.parentElement;
          }
        }
      }
      return null;
    });
    
    if (slInputElement && slInputElement.asElement()) {
      slInputElement = slInputElement.asElement();
    } else {
      slInputElement = null;
    }
    
    // Method 2: Fallback - Find SL Price input using page.$$ with improved search
    if (!slInputElement) {
      console.log(`[${exchange.name}] Method 1 failed, trying Method 2...`);
      const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      
      for (const input of allInputs) {
        const isVisible = await input.evaluate(el => {
          return el.offsetParent !== null && !el.disabled && !el.readOnly;
        });
        if (!isVisible) continue;
        
        const inputInfo = await page.evaluate((el) => {
          const placeholder = (el.placeholder || '').toLowerCase();
          const name = (el.name || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          
          // Check for associated label
          let labelText = '';
          const labels = document.querySelectorAll('label');
          for (const label of labels) {
            if (label.control === el || label.getAttribute('for') === el.id) {
              labelText = (label.textContent || '').toLowerCase();
              break;
            }
          }
          
          // Check parent and sibling text more thoroughly
          let parent = el.parentElement;
          let parentText = '';
          let siblingText = '';
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.textContent) {
              parentText = parent.textContent.toLowerCase();
              // Check siblings
              if (parent.previousElementSibling) {
                siblingText = (parent.previousElementSibling.textContent || '').toLowerCase();
              }
              if (parent.nextElementSibling) {
                siblingText += ' ' + (parent.nextElementSibling.textContent || '').toLowerCase();
              }
              break;
            }
            parent = parent.parentElement;
          }
          
          return { placeholder, name, id, labelText, parentText, siblingText };
        }, input);
        
        // More flexible matching
        if (inputInfo.placeholder.includes('sl') || inputInfo.placeholder.includes('stop loss') ||
            inputInfo.name.includes('sl') || inputInfo.name.includes('stop loss') ||
            inputInfo.id.includes('sl') || inputInfo.id.includes('stop loss') ||
            inputInfo.labelText.includes('sl') || inputInfo.labelText.includes('stop loss') ||
            inputInfo.parentText.includes('sl price') || inputInfo.parentText.includes('stop loss') ||
            inputInfo.siblingText.includes('sl price') || inputInfo.siblingText.includes('stop loss')) {
          slInputElement = input;
          console.log(`[${exchange.name}] Found SL input via Method 2`);
          break;
        }
      }
    }
    
    if (slInputElement) {
      const slValueStr = calculatedStopLoss.toFixed(2);
      console.log(`[${exchange.name}] ✅ Found SL Price input, filling calculated value: ${slValueStr}`);
      
      // Method 1: Clear first, then set value
      await slInputElement.focus();
      await delay(200);
      
      // Clear existing value
      await page.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, slInputElement);
      await delay(200);
      
      // Check input attributes to understand expected format
      const inputInfo = await page.evaluate((el) => {
        return {
          type: el.type || '',
          step: el.step || '',
          min: el.min || '',
          max: el.max || '',
          pattern: el.pattern || '',
          inputMode: el.inputMode || '',
          acceptsDecimals: el.step === 'any' || el.step === '' || (el.step && parseFloat(el.step) < 1)
        };
      }, slInputElement);
      
      console.log(`[${exchange.name}] SL Input info: type="${inputInfo.type}", step="${inputInfo.step}", acceptsDecimals=${inputInfo.acceptsDecimals}`);
      
      const valueNum = parseFloat(slValueStr);
      // Use Math.floor() for SL to ensure it's at most the calculated value (round down)
      const intValue = Math.floor(valueNum).toString();
      
      // Based on logs, the UI treats decimal point as thousands separator
      // So we'll use integer values for TP/SL inputs
      console.log(`[${exchange.name}] Using integer value (rounded down): ${intValue} (original: ${slValueStr})`);
      
      // Clear the input first using multiple methods to ensure it's empty
      await slInputElement.focus();
      await delay(200);
      
      // Method 1: Triple-click to select all
      await slInputElement.click({ clickCount: 3 });
      await delay(100);
      
      // Method 2: Ctrl+A and Delete
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await delay(100);
      await page.keyboard.press('Delete');
      await delay(100);
      
      // Method 3: JavaScript clear
      await page.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, slInputElement);
      await delay(200);
      
      // Verify it's cleared
      const clearedValue = await page.evaluate((el) => el.value || '', slInputElement);
      if (clearedValue && clearedValue.trim() !== '') {
        // More aggressive clear
        await page.evaluate((el) => {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, slInputElement);
        await delay(200);
      }
      
      // Now set the new value
      await slInputElement.focus();
      await delay(200);
      await page.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, slInputElement, intValue);
      
      await delay(500); // Wait for UI to process
      
      // Verify the value was set correctly
      const actualValue = await page.evaluate((el) => el.value || '', slInputElement);
      // Remove thousands separators (commas) and spaces for comparison
      const actualValueNum = parseFloat(actualValue.replace(/,/g, '').replace(/ /g, ''));
      const expectedValueNum = parseInt(intValue, 10);
      
      console.log(`[${exchange.name}] After setting: actualValue="${actualValue}", actualValueNum=${actualValueNum}, expectedValueNum=${expectedValueNum}`);
      
      if (actualValue && actualValue.trim() !== '' && !isNaN(actualValueNum) && actualValueNum === expectedValueNum) {
        console.log(`[${exchange.name}] ✅ SL Price filled successfully. Expected: ${intValue}, Actual: ${actualValue}`);
      } else {
        console.log(`[${exchange.name}] ⚠️  SL Price value mismatch. Expected: ${intValue} (${expectedValueNum}), Actual: "${actualValue}" (${actualValueNum})`);
        console.log(`[${exchange.name}] ⚠️  Retrying by typing the value...`);
        
        try {
          // Retry with aggressive clearing
          await slInputElement.focus();
          await delay(200);
          
          // Aggressive clear: Triple-click + Ctrl+A + Delete
          await slInputElement.click({ clickCount: 3 });
          await delay(100);
          await page.keyboard.down('Control');
          await page.keyboard.press('a');
          await page.keyboard.up('Control');
          await delay(100);
          await page.keyboard.press('Delete');
          await delay(100);
          await page.keyboard.press('Backspace');
          await delay(100);
          
          // JavaScript clear
          await page.evaluate((el) => {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, slInputElement);
          await delay(200);
          
          // Verify cleared
          const clearedCheck = await page.evaluate((el) => el.value || '', slInputElement);
          if (clearedCheck && clearedCheck.trim() !== '') {
            // Still not cleared, try one more time
            await page.evaluate((el) => {
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, slInputElement);
            await delay(200);
          }
          
          // Now type the value
          await slInputElement.focus();
          await delay(200);
          await slInputElement.type(intValue, { delay: 50 });
          await delay(500);
          
          await page.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
          }, slInputElement);
          await delay(300);
          
          const finalValue = await page.evaluate((el) => el.value || '', slInputElement);
          const finalValueNum = parseFloat(finalValue.replace(/,/g, '').replace(/ /g, ''));
          if (finalValueNum === expectedValueNum) {
            console.log(`[${exchange.name}] ✅ SL Price filled successfully after retry. Expected: ${intValue}, Actual: ${finalValue}`);
          } else {
            console.log(`[${exchange.name}] ⚠️  SL Price still incorrect after retry. Expected: ${intValue}, Actual: ${finalValue}`);
            // Last resort: Direct assignment after one more clear
            console.log(`[${exchange.name}] Attempting direct value assignment as last resort...`);
            await page.evaluate((el) => {
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, slInputElement);
            await delay(200);
            await page.evaluate((el, value) => {
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            }, slInputElement, intValue);
            await delay(500);
          }
        } catch (error) {
          console.log(`[${exchange.name}] ⚠️  Error during SL Price retry: ${error.message}`);
          // Continue anyway - value might still be set
        }
      }
      // Track SL input as last filled (will override TP if both are filled)
      lastFilledInput = slInputElement;
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find SL Price input`);
      // Debug: Log all visible inputs
      const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      console.log(`[${exchange.name}] Debug: Found ${allInputs.length} total inputs on page`);
      for (let i = 0; i < Math.min(allInputs.length, 10); i++) {
        const inputInfo = await page.evaluate((el) => {
          return {
            placeholder: el.placeholder || '',
            name: el.name || '',
            id: el.id || '',
            value: el.value || '',
            visible: el.offsetParent !== null
          };
        }, allInputs[i]);
        console.log(`[${exchange.name}]   Input ${i}: placeholder="${inputInfo.placeholder}", name="${inputInfo.name}", id="${inputInfo.id}", value="${inputInfo.value}", visible=${inputInfo.visible}`);
      }
    }
  }
  
  console.log(`[${exchange.name}] ✅ TP/SL handling completed`);
  
  // Wait a bit after filling TP/SL inputs, then press Enter
  console.log(`[${exchange.name}] Waiting 1 second after TP/SL inputs are filled...`);
  await delay(1000);
  
  // Focus on the last filled input (SL if both filled, TP if only TP filled) before pressing Enter
  if (lastFilledInput) {
    console.log(`[${exchange.name}] Focusing on last filled TP/SL input before pressing Enter...`);
    await lastFilledInput.focus();
    await delay(200);
  }
  
  // Press Enter to confirm/apply the TP/SL values
  console.log(`[${exchange.name}] Pressing Enter to confirm TP/SL values...`);
  await page.keyboard.press('Enter');
  await delay(500);
  
  return { success: true };
}

/**
 * Execute trade for Extended Exchange
 */
export async function executeTradeExtended(
  page,
  { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
  exchange,
  thresholdMetTime = null,
  cycleCount = null,
  sideLabel = '',
  email = ''
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

  // 4. Handle TP/SL for Extended Exchange (pass price and side for calculation)
  // Only calculate TP/SL for limit orders where price is set
  if (orderType === "limit" && price) {
    await handleTpSlExtended(page, exchange, price, side);
    // Wait after TP/SL is set to allow UI to process
    console.log(`[${exchange.name}] Waiting 2 seconds after TP/SL setup before proceeding to confirm...`);
    await delay(2000);
  } else {
    console.log(`[${exchange.name}] Skipping TP/SL - only available for limit orders with price`);
  }

  // 5. Find and click Confirm button
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
