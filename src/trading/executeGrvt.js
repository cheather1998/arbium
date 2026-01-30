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
 * GRVT specific trade execution logic
 */

/**
 * Set leverage for GRVT
 * TODO: Implement GRVT-specific leverage setting after UI inspection
 */
export async function setLeverageGrvt(page, leverage, exchange) {
  console.log(`[${exchange.name}] Setting leverage...`);
  // TODO: Implement GRVT-specific leverage setting logic
  // This will be implemented after inspecting GRVT UI
  console.log(`[${exchange.name}] ⚠️  Leverage setting not yet implemented for GRVT`);
  await delay(1000);
}

/**
 * Find confirm button for GRVT
 * Uses standard logic - can be overridden if GRVT has special requirements
 */
export async function findConfirmButtonGrvt(page, side, exchange) {
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
 * Handle TP/SL for GRVT Exchange
 * GRVT has "TP trigger price" and "SL trigger price" inputs with "Mark" dropdowns
 */
export async function handleTpSlGrvt(page, exchange, price = null, side = 'buy') {
  console.log(`[${exchange.name}] Handling TP/SL for GRVT (Side: ${side.toUpperCase()})...`);
  
  const takeProfitPercent = process.env.TAKE_PROFIT || '';
  const stopLossPercent = process.env.STOP_LOSS || '';
  
  if (!takeProfitPercent && !stopLossPercent) {
    console.log(`[${exchange.name}] ⚠️  TAKE_PROFIT and STOP_LOSS env variables not set, skipping TP/SL`);
    return { success: false, error: 'TAKE_PROFIT and STOP_LOSS not set' };
  }
  
  if (!price || isNaN(price)) {
    console.log(`[${exchange.name}] ⚠️  Price not provided or invalid, skipping TP/SL calculation`);
    return { success: false, error: 'Price not provided or invalid' };
  }
  
  console.log(`[${exchange.name}] Using price value: ${price} for TP/SL calculation`);
  
  let calculatedTakeProfit = null;
  let calculatedStopLoss = null;
  
  const takeProfitNum = parseFloat(takeProfitPercent);
  const stopLossNum = parseFloat(stopLossPercent);
  const percentageTP = (takeProfitNum / 10) / 100;
  const percentageSL = (stopLossNum / 10) / 100;
  
  if (side === 'buy') {
    if (!isNaN(takeProfitNum) && price) {
      calculatedTakeProfit = price + (price * percentageTP);
      console.log(`[${exchange.name}] BUY TP: ${price} + (${price} * ${percentageTP}) = ${calculatedTakeProfit.toFixed(2)}`);
      if (calculatedTakeProfit <= price) {
        console.log(`[${exchange.name}] ❌ ERROR: Calculated BUY TP (${calculatedTakeProfit.toFixed(2)}) is NOT greater than price (${price})!`);
        calculatedTakeProfit = null;
      }
    }
    if (!isNaN(stopLossNum) && price) {
      calculatedStopLoss = price - (price * percentageSL);
      console.log(`[${exchange.name}] BUY SL: ${price} - (${price} * ${percentageSL}) = ${calculatedStopLoss.toFixed(2)}`);
      if (calculatedStopLoss >= price) {
        console.log(`[${exchange.name}] ❌ ERROR: Calculated BUY SL (${calculatedStopLoss.toFixed(2)}) is NOT less than price (${price})!`);
        calculatedStopLoss = null;
      } else if (calculatedStopLoss <= 0) {
        console.log(`[${exchange.name}] ❌ ERROR: Calculated BUY SL (${calculatedStopLoss.toFixed(2)}) is negative or zero!`);
        calculatedStopLoss = null;
      }
    }
  } else if (side === 'sell') {
    if (!isNaN(takeProfitNum) && price) {
      calculatedTakeProfit = price - (price * percentageTP);
      console.log(`[${exchange.name}] SELL TP: ${price} - (${price} * ${percentageTP}) = ${calculatedTakeProfit.toFixed(2)}`);
      if (calculatedTakeProfit >= price) {
        console.log(`[${exchange.name}] ❌ ERROR: Calculated SELL TP (${calculatedTakeProfit.toFixed(2)}) is NOT less than price (${price})!`);
        calculatedTakeProfit = null;
      } else if (calculatedTakeProfit <= 0) {
        console.log(`[${exchange.name}] ❌ ERROR: Calculated SELL TP (${calculatedTakeProfit.toFixed(2)}) is negative or zero!`);
        calculatedTakeProfit = null;
      }
    }
    if (!isNaN(stopLossNum) && price) {
      calculatedStopLoss = price + (price * percentageSL);
      console.log(`[${exchange.name}] SELL SL: ${price} + (${price} * ${percentageSL}) = ${calculatedStopLoss.toFixed(2)}`);
      if (calculatedStopLoss <= price) {
        console.log(`[${exchange.name}] ❌ ERROR: Calculated SELL SL (${calculatedStopLoss.toFixed(2)}) is NOT greater than price (${price})!`);
        calculatedStopLoss = null;
      }
    }
  }
  
  if (!calculatedTakeProfit && !calculatedStopLoss) {
    console.log(`[${exchange.name}] ⚠️  Could not calculate TP/SL values, skipping`);
    return { success: false, error: 'Could not calculate TP/SL values' };
  }
  
  // Step 1: Find the "TP/SL" checkbox and check its status
  // First, try to find within CreateOrderPanel
  console.log(`[${exchange.name}] Looking for "TP/SL" checkbox in CreateOrderPanel...`);
  
  let checkboxElement = null;
  let isChecked = false;
  
  // Method 1: Search within CreateOrderPanel first
  const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
  if (createOrderPanel) {
    console.log(`[${exchange.name}] ✅ Found CreateOrderPanel, searching for TP/SL checkbox within it...`);
    
    // Find checkbox within CreateOrderPanel
    const panelCheckboxes = await createOrderPanel.$$('input[type="checkbox"]');
    for (const checkbox of panelCheckboxes) {
      const isVisible = await page.evaluate((el) => el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0, checkbox);
      if (!isVisible) continue;
      
      // Check parent text for TP/SL
      const parentText = await page.evaluate((el) => {
        let parent = el.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.textContent) {
            const text = parent.textContent.toLowerCase();
            if (text.includes('tp') && text.includes('sl')) {
              return text;
            }
          }
          parent = parent.parentElement;
        }
        return '';
      }, checkbox);
      
      if (parentText.includes('tp') && parentText.includes('sl')) {
        checkboxElement = checkbox;
        isChecked = await page.evaluate((el) => el.checked, checkbox);
        console.log(`[${exchange.name}] ✅ Found TP/SL checkbox in CreateOrderPanel (checked: ${isChecked})`);
        break;
      }
    }
    
    // Also check labels within CreateOrderPanel
    if (!checkboxElement) {
      const panelLabels = await createOrderPanel.$$('label');
      for (const label of panelLabels) {
        const labelText = await page.evaluate((el) => el.textContent?.trim().toLowerCase() || '', label);
        if ((labelText.includes('tp') && labelText.includes('sl')) || 
            (labelText.includes('take profit') && labelText.includes('stop loss'))) {
          const checkbox = await label.$('input[type="checkbox"]');
          if (checkbox) {
            checkboxElement = checkbox;
            isChecked = await page.evaluate((el) => el.checked, checkbox);
            console.log(`[${exchange.name}] ✅ Found TP/SL checkbox via label in CreateOrderPanel (checked: ${isChecked})`);
            break;
          }
        }
      }
    }
  }
  
  // Method 2: Fallback - Find via labels (page-wide search)
  if (!checkboxElement) {
    console.log(`[${exchange.name}] TP/SL checkbox not found in CreateOrderPanel, trying page-wide search...`);
    const labels = await page.$$('label');
    for (const label of labels) {
      const labelText = await page.evaluate((el) => el.textContent?.trim().toLowerCase() || '', label);
      if (labelText.includes('tp') && labelText.includes('sl') || 
          (labelText.includes('take profit') && labelText.includes('stop loss'))) {
        const checkbox = await label.$('input[type="checkbox"]');
        if (checkbox) {
          checkboxElement = checkbox;
          isChecked = await page.evaluate((el) => el.checked, checkbox);
          break;
        }
        const labelFor = await label.evaluate((el) => el.getAttribute('for'), label);
        if (labelFor) {
          const checkboxById = await page.$(`#${labelFor}`);
          if (checkboxById && await page.evaluate((el) => el.type, checkboxById) === 'checkbox') {
            checkboxElement = checkboxById;
            isChecked = await page.evaluate((el) => el.checked, checkboxById);
            break;
          }
        }
      }
    }
  }
  
  // Method 2: Fallback - Look for checkbox near text
  if (!checkboxElement) {
    const allCheckboxes = await page.$$('input[type="checkbox"]');
    for (const checkbox of allCheckboxes) {
      const isVisible = await page.evaluate(el => el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0, checkbox);
      if (!isVisible) continue;
      
      const parentText = await page.evaluate(el => {
        let parent = el.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.textContent) return parent.textContent.toLowerCase();
          parent = parent.parentElement;
        }
        return '';
      }, checkbox);
      
      if ((parentText.includes('tp') && parentText.includes('sl')) ||
          (parentText.includes('take profit') && parentText.includes('stop loss'))) {
        checkboxElement = checkbox;
        isChecked = await page.evaluate(el => el.checked, checkbox);
        break;
      }
    }
  }
  
  if (checkboxElement) {
    if (isChecked) {
      console.log(`[${exchange.name}] ✅ TP/SL checkbox is already checked, recalculating and re-entering values.`);
      await delay(500);
    } else {
      console.log(`[${exchange.name}] TP/SL checkbox is not checked, clicking it...`);
      
      // Try multiple methods to click the checkbox
      try {
        // Method 1: Scroll into view and click
        await checkboxElement.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        await delay(300);
        await checkboxElement.click();
        console.log(`[${exchange.name}] ✅ TP/SL checkbox clicked successfully`);
      } catch (error1) {
        console.log(`[${exchange.name}] ⚠️  Direct click failed: ${error1.message}, trying JavaScript click...`);
        try {
          // Method 2: JavaScript click
          await checkboxElement.evaluate(el => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
          });
          console.log(`[${exchange.name}] ✅ TP/SL checkbox clicked via JavaScript`);
        } catch (error2) {
          console.log(`[${exchange.name}] ⚠️  JavaScript click failed: ${error2.message}, trying label click...`);
          try {
            // Method 3: Find and click the label instead
            const label = await page.evaluateHandle((checkbox) => {
              let parent = checkbox.parentElement;
              for (let i = 0; i < 5 && parent; i++) {
                if (parent.tagName === 'LABEL') {
                  return parent;
                }
                parent = parent.parentElement;
              }
              return null;
            }, checkboxElement);
            
            if (label && label.asElement()) {
              await label.asElement().click();
              console.log(`[${exchange.name}] ✅ TP/SL checkbox clicked via label`);
            } else {
              console.log(`[${exchange.name}] ⚠️  Could not find label, checkbox may already be checked or UI changed`);
            }
          } catch (error3) {
            console.log(`[${exchange.name}] ⚠️  All click methods failed: ${error3.message}`);
            console.log(`[${exchange.name}] ⚠️  Continuing anyway - checkbox may already be checked or not required`);
          }
        }
      }
      
      await delay(1000);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find TP/SL checkbox, continuing anyway.`);
  }
  
  let lastFilledInput = null;
  let tpInputElement = null;
  let slInputElement = null;
  
  // Helper function for filling TP/SL trigger price inputs (integer values)
  const fillTpSlInput = async (inputElement, value, inputName) => {
    const valueStr = String(value);
    console.log(`[${exchange.name}] Filling ${inputName} with value: ${valueStr}`);
    
    // Clear the input using multiple methods
    await inputElement.focus();
    await delay(200);
    
    // Method 1: Triple-click to select all
    await inputElement.click({ clickCount: 3 });
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
    }, inputElement);
    await delay(200);
    
    // Verify cleared
    let clearedValue = await page.evaluate((el) => el.value || '', inputElement);
    if (clearedValue && clearedValue.trim() !== '') {
      // More aggressive clear
      await page.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, inputElement);
      await delay(200);
      clearedValue = await page.evaluate((el) => el.value || '', inputElement);
    }
    
    // Fill the value
    await inputElement.focus();
    await delay(200);
    
    // Try typing first
    if (!clearedValue || clearedValue.trim() === '') {
      await inputElement.type(valueStr, { delay: 30 });
      await delay(300);
    } else {
      // If still not cleared, use direct JS assignment
      await page.evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }, inputElement, valueStr);
      await delay(300);
    }
    
    // Verify the value was set
    let finalValue = await page.evaluate((el) => el.value || '', inputElement);
    await delay(300); // Wait a bit more for any formatting
    finalValue = await page.evaluate((el) => el.value || '', inputElement);
    
    const finalNum = parseFloat(finalValue.replace(/,/g, '').replace(/ /g, ''));
    const expectedNum = parseInt(valueStr, 10);
    
    if (finalValue && finalValue.trim() !== '' && !isNaN(finalNum) && finalNum === expectedNum) {
      console.log(`[${exchange.name}] ✅ ${inputName} filled successfully. Expected: ${valueStr}, Actual: ${finalValue}`);
      return true;
    } else {
      console.log(`[${exchange.name}] ⚠️  ${inputName} value mismatch. Expected: ${valueStr} (${expectedNum}), Got: "${finalValue}" (${finalNum}), retrying...`);
      
      // Retry with more aggressive method
      await inputElement.focus();
      await delay(200);
      await page.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, inputElement);
      await delay(200);
      
      await inputElement.type(valueStr, { delay: 50 });
      await delay(500);
      
      await page.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, inputElement);
      await delay(500);
      
      // Verify after retry
      finalValue = await page.evaluate((el) => el.value || '', inputElement);
      const finalNumRetry = parseFloat(finalValue.replace(/,/g, '').replace(/ /g, ''));
      
      if (finalValue && finalValue.trim() !== '' && !isNaN(finalNumRetry) && finalNumRetry === expectedNum) {
        console.log(`[${exchange.name}] ✅ ${inputName} filled successfully after retry. Expected: ${valueStr}, Actual: ${finalValue}`);
        return true;
      } else {
        console.log(`[${exchange.name}] ⚠️  ${inputName} still not matching after retry. Expected: ${valueStr} (${expectedNum}), Got: "${finalValue}" (${finalNumRetry})`);
        return false;
      }
    }
  };
  
  // Step 2: Find and fill TP trigger price input
  if (calculatedTakeProfit) {
    console.log(`[${exchange.name}] Looking for TP trigger price input in CreateOrderPanel...`);
    
    // First, try to find within CreateOrderPanel
    tpInputElement = null;
    const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
    
    if (createOrderPanel) {
      console.log(`[${exchange.name}] ✅ Found CreateOrderPanel, searching for TP trigger price input within it...`);
      
      const panelInputs = await createOrderPanel.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      for (const input of panelInputs) {
        const isVisible = await page.evaluate((el) => el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0, input);
        if (!isVisible) continue;
        
        const inputInfo = await page.evaluate((el) => {
          let labelText = '';
          const labels = document.querySelectorAll('label');
          for (const label of labels) {
            if (label.control === el || label.getAttribute('for') === el.id || label.contains(el)) {
              labelText = (label.textContent || '').trim().toLowerCase();
              break;
            }
          }
          
          let parent = el.parentElement;
          let parentText = '';
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.textContent) {
              parentText = (parent.textContent || '').trim().toLowerCase();
              break;
            }
            parent = parent.parentElement;
          }
          
          const placeholder = (el.placeholder || '').toLowerCase();
          return { labelText, parentText, placeholder };
        }, input);
        
        // Check if this is TP trigger price input
        if ((inputInfo.labelText.includes('tp') && inputInfo.labelText.includes('trigger')) ||
            (inputInfo.parentText.includes('tp') && inputInfo.parentText.includes('trigger')) ||
            (inputInfo.placeholder.includes('tp') && inputInfo.placeholder.includes('trigger')) ||
            (inputInfo.labelText.includes('take profit') && inputInfo.labelText.includes('trigger')) ||
            (inputInfo.parentText.includes('take profit') && inputInfo.parentText.includes('trigger'))) {
          tpInputElement = input;
          console.log(`[${exchange.name}] ✅ Found TP trigger price input in CreateOrderPanel`);
          break;
        }
      }
    }
    
    // Fallback: Use page-wide search
    if (!tpInputElement) {
      console.log(`[${exchange.name}] TP trigger price input not found in CreateOrderPanel, trying page-wide search...`);
      const tpInputHandle = await page.evaluateHandle(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while (node = walker.nextNode()) {
          const text = node.textContent?.trim().toLowerCase() || '';
          if (text.includes('tp trigger') || (text.includes('tp') && text.includes('trigger'))) {
            let parent = node.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
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
      
      if (tpInputHandle && tpInputHandle.asElement()) {
        tpInputElement = tpInputHandle.asElement();
      }
    }
    
    // Method 2: Fallback search
    if (!tpInputElement) {
      const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      for (const input of allInputs) {
        const isVisible = await input.evaluate(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
        if (!isVisible) continue;
        
        const inputInfo = await page.evaluate((el) => {
          const placeholder = (el.placeholder || '').toLowerCase();
          const name = (el.name || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          
          let labelText = '';
          const labels = document.querySelectorAll('label');
          for (const label of labels) {
            if (label.control === el || label.getAttribute('for') === el.id) {
              labelText = (label.textContent || '').toLowerCase();
              break;
            }
          }
          
          let parent = el.parentElement;
          let parentText = '';
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.textContent) {
              parentText = parent.textContent.toLowerCase();
              break;
            }
            parent = parent.parentElement;
          }
          
          return { placeholder, name, id, labelText, parentText };
        }, input);
        
        if (inputInfo.placeholder.includes('tp trigger') || inputInfo.name.includes('tp trigger') ||
            inputInfo.id.includes('tp trigger') || inputInfo.labelText.includes('tp trigger') ||
            inputInfo.parentText.includes('tp trigger')) {
          tpInputElement = input;
          break;
        }
      }
    }
    
    if (tpInputElement) {
      const valueNum = calculatedTakeProfit;
      const intValue = Math.ceil(valueNum);
      console.log(`[${exchange.name}] ✅ Found TP trigger price input, filling calculated value: ${intValue} (original: ${valueNum.toFixed(2)})`);
      
      const success = await fillTpSlInput(tpInputElement, intValue, 'TP trigger price');
      if (success) {
        lastFilledInput = tpInputElement;
      } else {
        console.log(`[${exchange.name}] ⚠️  TP trigger price fill failed, but continuing...`);
        lastFilledInput = tpInputElement; // Still set as last filled for Enter press
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find TP trigger price input`);
    }
  }
  
  // Step 3: Find and fill SL trigger price input
  if (calculatedStopLoss) {
    console.log(`[${exchange.name}] Looking for SL trigger price input in CreateOrderPanel...`);
    
    // First, try to find within CreateOrderPanel
    slInputElement = null;
    const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
    
    if (createOrderPanel) {
      console.log(`[${exchange.name}] ✅ Found CreateOrderPanel, searching for SL trigger price input within it...`);
      
      const panelInputs = await createOrderPanel.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      for (const input of panelInputs) {
        const isVisible = await page.evaluate((el) => el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0, input);
        if (!isVisible) continue;
        
        const inputInfo = await page.evaluate((el) => {
          let labelText = '';
          const labels = document.querySelectorAll('label');
          for (const label of labels) {
            if (label.control === el || label.getAttribute('for') === el.id || label.contains(el)) {
              labelText = (label.textContent || '').trim().toLowerCase();
              break;
            }
          }
          
          let parent = el.parentElement;
          let parentText = '';
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.textContent) {
              parentText = (parent.textContent || '').trim().toLowerCase();
              break;
            }
            parent = parent.parentElement;
          }
          
          const placeholder = (el.placeholder || '').toLowerCase();
          return { labelText, parentText, placeholder };
        }, input);
        
        // Check if this is SL trigger price input
        if ((inputInfo.labelText.includes('sl') && inputInfo.labelText.includes('trigger')) ||
            (inputInfo.parentText.includes('sl') && inputInfo.parentText.includes('trigger')) ||
            (inputInfo.placeholder.includes('sl') && inputInfo.placeholder.includes('trigger')) ||
            (inputInfo.labelText.includes('stop loss') && inputInfo.labelText.includes('trigger')) ||
            (inputInfo.parentText.includes('stop loss') && inputInfo.parentText.includes('trigger'))) {
          slInputElement = input;
          console.log(`[${exchange.name}] ✅ Found SL trigger price input in CreateOrderPanel`);
          break;
        }
      }
    }
    
    // Fallback: Use page-wide search
    if (!slInputElement) {
      console.log(`[${exchange.name}] SL trigger price input not found in CreateOrderPanel, trying page-wide search...`);
      const slInputHandle = await page.evaluateHandle(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while (node = walker.nextNode()) {
          const text = node.textContent?.trim().toLowerCase() || '';
          if (text.includes('sl trigger') || (text.includes('sl') && text.includes('trigger'))) {
            let parent = node.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
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
      
      if (slInputHandle && slInputHandle.asElement()) {
        slInputElement = slInputHandle.asElement();
      }
    }
    
    // Method 2: Fallback search
    if (!slInputElement) {
      const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      for (const input of allInputs) {
        const isVisible = await input.evaluate(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
        if (!isVisible) continue;
        
        const inputInfo = await page.evaluate((el) => {
          const placeholder = (el.placeholder || '').toLowerCase();
          const name = (el.name || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          
          let labelText = '';
          const labels = document.querySelectorAll('label');
          for (const label of labels) {
            if (label.control === el || label.getAttribute('for') === el.id) {
              labelText = (label.textContent || '').toLowerCase();
              break;
            }
          }
          
          let parent = el.parentElement;
          let parentText = '';
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.textContent) {
              parentText = parent.textContent.toLowerCase();
              break;
            }
            parent = parent.parentElement;
          }
          
          return { placeholder, name, id, labelText, parentText };
        }, input);
        
        if (inputInfo.placeholder.includes('sl trigger') || inputInfo.name.includes('sl trigger') ||
            inputInfo.id.includes('sl trigger') || inputInfo.labelText.includes('sl trigger') ||
            inputInfo.parentText.includes('sl trigger')) {
          slInputElement = input;
          break;
        }
      }
    }
    
    if (slInputElement) {
      const valueNum = calculatedStopLoss;
      const intValue = Math.floor(valueNum);
      console.log(`[${exchange.name}] ✅ Found SL trigger price input, filling calculated value: ${intValue} (original: ${valueNum.toFixed(2)})`);
      
      const success = await fillTpSlInput(slInputElement, intValue, 'SL trigger price');
      if (success) {
        lastFilledInput = slInputElement;
      } else {
        console.log(`[${exchange.name}] ⚠️  SL trigger price fill failed, but continuing...`);
        lastFilledInput = slInputElement; // Still set as last filled for Enter press
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find SL trigger price input`);
    }
  }
  
  console.log(`[${exchange.name}] ✅ TP/SL handling completed`);
  
  // Verify TP/SL values are still present before proceeding
  if (calculatedTakeProfit && tpInputElement) {
    await delay(300);
    const tpValue = await page.evaluate((el) => el.value || '', tpInputElement);
    const expectedTp = Math.ceil(calculatedTakeProfit);
    const actualTp = parseFloat(tpValue.replace(/,/g, '').replace(/ /g, '')) || 0;
    if (actualTp !== expectedTp) {
      console.log(`[${exchange.name}] ⚠️  TP value was cleared (expected: ${expectedTp}, got: ${actualTp}), refilling...`);
      await fillTpSlInput(tpInputElement, expectedTp, 'TP trigger price');
      await delay(300);
    }
  }
  
  if (calculatedStopLoss && slInputElement) {
    await delay(300);
    const slValue = await page.evaluate((el) => el.value || '', slInputElement);
    const expectedSl = Math.floor(calculatedStopLoss);
    const actualSl = parseFloat(slValue.replace(/,/g, '').replace(/ /g, '')) || 0;
    if (actualSl !== expectedSl) {
      console.log(`[${exchange.name}] ⚠️  SL value was cleared (expected: ${expectedSl}, got: ${actualSl}), refilling...`);
      await fillTpSlInput(slInputElement, expectedSl, 'SL trigger price');
      await delay(300);
    }
  }
  
  // Don't press Enter on TP/SL inputs as it might trigger form validation that clears values
  // Instead, just wait a bit for the UI to process the values
  console.log(`[${exchange.name}] Waiting for TP/SL values to be processed by UI...`);
  await delay(500);
  
  return { success: true };
}

/**
 * Execute trade for GRVT
 */
export async function executeTradeGrvt(
  page,
  { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
  exchange
) {
  console.log(`\n=== Executing Trade on ${exchange.name} ===`);

  // Set leverage first if requested
  if (setLeverageFirst && leverage) {
    await setLeverageGrvt(page, leverage, exchange);
  }

  // If limit order without price, fetch current market price
  if (orderType === "limit" && !price) {
    price = await getCurrentMarketPrice(page, exchange);
    if (!price) {
      console.log(`[${exchange.name}] ❌ Could not fetch market price for limit order`);
      return { success: false, error: "Could not fetch market price" };
    }
  }

  // GRVT: Fixed size to 0.002
  const grvtSize = 0.002;
  console.log(`[${exchange.name}] GRVT: Using fixed size ${grvtSize} BTC (overriding qty parameter: ${qty})`);

  console.log(
    `[${exchange.name}] Side: ${side}, Type: ${orderType}, Price: ${
      price || "market"
    }, Qty: ${grvtSize}`
  );

  // For GRVT: Limit/Market are tabs at the top, inputs (Price, Quantity) are always visible below
  // So we select the tab first, then fill inputs
  
  // 1. Select Limit or Market tab (tabs are at the top)
  console.log(`[${exchange.name}] Step 0: Selecting ${orderType.toUpperCase()} tab...`);
  try {
    const orderTypePromise = selectOrderType(page, orderType, exchange);
    const orderTypeTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('selectOrderType timeout after 5 seconds')), 5000)
    );
    
    const orderTypeResult = await Promise.race([orderTypePromise, orderTypeTimeout]);
    if (!orderTypeResult) {
      console.log(`[${exchange.name}] ⚠️  Failed to select order type tab, but continuing...`);
    }
  } catch (error) {
    console.log(`[${exchange.name}] ⚠️  Error selecting order type tab: ${error.message}, continuing...`);
  }
  await delay(300); // Small delay for tab to activate

  // 2. Find inputs - GRVT has "Price" and "Quantity" inputs within CreateOrderPanel
  console.log(`[${exchange.name}] Looking for Price and Quantity inputs in CreateOrderPanel...`);
  
  let sizeInput = null;
  let priceInput = null;
  
  // GRVT-specific: Find inputs within data-sentry-element="CreateOrderPanel"
  const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
  
  if (createOrderPanel) {
    console.log(`[${exchange.name}] ✅ Found CreateOrderPanel, searching for inputs within it...`);
    
    // Find all inputs within the CreateOrderPanel
    const panelInputs = await createOrderPanel.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
    console.log(`[${exchange.name}] Found ${panelInputs.length} input(s) in CreateOrderPanel`);
    
    for (const input of panelInputs) {
      const rect = await input.boundingBox();
      if (!rect) continue;
      
      const inputInfo = await page.evaluate((el) => {
        // Find label
        let labelText = '';
        const labels = document.querySelectorAll('label');
        for (const label of labels) {
          if (label.control === el || label.getAttribute('for') === el.id || label.contains(el)) {
            labelText = (label.textContent || '').trim().toLowerCase();
            break;
          }
        }
        
        // Check parent text
        let parent = el.parentElement;
        let parentText = '';
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.textContent) {
            parentText = (parent.textContent || '').trim();
            break;
          }
          parent = parent.parentElement;
        }
        
        // Check placeholder
        const placeholder = el.placeholder || '';
        
        return { 
          labelText: labelText.toLowerCase(), 
          parentText: parentText.toLowerCase(),
          placeholder: placeholder.toLowerCase(),
          value: el.value || ''
        };
      }, input);
      
      console.log(`[${exchange.name}] Input in CreateOrderPanel: label="${inputInfo.labelText}", placeholder="${inputInfo.placeholder}", parent="${inputInfo.parentText.substring(0, 30)}"`);
      
      // Quantity/Size input: has "quantity", "size", "qty", or "BTC" in label/parent/placeholder
      if (!sizeInput && (
        inputInfo.labelText.includes('quantity') || 
        inputInfo.labelText.includes('size') || 
        inputInfo.labelText.includes('qty') ||
        inputInfo.parentText.includes('btc') ||
        inputInfo.parentText.includes('quantity') ||
        inputInfo.placeholder.includes('quantity') ||
        inputInfo.placeholder.includes('size')
      )) {
        sizeInput = input;
        console.log(`[${exchange.name}] ✅ Found Quantity input in CreateOrderPanel`);
      }
      
      // Price input: has "price" or "mid" in label/parent/placeholder/value (for limit orders)
      if (!priceInput && orderType === "limit" && (
        inputInfo.labelText.includes('price') ||
        inputInfo.parentText.includes('price') ||
        inputInfo.placeholder.includes('price') ||
        inputInfo.value.toLowerCase().includes('mid') ||
        inputInfo.parentText.includes('mid')
      )) {
        priceInput = input;
        console.log(`[${exchange.name}] ✅ Found Price input in CreateOrderPanel`);
      }
    }
    
    // If we found one but not the other, try position-based matching within the panel
    if (sizeInput && !priceInput && orderType === "limit") {
      console.log(`[${exchange.name}] Found Quantity but not Price, trying position-based search within panel...`);
      const sizeRect = await sizeInput.boundingBox();
      if (sizeRect) {
        for (const input of panelInputs) {
          if (input === sizeInput) continue;
          const inputRect = await input.boundingBox();
          if (!inputRect) continue;
          // Price is likely near Quantity (same row, different column)
          const isNearQuantity = Math.abs(inputRect.y - sizeRect.y) < 50 && 
                                 Math.abs(inputRect.x - sizeRect.x) < 400 &&
                                 inputRect.x !== sizeRect.x;
          if (isNearQuantity) {
            priceInput = input;
            console.log(`[${exchange.name}] ✅ Found Price input via position-based search near Quantity`);
            break;
          }
        }
      }
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  CreateOrderPanel not found, falling back to standard search...`);
  }
  
  // Fallback to standard search if CreateOrderPanel method didn't find inputs
  if (!sizeInput || (orderType === "limit" && !priceInput)) {
    console.log(`[${exchange.name}] CreateOrderPanel search incomplete, trying fallback methods...`);
    const inputs = await findSizeAndPriceInputs(page, orderType);
    if (!sizeInput) sizeInput = inputs.sizeInput;
    if (!priceInput && orderType === "limit") priceInput = inputs.priceInput;
    
    // Additional fallback: Find "Available to trade" text, then next two inputs (Price, then Quantity)
    if (!sizeInput || (orderType === "limit" && !priceInput)) {
      console.log(`[${exchange.name}] Standard search incomplete, trying GRVT-specific search...`);
      const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      const screenWidth = await page.evaluate(() => window.innerWidth);
      // Use stricter threshold - only inputs in the rightmost 30% of screen (most right sidebar)
      const rightSideThreshold = screenWidth * 0.7; // 70% from left = rightmost 30%
      
      // GRVT-specific: Find "Available to trade" text in right half, then next two inputs using DOM traversal
      if (!sizeInput || (orderType === "limit" && !priceInput)) {
      console.log(`[${exchange.name}] GRVT method: Looking for "Available to trade" text, then traversing DOM to find inputs...`);
      
      // Use a more robust method: Find text node with "Available to trade", then traverse DOM
      const inputsFound = await page.evaluate((rightThreshold) => {
        // Method 1: Use TreeWalker to find text node containing "Available to trade"
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );
        
        let availableToTradeNode = null;
        let node;
        while (node = walker.nextNode()) {
          const text = node.textContent?.trim() || '';
          if (text.includes('Available to trade') || text === 'Available to trade') {
            // Check if parent element is in right half
            const parent = node.parentElement;
            if (parent) {
              const rect = parent.getBoundingClientRect();
              if (rect.x >= rightThreshold && parent.offsetParent !== null) {
                availableToTradeNode = node;
                break;
              }
            }
          }
        }
        
        if (!availableToTradeNode) {
          // Fallback: Search all elements
          const allElements = Array.from(document.querySelectorAll('*'));
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text.includes('Available to trade') || text === 'Available to trade') {
              const rect = el.getBoundingClientRect();
              if (rect.x >= rightThreshold && el.offsetParent !== null) {
                availableToTradeNode = el;
                break;
              }
            }
          }
        }
        
        if (!availableToTradeNode) {
          console.log('Could not find "Available to trade" text');
          return { priceInput: null, sizeInput: null, found: false };
        }
        
        // Get the parent element containing the text
        let container = availableToTradeNode.parentElement || availableToTradeNode;
        if (!container) {
          return { priceInput: null, sizeInput: null, found: false };
        }
        
        // Traverse up to find a common container (likely a form or div containing both inputs)
        let commonContainer = container;
        for (let i = 0; i < 5 && commonContainer; i++) {
          const inputs = commonContainer.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])');
          if (inputs.length >= 2) {
            break;
          }
          commonContainer = commonContainer.parentElement;
        }
        
        // Get all visible inputs in the container, sorted by DOM order
        const allInputs = Array.from(commonContainer.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])'));
        
        // Filter to visible, enabled inputs in the rightmost 30% of screen (strict)
        const visibleInputs = allInputs.filter(input => {
          if (input.offsetParent === null || input.disabled || input.readOnly) return false;
          const rect = input.getBoundingClientRect();
          // Must be in rightmost 30% of screen (strict)
          return rect.x >= rightThreshold && rect.width > 0 && rect.height > 0;
        });
        
        // Get position of "Available to trade" element
        const availableRect = (availableToTradeNode.parentElement || availableToTradeNode).getBoundingClientRect();
        
        // Find inputs that come after "Available to trade" in DOM order and position
        // Also ensure they're in the same rightmost panel (check X position is close to "Available to trade")
        const inputsAfterAvailable = [];
        for (const input of visibleInputs) {
          const inputRect = input.getBoundingClientRect();
          // Input should be below "Available to trade" (with tolerance)
          // AND in the same rightmost panel (X position should be close to "Available to trade")
          const isBelow = inputRect.y >= availableRect.y - 100;
          const isInSamePanel = Math.abs(inputRect.x - availableRect.x) < 200; // Within 200px horizontally
          
          if (isBelow && isInSamePanel) {
            inputsAfterAvailable.push(input);
          }
        }
        
        // If no inputs found with same panel check, relax the panel constraint
        if (inputsAfterAvailable.length < 2) {
          inputsAfterAvailable.length = 0; // Clear and retry
          for (const input of visibleInputs) {
            const inputRect = input.getBoundingClientRect();
            if (inputRect.y >= availableRect.y - 100) {
              inputsAfterAvailable.push(input);
            }
          }
        }
        
        // Sort by X position first (rightmost first), then by Y (top to bottom)
        // This ensures we get inputs from the rightmost trading panel
        inputsAfterAvailable.sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          // First sort by X (rightmost first - descending)
          if (Math.abs(rectA.x - rectB.x) > 50) {
            return rectB.x - rectA.x; // Descending (rightmost first)
          }
          // Then by Y (top to bottom)
          return rectA.y - rectB.y;
        });
        
        // The first two inputs after "Available to trade" (rightmost, then top to bottom) are Price and Quantity
        if (inputsAfterAvailable.length >= 2) {
          return {
            priceInput: inputsAfterAvailable[0], // First input = Price (rightmost, topmost)
            sizeInput: inputsAfterAvailable[1],  // Second input = Quantity (rightmost, second from top)
            found: true
          };
        } else if (inputsAfterAvailable.length === 1) {
          return {
            priceInput: null,
            sizeInput: inputsAfterAvailable[0],
            found: true
          };
        }
        
        return { priceInput: null, sizeInput: null, found: false };
      }, rightSideThreshold);
      
      if (inputsFound.found) {
        // Re-find inputs using the same logic but return them as handles (screen-size independent)
        // This ensures we get the actual ElementHandles, not just references
        const priceInputHandle = await page.evaluateHandle((rightThreshold, needPrice) => {
          if (!needPrice) return null;
          
          // Find "Available to trade" text
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null
          );
          
          let availableToTradeNode = null;
          let node;
          while (node = walker.nextNode()) {
            const text = node.textContent?.trim() || '';
            if (text.includes('Available to trade') || text === 'Available to trade') {
              const parent = node.parentElement;
              if (parent) {
                const rect = parent.getBoundingClientRect();
                if (rect.x >= rightThreshold && parent.offsetParent !== null) {
                  availableToTradeNode = node;
                  break;
                }
              }
            }
          }
          
          if (!availableToTradeNode) return null;
          
          // Get container
          let container = availableToTradeNode.parentElement || availableToTradeNode;
          let commonContainer = container;
          for (let i = 0; i < 5 && commonContainer; i++) {
            const inputs = commonContainer.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])');
            if (inputs.length >= 2) {
              break;
            }
            commonContainer = commonContainer.parentElement;
          }
          
          // Get all visible inputs
          const allInputs = Array.from(commonContainer.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])'));
          const visibleInputs = allInputs.filter(input => {
            if (input.offsetParent === null || input.disabled || input.readOnly) return false;
            const rect = input.getBoundingClientRect();
            return rect.x >= rightThreshold && rect.width > 0 && rect.height > 0;
          });
          
          const availableRect = (availableToTradeNode.parentElement || availableToTradeNode).getBoundingClientRect();
          const inputsAfterAvailable = visibleInputs.filter(input => {
            const inputRect = input.getBoundingClientRect();
            // Must be below "Available to trade" AND in same rightmost panel
            const isBelow = inputRect.y >= availableRect.y - 100;
            const isInSamePanel = Math.abs(inputRect.x - availableRect.x) < 200;
            return isBelow && isInSamePanel;
          });
          
          // If no inputs with same panel, relax constraint
          if (inputsAfterAvailable.length === 0) {
            for (const input of visibleInputs) {
              const inputRect = input.getBoundingClientRect();
              if (inputRect.y >= availableRect.y - 100) {
                inputsAfterAvailable.push(input);
              }
            }
          }
          
          // Sort by X (rightmost first), then Y (top to bottom)
          inputsAfterAvailable.sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            if (Math.abs(rectA.x - rectB.x) > 50) {
              return rectB.x - rectA.x; // Descending (rightmost first)
            }
            return rectA.y - rectB.y;
          });
          
          // Return first input (Price) - rightmost, topmost
          return inputsAfterAvailable.length > 0 ? inputsAfterAvailable[0] : null;
        }, rightSideThreshold, orderType === "limit");
        
        const sizeInputHandle = await page.evaluateHandle((rightThreshold) => {
          // Find "Available to trade" text
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null
          );
          
          let availableToTradeNode = null;
          let node;
          while (node = walker.nextNode()) {
            const text = node.textContent?.trim() || '';
            if (text.includes('Available to trade') || text === 'Available to trade') {
              const parent = node.parentElement;
              if (parent) {
                const rect = parent.getBoundingClientRect();
                if (rect.x >= rightThreshold && parent.offsetParent !== null) {
                  availableToTradeNode = node;
                  break;
                }
              }
            }
          }
          
          if (!availableToTradeNode) return null;
          
          // Get container
          let container = availableToTradeNode.parentElement || availableToTradeNode;
          let commonContainer = container;
          for (let i = 0; i < 5 && commonContainer; i++) {
            const inputs = commonContainer.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])');
            if (inputs.length >= 2) {
              break;
            }
            commonContainer = commonContainer.parentElement;
          }
          
          // Get all visible inputs in rightmost 30%
          const allInputs = Array.from(commonContainer.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])'));
          const visibleInputs = allInputs.filter(input => {
            if (input.offsetParent === null || input.disabled || input.readOnly) return false;
            const rect = input.getBoundingClientRect();
            return rect.x >= rightThreshold && rect.width > 0 && rect.height > 0;
          });
          
          const availableRect = (availableToTradeNode.parentElement || availableToTradeNode).getBoundingClientRect();
          const inputsAfterAvailable = visibleInputs.filter(input => {
            const inputRect = input.getBoundingClientRect();
            // Must be below "Available to trade" AND in same rightmost panel
            const isBelow = inputRect.y >= availableRect.y - 100;
            const isInSamePanel = Math.abs(inputRect.x - availableRect.x) < 200;
            return isBelow && isInSamePanel;
          });
          
          // If no inputs with same panel, relax constraint
          if (inputsAfterAvailable.length === 0) {
            for (const input of visibleInputs) {
              const inputRect = input.getBoundingClientRect();
              if (inputRect.y >= availableRect.y - 100) {
                inputsAfterAvailable.push(input);
              }
            }
          }
          
          // Sort by X (rightmost first), then Y (top to bottom)
          inputsAfterAvailable.sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            if (Math.abs(rectA.x - rectB.x) > 50) {
              return rectB.x - rectA.x; // Descending (rightmost first)
            }
            return rectA.y - rectB.y;
          });
          
          // Return second input (Quantity) - rightmost, second from top
          if (inputsAfterAvailable.length > 1) {
            return inputsAfterAvailable[1];
          } else if (inputsAfterAvailable.length > 0) {
            return inputsAfterAvailable[0];
          }
          return null;
        }, rightSideThreshold);
        
        // Convert handles to elements
        if (priceInputHandle && orderType === "limit") {
          priceInput = priceInputHandle.asElement();
          if (priceInput) {
            const priceValue = await page.evaluate((el) => el.value || '', priceInput);
            console.log(`[${exchange.name}] ✅ Found Price input via GRVT method (first input after "Available to trade"), current value: "${priceValue}"`);
          }
        }
        
        if (sizeInputHandle) {
          sizeInput = sizeInputHandle.asElement();
          if (sizeInput) {
            const sizeValue = await page.evaluate((el) => el.value || '', sizeInput);
            console.log(`[${exchange.name}] ✅ Found Quantity input via GRVT method (second input after "Available to trade"), current value: "${sizeValue}"`);
          }
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Could not find inputs using "Available to trade" method`);
      }
      }
    }
    
    // If still not found, try the original method with stricter right-side filtering
    if (!sizeInput) {
      // Get screen width for threshold (use stricter threshold for rightmost panel)
      const screenWidthStrict = await page.evaluate(() => window.innerWidth);
      const strictRightThreshold = screenWidthStrict * 0.7; // Rightmost 30% only
      
      for (const input of allInputs) {
        const rect = await input.boundingBox();
        if (!rect || rect.x < strictRightThreshold) continue; // Only rightmost 30%
        
        const inputInfo = await page.evaluate((el) => {
          // Find label
          let labelText = '';
          const labels = document.querySelectorAll('label');
          for (const label of labels) {
            if (label.control === el || label.getAttribute('for') === el.id || label.contains(el)) {
              labelText = (label.textContent || '').trim().toLowerCase();
              break;
            }
          }
          
          // Check parent text
          let parent = el.parentElement;
          let parentText = '';
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.textContent) {
              parentText = (parent.textContent || '').trim();
              break;
            }
            parent = parent.parentElement;
          }
          
          return { 
            labelText: labelText.toLowerCase(), 
            parentText: parentText.toLowerCase(),
            value: el.value || ''
          };
        }, input);
        
        // Quantity input: has "BTC" in parent text
        if (!sizeInput && (inputInfo.parentText.includes('btc') || 
                           inputInfo.parentText.includes('quantity') ||
                           inputInfo.labelText === 'quantity')) {
          sizeInput = input;
          console.log(`[${exchange.name}] ✅ Found Quantity input (parent: "${inputInfo.parentText.substring(0, 30)}")`);
        }
        
        // Price input: has "price" or "Mid" in label/parent/value (GRVT uses "Mid" similar to "BTC" for quantity)
        if (!priceInput && orderType === "limit") {
          if (inputInfo.labelText === 'price' || 
              inputInfo.parentText.includes('price') ||
              inputInfo.value.toLowerCase().includes('mid') ||
              inputInfo.parentText.includes('mid')) {
            priceInput = input;
            console.log(`[${exchange.name}] ✅ Found Price input via text match (parent: "${inputInfo.parentText.substring(0, 30)}", value: "${inputInfo.value.substring(0, 20)}")`);
          } else if (sizeInput) {
            // If we found Quantity, Price is likely the input immediately before or after it horizontally
            const sizeRect = await sizeInput.boundingBox();
            if (sizeRect) {
              const inputRect = await input.boundingBox();
              if (inputRect) {
                // Check if this input is near the Quantity input (same approximate row, different column)
                const isNearQuantity = Math.abs(inputRect.y - sizeRect.y) < 50 && 
                                       Math.abs(inputRect.x - sizeRect.x) < 400 &&
                                       input !== sizeInput;
                if (isNearQuantity) {
                  priceInput = input;
                  console.log(`[${exchange.name}] ✅ Found Price input near Quantity input (parent: "${inputInfo.parentText.substring(0, 30)}")`);
                }
              }
            }
          }
        }
        
        if (sizeInput && (orderType === "market" || priceInput)) {
          break;
        }
      }
    }
  }
  
  if (!sizeInput) {
    console.log(`[${exchange.name}] ❌ Quantity input not found`);
    return { success: false, error: "Quantity input not found" };
  }
  
  if (orderType === "limit" && !priceInput) {
    console.log(`[${exchange.name}] ❌ Price input not found for limit order`);
    return { success: false, error: "Price input not found for limit order" };
  }
  
  console.log(`[${exchange.name}] ✅ Found all required inputs`);

  // 3. Fill inputs in order: Price -> Quantity -> TP/SL -> Buy/Sell
  // GRVT-specific clear and fill functions (more aggressive)
  
  // Helper function for GRVT: Clear and fill input with multiple methods
  const clearAndFillInputGrvt = async (input, value, inputName) => {
    console.log(`[${exchange.name}] Clearing and filling ${inputName} with value: ${value}`);
    
    // Get current value
    const currentValue = await page.evaluate((el) => el.value || '', input);
    console.log(`[${exchange.name}] Current ${inputName} value: "${currentValue}"`);
    
    // Method 1: Focus and select all
    await input.focus();
    await delay(300);
    
    // Method 2: Triple click to select all
    await input.click({ clickCount: 3 });
    await delay(200);
    
    // Method 3: Select all with Ctrl+A
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await delay(200);
    
    // Method 4: Delete selected text
    await page.keyboard.press('Delete');
    await delay(200);
    await page.keyboard.press('Backspace');
    await delay(200);
    
    // Method 5: JavaScript clear (most reliable)
    await page.evaluate((el) => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('keydown', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
    }, input);
    await delay(300);
    
    // Verify cleared
    let clearedValue = await page.evaluate((el) => el.value || '', input);
    console.log(`[${exchange.name}] ${inputName} value after clearing: "${clearedValue}"`);
    
    // If still not cleared, try more aggressive methods
    if (clearedValue && clearedValue.trim() !== '') {
      console.log(`[${exchange.name}] ${inputName} still not cleared, trying more aggressive clear...`);
      await page.evaluate((el) => {
        // Try multiple ways to clear
        el.value = '';
        el.textContent = '';
        el.innerText = '';
        el.setAttribute('value', '');
        // Trigger all possible events
        ['input', 'change', 'keydown', 'keyup', 'keypress', 'blur', 'focus'].forEach(eventType => {
          el.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
        });
      }, input);
      await delay(300);
      clearedValue = await page.evaluate((el) => el.value || '', input);
      console.log(`[${exchange.name}] ${inputName} value after aggressive clear: "${clearedValue}"`);
    }
    
    // Now fill the new value - use a single, reliable method
    const valueStr = String(value);
    console.log(`[${exchange.name}] Filling ${inputName} with: "${valueStr}"`);
    
    // Focus the input first
    await input.focus();
    await delay(200);
    
    // Triple-click to select all existing text
    await input.click({ clickCount: 3 });
    await delay(100);
    
    // Delete selected text
    await page.keyboard.press('Delete');
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    
    // Verify it's cleared (second check after triple-click)
    let clearedValueCheck = await page.evaluate((el) => el.value || '', input);
    if (clearedValueCheck && clearedValueCheck.trim() !== '') {
      // If not cleared, try Ctrl+A + Delete
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await delay(100);
      await page.keyboard.press('Delete');
      await delay(100);
      clearedValueCheck = await page.evaluate((el) => el.value || '', input);
    }
    
    // If still not cleared, use JavaScript
    if (clearedValueCheck && clearedValueCheck.trim() !== '') {
      await page.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, input);
      await delay(200);
      clearedValueCheck = await page.evaluate((el) => el.value || '', input);
    }
    
    // Now type the new value (only if input is cleared)
    if (!clearedValueCheck || clearedValueCheck.trim() === '') {
      await input.type(valueStr, { delay: 30 });
      await delay(300);
    } else {
      // If still not cleared, use direct JavaScript assignment
      console.log(`[${exchange.name}] Input not cleared, using direct JS assignment...`);
      await page.evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }, input, valueStr);
      await delay(300);
    }
    
    // Verify the value was set and persists
    let finalValue = await page.evaluate((el) => el.value || '', input);
    console.log(`[${exchange.name}] Final ${inputName} value (immediate): "${finalValue}"`);
    
    // Wait a bit and check again to ensure it persists
    await delay(500);
    finalValue = await page.evaluate((el) => el.value || '', input);
    console.log(`[${exchange.name}] Final ${inputName} value (after delay): "${finalValue}"`);
    
    // If still empty, try one more time with focus and type
    if (!finalValue || finalValue.trim() === '') {
      console.log(`[${exchange.name}] ${inputName} still empty, trying one more time with focus and type...`);
      await input.focus();
      await delay(200);
      await input.click({ clickCount: 3 });
      await delay(100);
      await page.keyboard.press('Backspace');
      await delay(100);
      await input.type(valueStr, { delay: 50 });
      await delay(500);
      finalValue = await page.evaluate((el) => el.value || '', input);
      console.log(`[${exchange.name}] ${inputName} value after retry: "${finalValue}"`);
    }
    
    // Check if value matches
    const finalNum = parseFloat(finalValue.replace(/,/g, '').replace(/ /g, ''));
    const expectedNum = parseFloat(valueStr);
    
    // For Price inputs, the field may round to 1 decimal place, so use more lenient tolerance (0.1)
    // For Quantity inputs, use stricter tolerance (0.0001)
    const tolerance = inputName === 'Price' ? 0.1 : 0.0001;
    
    if (finalValue && finalValue.trim() !== '' && !isNaN(finalNum) && Math.abs(finalNum - expectedNum) < tolerance) {
      console.log(`[${exchange.name}] ✅ ${inputName} filled successfully: "${finalValue}" (expected: ${expectedNum}, got: ${finalNum}, diff: ${Math.abs(finalNum - expectedNum).toFixed(4)})`);
      return true;
    } else {
      console.log(`[${exchange.name}] ⚠️  ${inputName} value mismatch. Expected: ${valueStr} (${expectedNum}), Got: "${finalValue}" (${finalNum}), diff: ${Math.abs(finalNum - expectedNum).toFixed(4)}, tolerance: ${tolerance}`);
      return false;
    }
  };
  
  // Step 1: Enter price (for limit orders) - CLEAR AND FILL
  if (orderType === "limit" && priceInput) {
    console.log(`[${exchange.name}] Step 1: Clearing and entering price (${price})...`);
    const priceSuccess = await clearAndFillInputGrvt(priceInput, price, 'Price');
    if (!priceSuccess) {
      console.log(`[${exchange.name}] ⚠️  Price fill verification failed, retrying...`);
      // Retry once
      await delay(500);
      const retrySuccess = await clearAndFillInputGrvt(priceInput, price, 'Price');
      if (!retrySuccess) {
        console.log(`[${exchange.name}] ❌ Price fill failed after retry`);
        return { success: false, error: "Failed to fill price input after retry" };
      }
    }
    
    // Final verification that price persists
    // Note: Price input may round to 1 decimal place, so use lenient tolerance (0.1)
    await delay(500);
    const priceFinalCheck = await page.evaluate((el) => el.value || '', priceInput);
    const priceFinalNum = parseFloat(priceFinalCheck.replace(/,/g, ''));
    const expectedPriceNum = parseFloat(String(price));
    const priceTolerance = 0.1; // Allow up to 0.1 difference for price rounding
    if (!priceFinalCheck || Math.abs(priceFinalNum - expectedPriceNum) >= priceTolerance) {
      console.log(`[${exchange.name}] ❌ Price not persisting. Expected: ${price} (${expectedPriceNum}), Got: "${priceFinalCheck}" (${priceFinalNum}), diff: ${Math.abs(priceFinalNum - expectedPriceNum).toFixed(4)}`);
      return { success: false, error: `Price input not persisting. Expected: ${price}, Got: "${priceFinalCheck}"` };
    }
    console.log(`[${exchange.name}] ✅ Price verified and persisting: "${priceFinalCheck}" (expected: ${expectedPriceNum}, got: ${priceFinalNum}, diff: ${Math.abs(priceFinalNum - expectedPriceNum).toFixed(4)})`);
    await delay(300);
  } else if (orderType === "limit" && !priceInput) {
    console.log(`[${exchange.name}] ⚠️  Price input not found for limit order`);
    return { success: false, error: "Price input not found for limit order" };
  }

  // Step 2: Enter quantity/size (using fixed 0.002 for GRVT) - CLEAR AND FILL
  console.log(`[${exchange.name}] Step 2: Clearing and entering quantity (${grvtSize} BTC)...`);
  const sizeSuccess = await clearAndFillInputGrvt(sizeInput, grvtSize, 'Quantity');
  
  if (!sizeSuccess) {
    console.log(`[${exchange.name}] ⚠️  Quantity fill verification failed, retrying...`);
    // Retry once
    await delay(500);
    const retrySuccess = await clearAndFillInputGrvt(sizeInput, grvtSize, 'Quantity');
    if (!retrySuccess) {
      console.log(`[${exchange.name}] ❌ Quantity fill failed after retry`);
      return { success: false, error: "Failed to fill quantity input after retry" };
    }
  }

  // Final verification that quantity persists
  await delay(500);
  const sizeFinalCheck = await page.evaluate((el) => el.value || '', sizeInput);
  const sizeFinalNum = parseFloat(sizeFinalCheck.replace(/,/g, ''));
  const expectedSizeNumFinal = parseFloat(String(grvtSize));
  if (!sizeFinalCheck || Math.abs(sizeFinalNum - expectedSizeNumFinal) >= 0.0001) {
    console.log(`[${exchange.name}] ❌ Quantity not persisting. Expected: ${grvtSize}, Got: "${sizeFinalCheck}"`);
    return { success: false, error: `Quantity input not persisting. Expected: ${grvtSize}, Got: "${sizeFinalCheck}"` };
  }
  console.log(`[${exchange.name}] ✅ Quantity verified and persisting: "${sizeFinalCheck}"`);
  await delay(500); // Increased delay to ensure quantity is set

  // Step 3: Handle TP/SL for GRVT (only for limit orders with price)
  // This will: 1) Click TP/SL checkbox, 2) Enter TP/SL values
  if (orderType === "limit" && price) {
    console.log(`[${exchange.name}] Step 3: Handling TP/SL (clicking checkbox and entering values)...`);
    const tpSlResult = await handleTpSlGrvt(page, exchange, price, side);
    if (!tpSlResult.success) {
      console.log(`[${exchange.name}] ⚠️  TP/SL handling failed: ${tpSlResult.error || 'unknown error'}, continuing anyway...`);
    }
    await delay(500); // Wait for TP/SL inputs to be processed
    
    // IMPORTANT: After TP/SL handling, check if inputs were cleared - only refill if actually cleared
    // Note: Price input rounds to 1 decimal place, so use lenient tolerance (0.1)
    console.log(`[${exchange.name}] Step 3.5: Checking if price and quantity are still filled after TP/SL...`);
    
    // Check price (only refill if actually cleared, not just rounded)
    if (orderType === "limit" && priceInput) {
      const priceAfterTpSl = await page.evaluate((el) => el.value || '', priceInput);
      const priceAfterTpSlNum = parseFloat(priceAfterTpSl.replace(/,/g, ''));
      const expectedPriceNum = parseFloat(String(price));
      const priceTolerance = 0.1; // Allow up to 0.1 difference for price rounding
      
      if (!priceAfterTpSl || priceAfterTpSl.trim() === '' || Math.abs(priceAfterTpSlNum - expectedPriceNum) >= priceTolerance) {
        console.log(`[${exchange.name}] Price was cleared or significantly changed after TP/SL (expected: ${expectedPriceNum}, got: ${priceAfterTpSlNum}), refilling...`);
        await clearAndFillInputGrvt(priceInput, price, 'Price');
        await delay(300);
      } else {
        console.log(`[${exchange.name}] ✅ Price still filled after TP/SL: "${priceAfterTpSl}" (expected: ${expectedPriceNum}, got: ${priceAfterTpSlNum}, diff: ${Math.abs(priceAfterTpSlNum - expectedPriceNum).toFixed(4)})`);
      }
    }
    
    // Check quantity (only refill if actually cleared)
    const sizeAfterTpSl = await page.evaluate((el) => el.value || '', sizeInput);
    const sizeAfterTpSlNum = parseFloat(sizeAfterTpSl.replace(/,/g, ''));
    const expectedSizeNum = parseFloat(String(grvtSize));
    const sizeTolerance = 0.0001; // Stricter tolerance for quantity
    
    if (!sizeAfterTpSl || sizeAfterTpSl.trim() === '' || Math.abs(sizeAfterTpSlNum - expectedSizeNum) >= sizeTolerance) {
      console.log(`[${exchange.name}] Quantity was cleared or changed after TP/SL (expected: ${expectedSizeNum}, got: ${sizeAfterTpSlNum}), refilling...`);
      await clearAndFillInputGrvt(sizeInput, grvtSize, 'Quantity');
      await delay(300);
    } else {
      console.log(`[${exchange.name}] ✅ Quantity still filled after TP/SL: "${sizeAfterTpSl}" (expected: ${expectedSizeNum}, got: ${sizeAfterTpSlNum})`);
    }
  } else {
    console.log(`[${exchange.name}] Skipping TP/SL - only available for limit orders with price`);
  }

  // Step 4: Verify inputs are still filled before clicking Buy/Sell
  console.log(`[${exchange.name}] Step 4: Verifying inputs are filled before clicking ${side.toUpperCase()} button...`);
  
  // Verify price is still filled (for limit orders)
  // Note: Price input may round to 1 decimal place, so use lenient tolerance (0.1)
  if (orderType === "limit" && priceInput) {
    const priceCheck = await page.evaluate((el) => el.value || '', priceInput);
    const priceCheckNum = parseFloat(priceCheck.replace(/,/g, ''));
    const expectedPriceNum = parseFloat(String(price));
    const priceTolerance = 0.1; // Allow up to 0.1 difference for price rounding
    if (!priceCheck || Math.abs(priceCheckNum - expectedPriceNum) >= priceTolerance) {
      console.log(`[${exchange.name}] ❌ Price lost before Buy/Sell click. Expected: ${price} (${expectedPriceNum}), Got: "${priceCheck}" (${priceCheckNum}), diff: ${Math.abs(priceCheckNum - expectedPriceNum).toFixed(4)}`);
      // Try to refill
      console.log(`[${exchange.name}] Attempting to refill price...`);
      await clearAndFillInputGrvt(priceInput, price, 'Price');
      await delay(500);
    } else {
      console.log(`[${exchange.name}] ✅ Price verified before Buy/Sell: "${priceCheck}" (expected: ${expectedPriceNum}, got: ${priceCheckNum}, diff: ${Math.abs(priceCheckNum - expectedPriceNum).toFixed(4)})`);
    }
  }
  
  // Verify quantity is still filled
  const sizeCheck = await page.evaluate((el) => el.value || '', sizeInput);
  const sizeCheckNum = parseFloat(sizeCheck.replace(/,/g, ''));
  const expectedSizeNumCheck = parseFloat(String(grvtSize));
  if (!sizeCheck || Math.abs(sizeCheckNum - expectedSizeNumCheck) >= 0.0001) {
    console.log(`[${exchange.name}] ❌ Quantity lost before Buy/Sell click. Expected: ${grvtSize}, Got: "${sizeCheck}"`);
    // Try to refill
    console.log(`[${exchange.name}] Attempting to refill quantity...`);
    await clearAndFillInputGrvt(sizeInput, grvtSize, 'Quantity');
    await delay(500);
  } else {
    console.log(`[${exchange.name}] ✅ Quantity verified before Buy/Sell: "${sizeCheck}"`);
  }
  
  // Step 4.5: Handle order type dropdown (BTC vs USDT) if it exists
  // The error "BTCOrder by Number of CoinsOrder by Number of Notional in USDT" suggests a dropdown selection
  console.log(`[${exchange.name}] Step 4.5: Checking for order type dropdown (BTC vs USDT)...`);
  const orderTypeDropdown = await page.evaluate(() => {
    // Look for elements containing "Order by" or "Number of Coins" or "Notional"
    const allElements = Array.from(document.querySelectorAll('*'));
    for (const el of allElements) {
      const text = (el.textContent || '').trim();
      if ((text.includes('Order by') || text.includes('Number of Coins') || text.includes('Notional')) && 
          el.offsetParent !== null) {
        // Check if it's a dropdown/select
        if (el.tagName === 'SELECT' || el.getAttribute('role') === 'combobox' || 
            el.classList.toString().toLowerCase().includes('select') ||
            el.classList.toString().toLowerCase().includes('dropdown')) {
          return { element: el, text: text };
        }
        // Check if clicking it opens a dropdown
        const parent = el.parentElement;
        if (parent && (parent.tagName === 'BUTTON' || parent.getAttribute('role') === 'button' ||
            parent.classList.toString().toLowerCase().includes('select') ||
            parent.classList.toString().toLowerCase().includes('dropdown'))) {
          return { element: parent, text: text };
        }
      }
    }
    return null;
  });
  
  if (orderTypeDropdown) {
    console.log(`[${exchange.name}] Found order type dropdown: "${orderTypeDropdown.text}"`);
    // Try to select "Order by Number of Coins" (BTC) - this is what we want for BTC quantity
    const coinsOption = await findByText(page, "Number of Coins", ["button", "div", "span", "option"]);
    if (coinsOption) {
      console.log(`[${exchange.name}] Selecting "Number of Coins" option...`);
      await coinsOption.click();
      await delay(500);
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find "Number of Coins" option, trying to click dropdown...`);
      // Try clicking the dropdown to open it
      const dropdownHandle = await page.evaluateHandle((text) => {
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
          const elText = (el.textContent || '').trim();
          if (elText.includes('Order by') || elText.includes('Number of Coins') || elText.includes('Notional')) {
            if (el.offsetParent !== null) {
              return el;
            }
          }
        }
        return null;
      }, orderTypeDropdown.text);
      
      const dropdownElement = dropdownHandle.asElement();
      if (dropdownElement) {
        await dropdownElement.click();
        await delay(500);
        // Try to find and click "Number of Coins" after opening
        const coinsOptionAfterOpen = await findByText(page, "Number of Coins", ["button", "div", "span", "option"]);
        if (coinsOptionAfterOpen) {
          await coinsOptionAfterOpen.click();
          await delay(500);
        }
      }
    }
  } else {
    console.log(`[${exchange.name}] No order type dropdown found, continuing...`);
  }
  
  // Check for any other modals/dropdowns that might be blocking
  console.log(`[${exchange.name}] Checking for other modals or dropdowns that might need to be closed...`);
  const hasModal = await page.evaluate(() => {
    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
    for (const modal of modals) {
      const style = window.getComputedStyle(modal);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        return true;
      }
    }
    return false;
  });
  
  if (hasModal) {
    console.log(`[${exchange.name}] ⚠️  Modal detected, trying to close it...`);
    await page.keyboard.press('Escape');
    await delay(500);
  }
  
  // Step 5: Click Buy/Sell button - FOR GRVT, THIS IS THE FINAL CONFIRM BUTTON
  // GRVT: "Buy / Long" or "Sell / Short" button IS the confirm button (no separate confirm step)
  console.log(`[${exchange.name}] Step 5: Clicking ${side.toUpperCase()} button (this IS the confirm button for GRVT)...`);
  console.log(`[${exchange.name}]    Looking for: "${side === 'buy' ? exchange.selectors.buyButton : exchange.selectors.sellButton}"`);
  
  // Find the Buy/Sell button element directly (for GRVT, this is the final confirm)
  const buttonText = side === "buy" ? exchange.selectors.buyButton : exchange.selectors.sellButton;
  let buySellBtn = await findByExactText(page, buttonText, ["button", "div", "span"]);
  
  // If exact match fails, try partial match
  if (!buySellBtn) {
    buySellBtn = await findByText(page, buttonText, ["button", "div", "span"]);
  }
  
  // Fallback: Try matching just "Buy"/"Long" or "Sell"/"Short"
  if (!buySellBtn) {
    if (side === "buy") {
      buySellBtn = await findByText(page, "Buy", ["button", "div", "span"]);
      if (!buySellBtn) {
        buySellBtn = await findByText(page, "Long", ["button", "div", "span"]);
      }
    } else {
      buySellBtn = await findByText(page, "Sell", ["button", "div", "span"]);
      if (!buySellBtn) {
        buySellBtn = await findByText(page, "Short", ["button", "div", "span"]);
      }
    }
  }
  
  if (!buySellBtn) {
    console.log(`[${exchange.name}] ❌ Could not find ${side.toUpperCase()} button`);
    
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
        .slice(0, 20);
    });
    
    console.log(`[${exchange.name}]    Available buttons (first 20):`, JSON.stringify(availableButtons, null, 2));
    
    return { success: false, error: `${side.toUpperCase()} button not found. Looking for: "${buttonText}"` };
  }
  
  // For GRVT, the Buy/Sell button click opens a modal - use clickConfirmButton for proper scrolling/visibility
  console.log(`[${exchange.name}] ✅ Found ${side.toUpperCase()} button, clicking (this will open a confirmation modal for GRVT)...`);
  await clickConfirmButton(page, buySellBtn, buttonText, exchange, side);
  
  // Step 6: Wait for modal to open and click Confirm button in the modal
  console.log(`[${exchange.name}] Waiting 500ms for confirmation modal to open...`);
  await delay(500);
  
  // Check if a modal opened and find the Confirm button
  console.log(`[${exchange.name}] Looking for Confirm button in the modal...`);
  let confirmModalBtn = null;
  
  // Try to find Confirm button in modal
  confirmModalBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);
  
  // If exact match fails, try partial match
  if (!confirmModalBtn) {
    confirmModalBtn = await findByText(page, "Confirm", ["button", "div", "span"]);
  }
  
  if (confirmModalBtn) {
    // Verify the button is in a modal (check if it's visible and likely in a modal)
    const isInModal = await page.evaluate((btn) => {
      // Check if button is in a modal/dialog
      let parent = btn.parentElement;
      for (let i = 0; i < 10 && parent; i++) {
        const role = parent.getAttribute('role');
        const className = parent.className || '';
        if (role === 'dialog' || 
            className.toLowerCase().includes('modal') || 
            className.toLowerCase().includes('dialog')) {
          return true;
        }
        parent = parent.parentElement;
      }
      return false;
    }, confirmModalBtn);
    
    if (isInModal) {
      console.log(`[${exchange.name}] ✅ Found Confirm button in modal, clicking...`);
      try {
        await confirmModalBtn.click();
        console.log(`[${exchange.name}] ✅ Clicked Confirm button in modal`);
        await delay(1000); // Wait for order to be processed
      } catch (error) {
        console.log(`[${exchange.name}] ⚠️  Direct click failed, trying JavaScript click: ${error.message}`);
        await confirmModalBtn.evaluate((el) => el.click());
        console.log(`[${exchange.name}] ✅ Clicked Confirm button via JavaScript`);
        await delay(1000);
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Found Confirm button but it's not in a modal, may have already been processed`);
      await delay(1000);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find Confirm button in modal, order may have been processed without confirmation`);
    await delay(1000);
  }

  // Verify order placement
  return await verifyOrderPlacement(page, exchange, side, qty);
}
