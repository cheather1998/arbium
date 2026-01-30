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
  console.log(`[${exchange.name}] Looking for "TP/SL" checkbox...`);
  
  let checkboxElement = null;
  let isChecked = false;
  
  // Method 1: Find via labels
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
      await checkboxElement.click();
      console.log(`[${exchange.name}] ✅ TP/SL checkbox clicked successfully`);
      await delay(1000);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find TP/SL checkbox, continuing anyway.`);
  }
  
  let lastFilledInput = null;
  
  // Step 2: Find and fill TP trigger price input
  if (calculatedTakeProfit) {
    console.log(`[${exchange.name}] Looking for TP trigger price input...`);
    
    let tpInputElement = await page.evaluateHandle(() => {
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
    
    if (tpInputElement && tpInputElement.asElement()) {
      tpInputElement = tpInputElement.asElement();
    } else {
      tpInputElement = null;
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
      const intValue = Math.ceil(valueNum).toString();
      console.log(`[${exchange.name}] ✅ Found TP trigger price input, filling calculated value: ${intValue} (original: ${valueNum.toFixed(2)})`);
      
      await tpInputElement.focus();
      await delay(200);
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
      }, tpInputElement, intValue);
      await delay(500);
      
      const actualValue = await page.evaluate((el) => el.value || '', tpInputElement);
      const actualValueNum = parseFloat(actualValue.replace(/,/g, '').replace(/ /g, ''));
      const expectedValueNum = parseInt(intValue, 10);
      
      if (actualValue && actualValue.trim() !== '' && !isNaN(actualValueNum) && actualValueNum === expectedValueNum) {
        console.log(`[${exchange.name}] ✅ TP trigger price filled successfully. Expected: ${intValue}, Actual: ${actualValue}`);
      } else {
        console.log(`[${exchange.name}] ⚠️  TP trigger price value mismatch, retrying...`);
        await tpInputElement.focus();
        await delay(200);
        await page.evaluate((el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }, tpInputElement);
        await delay(100);
        await tpInputElement.type(intValue, { delay: 30 });
        await delay(500);
        await page.evaluate((el) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, tpInputElement);
        await delay(300);
      }
      lastFilledInput = tpInputElement;
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find TP trigger price input`);
    }
  }
  
  // Step 3: Find and fill SL trigger price input
  if (calculatedStopLoss) {
    console.log(`[${exchange.name}] Looking for SL trigger price input...`);
    
    let slInputElement = await page.evaluateHandle(() => {
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
    
    if (slInputElement && slInputElement.asElement()) {
      slInputElement = slInputElement.asElement();
    } else {
      slInputElement = null;
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
      const intValue = Math.floor(valueNum).toString();
      console.log(`[${exchange.name}] ✅ Found SL trigger price input, filling calculated value: ${intValue} (original: ${valueNum.toFixed(2)})`);
      
      await slInputElement.focus();
      await delay(200);
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
      }, slInputElement, intValue);
      await delay(500);
      
      const actualValue = await page.evaluate((el) => el.value || '', slInputElement);
      const actualValueNum = parseFloat(actualValue.replace(/,/g, '').replace(/ /g, ''));
      const expectedValueNum = parseInt(intValue, 10);
      
      if (actualValue && actualValue.trim() !== '' && !isNaN(actualValueNum) && actualValueNum === expectedValueNum) {
        console.log(`[${exchange.name}] ✅ SL trigger price filled successfully. Expected: ${intValue}, Actual: ${actualValue}`);
      } else {
        console.log(`[${exchange.name}] ⚠️  SL trigger price value mismatch, retrying...`);
        await slInputElement.focus();
        await delay(200);
        await page.evaluate((el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }, slInputElement);
        await delay(100);
        await slInputElement.type(intValue, { delay: 30 });
        await delay(500);
        await page.evaluate((el) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, slInputElement);
        await delay(300);
      }
      lastFilledInput = slInputElement;
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find SL trigger price input`);
    }
  }
  
  console.log(`[${exchange.name}] ✅ TP/SL handling completed`);
  
  if (lastFilledInput) {
    console.log(`[${exchange.name}] Waiting 1 second after TP/SL inputs are filled...`);
    await delay(1000);
    console.log(`[${exchange.name}] Focusing last filled input and pressing Enter...`);
    await lastFilledInput.focus();
    await page.keyboard.press('Enter');
    await delay(500);
  }
  
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

  // 2. Find inputs - GRVT has "Price" and "Quantity" inputs
  // Based on logs: Quantity has parent "BTC", Price is nearby (might have parent "1" or be positioned near Quantity)
  console.log(`[${exchange.name}] Looking for Price and Quantity inputs...`);
  
  const inputs = await findSizeAndPriceInputs(page, orderType);
  let sizeInput = inputs.sizeInput;
  let priceInput = inputs.priceInput;
  
  // GRVT-specific search: Look for inputs with "BTC" (Quantity) and nearby input (Price)
  if (!sizeInput || (orderType === "limit" && !priceInput)) {
    console.log(`[${exchange.name}] Standard search incomplete, trying GRVT-specific search...`);
    const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
    const screenWidth = await page.evaluate(() => window.innerWidth);
    const rightSideThreshold = screenWidth * 0.4;
    
    for (const input of allInputs) {
      const rect = await input.boundingBox();
      if (!rect || rect.x < rightSideThreshold) continue;
      
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
  
  if (!sizeInput) {
    console.log(`[${exchange.name}] ❌ Quantity input not found`);
    return { success: false, error: "Quantity input not found" };
  }
  
  if (orderType === "limit" && !priceInput) {
    console.log(`[${exchange.name}] ❌ Price input not found for limit order`);
    return { success: false, error: "Price input not found for limit order" };
  }
  
  console.log(`[${exchange.name}] ✅ Found all required inputs`);

  // 3. Fill inputs in order: Price -> Quantity -> TP/SL
  // Step 1: Enter price (for limit orders)
  if (orderType === "limit" && priceInput) {
    console.log(`[${exchange.name}] Step 1: Entering price (${price})...`);
    await enterPrice(page, priceInput, price, orderType);
    await delay(200);
  }

  // Step 2: Enter quantity/size (using fixed 0.002 for GRVT)
  console.log(`[${exchange.name}] Step 2: Entering quantity (${grvtSize} BTC)...`);
  const sizeResult = await enterSize(page, sizeInput, grvtSize, exchange);
  
  if (!sizeResult.success) {
    console.log(`[${exchange.name}] ❌ Failed to enter quantity: ${sizeResult.error || 'unknown error'}`);
    return sizeResult;
  }

  console.log(`[${exchange.name}] ✅ Quantity entered successfully`);
  await delay(300);

  // Step 3: Handle TP/SL for GRVT (only for limit orders with price)
  if (orderType === "limit" && price) {
    console.log(`[${exchange.name}] Step 3: Handling TP/SL...`);
    await handleTpSlGrvt(page, exchange, price, side);
    await delay(500);
  }

  // Step 4: Click Buy/Sell button to set the side (inputs are already filled)
  console.log(`[${exchange.name}] Step 4: Clicking ${side.toUpperCase()} button...`);
  await selectBuyOrSell(page, side, exchange);
  await delay(300);

  // 5. Find and click Confirm button
  const { confirmBtn, confirmText } = await findConfirmButtonGrvt(page, side, exchange);

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
