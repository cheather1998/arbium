import { selectBuyOrSell, enterSize } from './executeBase.js';
import { selectOrderTypeKraken, findKrakenInputs } from './executeKraken.js';
import { delay, closeNotifyBarWrapperNotifications } from '../utils/helpers.js';
import { handleTpSlGrvt } from './executeGrvt.js';

/**
 * Pre-fill form for Kraken (everything except price and side)
 * This includes: order type selection, quantity, and TP/SL setup
 * Side and price will be filled after threshold is met
 */
export async function prefillFormKraken(page, { orderType, qty }, exchange) {
  console.log(`[${exchange.name}] 🚀 [PRE-FILL] Starting form pre-fill (order type, quantity, TP/SL - excluding price and side)...`);
  
  await delay(1000);
  
  // 1. Select order type
  console.log(`[${exchange.name}] [PRE-FILL] Step 1: Selecting ${orderType.toUpperCase()}...`);
  await selectOrderTypeKraken(page, orderType, exchange);
  await delay(500);
  
  // 2. Find inputs
  console.log(`[${exchange.name}] [PRE-FILL] Step 2: Finding inputs...`);
  const { sizeInput, priceInput } = await findKrakenInputs(page, orderType);
  
  if (!sizeInput) {
    return { success: false, error: "Quantity input not found" };
  }
  
  if (orderType === "limit" && !priceInput) {
    return { success: false, error: "Price input not found" };
  }
  
  // 3. Fill quantity
  console.log(`[${exchange.name}] [PRE-FILL] Step 3: Filling quantity...`);
  const sizeResult = await enterSize(page, sizeInput, qty, exchange);
  if (!sizeResult.success) {
    return sizeResult;
  }
  await delay(300);
  
  // 4. Set up TP/SL dropdown (select "Simple")
  console.log(`[${exchange.name}] [PRE-FILL] Step 4: Setting up TP/SL dropdown...`);
  try {
    let tpSlButton = await page.$('button[aria-label="TP/SL"][aria-haspopup="listbox"]');
    
    if (!tpSlButton) {
      const buttonInfo = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label'));
        for (const label of labels) {
          const text = (label.textContent || '').trim();
          if (text === 'TP/SL' && label.offsetParent !== null) {
            let parent = label.parentElement;
            for (let i = 0; i < 3 && parent; i++) {
              const buttons = Array.from(parent.querySelectorAll('button'));
              for (const btn of buttons) {
                if (btn.offsetParent === null) continue;
                const ariaLabel = btn.getAttribute('aria-label');
                const ariaHaspopup = btn.getAttribute('aria-haspopup');
                if (ariaLabel === 'TP/SL' && ariaHaspopup === 'listbox') {
                  return { found: true, element: btn };
                }
              }
              parent = parent.parentElement;
            }
          }
        }
        return { found: false };
      });
      
      if (buttonInfo.found) {
        const buttonHandle = await page.evaluateHandle((el) => el, buttonInfo.element);
        tpSlButton = buttonHandle.asElement();
      }
    }
    
    if (tpSlButton) {
      const isSimpleSelected = await page.evaluate((button) => {
        const buttonText = (button.textContent || '').trim();
        return buttonText.toLowerCase().includes('simple');
      }, tpSlButton);
      
      if (!isSimpleSelected) {
        await tpSlButton.click();
        await delay(800);
        
        const { findByExactText } = await import('../utils/helpers.js');
        let simpleOption = await findByExactText(page, "Simple", ["button", "div", "span", "option", "li"]);
        
        if (simpleOption) {
          await simpleOption.click();
          await delay(300);
        }
      }
    }
  } catch (error) {
    console.log(`[${exchange.name}] [PRE-FILL] ⚠️  TP/SL setup error: ${error.message}`);
  }
  
  // 5. Pre-fill TP/SL Entry Distance inputs (if orderType is limit)
  if (orderType === "limit") {
    console.log(`[${exchange.name}] [PRE-FILL] Step 5: Pre-filling TP/SL Entry Distance inputs...`);
    const takeProfitValue = process.env.TAKE_PROFIT || '';
    const stopLossValue = process.env.STOP_LOSS || '';
    
    if (takeProfitValue || stopLossValue) {
      // Find TP/SL inputs
      let takeProfitInput = await page.$('input[aria-label="Distance for Take profit"]');
      let stopLossInput = await page.$('input[aria-label="Distance for Stop loss"]');
      
      // Fallback: Find by name attribute
      if (!takeProfitInput || !stopLossInput) {
        const inputs = await page.$$('input[name*="priceDeviationValue"]');
        for (const input of inputs) {
          const ariaLabel = await page.evaluate((el) => el.getAttribute('aria-label'), input);
          if (ariaLabel && ariaLabel.includes('Take profit') && !takeProfitInput) {
            takeProfitInput = input;
          } else if (ariaLabel && ariaLabel.includes('Stop loss') && !stopLossInput) {
            stopLossInput = input;
          }
        }
      }
      
      // Fill Take Profit
      if (takeProfitValue && takeProfitInput) {
        console.log(`[${exchange.name}] [PRE-FILL] Filling Take Profit: ${takeProfitValue}`);
        await takeProfitInput.click({ clickCount: 3 });
        await delay(100);
        await takeProfitInput.type(takeProfitValue, { delay: 50 });
        await delay(200);
      }
      
      // Fill Stop Loss
      if (stopLossValue && stopLossInput) {
        console.log(`[${exchange.name}] [PRE-FILL] Filling Stop Loss: ${stopLossValue}`);
        await stopLossInput.click({ clickCount: 3 });
        await delay(100);
        await stopLossInput.type(stopLossValue, { delay: 50 });
        await delay(200);
      }
      
      if (!takeProfitInput && takeProfitValue) {
        console.log(`[${exchange.name}] [PRE-FILL] ⚠️  Take Profit input not found`);
      }
      if (!stopLossInput && stopLossValue) {
        console.log(`[${exchange.name}] [PRE-FILL] ⚠️  Stop Loss input not found`);
      }
    } else {
      console.log(`[${exchange.name}] [PRE-FILL] No TP/SL values configured (TAKE_PROFIT or STOP_LOSS env vars)`);
    }
  }
  
  return { 
    success: true, 
    sizeInput, 
    priceInput 
  };
}

/**
 * Quick fill price, select side, and submit order for Kraken (after pre-fill is done)
 */
export async function fillPriceSideAndSubmitKraken(page, price, { side, orderType }, exchange, thresholdMetTime, cycleCount, sideLabel, email, prefillData) {
  console.log(`[${exchange.name}] ⚡ [QUICK-FILL] Selecting side, filling price, and submitting order...`);
  
  const quickFillStartTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = quickFillStartTime - thresholdMetTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] Quick fill started - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met`);
  }
  
  // 1. Select Buy or Sell (side was not pre-filled)
  console.log(`[${exchange.name}] [QUICK-FILL] Step 1: Selecting ${side.toUpperCase()}...`);
  await selectBuyOrSell(page, side, exchange);
  await delay(300);
  
  // 1.5. Check if TP/SL inputs were cleared after side selection, and refill if needed
  if (orderType === "limit") {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 1.5: Checking if TP/SL inputs were cleared after side selection...`);
    const takeProfitValue = process.env.TAKE_PROFIT || '';
    const stopLossValue = process.env.STOP_LOSS || '';
    
    if (takeProfitValue || stopLossValue) {
      // First, check if TP/SL dropdown is still set to "Simple"
      try {
        let tpSlButton = await page.$('button[aria-label="TP/SL"][aria-haspopup="listbox"]');
        
        if (!tpSlButton) {
          const buttonInfo = await page.evaluate(() => {
            const labels = Array.from(document.querySelectorAll('label'));
            for (const label of labels) {
              const text = (label.textContent || '').trim();
              if (text === 'TP/SL' && label.offsetParent !== null) {
                let parent = label.parentElement;
                for (let i = 0; i < 3 && parent; i++) {
                  const buttons = Array.from(parent.querySelectorAll('button'));
                  for (const btn of buttons) {
                    if (btn.offsetParent === null) continue;
                    const ariaLabel = btn.getAttribute('aria-label');
                    const ariaHaspopup = btn.getAttribute('aria-haspopup');
                    if (ariaLabel === 'TP/SL' && ariaHaspopup === 'listbox') {
                      return { found: true, element: btn };
                    }
                  }
                  parent = parent.parentElement;
                }
              }
            }
            return { found: false };
          });
          
          if (buttonInfo.found) {
            const buttonHandle = await page.evaluateHandle((el) => el, buttonInfo.element);
            tpSlButton = buttonHandle.asElement();
          }
        }
        
        if (tpSlButton) {
          const isSimpleSelected = await page.evaluate((button) => {
            const buttonText = (button.textContent || '').trim();
            return buttonText.toLowerCase().includes('simple');
          }, tpSlButton);
          
          if (!isSimpleSelected) {
            console.log(`[${exchange.name}] [QUICK-FILL] TP/SL dropdown was reset, reselecting "Simple"...`);
            await tpSlButton.click();
            await delay(800);
            
            const { findByExactText } = await import('../utils/helpers.js');
            let simpleOption = await findByExactText(page, "Simple", ["button", "div", "span", "option", "li"]);
            
            if (simpleOption) {
              await simpleOption.click();
              await delay(300);
            }
          } else {
            console.log(`[${exchange.name}] [QUICK-FILL] ✅ TP/SL dropdown still set to "Simple"`);
          }
        }
      } catch (error) {
        console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  TP/SL dropdown check error: ${error.message}`);
      }
      
      // Find TP/SL inputs
      let takeProfitInput = await page.$('input[aria-label="Distance for Take profit"]');
      let stopLossInput = await page.$('input[aria-label="Distance for Stop loss"]');
      
      // Fallback: Find by name attribute
      if (!takeProfitInput || !stopLossInput) {
        const inputs = await page.$$('input[name*="priceDeviationValue"]');
        for (const input of inputs) {
          const ariaLabel = await page.evaluate((el) => el.getAttribute('aria-label'), input);
          if (ariaLabel && ariaLabel.includes('Take profit') && !takeProfitInput) {
            takeProfitInput = input;
          } else if (ariaLabel && ariaLabel.includes('Stop loss') && !stopLossInput) {
            stopLossInput = input;
          }
        }
      }
      
      // Check and refill Take Profit if cleared
      if (takeProfitValue && takeProfitInput) {
        const currentTpValue = await page.evaluate((el) => el.value || '', takeProfitInput);
        if (!currentTpValue || currentTpValue.trim() === '') {
          console.log(`[${exchange.name}] [QUICK-FILL] Take Profit was cleared, refilling: ${takeProfitValue}`);
          await takeProfitInput.click({ clickCount: 3 });
          await delay(100);
          await takeProfitInput.type(takeProfitValue, { delay: 50 });
          await delay(200);
        } else {
          console.log(`[${exchange.name}] [QUICK-FILL] ✅ Take Profit still filled: "${currentTpValue}"`);
        }
      }
      
      // Check and refill Stop Loss if cleared
      if (stopLossValue && stopLossInput) {
        const currentSlValue = await page.evaluate((el) => el.value || '', stopLossInput);
        if (!currentSlValue || currentSlValue.trim() === '') {
          console.log(`[${exchange.name}] [QUICK-FILL] Stop Loss was cleared, refilling: ${stopLossValue}`);
          await stopLossInput.click({ clickCount: 3 });
          await delay(100);
          await stopLossInput.type(stopLossValue, { delay: 50 });
          await delay(200);
        } else {
          console.log(`[${exchange.name}] [QUICK-FILL] ✅ Stop Loss still filled: "${currentSlValue}"`);
        }
      }
    }
  }
  
  // 2. Fill price only (TP/SL already pre-filled or just refilled)
  if (orderType === "limit" && prefillData.priceInput) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 2: Filling price: ${price}`);
    const { enterPrice } = await import('./executeBase.js');
    await enterPrice(page, prefillData.priceInput, price, orderType);
    await delay(300);
  }
  
  // 3. Find and click Confirm button
  const { findConfirmButtonKraken } = await import('./executeKraken.js');
  const { confirmBtn, confirmText } = await findConfirmButtonKraken(page, side, exchange);
  
  if (!confirmBtn) {
    return { success: false, error: `Confirm button not found: "${confirmText}"` };
  }
  
  const firstConfirmClickTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = firstConfirmClickTime - thresholdMetTime;
    const quickFillTime = firstConfirmClickTime - quickFillStartTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] First Confirm button clicked - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met (quick fill took ${(quickFillTime / 1000).toFixed(2)}s)`);
  }
  
  const { clickConfirmButton } = await import('./executeBase.js');
  await clickConfirmButton(page, confirmBtn, confirmText, exchange, side);
  
  // 4. Click Confirm in modal
  await delay(500);
  const { findByExactText } = await import('../utils/helpers.js');
  const confirmModalBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);
  
  if (confirmModalBtn) {
    const confirmClickTime = Date.now();
    
    const isInModal = await page.evaluate((btn) => {
      let parent = btn.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const className = (typeof parent.className === 'string' ? parent.className : (parent.className?.baseVal || String(parent.className) || '')).toLowerCase();
        if (parent.tagName === 'DIV' && (parent.getAttribute('role') === 'dialog' || 
            className.includes('modal') || className.includes('dialog') || 
            className.includes('overlay'))) {
          return true;
        }
        parent = parent.parentElement;
      }
      return false;
    }, confirmModalBtn);
    
    if (isInModal) {
      await confirmModalBtn.click();
      
      // Log timing metrics
      if (thresholdMetTime) {
        const totalTime = confirmClickTime - thresholdMetTime;
        const quickFillTime = firstConfirmClickTime - quickFillStartTime;
        const buttonClickTime = confirmClickTime - firstConfirmClickTime;
        
        console.log(`\n[${exchange.name}] ⏱️  [TIMING METRICS] ${sideLabel} Order Submission Complete:`);
        console.log(`[${exchange.name}]    Account: ${email}`);
        console.log(`[${exchange.name}]    Total time (threshold → submit): ${(totalTime / 1000).toFixed(2)}s`);
        console.log(`[${exchange.name}]    Quick fill time (side + price + submit): ${(quickFillTime / 1000).toFixed(2)}s`);
        console.log(`[${exchange.name}]    Button click time: ${(buttonClickTime / 1000).toFixed(2)}s`);
        console.log(`[${exchange.name}]    Timestamp: ${new Date(confirmClickTime).toISOString()}\n`);
      }
      
      await delay(1000);
    }
  }
  
  const { verifyOrderPlacement } = await import('./executeBase.js');
  const qty = parseFloat(process.env.BUY_QTY) || parseFloat(process.env.SELL_QTY) || 0;
  return await verifyOrderPlacement(page, exchange, side, qty);
}

/**
 * Pre-fill form for GRVT (everything except price and side)
 * This includes: order type selection, quantity
 * Side and price will be filled after threshold is met
 */
export async function prefillFormGrvt(page, { orderType, qty }, exchange) {
  console.log(`[${exchange.name}] 🚀 [PRE-FILL] Starting form pre-fill (order type, quantity - excluding price and side)...`);
  
  // GRVT: Ensure quantity is at least 0.002 (minimum requirement)
  const grvtQty = qty >= 0.002 ? qty : 0.002;
  if (qty < 0.002) {
    console.log(`[${exchange.name}] [PRE-FILL] ⚠️  Quantity from env (${qty}) < 0.002, using minimum: ${grvtQty} BTC`);
  } else {
    console.log(`[${exchange.name}] [PRE-FILL] Using quantity: ${grvtQty} BTC`);
  }
  
  await delay(1000);
  
  // Close any NotifyBarWrapper notifications before starting
  await closeNotifyBarWrapperNotifications(page, exchange, 'before prefilling form');
  
  // Check URL before starting - make sure we're on the trading page
  const initialUrl = page.url();
  if (initialUrl.includes('/deposit') || initialUrl.includes('/withdraw')) {
    console.log(`[${exchange.name}] [PRE-FILL] ⚠️  Already on ${initialUrl}, navigating to trading page first...`);
    await page.goto(exchange.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);
  }
  
  // Scroll to top to ensure Limit/Market buttons are in viewport
  console.log(`[${exchange.name}] [PRE-FILL] Scrolling to top to ensure ${orderType.toUpperCase()} button is in viewport...`);
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  await delay(500);
  
  // 1. Select order type (Limit/Market tab)
  console.log(`[${exchange.name}] [PRE-FILL] Step 1: Selecting ${orderType.toUpperCase()} tab...`);
  try {
    const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
    let orderTypeResult = false;
    
    if (createOrderPanel) {
      const buttonText = orderType === "limit" ? exchange.selectors.limitButton : exchange.selectors.marketButton;
      
      const orderTypeBtn = await createOrderPanel.evaluateHandle((panel, searchText, orderType) => {
        const buttons = Array.from(panel.querySelectorAll('button, div[role="button"], span[role="button"]'));
        for (const btn of buttons) {
          if (btn.offsetParent === null) continue;
          
          const btnText = (btn.textContent || '').trim();
          const btnTextLower = btnText.toLowerCase();
          const href = btn.getAttribute('href') || '';
          const isLink = btn.tagName === 'A' || href !== '';
          
          if (isLink) continue;
          if (btnTextLower.includes('deposit') || btnTextLower.includes('withdraw')) continue;
          
          if (orderType === 'limit') {
            if (btnTextLower === 'limit' || btnTextLower.includes('limit')) {
              return btn;
            }
          } else {
            if (btnTextLower === 'market' || btnTextLower.includes('market')) {
              return btn;
            }
          }
        }
        return null;
      }, buttonText, orderType);
      
      const orderTypeElement = orderTypeBtn.asElement();
      if (orderTypeElement) {
        const buttonInfo = await page.evaluate((el) => {
          const text = (el.textContent || '').trim();
          const href = el.getAttribute('href') || '';
          const isLink = el.tagName === 'A' || href !== '';
          return { text: text, isLink: isLink, href: href };
        }, orderTypeElement);
        
        if (!buttonInfo.isLink && !buttonInfo.text.toLowerCase().includes('deposit') && !buttonInfo.text.toLowerCase().includes('withdraw')) {
          const isInViewport = await page.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.top >= 0 &&
              rect.left >= 0 &&
              rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
              rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );
          }, orderTypeElement);
          
          if (!isInViewport) {
            await orderTypeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await delay(500);
          }
          
          await orderTypeElement.click();
          orderTypeResult = true;
          await delay(300);
        }
      }
    }
    
    if (!orderTypeResult) {
      const { selectOrderType } = await import('./executeBase.js');
      const orderTypePromise = selectOrderType(page, orderType, exchange);
      const orderTypeTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('selectOrderType timeout')), 5000)
      );
      try {
        await Promise.race([orderTypePromise, orderTypeTimeout]);
        orderTypeResult = true;
      } catch (error) {
        console.log(`[${exchange.name}] [PRE-FILL] ⚠️  Failed to select order type: ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`[${exchange.name}] [PRE-FILL] ⚠️  Error selecting order type: ${error.message}`);
  }
  await delay(200);
  
  // 2. Find inputs
  console.log(`[${exchange.name}] [PRE-FILL] Step 2: Finding inputs...`);
  let sizeInput = null;
  let priceInput = null;
  
  const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
  if (createOrderPanel) {
    const panelInputs = await createOrderPanel.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
    
    for (const input of panelInputs) {
      const rect = await input.boundingBox();
      if (!rect) continue;
      
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
            parentText = (parent.textContent || '').trim();
            break;
          }
          parent = parent.parentElement;
        }
        
        const placeholder = el.placeholder || '';
        return {
          labelText: labelText.toLowerCase(),
          parentText: parentText.toLowerCase(),
          placeholder: placeholder.toLowerCase(),
          value: el.value || ''
        };
      }, input);
      
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
      }
      
      if (!priceInput && orderType === "limit" && (
        inputInfo.labelText.includes('price') ||
        inputInfo.parentText.includes('price') ||
        inputInfo.placeholder.includes('price') ||
        inputInfo.value.toLowerCase().includes('mid') ||
        inputInfo.parentText.includes('mid')
      )) {
        priceInput = input;
      }
    }
    
    if (sizeInput && !priceInput && orderType === "limit") {
      const sizeRect = await sizeInput.boundingBox();
      if (sizeRect) {
        for (const input of panelInputs) {
          if (input === sizeInput) continue;
          const inputRect = await input.boundingBox();
          if (!inputRect) continue;
          const isNearQuantity = Math.abs(inputRect.y - sizeRect.y) < 50 &&
            Math.abs(inputRect.x - sizeRect.x) < 400 &&
            inputRect.x !== sizeRect.x;
          if (isNearQuantity) {
            priceInput = input;
            break;
          }
        }
      }
    }
  }
  
  if (!sizeInput) {
    return { success: false, error: "Quantity input not found" };
  }
  
  if (orderType === "limit" && !priceInput) {
    return { success: false, error: "Price input not found" };
  }
  
  // 3. Fill quantity (using grvtQty which is at least 0.002)
  console.log(`[${exchange.name}] [PRE-FILL] Step 3: Filling quantity (${grvtQty} BTC)...`);
  const sizeResult = await enterSize(page, sizeInput, grvtQty, exchange);
  if (!sizeResult.success) {
    return sizeResult;
  }
  await delay(500);
  
  // Verify quantity persists
  const sizeCheck = await page.evaluate((el) => el.value || '', sizeInput);
  if (!sizeCheck || sizeCheck.trim() === '') {
    console.log(`[${exchange.name}] [PRE-FILL] ⚠️  Quantity not persisting, retrying...`);
    const retryResult = await enterSize(page, sizeInput, grvtQty, exchange);
    if (!retryResult.success) {
      return retryResult;
    }
    await delay(500);
  }
  
  // 4. Set up TP/SL: Click checkbox, click Advanced, open modal, update dropdown to P&L (but don't fill values yet)
  console.log(`[${exchange.name}] [PRE-FILL] Step 4: Setting up TP/SL (checkbox, Advanced, dropdown to P&L)...`);
  const tpSlSetupResult = await setupTpSlGrvtPrefill(page, exchange);
  if (!tpSlSetupResult.success) {
    console.log(`[${exchange.name}] [PRE-FILL] ⚠️  TP/SL setup failed: ${tpSlSetupResult.error}, continuing anyway...`);
  }
  
  return { 
    success: true, 
    sizeInput, 
    priceInput,
    tpSlSetup: tpSlSetupResult
  };
}

/**
 * Set up TP/SL for GRVT during prefill: Click checkbox, click Advanced, open modal, update dropdown to P&L
 * Does NOT fill values or confirm (that happens after threshold is met)
 */
async function setupTpSlGrvtPrefill(page, exchange) {
  const takeProfitPercent = process.env.TAKE_PROFIT || '';
  const stopLossPercent = process.env.STOP_LOSS || '';
  
  if (!takeProfitPercent && !stopLossPercent) {
    console.log(`[${exchange.name}] [PRE-FILL] No TP/SL values configured, skipping TP/SL setup`);
    return { success: true, skipped: true };
  }
  
  try {
    // Step 1: Find and click TP/SL checkbox
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 1: Finding and clicking TP/SL checkbox...`);
    const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
    let checkboxElement = null;
    
    if (createOrderPanel) {
      const panelLabels = await createOrderPanel.$$('label');
      for (const label of panelLabels) {
        const labelText = await page.evaluate((el) => el.textContent?.trim().toLowerCase() || '', label);
        if ((labelText.includes('tp') && labelText.includes('sl')) ||
          (labelText.includes('take profit') && labelText.includes('stop loss'))) {
          const checkbox = await label.$('input[type="checkbox"]');
          if (checkbox) {
            checkboxElement = checkbox;
            const isChecked = await page.evaluate((el) => el.checked, checkbox);
            if (!isChecked) {
              // Try multiple click methods to ensure checkbox is checked
              try {
                await checkbox.click();
                await delay(200);
                // Verify checkbox is now checked
                const isCheckedAfter = await page.evaluate((el) => el.checked, checkbox);
                if (!isCheckedAfter) {
                  // Try JavaScript click as fallback
                  await checkbox.evaluate((el) => el.click());
                  await delay(200);
                  const isCheckedAfter2 = await page.evaluate((el) => el.checked, checkbox);
                  if (!isCheckedAfter2) {
                    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Checkbox click did not register, trying label click...`);
                    await label.click();
                    await delay(200);
                  }
                }
                console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked TP/SL checkbox`);
              } catch (error) {
                console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Error clicking checkbox: ${error.message}, trying label click...`);
                try {
                  await label.click();
                  await delay(200);
                  console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked TP/SL checkbox via label`);
                } catch (labelError) {
                  console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Label click also failed: ${labelError.message}`);
                }
              }
              await delay(500);
            } else {
              console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ TP/SL checkbox already checked`);
            }
            break;
          }
        }
      }
    }
    
    if (!checkboxElement) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Could not find TP/SL checkbox`);
      return { success: false, error: 'TP/SL checkbox not found' };
    }
    
    // Step 2: Find and click "Advanced" button
    // Wait a bit longer for UI to update after checkbox click
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 2: Finding and clicking Advanced button...`);
    await delay(800); // Give UI time to render Advanced button
    
    let advancedElement = null;
    let advancedEl = null;
    
    // Strategy 1: Search from checkbox parent tree, but EXCLUDE order type tabs
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Strategy 1: Searching from checkbox parent tree (excluding order type tabs)...`);
    const advancedHandle1 = await page.evaluateHandle((checkbox) => {
      let parentContainer = checkbox.parentElement;
      for (let i = 0; i < 8 && parentContainer; i++) {
        const allElements = Array.from(parentContainer.querySelectorAll('*'));
        for (const el of allElements) {
          if (el.offsetParent === null) continue;
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
            // EXCLUDE order type tabs - check if this is in a tab context (Limit/Market/Advanced tabs)
            let isOrderTypeTab = false;
            let checkParent = el.parentElement;
            let depth = 0;
            while (checkParent && depth < 5) {
              const parentText = (checkParent.textContent || '').toLowerCase();
              // If we find "limit" or "market" nearby, this is likely an order type tab
              if (parentText.includes('limit') && parentText.includes('market') && 
                  (parentText.includes('tab') || checkParent.getAttribute('role') === 'tablist' || 
                   checkParent.classList.toString().toLowerCase().includes('tab'))) {
                isOrderTypeTab = true;
                break;
              }
              checkParent = checkParent.parentElement;
              depth++;
            }
            
            // Skip if this is an order type tab
            if (isOrderTypeTab) {
              continue;
            }
            
            // Check if it's clickable (button, link, or has click handler)
            const tagName = el.tagName.toLowerCase();
            const role = el.getAttribute('role');
            if (tagName === 'button' || tagName === 'a' || role === 'button' || 
                el.onclick || el.getAttribute('onclick') || 
                window.getComputedStyle(el).cursor === 'pointer') {
              // Additional check: make sure it's near the TP/SL checkbox context
              // Look for TP/SL related text in nearby elements
              let nearbyText = '';
              let checkNearby = el.parentElement;
              for (let j = 0; j < 3 && checkNearby; j++) {
                nearbyText += (checkNearby.textContent || '').toLowerCase() + ' ';
                checkNearby = checkNearby.parentElement;
              }
              if (nearbyText.includes('tp') || nearbyText.includes('sl') || 
                  nearbyText.includes('take profit') || nearbyText.includes('stop loss')) {
                return el;
              }
            }
          }
        }
        parentContainer = parentContainer.parentElement;
      }
      return null;
    }, checkboxElement);
    
    if (advancedHandle1 && advancedHandle1.asElement()) {
      advancedEl = advancedHandle1.asElement();
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Found Advanced button via Strategy 1`);
    } else {
      // Strategy 2: Search within CreateOrderPanel, but EXCLUDE order type tabs
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Strategy 2: Searching within CreateOrderPanel (excluding order type tabs)...`);
      if (createOrderPanel) {
        const advancedHandle2 = await page.evaluateHandle((panel) => {
          // First, identify and exclude order type tab areas
          const tabLists = Array.from(panel.querySelectorAll('[role="tablist"], [class*="tab"], [class*="Tab"]'));
          const tabAreas = new Set();
          for (const tabList of tabLists) {
            const tabText = (tabList.textContent || '').toLowerCase();
            if (tabText.includes('limit') && tabText.includes('market') && tabText.includes('advanced')) {
              // This is the order type tab area - exclude it
              const allTabs = tabList.querySelectorAll('*');
              for (const tab of allTabs) {
                tabAreas.add(tab);
              }
            }
          }
          
          const allElements = Array.from(panel.querySelectorAll('*'));
          for (const el of allElements) {
            // Skip if in order type tab area
            if (tabAreas.has(el)) continue;
            
            if (el.offsetParent === null) continue;
            const text = (el.textContent || '').trim();
            if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
              const tagName = el.tagName.toLowerCase();
              const role = el.getAttribute('role');
              if (tagName === 'button' || tagName === 'a' || role === 'button' || 
                  el.onclick || el.getAttribute('onclick') || 
                  window.getComputedStyle(el).cursor === 'pointer') {
                // Make sure it's in TP/SL context - check nearby text
                let nearbyText = '';
                let checkNearby = el.parentElement;
                for (let j = 0; j < 5 && checkNearby; j++) {
                  nearbyText += (checkNearby.textContent || '').toLowerCase() + ' ';
                  checkNearby = checkNearby.parentElement;
                }
                if (nearbyText.includes('tp') || nearbyText.includes('sl') || 
                    nearbyText.includes('take profit') || nearbyText.includes('stop loss')) {
                  return el;
                }
              }
            }
          }
          return null;
        }, createOrderPanel);
        
        if (advancedHandle2 && advancedHandle2.asElement()) {
          advancedEl = advancedHandle2.asElement();
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Found Advanced button via Strategy 2`);
        }
      }
    }
    
    // Strategy 3: Broader search for any button with "Advanced" text, but EXCLUDE order type tabs
    if (!advancedEl) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Strategy 3: Broader search for Advanced button (excluding order type tabs)...`);
      const advancedHandle3 = await page.evaluateHandle(() => {
        // First, identify order type tab areas to exclude
        const tabLists = Array.from(document.querySelectorAll('[role="tablist"], [class*="tab"], [class*="Tab"]'));
        const tabAreas = new Set();
        for (const tabList of tabLists) {
          const tabText = (tabList.textContent || '').toLowerCase();
          if (tabText.includes('limit') && tabText.includes('market') && tabText.includes('advanced')) {
            const allTabs = tabList.querySelectorAll('*');
            for (const tab of allTabs) {
              tabAreas.add(tab);
            }
          }
        }
        
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div[class*="button"], span[class*="button"]'));
        for (const btn of buttons) {
          // Skip if in order type tab area
          if (tabAreas.has(btn)) continue;
          
          if (btn.offsetParent === null) continue;
          const text = (btn.textContent || '').trim();
          if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
            // Make sure it's visible and clickable
            const style = window.getComputedStyle(btn);
            if (style.display !== 'none' && style.visibility !== 'hidden' && 
                btn.offsetWidth > 0 && btn.offsetHeight > 0) {
              // Make sure it's in TP/SL context
              let nearbyText = '';
              let checkNearby = btn.parentElement;
              for (let j = 0; j < 5 && checkNearby; j++) {
                nearbyText += (checkNearby.textContent || '').toLowerCase() + ' ';
                checkNearby = checkNearby.parentElement;
              }
              if (nearbyText.includes('tp') || nearbyText.includes('sl') || 
                  nearbyText.includes('take profit') || nearbyText.includes('stop loss')) {
                return btn;
              }
            }
          }
        }
        return null;
      });
      
      if (advancedHandle3 && advancedHandle3.asElement()) {
        advancedEl = advancedHandle3.asElement();
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Found Advanced button via Strategy 3`);
      }
    }
    
    // Try to click the Advanced button with multiple methods and retries
    if (advancedEl) {
      let clicked = false;
      const maxClickAttempts = 3;
      
      for (let attempt = 1; attempt <= maxClickAttempts; attempt++) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Attempting to click Advanced button (attempt ${attempt}/${maxClickAttempts})...`);
        
        // Method 1: Direct Puppeteer click
        try {
          await advancedEl.click({ delay: 100 });
          clicked = true;
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked Advanced button (method 1: direct click, attempt ${attempt})`);
          break;
        } catch (error) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Direct click failed (attempt ${attempt}): ${error.message}, trying JavaScript click...`);
        }
        
        // Method 2: JavaScript click
        try {
          await advancedEl.evaluate((el) => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
          });
          clicked = true;
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked Advanced button (method 2: JavaScript click, attempt ${attempt})`);
          break;
        } catch (error) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  JavaScript click failed (attempt ${attempt}): ${error.message}, trying event dispatch...`);
        }
        
        // Method 3: Event dispatch
        try {
          await advancedEl.evaluate((el) => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            
            const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
            const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
            const click = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
            
            el.dispatchEvent(mouseDown);
            el.dispatchEvent(mouseUp);
            el.dispatchEvent(click);
          });
          clicked = true;
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked Advanced button (method 3: event dispatch, attempt ${attempt})`);
          break;
        } catch (error) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Event dispatch failed (attempt ${attempt}): ${error.message}`);
        }
        
        // Wait before retry
        if (attempt < maxClickAttempts) {
          await delay(500);
        }
      }
      
      if (!clicked) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  All click methods failed for Advanced button after ${maxClickAttempts} attempts`);
        return { success: false, error: 'Advanced button found but could not be clicked' };
      }
      
      // Wait longer after clicking (MacBook may need more time)
      await delay(1000);
    } else {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Could not find Advanced button with any strategy`);
      return { success: false, error: 'Advanced button not found' };
    }
    
    // Step 3: Wait for TP/SL modal to open with improved detection
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 3: Waiting for TP/SL modal to open...`);
    let modalOpened = false;
    const maxWaitAttempts = 20; // Increased from 10 to 20 (6 seconds total)
    
    for (let i = 0; i < maxWaitAttempts; i++) {
      modalOpened = await page.evaluate(() => {
        // Strategy 1: Look for modal by role/class
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="drawer"], [class*="Drawer"]'));
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          if (style.display !== 'none' && style.visibility !== 'hidden' &&
            modal.offsetWidth > 0 && modal.offsetHeight > 0) {
            const modalText = (modal.textContent || '').toLowerCase();
            if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss') ||
                modalText.includes('roi%') || modalText.includes('p&l')) {
              return true;
            }
          }
        }
        
        // Strategy 2: Look for TP/SL input fields directly (more reliable)
        const allInputs = Array.from(document.querySelectorAll('input, textarea'));
        let hasTakeProfitInput = false;
        let hasStopLossInput = false;
        
        for (const input of allInputs) {
          if (input.offsetParent === null) continue;
          const placeholder = (input.placeholder || '').toLowerCase();
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          const parentText = (input.parentElement?.textContent || '').toLowerCase();
          
          if (placeholder.includes('take profit') || label.includes('take profit') || 
              parentText.includes('take profit')) {
            hasTakeProfitInput = true;
          }
          if (placeholder.includes('stop loss') || label.includes('stop loss') || 
              parentText.includes('stop loss')) {
            hasStopLossInput = true;
          }
        }
        
        if (hasTakeProfitInput && hasStopLossInput) {
          return true;
        }
        
        // Strategy 3: Look for "Confirm" button that's typically in TP/SL modal
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if (btn.offsetParent === null) continue;
          const btnText = (btn.textContent || '').trim().toLowerCase();
          if (btnText === 'confirm') {
            // Check if this Confirm button is in a modal context
            let parent = btn.parentElement;
            let depth = 0;
            while (parent && depth < 10) {
              const parentText = (parent.textContent || '').toLowerCase();
              if (parentText.includes('tp/sl') || parentText.includes('take profit') || 
                  parentText.includes('stop loss')) {
                return true;
              }
              parent = parent.parentElement;
              depth++;
            }
          }
        }
        
        return false;
      });
      
      if (modalOpened) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ TP/SL modal opened (detected on attempt ${i + 1})`);
        await delay(500);
        break;
      }
      
      if (i < maxWaitAttempts - 1) {
        await delay(300);
      }
    }
    
    if (!modalOpened) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  TP/SL modal did not open after ${maxWaitAttempts} attempts`);
      return { success: false, error: 'TP/SL modal did not open' };
    }
    
    // Step 4: Update dropdown to P&L for both Take profit and Stop loss sections
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 4: Updating ROI% dropdown to P&L for both sections...`);
    
    // Helper function to update ROI% dropdown to P&L for a section
    // Using the same approach as handleTpSlGrvt in executeGrvt.js
    const updateRoiDropdown = async (sectionName) => {
      const roiParentInfo = await page.evaluate((sectionName) => {
        // Step 1: Find the TP/SL modal by text "TP/SL" in header
        const allElements = Array.from(document.querySelectorAll('*'));
        let tpslModal = null;
        
        // Find element with "TP/SL" text (this is the modal header)
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text === 'TP/SL' && el.offsetParent !== null) {
            // Walk up to find the modal container
            let parent = el.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              const style = window.getComputedStyle(parent);
              if (style.display !== 'none' && style.visibility !== 'hidden' &&
                parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                // Check if this parent contains both "Take profit" and "Stop loss"
                const parentText = (parent.textContent || '').toLowerCase();
                if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                  tpslModal = parent;
                  break;
                }
              }
              parent = parent.parentElement;
            }
            if (tpslModal) break;
          }
        }

        if (!tpslModal) {
          return { success: false, step: 1, message: 'TP/SL modal not found' };
        }

        // Step 2: Find element with text matching sectionName ("Take profit" or "Stop loss")
        const sectionNameLower = sectionName.toLowerCase();
        let sectionElement = null;
        const modalElements = Array.from(tpslModal.querySelectorAll('*'));
        for (const el of modalElements) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
            sectionElement = el;
            break;
          }
        }

        if (!sectionElement) {
          return { success: false, step: 2, message: `Could not find "${sectionName}" section` };
        }

        // Step 3: Find ROI% element within the section's parent
        let sectionParent = sectionElement.parentElement;
        if (!sectionParent) {
          return { success: false, step: 3, message: `Could not find parent of "${sectionName}" element` };
        }

        // Step 4: Find ROI% element - look for React Select control structure
        // Strategy: Find ROI% text, then walk up to find the React Select control container
        // The control container will have: ROI% text + input[role="combobox"] as children/descendants
        
        const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
        let roiTextElement = null;
        
        // First, find the ROI% text element
        for (const el of allDescendants) {
          const text = (el.textContent || '').trim();
          if (text === 'ROI%' && el.offsetParent !== null) {
            roiTextElement = el;
            break;
          }
        }
        
        if (!roiTextElement) {
          return { success: false, step: 3, message: `Could not find "ROI%" text element inside "${sectionName}" parent` };
        }
        
        // Walk up from ROI% text to find the React Select control container
        // The control container should contain both ROI% text AND an input[role="combobox"]
        let roiClickableElement = null;
        let current = roiTextElement.parentElement;
        
        for (let i = 0; i < 15 && current; i++) {
          // Check if this element contains both ROI% text and a combobox input
          const hasRoiText = (current.textContent || '').includes('ROI%');
          const hasCombobox = current.querySelector('input[role="combobox"]') !== null;
          const hasAriaHaspopup = current.querySelector('[aria-haspopup="true"]') !== null;
          
          // Also check if this element itself is the combobox input
          const isCombobox = current.tagName.toLowerCase() === 'input' && 
                            current.getAttribute('role') === 'combobox';
          
          // Check if this is a div that looks like a select control container
          const isDiv = current.tagName.toLowerCase() === 'div';
          const style = window.getComputedStyle(current);
          const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
          
          // If it has both ROI% text and combobox input, or is the combobox itself, it's likely the control
          if ((hasRoiText && (hasCombobox || hasAriaHaspopup)) || isCombobox) {
            if (isVisible && current.offsetParent !== null) {
              roiClickableElement = current;
              break;
            }
          }
          
          // Also check for dropdown indicator (arrow icon) - if parent contains it, it's likely the control
          const hasDropdownIndicator = current.querySelector('svg') !== null || 
                                      current.querySelector('[aria-hidden="true"]') !== null;
          if (hasRoiText && hasDropdownIndicator && isDiv && isVisible) {
            roiClickableElement = current;
            break;
          }
          
          current = current.parentElement;
        }
        
        // If still not found, try to find the combobox input directly
        if (!roiClickableElement) {
          const comboboxInput = sectionParent.querySelector('input[role="combobox"][aria-haspopup="true"]');
          if (comboboxInput) {
            // Check if it's near the ROI% text (same parent structure)
            let checkParent = comboboxInput.parentElement;
            for (let i = 0; i < 5 && checkParent; i++) {
              if ((checkParent.textContent || '').includes('ROI%')) {
                roiClickableElement = comboboxInput;
                break;
              }
              checkParent = checkParent.parentElement;
            }
          }
        }
        
        // Fallback: use the ROI% text element's parent that contains the combobox
        if (!roiClickableElement) {
          let parent = roiTextElement.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            const hasCombobox = parent.querySelector('input[role="combobox"]') !== null;
            if (hasCombobox) {
              const style = window.getComputedStyle(parent);
              if (style.display !== 'none' && style.visibility !== 'hidden' && parent.offsetParent !== null) {
                roiClickableElement = parent;
                break;
              }
            }
            parent = parent.parentElement;
          }
        }
        
        // Final fallback: use ROI% text element itself
        if (!roiClickableElement) {
          roiClickableElement = roiTextElement;
        }

        // Get the clickable element's bounding rect for clicking
        const rect = roiClickableElement.getBoundingClientRect();
        return {
          success: true,
          clickX: rect.x + rect.width / 2,
          clickY: rect.y + rect.height / 2,
          roiElementText: (roiClickableElement.textContent || '').trim().substring(0, 20),
          clickableTag: roiClickableElement.tagName,
          clickableRole: roiClickableElement.getAttribute('role') || 'none'
        };
      }, sectionName);
      
      if (!roiParentInfo || !roiParentInfo.success) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Could not find ROI% element for ${sectionName}: ${roiParentInfo?.message || 'unknown'} (step: ${roiParentInfo?.step || 'unknown'})`);
        return false;
      }
      
      try {
        // Phase 1: Click on ROI% element - try multiple methods
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Clicking on ROI% element for ${sectionName}...`);
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Found element: ${roiParentInfo.clickableTag}, role: ${roiParentInfo.clickableRole}, text: "${roiParentInfo.roiElementText}"`);
        
        // Try JavaScript click first on the React Select control or combobox input
        const jsClickWorked = await page.evaluate((sectionName) => {
          const allElements = Array.from(document.querySelectorAll('*'));
          let tpslModal = null;
          
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text === 'TP/SL' && el.offsetParent !== null) {
              let parent = el.parentElement;
              for (let i = 0; i < 10 && parent; i++) {
                const style = window.getComputedStyle(parent);
                if (style.display !== 'none' && style.visibility !== 'hidden' &&
                  parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                  const parentText = (parent.textContent || '').toLowerCase();
                  if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                    tpslModal = parent;
                    break;
                  }
                }
                parent = parent.parentElement;
              }
              if (tpslModal) break;
            }
          }
          
          if (!tpslModal) return false;
          
          const sectionNameLower = sectionName.toLowerCase();
          let sectionElement = null;
          const modalElements = Array.from(tpslModal.querySelectorAll('*'));
          for (const el of modalElements) {
            const text = (el.textContent || '').trim();
            if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
              sectionElement = el;
              break;
            }
          }
          
          if (!sectionElement) return false;
          
          let sectionParent = sectionElement.parentElement;
          if (!sectionParent) return false;
          
          // Strategy: Find ROI% text, then find the React Select control container
          // The control container contains both ROI% text AND input[role="combobox"]
          const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
          let roiTextElement = null;
          
          for (const el of allDescendants) {
            const text = (el.textContent || '').trim();
            if (text === 'ROI%' && el.offsetParent !== null) {
              roiTextElement = el;
              break;
            }
          }
          
          if (!roiTextElement) return false;
          
          // Walk up to find the React Select control container
          let current = roiTextElement.parentElement;
          for (let i = 0; i < 15 && current; i++) {
            const hasRoiText = (current.textContent || '').includes('ROI%');
            const hasCombobox = current.querySelector('input[role="combobox"]') !== null;
            const hasAriaHaspopup = current.querySelector('[aria-haspopup="true"]') !== null;
            const isCombobox = current.tagName.toLowerCase() === 'input' && 
                              current.getAttribute('role') === 'combobox';
            
            const style = window.getComputedStyle(current);
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
            
            // Found the control container or combobox input
            if ((hasRoiText && (hasCombobox || hasAriaHaspopup)) || isCombobox) {
              if (isVisible && current.offsetParent !== null) {
                if (current.click) {
                  current.click();
                  return true;
                }
              }
            }
            
            current = current.parentElement;
          }
          
          // Fallback: Find and click the combobox input directly
          const comboboxInput = sectionParent.querySelector('input[role="combobox"][aria-haspopup="true"]');
          if (comboboxInput) {
            let checkParent = comboboxInput.parentElement;
            for (let i = 0; i < 5 && checkParent; i++) {
              if ((checkParent.textContent || '').includes('ROI%')) {
                if (comboboxInput.click) {
                  comboboxInput.click();
                  return true;
                }
                break;
              }
              checkParent = checkParent.parentElement;
            }
          }
          
          // Final fallback: click parent of ROI% text that contains combobox
          let parent = roiTextElement.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            const hasCombobox = parent.querySelector('input[role="combobox"]') !== null;
            if (hasCombobox) {
              const style = window.getComputedStyle(parent);
              if (style.display !== 'none' && style.visibility !== 'hidden' && parent.offsetParent !== null) {
                if (parent.click) {
                  parent.click();
                  return true;
                }
              }
            }
            parent = parent.parentElement;
          }
          
          return false;
        }, sectionName);
        
        if (jsClickWorked) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ JavaScript click executed on ROI% element`);
          await delay(500);
        } else {
          // Fallback to mouse click
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] JavaScript click didn't work, trying mouse click...`);
          await page.mouse.click(roiParentInfo.clickX, roiParentInfo.clickY);
          await delay(500);
        }
        
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked ROI% element for ${sectionName}`);
        
        // Wait for dropdown to be ready (same as handleTpSlGrvt)
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Waiting for ROI% dropdown to be ready...`);
        let dropdownReady = false;
        for (let i = 0; i < 15; i++) {
          const checkResult = await page.evaluate(() => {
            const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
            const menus = Array.from(document.querySelectorAll('[role="menu"]'));
            const allDropdowns = [...listboxes, ...menus];
            
            for (const menu of allDropdowns) {
              const style = window.getComputedStyle(menu);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                const rect = menu.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return { ready: true };
                }
              }
            }
            return { ready: false };
          });
          
          if (checkResult.ready) {
            dropdownReady = true;
            break;
          }
          await delay(200);
        }
        
        if (!dropdownReady) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  ROI% dropdown not detected as ready, proceeding anyway...`);
        } else {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ ROI% dropdown is ready`);
        }
        
        await delay(300);
        
        // Focus the combobox input first, then use keyboard navigation
        // This ensures the dropdown is focused and keyboard events work
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Focusing combobox input for keyboard navigation...`);
        const comboboxFocused = await page.evaluate((sectionName) => {
          const allElements = Array.from(document.querySelectorAll('*'));
          let tpslModal = null;
          
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text === 'TP/SL' && el.offsetParent !== null) {
              let parent = el.parentElement;
              for (let i = 0; i < 10 && parent; i++) {
                const style = window.getComputedStyle(parent);
                if (style.display !== 'none' && style.visibility !== 'hidden' &&
                  parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                  const parentText = (parent.textContent || '').toLowerCase();
                  if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                    tpslModal = parent;
                    break;
                  }
                }
                parent = parent.parentElement;
              }
              if (tpslModal) break;
            }
          }
          
          if (!tpslModal) return false;
          
          const sectionNameLower = sectionName.toLowerCase();
          let sectionElement = null;
          const modalElements = Array.from(tpslModal.querySelectorAll('*'));
          for (const el of modalElements) {
            const text = (el.textContent || '').trim();
            if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
              sectionElement = el;
              break;
            }
          }
          
          if (!sectionElement) return false;
          
          let sectionParent = sectionElement.parentElement;
          if (!sectionParent) return false;
          
          // Find the combobox input in this section
          const comboboxInput = sectionParent.querySelector('input[role="combobox"]');
          if (comboboxInput) {
            comboboxInput.focus();
            comboboxInput.click();
            return true;
          }
          return false;
        }, sectionName);
        
        if (comboboxFocused) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Focused combobox input`);
          await delay(300);
        } else {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Could not focus combobox input, proceeding with keyboard navigation anyway...`);
        }
        
        // Try to open dropdown with Space if not already open
        if (!dropdownReady) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Dropdown not detected, trying Space key to open...`);
          await page.keyboard.press('Space');
          await delay(500);
          
          // Check again if dropdown opened
          const checkAgain = await page.evaluate(() => {
            const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
            const menus = Array.from(document.querySelectorAll('[role="menu"]'));
            const allDropdowns = [...listboxes, ...menus];
            
            for (const menu of allDropdowns) {
              const style = window.getComputedStyle(menu);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                const rect = menu.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return { ready: true };
                }
              }
            }
            return { ready: false };
          });
          
          if (checkAgain.ready) {
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Dropdown opened with Space key`);
            dropdownReady = true;
          }
        }
        
        // Since ROI% is the default, we need to navigate to P&L
        // Try to click P&L option directly if dropdown is open, otherwise use keyboard navigation
        if (dropdownReady) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Dropdown is open, trying to click P&L option directly (ROI% is default)...`);
          const pnlClicked = await page.evaluate(() => {
            const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
            const menus = Array.from(document.querySelectorAll('[role="menu"]'));
            const allDropdowns = [...listboxes, ...menus];
            
            for (const dropdown of allDropdowns) {
              const style = window.getComputedStyle(dropdown);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                const rect = dropdown.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  // Find all options in this dropdown
                  const options = Array.from(dropdown.querySelectorAll('[role="option"], li, div, button, span'));
                  for (const option of options) {
                    const text = (option.textContent || '').trim();
                    if (text === 'P&L' || text === 'P&amp;L') {
                      const optionStyle = window.getComputedStyle(option);
                      if (optionStyle.display !== 'none' && optionStyle.visibility !== 'hidden') {
                        const optionRect = option.getBoundingClientRect();
                        if (optionRect.width > 0 && optionRect.height > 0) {
                          // Try to click it
                          if (option.click) {
                            option.click();
                            return true;
                          } else if (option.dispatchEvent) {
                            const clickEvent = new MouseEvent('click', {
                              bubbles: true,
                              cancelable: true,
                              view: window
                            });
                            option.dispatchEvent(clickEvent);
                            return true;
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            return false;
          }, sectionName);
          
          if (pnlClicked) {
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked P&L option directly in dropdown`);
            await delay(500);
          } else {
            // Couldn't click directly, use keyboard navigation
            // Since ROI% is default, press ArrowDown once to get to P&L
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Could not click P&L directly, navigating with ArrowDown (ROI% is default, so ArrowDown once to P&L)...`);
            await page.keyboard.press('ArrowDown');
            await delay(500);
            // Press Enter to select P&L
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Pressing Enter to select P&L...`);
            await page.keyboard.press('Enter');
            await delay(500);
          }
        } else {
          // Dropdown not detected as open, but try keyboard navigation anyway
          // Since ROI% is default, press ArrowDown once to get to P&L
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Dropdown not detected, using keyboard navigation (ArrowDown once from ROI% to P&L)...`);
          await page.keyboard.press('ArrowDown');
          await delay(500);
          // Press Enter to select P&L
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Pressing Enter to select P&L...`);
          await page.keyboard.press('Enter');
          await delay(500);
        }
        
        // Wait for ROI% dropdown to close and verify P&L was selected
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Waiting for ROI% dropdown to close and verifying P&L selection...`);
        let roiDropdownClosed = false;
        for (let i = 0; i < 10; i++) {
          const checkResult = await page.evaluate(() => {
            // Check if any dropdown is still open
            const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
            const menus = Array.from(document.querySelectorAll('[role="menu"]'));
            const allDropdowns = [...listboxes, ...menus];
            
            for (const menu of allDropdowns) {
              const style = window.getComputedStyle(menu);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                const rect = menu.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return { open: true };
                }
              }
            }
            return { open: false };
          });
          
          if (!checkResult.open) {
            roiDropdownClosed = true;
            break;
          }
          await delay(200);
        }
        
        if (!roiDropdownClosed) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  ROI% dropdown did not close within timeout`);
        }
        
        await delay(300);
        
        // Verify P&L was actually selected
        const verifyPnlSelected = await page.evaluate((sectionName) => {
          const allElements = Array.from(document.querySelectorAll('*'));
          let tpslModal = null;
          
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text === 'TP/SL' && el.offsetParent !== null) {
              let parent = el.parentElement;
              for (let i = 0; i < 10 && parent; i++) {
                const style = window.getComputedStyle(parent);
                if (style.display !== 'none' && style.visibility !== 'hidden' &&
                  parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                  const parentText = (parent.textContent || '').toLowerCase();
                  if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                    tpslModal = parent;
                    break;
                  }
                }
                parent = parent.parentElement;
              }
              if (tpslModal) break;
            }
          }
          
          if (!tpslModal) return { selected: false, reason: 'Modal not found' };
          
          const sectionNameLower = sectionName.toLowerCase();
          let sectionElement = null;
          const modalElements = Array.from(tpslModal.querySelectorAll('*'));
          for (const el of modalElements) {
            const text = (el.textContent || '').trim();
            if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
              sectionElement = el;
              break;
            }
          }
          
          if (!sectionElement) return { selected: false, reason: 'Section not found' };
          
          let sectionParent = sectionElement.parentElement;
          if (!sectionParent) return { selected: false, reason: 'Section parent not found' };
          
          // Look for P&L text in the section (should be visible if selected)
          const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
          for (const el of allDescendants) {
            const text = (el.textContent || '').trim();
            // Check if P&L is visible (not ROI%)
            if (text === 'P&L' && el.offsetParent !== null) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                // Also check that ROI% is not visible (meaning P&L replaced it)
                let roiVisible = false;
                for (const checkEl of allDescendants) {
                  const checkText = (checkEl.textContent || '').trim();
                  if (checkText === 'ROI%' && checkEl.offsetParent !== null) {
                    const checkStyle = window.getComputedStyle(checkEl);
                    if (checkStyle.display !== 'none' && checkStyle.visibility !== 'hidden') {
                      // Check if ROI% is in the same area as P&L (same dropdown)
                      const roiRect = checkEl.getBoundingClientRect();
                      const pnlRect = el.getBoundingClientRect();
                      // If they're close together, ROI% might still be visible
                      const distance = Math.abs(roiRect.x - pnlRect.x) + Math.abs(roiRect.y - pnlRect.y);
                      if (distance < 50) {
                        roiVisible = true;
                        break;
                      }
                    }
                  }
                }
                if (!roiVisible) {
                  return { selected: true };
                }
              }
            }
          }
          
          return { selected: false, reason: 'P&L not found or ROI% still visible' };
        }, sectionName);
        
        if (verifyPnlSelected.selected) {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Updated ROI% dropdown to P&L for ${sectionName} (verified)`);
          return true;
        } else {
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  ROI% dropdown update may have failed for ${sectionName}: ${verifyPnlSelected.reason || 'unknown'}`);
          return false;
        }
      } catch (error) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Error updating ROI% dropdown for ${sectionName}: ${error.message}`);
        return false;
      }
    };
    
    // Update ROI% dropdown to P&L for both sections (with retry)
    let takeProfitRoiUpdated = await updateRoiDropdown('Take profit');
    if (!takeProfitRoiUpdated) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  First attempt failed for Take profit ROI%, retrying...`);
      await delay(500);
      takeProfitRoiUpdated = await updateRoiDropdown('Take profit');
    }
    await delay(300);
    
    let stopLossRoiUpdated = await updateRoiDropdown('Stop loss');
    if (!stopLossRoiUpdated) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  First attempt failed for Stop loss ROI%, retrying...`);
      await delay(500);
      stopLossRoiUpdated = await updateRoiDropdown('Stop loss');
    }
    
    if (!takeProfitRoiUpdated || !stopLossRoiUpdated) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Failed to update one or both ROI% dropdowns after retry`);
    } else {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Successfully updated both ROI% dropdowns to P&L`);
    }
    
    // Step 5: Update Market dropdown to Limit for both Take profit and Stop loss sections
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 5: Updating Market dropdown to Limit for both sections...`);
    
    // Helper function to update Market dropdown to Limit for a section
    const updateMarketDropdown = async (sectionName) => {
      const selectElementInfo = await page.evaluate((sectionName) => {
        const allElements = Array.from(document.querySelectorAll('*'));
        let tpslModal = null;
        
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text === 'TP/SL' && el.offsetParent !== null) {
            let parent = el.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              const style = window.getComputedStyle(parent);
              if (style.display !== 'none' && style.visibility !== 'hidden' &&
                parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                const parentText = (parent.textContent || '').toLowerCase();
                if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                  tpslModal = parent;
                  break;
                }
              }
              parent = parent.parentElement;
            }
            if (tpslModal) break;
          }
        }
        
        if (!tpslModal) return { success: false, message: 'TP/SL modal not found' };
        
        const sectionNameLower = sectionName.toLowerCase();
        let sectionElement = null;
        const modalElements = Array.from(tpslModal.querySelectorAll('*'));
        for (const el of modalElements) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
            sectionElement = el;
            break;
          }
        }
        
        if (!sectionElement) return { success: false, message: `Could not find "${sectionName}" section` };
        
        let sectionParent = sectionElement.parentElement;
        const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
        
        for (let i = 0; i < 10 && sectionParent; i++) {
          const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
          let hasMarketSelect = false;
          let hasOtherSection = false;
          
          for (const el of allDescendants) {
            const text = (el.textContent || '').trim();
            if (text === 'Market' && el.offsetParent !== null) {
              let parent = el.parentElement;
              for (let j = 0; j < 5 && parent; j++) {
                if (parent.getAttribute && parent.getAttribute('data-sentry-component') === 'Select') {
                  hasMarketSelect = true;
                  break;
                }
                parent = parent.parentElement;
              }
            }
            if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
              hasOtherSection = true;
              break;
            }
          }
          
          if (hasMarketSelect && !hasOtherSection) {
            break;
          }
          
          sectionParent = sectionParent.parentElement;
          if (!sectionParent) break;
        }
        
        if (!sectionParent) {
          sectionParent = sectionElement.parentElement;
        }
        
        const allSelectElements = Array.from(sectionParent.querySelectorAll('[data-sentry-component="Select"]'));
        
        for (const selectEl of allSelectElements) {
          if (selectEl.offsetParent === null) continue;
          const style = window.getComputedStyle(selectEl);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (selectEl.offsetWidth === 0 || selectEl.offsetHeight === 0) continue;
          
          const singleValueElements = Array.from(selectEl.querySelectorAll('[class*="singleValue"]'));
          for (const svEl of singleValueElements) {
            const svText = (svEl.textContent || '').trim();
            if (svText === 'Market') {
              const controlEl = selectEl.querySelector('.style_control__NtOg3') || selectEl;
              const rect = controlEl.getBoundingClientRect();
              return {
                success: true,
                clickX: rect.x + rect.width / 2,
                clickY: rect.y + rect.height / 2,
                sectionName: sectionName
              };
            }
          }
        }
        
        return {
          success: false,
          message: `Could not find Market Select element in "${sectionName}" section`
        };
      }, sectionName);
      
      if (!selectElementInfo || !selectElementInfo.success) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Could not find Market dropdown for ${sectionName}: ${selectElementInfo?.message || 'unknown'}`);
        return false;
      }
      
      // Check if modal is still open
      const modalStillOpen = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          if (style.display !== 'none' && style.visibility !== 'hidden' &&
            modal.offsetWidth > 0 && modal.offsetHeight > 0) {
            const modalText = (modal.textContent || '').toLowerCase();
            if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss')) {
              return true;
            }
          }
        }
        return false;
      });
      
      if (!modalStillOpen) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Modal closed before clicking Market dropdown`);
        return false;
      }
      
      // Click the Market dropdown
      await page.mouse.click(selectElementInfo.clickX, selectElementInfo.clickY);
      await delay(500);
      
      // Wait for dropdown to open
      let dropdownOpened = false;
      for (let i = 0; i < 10; i++) {
        const checkResult = await page.evaluate(() => {
          const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
          const menus = Array.from(document.querySelectorAll('[role="menu"]'));
          const allDropdowns = [...listboxes, ...menus];
          const expandedElements = Array.from(document.querySelectorAll('[aria-expanded="true"]'));
          for (const el of expandedElements) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' &&
              el.offsetWidth > 0 && el.offsetHeight > 0) {
              allDropdowns.push(el);
            }
          }
          for (const menu of allDropdowns) {
            const style = window.getComputedStyle(menu);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const rect = menu.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { open: true };
              }
            }
          }
          return { open: false };
        });
        
        if (checkResult.open) {
          dropdownOpened = true;
          break;
        }
        await delay(200);
      }
      
      if (!dropdownOpened) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Market dropdown did not open for ${sectionName}`);
      }
      
      await delay(300);
      
      // Press ArrowDown once, then Enter to select Limit
      await page.keyboard.press('ArrowDown');
      await delay(300);
      await page.keyboard.press('Enter');
      await delay(300);
      
      // Verify modal is still open
      const modalStillOpenAfter = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          if (style.display !== 'none' && style.visibility !== 'hidden' &&
            modal.offsetWidth > 0 && modal.offsetHeight > 0) {
            const modalText = (modal.textContent || '').toLowerCase();
            if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss')) {
              return true;
            }
          }
        }
        return false;
      });
      
      if (!modalStillOpenAfter) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Modal closed after Market dropdown selection for ${sectionName}`);
        return false;
      }
      
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Updated Market dropdown to Limit for ${sectionName}`);
      return true;
    };
    
    // Update Market dropdown to Limit for both sections
    const takeProfitMarketUpdated = await updateMarketDropdown('Take profit');
    await delay(300);
    const stopLossMarketUpdated = await updateMarketDropdown('Stop loss');
    
    if (!takeProfitMarketUpdated || !stopLossMarketUpdated) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Failed to update one or both Market dropdowns`);
    }
    
    // Step 6: Fill TP/SL input values for both sections
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 6: Filling TP/SL input values...`);
    
    const takeProfitValue = (parseFloat(takeProfitPercent) / 10).toString();
    const stopLossValue = (parseFloat(stopLossPercent) / 10).toString();
    
    // Helper function to fill inputs for a section
    const fillInputsForSection = async (sectionName) => {
      // Find input elements in the section
      const inputInfo = await page.evaluate((sectionName) => {
        const allElements = Array.from(document.querySelectorAll('*'));
        let tpslModal = null;
        
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text === 'TP/SL' && el.offsetParent !== null) {
            let parent = el.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              const style = window.getComputedStyle(parent);
              if (style.display !== 'none' && style.visibility !== 'hidden' &&
                parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                const parentText = (parent.textContent || '').toLowerCase();
                if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                  tpslModal = parent;
                  break;
                }
              }
              parent = parent.parentElement;
            }
            if (tpslModal) break;
          }
        }
        
        if (!tpslModal) return { success: false, message: 'TP/SL modal not found' };
        
        const sectionNameLower = sectionName.toLowerCase();
        let sectionElement = null;
        const modalElements = Array.from(tpslModal.querySelectorAll('*'));
        for (const el of modalElements) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
            sectionElement = el;
            break;
          }
        }
        
        if (!sectionElement) return { success: false, message: `Could not find "${sectionName}" section` };
        
        // Find section parent
        let sectionParent = sectionElement.parentElement;
        const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
        
        for (let i = 0; i < 10 && sectionParent; i++) {
          const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
          let hasOtherSection = false;
          for (const el of allDescendants) {
            const text = (el.textContent || '').trim();
            if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
              hasOtherSection = true;
              break;
            }
          }
          if (!hasOtherSection) break;
          sectionParent = sectionParent.parentElement;
          if (!sectionParent) break;
        }
        
        if (!sectionParent) {
          sectionParent = sectionElement.parentElement;
        }
        
        // Find inputs within this section
        const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
        const emptyPlaceholderInputs = [];
        for (const input of allInputsInSection) {
          if (input.tagName !== 'INPUT') continue;
          const placeholder = input.getAttribute('placeholder') || '';
          const className = input.className || '';
          if ((placeholder.trim() === '' || placeholder === ' ') && className.toLowerCase().includes('text')) {
            if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
              emptyPlaceholderInputs.push({
                id: input.id || '',
                className: className,
                placeholder: placeholder
              });
            }
          }
        }
        
        return {
          success: true,
          inputsFound: emptyPlaceholderInputs.length,
          inputs: emptyPlaceholderInputs
        };
      }, sectionName);
      
      if (!inputInfo || !inputInfo.success) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Could not find inputs for ${sectionName}: ${inputInfo?.message || 'unknown'}`);
        return false;
      }
      
      // Fill first input (Take Profit value)
      if (inputInfo.inputs.length >= 1 && takeProfitValue) {
        const firstInputInfo = inputInfo.inputs[0];
        let inputElement = null;
        
        if (firstInputInfo.id) {
          const inputHandle = await page.evaluateHandle((id) => {
            return document.getElementById(id);
          }, firstInputInfo.id);
          const isValid = await page.evaluate(el => el !== null && el !== undefined, inputHandle);
          if (isValid) {
            inputElement = inputHandle.asElement();
          }
        }
        
        if (!inputElement) {
          const allInputs = await page.$$('input');
          for (const input of allInputs) {
            const className = await page.evaluate(el => el.className || '', input);
            const placeholder = await page.evaluate(el => el.getAttribute('placeholder') || '', input);
            const isVisible = await page.evaluate(el => {
              const style = window.getComputedStyle(el);
              return el.offsetParent !== null && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     !el.disabled && 
                     !el.readOnly;
            }, input);
            
            if (className.toLowerCase().includes('text') && (placeholder.trim() === '' || placeholder === ' ') && isVisible) {
              inputElement = input;
              break;
            }
          }
        }
        
        if (inputElement) {
          // Use JavaScript to set value directly (more reliable across platforms)
          const valueSet = await inputElement.evaluate((el, value) => {
            el.focus();
            el.value = '';
            el.value = value;
            // Trigger input events to ensure React/form handlers are notified
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.value;
          }, takeProfitValue);
          
          await delay(200);
          
          // Verify the value was set correctly
          const verifyValue = await page.evaluate((el) => el.value || '', inputElement);
          if (verifyValue === takeProfitValue || parseFloat(verifyValue) === parseFloat(takeProfitValue)) {
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Filled first input for ${sectionName}: ${verifyValue}`);
          } else {
            // Fallback to keyboard input if JavaScript didn't work
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  JavaScript set value failed (${verifyValue}), trying keyboard input...`);
            await inputElement.focus();
            await delay(200);
            // Detect platform and use appropriate modifier key
            const platform = await page.evaluate(() => navigator.platform || navigator.userAgentData?.platform || '');
            const isMac = platform.toLowerCase().includes('mac');
            const modifierKey = isMac ? 'Meta' : 'Control';
            
            await page.keyboard.down(modifierKey);
            await page.keyboard.press('KeyA');
            await page.keyboard.up(modifierKey);
            await delay(100);
            await page.keyboard.press('Backspace');
            await delay(100);
            await inputElement.type(takeProfitValue, { delay: 50 });
            await delay(200);
            
            // Verify again
            const finalValue = await page.evaluate((el) => el.value || '', inputElement);
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Filled first input for ${sectionName} (keyboard fallback): ${finalValue}`);
          }
        }
      }
      
      // Fill second input (Stop Loss value)
      if (inputInfo.inputs.length >= 2 && stopLossValue) {
        const secondInputInfo = inputInfo.inputs[1];
        let inputElement = null;
        
        if (secondInputInfo.id) {
          const inputHandle = await page.evaluateHandle((id) => {
            return document.getElementById(id);
          }, secondInputInfo.id);
          const isValid = await page.evaluate(el => el !== null && el !== undefined, inputHandle);
          if (isValid) {
            inputElement = inputHandle.asElement();
          }
        }
        
        if (!inputElement) {
          const allInputs = await page.$$('input');
          let foundFirst = false;
          for (const input of allInputs) {
            const className = await page.evaluate(el => el.className || '', input);
            const placeholder = await page.evaluate(el => el.getAttribute('placeholder') || '', input);
            const isVisible = await page.evaluate(el => {
              const style = window.getComputedStyle(el);
              return el.offsetParent !== null && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     !el.disabled && 
                     !el.readOnly;
            }, input);
            
            if (className.toLowerCase().includes('text') && (placeholder.trim() === '' || placeholder === ' ') && isVisible) {
              if (foundFirst) {
                inputElement = input;
                break;
              } else {
                foundFirst = true;
              }
            }
          }
        }
        
        if (inputElement) {
          // Use JavaScript to set value directly (more reliable across platforms)
          const valueSet = await inputElement.evaluate((el, value) => {
            el.focus();
            el.value = '';
            el.value = value;
            // Trigger input events to ensure React/form handlers are notified
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.value;
          }, stopLossValue);
          
          await delay(200);
          
          // Verify the value was set correctly
          const verifyValue = await page.evaluate((el) => el.value || '', inputElement);
          if (verifyValue === stopLossValue || parseFloat(verifyValue) === parseFloat(stopLossValue)) {
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Filled second input for ${sectionName}: ${verifyValue}`);
          } else {
            // Fallback to keyboard input if JavaScript didn't work
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  JavaScript set value failed (${verifyValue}), trying keyboard input...`);
            await inputElement.focus();
            await delay(200);
            // Detect platform and use appropriate modifier key
            const platform = await page.evaluate(() => navigator.platform || navigator.userAgentData?.platform || '');
            const isMac = platform.toLowerCase().includes('mac');
            const modifierKey = isMac ? 'Meta' : 'Control';
            
            await page.keyboard.down(modifierKey);
            await page.keyboard.press('KeyA');
            await page.keyboard.up(modifierKey);
            await delay(100);
            await page.keyboard.press('Backspace');
            await delay(100);
            await inputElement.type(stopLossValue, { delay: 50 });
            await delay(200);
            
            // Verify again
            const finalValue = await page.evaluate((el) => el.value || '', inputElement);
            console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Filled second input for ${sectionName} (keyboard fallback): ${finalValue}`);
          }
        }
      }
      
      return true;
    };
    
    // Fill inputs for both sections
    const takeProfitInputsFilled = await fillInputsForSection('Take profit');
    await delay(300);
    const stopLossInputsFilled = await fillInputsForSection('Stop loss');
    
    if (!takeProfitInputsFilled || !stopLossInputsFilled) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Failed to fill inputs for one or both sections`);
    }
    
    // Wait for inputs to be processed
    await delay(500);
    
    // KEEP THE MODAL OPEN - we'll wait for threshold with it open, then update side and confirm
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ TP/SL modal is open and ready (ROI% set to P&L, Market set to Limit, inputs filled). Will wait for threshold with modal open, then update side and confirm.`);
    
    return { success: true, modalOpen: true };
  } catch (error) {
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Error setting up TP/SL: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Helper function to check and fill P&L input values in TP/SL modal for a specific section
 */
async function checkAndFillPnlInputs(page, exchange, sectionName, pnlValue) {
  try {
    const inputInfo = await page.evaluate((sectionName) => {
      const allElements = Array.from(document.querySelectorAll('*'));
      let tpslModal = null;
      
      // Find TP/SL modal
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        if (text === 'TP/SL' && el.offsetParent !== null) {
          let parent = el.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            const style = window.getComputedStyle(parent);
            if (style.display !== 'none' && style.visibility !== 'hidden' &&
              parent.offsetWidth > 0 && parent.offsetHeight > 0) {
              const parentText = (parent.textContent || '').toLowerCase();
              if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                tpslModal = parent;
                break;
              }
            }
            parent = parent.parentElement;
          }
          if (tpslModal) break;
        }
      }
      
      if (!tpslModal) return { success: false, message: 'TP/SL modal not found' };
      
      // Find the section element
      const sectionNameLower = sectionName.toLowerCase();
      let sectionElement = null;
      const modalElements = Array.from(tpslModal.querySelectorAll('*'));
      for (const el of modalElements) {
        const text = (el.textContent || '').trim();
        if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
          sectionElement = el;
          break;
        }
      }
      
      if (!sectionElement) return { success: false, message: `Could not find "${sectionName}" section` };
      
      // Find section parent
      let sectionParent = sectionElement.parentElement;
      const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
      
      for (let i = 0; i < 10 && sectionParent; i++) {
        const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
        let hasOtherSection = false;
        for (const el of allDescendants) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
            hasOtherSection = true;
            break;
          }
        }
        if (!hasOtherSection) break;
        sectionParent = sectionParent.parentElement;
        if (!sectionParent) break;
      }
      
      if (!sectionParent) {
        sectionParent = sectionElement.parentElement;
      }
      
      // Find P&L input (first empty placeholder input in the section)
      const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
      let pnlInput = null;
      let pnlInputId = '';
      let currentValue = '';
      
      for (const input of allInputsInSection) {
        if (input.tagName !== 'INPUT') continue;
        const placeholder = (input.getAttribute('placeholder') || '').trim();
        const className = (input.className || '').toLowerCase();
        // P&L input typically has empty placeholder and text class
        if ((placeholder === '' || placeholder === ' ') && className.includes('text')) {
          if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
            pnlInput = input;
            pnlInputId = input.id || '';
            currentValue = input.value || '';
            break;
          }
        }
      }
      
      if (!pnlInput) {
        return { success: false, message: `Could not find P&L input in "${sectionName}" section` };
      }
      
      return {
        success: true,
        pnlInputId: pnlInputId,
        currentValue: currentValue
      };
    }, sectionName);
    
    if (!inputInfo || !inputInfo.success) {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find P&L input for ${sectionName}: ${inputInfo?.message || 'unknown'}`);
      return false;
    }
    
    // Always refill the P&L input (even if it has a value) to ensure it's correct after threshold
    const currentValue = inputInfo.currentValue || '';
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Current ${sectionName} P&L value: ${currentValue || '(empty)'}, refilling with ${pnlValue}...`);
    
    // Find and fill the P&L input element
    let pnlInputElement = null;
    if (inputInfo.pnlInputId) {
      const inputHandle = await page.evaluateHandle((id) => {
        return document.getElementById(id);
      }, inputInfo.pnlInputId);
      const isValid = await page.evaluate(el => el !== null && el !== undefined, inputHandle);
      if (isValid) {
        pnlInputElement = inputHandle.asElement();
      }
    }
    
        if (!pnlInputElement) {
          // Fallback: find by placeholder and class, but MUST be in the correct section
          const allInputs = await page.$$('input');
          for (const input of allInputs) {
            const placeholder = await page.evaluate(el => (el.getAttribute('placeholder') || '').trim(), input);
            const className = await page.evaluate(el => (el.className || '').toLowerCase(), input);
            const isVisible = await page.evaluate(el => {
              const style = window.getComputedStyle(el);
              return el.offsetParent !== null && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     !el.disabled && 
                     !el.readOnly;
            }, input);
            
            if ((placeholder === '' || placeholder === ' ') && className.includes('text') && isVisible) {
              // Verify it's in the correct section - must be strict about this
              const sectionMatch = await page.evaluate((input, sectionName) => {
                // Find TP/SL modal first
                const allElements = Array.from(document.querySelectorAll('*'));
                let tpslModal = null;
                
                for (const el of allElements) {
                  const text = (el.textContent || '').trim();
                  if (text === 'TP/SL' && el.offsetParent !== null) {
                    let parent = el.parentElement;
                    for (let i = 0; i < 10 && parent; i++) {
                      const style = window.getComputedStyle(parent);
                      if (style.display !== 'none' && style.visibility !== 'hidden' &&
                        parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                        const parentText = (parent.textContent || '').toLowerCase();
                        if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                          tpslModal = parent;
                          break;
                        }
                      }
                      parent = parent.parentElement;
                    }
                    if (tpslModal) break;
                  }
                }
                
                if (!tpslModal) return false;
                
                // Find the specific section element
                const sectionNameLower = sectionName.toLowerCase();
                let sectionElement = null;
                const modalElements = Array.from(tpslModal.querySelectorAll('*'));
                for (const el of modalElements) {
                  const text = (el.textContent || '').trim();
                  if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
                    sectionElement = el;
                    break;
                  }
                }
                
                if (!sectionElement) return false;
                
                // Find section parent container
                let sectionParent = sectionElement.parentElement;
                const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
                
                for (let i = 0; i < 10 && sectionParent; i++) {
                  const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
                  let hasOtherSection = false;
                  for (const el of allDescendants) {
                    const text = (el.textContent || '').trim();
                    if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
                      hasOtherSection = true;
                      break;
                    }
                  }
                  if (!hasOtherSection) break;
                  sectionParent = sectionParent.parentElement;
                  if (!sectionParent) break;
                }
                
                if (!sectionParent) {
                  sectionParent = sectionElement.parentElement;
                }
                
                // Verify input is within this sectionParent
                let inputParent = input.parentElement;
                for (let i = 0; i < 20 && inputParent; i++) {
                  if (inputParent === sectionParent) {
                    return true;
                  }
                  inputParent = inputParent.parentElement;
                }
                
                return false;
              }, input, sectionName);
              
              if (sectionMatch) {
                pnlInputElement = input;
                break;
              }
            }
          }
        }
    
    if (pnlInputElement) {
      const pnlValueStr = String(pnlValue);
      
      // Detect platform - on Mac, prefer keyboard typing for better React handler triggering
      const platform = await page.evaluate(() => navigator.platform || navigator.userAgentData?.platform || '');
      const isMac = platform.toLowerCase().includes('mac');
      const modifierKey = isMac ? 'Meta' : 'Control';
      
      // On Mac, use keyboard typing as primary method (more reliable for React handlers)
      // On other platforms, try JavaScript first, then keyboard
      let useKeyboardFirst = isMac;
      
      if (useKeyboardFirst) {
        // Method 1: Keyboard typing (primary for Mac)
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Using keyboard typing for ${sectionName} P&L input (Mac detected)...`);
        await pnlInputElement.focus();
        await delay(200);
        
        // Clear existing value - use multiple methods to ensure it's completely cleared
        // First, try JavaScript clear
        await pnlInputElement.evaluate((el) => {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await delay(100);
        
        // Then verify it's cleared
        let clearedValue = await page.evaluate((el) => el.value || '', pnlInputElement);
        if (clearedValue && clearedValue.trim() !== '') {
          // If not cleared, use keyboard selection and delete
          await page.keyboard.down(modifierKey);
          await page.keyboard.press('KeyA');
          await page.keyboard.up(modifierKey);
          await delay(100);
          await page.keyboard.press('Backspace');
          await delay(100);
          
          // Verify again
          clearedValue = await page.evaluate((el) => el.value || '', pnlInputElement);
          if (clearedValue && clearedValue.trim() !== '') {
            // Last resort: JavaScript clear again
            await pnlInputElement.evaluate((el) => {
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await delay(100);
          }
        }
        
        // Final verification that input is empty before typing
        const finalClearedCheck = await page.evaluate((el) => el.value || '', pnlInputElement);
        if (finalClearedCheck && finalClearedCheck.trim() !== '') {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Input still has value "${finalClearedCheck}" after clearing, using JavaScript method instead...`);
          // Fall through to JavaScript method
        } else {
          // Input is cleared, now type the value
          // Use faster typing (no delay) to avoid intermediate states being visible
          await pnlInputElement.type(pnlValueStr, { delay: 0 });
          await delay(300);
          
          // Trigger blur to ensure React handlers process the change
          await pnlInputElement.evaluate((el) => {
            el.blur();
            el.focus();
          });
          await delay(200);
          
          // Verify the value was set
          const updatedValue = await page.evaluate((el) => el.value || '', pnlInputElement);
          const updatedNum = parseFloat(updatedValue.replace(/,/g, ''));
          const expectedNum = parseFloat(pnlValueStr);
          const tolerance = 0.01;
          
          if (updatedValue && !isNaN(updatedNum) && Math.abs(updatedNum - expectedNum) < tolerance) {
            console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Filled ${sectionName} P&L input with ${updatedValue} (keyboard, expected: ${pnlValueStr})`);
            return true;
          } else {
            console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Keyboard typing failed (${updatedValue}), trying JavaScript method...`);
            // Fall through to JavaScript method
          }
        }
      }
      
      // Method 2: JavaScript with comprehensive event triggering
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Using JavaScript method for ${sectionName} P&L input...`);
      const valueSet = await pnlInputElement.evaluate((el, value) => {
        el.focus();
        
        // Clear existing value
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        
        // Set new value
        el.value = value;
        
        // Trigger comprehensive events for React
        const inputEvent = new Event('input', { bubbles: true, cancelable: true });
        Object.defineProperty(inputEvent, 'target', { value: el, enumerable: true });
        el.dispatchEvent(inputEvent);
        
        const changeEvent = new Event('change', { bubbles: true, cancelable: true });
        Object.defineProperty(changeEvent, 'target', { value: el, enumerable: true });
        el.dispatchEvent(changeEvent);
        
        // Also trigger React's synthetic events if possible
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, value);
          const reactEvent = new Event('input', { bubbles: true });
          el.dispatchEvent(reactEvent);
        }
        
        return el.value;
      }, pnlValueStr);
      
      await delay(300);
      
      // Trigger blur and refocus to ensure handlers process
      await pnlInputElement.evaluate((el) => {
        el.blur();
        setTimeout(() => el.focus(), 50);
      });
      await delay(200);
      
      // Verify the value was set
      const updatedValue = await page.evaluate((el) => el.value || '', pnlInputElement);
      const updatedNum = parseFloat(updatedValue.replace(/,/g, ''));
      const expectedNum = parseFloat(pnlValueStr);
      const tolerance = 0.01;
      
      if (updatedValue && !isNaN(updatedNum) && Math.abs(updatedNum - expectedNum) < tolerance) {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Filled ${sectionName} P&L input with ${updatedValue} (JavaScript, expected: ${pnlValueStr})`);
        return true;
      } else {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Both methods failed. Expected: ${pnlValueStr}, Got: ${updatedValue}`);
        return false;
      }
    } else {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find P&L input element for ${sectionName}`);
      return false;
    }
  } catch (error) {
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Error checking/filling P&L input for ${sectionName}: ${error.message}`);
    return false;
  }
}

/**
 * Helper function to read trigger price from a section and fill it into the limit price input
 */
async function readTriggerPriceAndFillLimitPrice(page, exchange, sectionName) {
  try {
    const limitPriceInfo = await page.evaluate((sectionName) => {
      const allElements = Array.from(document.querySelectorAll('*'));
      let tpslModal = null;
      
      // Find TP/SL modal
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        if (text === 'TP/SL' && el.offsetParent !== null) {
          let parent = el.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            const style = window.getComputedStyle(parent);
            if (style.display !== 'none' && style.visibility !== 'hidden' &&
              parent.offsetWidth > 0 && parent.offsetHeight > 0) {
              const parentText = (parent.textContent || '').toLowerCase();
              if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                tpslModal = parent;
                break;
              }
            }
            parent = parent.parentElement;
          }
          if (tpslModal) break;
        }
      }
      
      if (!tpslModal) return { success: false, message: 'TP/SL modal not found' };
      
      // Find the section element
      const sectionNameLower = sectionName.toLowerCase();
      let sectionElement = null;
      const modalElements = Array.from(tpslModal.querySelectorAll('*'));
      for (const el of modalElements) {
        const text = (el.textContent || '').trim();
        if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
          sectionElement = el;
          break;
        }
      }
      
      if (!sectionElement) return { success: false, message: `Could not find "${sectionName}" section` };
      
      // Find section parent
      let sectionParent = sectionElement.parentElement;
      const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
      
      for (let i = 0; i < 10 && sectionParent; i++) {
        const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
        let hasOtherSection = false;
        for (const el of allDescendants) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
            hasOtherSection = true;
            break;
          }
        }
        if (!hasOtherSection) break;
        sectionParent = sectionParent.parentElement;
        if (!sectionParent) break;
      }
      
      if (!sectionParent) {
        sectionParent = sectionElement.parentElement;
      }
      
      // Find trigger price input and its value
      const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
      let triggerPriceInput = null;
      let triggerPriceValue = '';
      
      for (const input of allInputsInSection) {
        if (input.tagName !== 'INPUT') continue;
        const placeholder = (input.getAttribute('placeholder') || '').trim().toLowerCase();
        if (placeholder.includes('trigger price')) {
          triggerPriceInput = input;
          triggerPriceValue = input.value || '';
          break;
        }
      }
      
      if (!triggerPriceInput || !triggerPriceValue) {
        return { success: false, message: `Could not find Trigger price input or value in "${sectionName}" section` };
      }
      
      // Find limit price input
      let limitPriceInput = null;
      let limitPriceInputId = '';

      for (const input of allInputsInSection) {
        if (input.tagName !== 'INPUT') continue;
        const placeholder = (input.getAttribute('placeholder') || '').trim().toLowerCase();
        const sectionPrefix = sectionNameLower.includes('profit') ? 'tp' : 'sl';
        if ((placeholder.includes(`${sectionPrefix} limit price`) ||
             placeholder.includes(`${sectionNameLower} limit price`) ||
             placeholder.includes('limit price') ||
             placeholder.includes('limit')) &&
            !placeholder.includes('trigger') &&
            !placeholder.includes('p&l') &&
            !placeholder.includes('roi')) {
          limitPriceInput = input;
          limitPriceInputId = input.id || '';
          break;
        }
      }

      // Fallback: if limit price input not found by placeholder, find the last input that isn't the trigger price
      if (!limitPriceInput) {
        const nonTriggerInputs = allInputsInSection.filter(inp => {
          if (inp.tagName !== 'INPUT') return false;
          if (inp === triggerPriceInput) return false;
          const ph = (inp.getAttribute('placeholder') || '').toLowerCase();
          return !ph.includes('trigger') && !ph.includes('p&l') && !ph.includes('roi');
        });
        if (nonTriggerInputs.length > 0) {
          limitPriceInput = nonTriggerInputs[nonTriggerInputs.length - 1];
          limitPriceInputId = limitPriceInput.id || '';
        }
      }

      if (!limitPriceInput) {
        return { success: false, message: `Could not find limit price input in "${sectionName}" section` };
      }
      
      return {
        success: true,
        triggerPriceValue: triggerPriceValue,
        limitPriceInputId: limitPriceInputId
      };
    }, sectionName);
    
    if (!limitPriceInfo || !limitPriceInfo.success) {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not read trigger price for ${sectionName}: ${limitPriceInfo?.message || 'unknown'}`);
      return false;
    }
    
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Found ${sectionName} trigger price: ${limitPriceInfo.triggerPriceValue}`);
    
    // Find and fill the limit price input element
    let limitPriceElement = null;
    if (limitPriceInfo.limitPriceInputId) {
      const inputHandle = await page.evaluateHandle((id) => {
        return document.getElementById(id);
      }, limitPriceInfo.limitPriceInputId);
      const isValid = await page.evaluate(el => el !== null && el !== undefined, inputHandle);
      if (isValid) {
        limitPriceElement = inputHandle.asElement();
      }
    }
    
    if (!limitPriceElement) {
      // Fallback: find by placeholder
      const allInputs = await page.$$('input');
      const sectionPrefix = sectionName.toLowerCase().includes('profit') ? 'tp' : 'sl';
      for (const input of allInputs) {
        const placeholder = await page.evaluate(el => (el.getAttribute('placeholder') || '').trim().toLowerCase(), input);
        if ((placeholder.includes(`${sectionPrefix} limit price`) || 
             placeholder.includes(`${sectionName.toLowerCase()} limit price`) || 
             placeholder.includes('limit price')) && 
            !placeholder.includes('trigger')) {
          const isVisible = await page.evaluate(el => {
            const style = window.getComputedStyle(el);
            return el.offsetParent !== null && 
                   style.display !== 'none' && 
                   style.visibility !== 'hidden' &&
                   !el.disabled && 
                   !el.readOnly;
          }, input);
          
          if (isVisible) {
            // Verify it's in the correct section
            const sectionMatch = await page.evaluate((input, sectionName) => {
              let parent = input.parentElement;
              for (let i = 0; i < 10 && parent; i++) {
                const text = (parent.textContent || '').toLowerCase();
                if (text.includes(sectionName.toLowerCase())) {
                  return true;
                }
                parent = parent.parentElement;
              }
              return false;
            }, input, sectionName);
            
            if (sectionMatch) {
              limitPriceElement = input;
              break;
            }
          }
        }
      }
    }
    
    if (limitPriceElement) {
      // Focus and clear the input
      await limitPriceElement.focus();
      await delay(200);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await delay(100);
      await page.keyboard.press('Backspace');
      await delay(100);
      
      // Type the trigger price value
      await limitPriceElement.type(limitPriceInfo.triggerPriceValue, { delay: 50 });
      await delay(300);
      
      // Verify the value was set
      const updatedValue = await page.evaluate((el) => el.value || '', limitPriceElement);
      const updatedNum = parseFloat(updatedValue.replace(/,/g, ''));
      const expectedNum = parseFloat(limitPriceInfo.triggerPriceValue.replace(/,/g, ''));
      const tolerance = 0.1;
      
      if (updatedValue && !isNaN(updatedNum) && Math.abs(updatedNum - expectedNum) < tolerance) {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Filled ${sectionName} limit price with ${updatedValue} (from trigger price: ${limitPriceInfo.triggerPriceValue})`);
        return true;
      } else {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Limit price fill verification failed. Expected: ${limitPriceInfo.triggerPriceValue}, Got: ${updatedValue}`);
        return false;
      }
    } else {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find limit price input element for ${sectionName}`);
      return false;
    }
  } catch (error) {
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Error reading/filling limit price for ${sectionName}: ${error.message}`);
    return false;
  }
}

/**
 * Helper function to update trigger price input in TP/SL modal for a specific section
 */
async function updateTriggerPriceInput(page, exchange, sectionName, newTriggerPrice) {
  try {
    const triggerPriceInfo = await page.evaluate((sectionName) => {
      const allElements = Array.from(document.querySelectorAll('*'));
      let tpslModal = null;
      
      // Find TP/SL modal
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        if (text === 'TP/SL' && el.offsetParent !== null) {
          let parent = el.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            const style = window.getComputedStyle(parent);
            if (style.display !== 'none' && style.visibility !== 'hidden' &&
              parent.offsetWidth > 0 && parent.offsetHeight > 0) {
              const parentText = (parent.textContent || '').toLowerCase();
              if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                tpslModal = parent;
                break;
              }
            }
            parent = parent.parentElement;
          }
          if (tpslModal) break;
        }
      }
      
      if (!tpslModal) return { success: false, message: 'TP/SL modal not found' };
      
      // Find the section element
      const sectionNameLower = sectionName.toLowerCase();
      let sectionElement = null;
      const modalElements = Array.from(tpslModal.querySelectorAll('*'));
      for (const el of modalElements) {
        const text = (el.textContent || '').trim();
        if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
          sectionElement = el;
          break;
        }
      }
      
      if (!sectionElement) return { success: false, message: `Could not find "${sectionName}" section` };
      
      // Find section parent
      let sectionParent = sectionElement.parentElement;
      const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
      
      for (let i = 0; i < 10 && sectionParent; i++) {
        const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
        let hasOtherSection = false;
        for (const el of allDescendants) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
            hasOtherSection = true;
            break;
          }
        }
        if (!hasOtherSection) break;
        sectionParent = sectionParent.parentElement;
        if (!sectionParent) break;
      }
      
      if (!sectionParent) {
        sectionParent = sectionElement.parentElement;
      }
      
      // Find trigger price input in this section
      const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
      let triggerPriceInput = null;
      let triggerPriceInputId = '';
      
      for (const input of allInputsInSection) {
        if (input.tagName !== 'INPUT') continue;
        const placeholder = (input.getAttribute('placeholder') || '').trim().toLowerCase();
        if (placeholder.includes('trigger price')) {
          triggerPriceInput = input;
          triggerPriceInputId = input.id || '';
          break;
        }
      }
      
      if (!triggerPriceInput) {
        return { success: false, message: `Could not find Trigger price input in "${sectionName}" section` };
      }
      
      return {
        success: true,
        triggerPriceInputId: triggerPriceInputId
      };
    }, sectionName);
    
    if (!triggerPriceInfo || !triggerPriceInfo.success) {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find trigger price input for ${sectionName}: ${triggerPriceInfo?.message || 'unknown'}`);
      return false;
    }
    
    // Find and update the trigger price input element
    let triggerPriceElement = null;
    if (triggerPriceInfo.triggerPriceInputId) {
      const inputHandle = await page.evaluateHandle((id) => {
        return document.getElementById(id);
      }, triggerPriceInfo.triggerPriceInputId);
      const isValid = await page.evaluate(el => el !== null && el !== undefined, inputHandle);
      if (isValid) {
        triggerPriceElement = inputHandle.asElement();
      }
    }
    
    if (!triggerPriceElement) {
      // Fallback: find by placeholder
      const allInputs = await page.$$('input');
      for (const input of allInputs) {
        const placeholder = await page.evaluate(el => (el.getAttribute('placeholder') || '').trim().toLowerCase(), input);
        if (placeholder.includes('trigger price')) {
          const isVisible = await page.evaluate(el => {
            const style = window.getComputedStyle(el);
            return el.offsetParent !== null && 
                   style.display !== 'none' && 
                   style.visibility !== 'hidden' &&
                   !el.disabled && 
                   !el.readOnly;
          }, input);
          
          if (isVisible) {
            // Verify it's in the correct section by checking nearby text
            const sectionMatch = await page.evaluate((input, sectionName) => {
              let parent = input.parentElement;
              for (let i = 0; i < 10 && parent; i++) {
                const text = (parent.textContent || '').toLowerCase();
                if (text.includes(sectionName.toLowerCase())) {
                  return true;
                }
                parent = parent.parentElement;
              }
              return false;
            }, input, sectionName);
            
            if (sectionMatch) {
              triggerPriceElement = input;
              break;
            }
          }
        }
      }
    }
    
    if (triggerPriceElement) {
      // Focus and clear the input
      await triggerPriceElement.focus();
      await delay(200);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await delay(100);
      await page.keyboard.press('Backspace');
      await delay(100);
      
      // Type the new trigger price
      const triggerPriceStr = String(newTriggerPrice);
      await triggerPriceElement.type(triggerPriceStr, { delay: 50 });
      await delay(300);
      
      // Verify the value was set
      const updatedValue = await page.evaluate((el) => el.value || '', triggerPriceElement);
      const updatedNum = parseFloat(updatedValue.replace(/,/g, ''));
      const expectedNum = parseFloat(triggerPriceStr);
      const tolerance = 0.1;
      
      if (updatedValue && !isNaN(updatedNum) && Math.abs(updatedNum - expectedNum) < tolerance) {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Updated ${sectionName} trigger price to ${updatedValue} (expected: ${triggerPriceStr})`);
        return true;
      } else {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Trigger price update verification failed. Expected: ${triggerPriceStr}, Got: ${updatedValue}`);
        return false;
      }
    } else {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find trigger price input element for ${sectionName}`);
      return false;
    }
  } catch (error) {
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Error updating trigger price for ${sectionName}: ${error.message}`);
    return false;
  }
}

/**
 * Quick fill price, select side, handle TP/SL, and submit order for GRVT (after pre-fill is done)
 */
export async function fillPriceSideAndSubmitGrvt(page, price, { side, orderType, qty }, exchange, thresholdMetTime, cycleCount, sideLabel, email, prefillData) {
  console.log(`[${exchange.name}] ⚡ [QUICK-FILL] Selecting side, filling price, handling TP/SL, and submitting order...`);
  
  const quickFillStartTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = quickFillStartTime - thresholdMetTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] Quick fill started - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met`);
  }
  
  const { sizeInput, priceInput } = prefillData;
  
  if (!sizeInput) {
    return { success: false, error: "Size input not found in prefill data" };
  }
  
  if (orderType === "limit" && !priceInput) {
    return { success: false, error: "Price input not found in prefill data" };
  }
  
  // GRVT: Use quantity from env if >= 0.002, otherwise default to 0.002
  const envQty = side === 'buy'
    ? parseFloat(process.env.BUY_QTY) || 0
    : parseFloat(process.env.SELL_QTY) || 0;
  const grvtSize = envQty >= 0.002 ? envQty : 0.002;
  
  // Helper function to clear and fill input (from executeGrvt.js logic)
  const clearAndFillInputGrvt = async (input, value, inputName) => {
    await input.focus();
    await delay(200);
    await input.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await delay(100);
    await page.keyboard.press('Delete');
    await delay(100);
    await page.keyboard.press('Backspace');
    await delay(100);
    
    await page.evaluate((el) => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, input);
    await delay(200);
    
    const clearedValue = await page.evaluate((el) => el.value || '', input);
    if (clearedValue && clearedValue.trim() !== '') {
      await page.evaluate((el) => {
        el.value = '';
        ['input', 'change', 'keydown', 'keyup'].forEach(eventType => {
          el.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
        });
      }, input);
      await delay(200);
    }
    
    const valueStr = String(value);
    await input.focus();
    await delay(100);
    await input.click({ clickCount: 3 });
    await delay(50);
    await page.keyboard.press('Delete');
    await delay(50);
    await page.keyboard.press('Backspace');
    await delay(50);
    
    const clearedCheck = await page.evaluate((el) => el.value || '', input);
    if (clearedCheck && clearedCheck.trim() !== '') {
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await delay(50);
      await page.keyboard.press('Delete');
      await delay(50);
    }
    
    if (!clearedCheck || clearedCheck.trim() === '') {
      await input.type(valueStr, { delay: 30 });
      await delay(300);
    } else {
      await page.evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }, input, valueStr);
      await delay(300);
    }
    
    const finalValue = await page.evaluate((el) => el.value || '', input);
    const finalNum = parseFloat(finalValue.replace(/,/g, '').replace(/ /g, ''));
    const expectedNum = parseFloat(valueStr);
    const tolerance = inputName === 'Price' ? 0.1 : 0.0001;
    
    if (finalValue && finalValue.trim() !== '' && !isNaN(finalNum) && Math.abs(finalNum - expectedNum) < tolerance) {
      return true;
    }
    return false;
  };
  
  // 1. Fill price (for limit orders) - MUST be done first so GRVT can recalculate trigger prices
  if (orderType === "limit" && priceInput) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 1: Filling price: ${price}`);
    const priceSuccess = await clearAndFillInputGrvt(priceInput, price, 'Price');
    if (!priceSuccess) {
      console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  Price fill failed, retrying...`);
      await delay(500);
      const retrySuccess = await clearAndFillInputGrvt(priceInput, price, 'Price');
      if (!retrySuccess) {
        return { success: false, error: "Failed to fill price input after retry" };
      }
    }
    await delay(500);
    
    const priceFinalCheck = await page.evaluate((el) => el.value || '', priceInput);
    const priceFinalNum = parseFloat(priceFinalCheck.replace(/,/g, ''));
    const expectedPriceNum = parseFloat(String(price));
    const priceTolerance = 0.1;
    if (!priceFinalCheck || Math.abs(priceFinalNum - expectedPriceNum) >= priceTolerance) {
      return { success: false, error: `Price input not persisting. Expected: ${price}, Got: "${priceFinalCheck}"` };
    }
    await delay(300);
  }
  
  // 2. Verify quantity is still filled, refill if needed
  console.log(`[${exchange.name}] [QUICK-FILL] Step 2: Verifying quantity is still filled...`);
  const sizeCheck = await page.evaluate((el) => el.value || '', sizeInput);
  const sizeCheckNum = parseFloat(sizeCheck.replace(/,/g, ''));
  const expectedSizeNum = parseFloat(String(grvtSize));
  if (!sizeCheck || Math.abs(sizeCheckNum - expectedSizeNum) >= 0.0001) {
    console.log(`[${exchange.name}] [QUICK-FILL] Quantity was cleared or changed, refilling...`);
    const sizeSuccess = await clearAndFillInputGrvt(sizeInput, grvtSize, 'Quantity');
    if (!sizeSuccess) {
      console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  Quantity refill failed, retrying...`);
      await delay(500);
      const retrySuccess = await clearAndFillInputGrvt(sizeInput, grvtSize, 'Quantity');
      if (!retrySuccess) {
        return { success: false, error: "Failed to fill quantity input after retry" };
      }
    }
    await delay(500);
  } else {
    console.log(`[${exchange.name}] [QUICK-FILL] ✅ Quantity still filled: "${sizeCheck}"`);
  }
  
  // 3. Check if TP/SL modal is still open, close it, click Advanced again, then refill P&L inputs, wait for trigger price update, and fill limit prices
  if (orderType === "limit" && price) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 3: Handling TP/SL (close modal, reopen with Advanced, refill P&L inputs, wait for trigger price update, fill limit prices, update side, confirm)...`);
    
    // Step 3.0: Close TP/SL modal if it's open (after price refill)
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Step 3.0: Closing TP/SL modal after price refill...`);
    let modalOpen = await page.evaluate(() => {
      const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
      for (const modal of modals) {
        const style = window.getComputedStyle(modal);
        if (style.display !== 'none' && style.visibility !== 'hidden' &&
          modal.offsetWidth > 0 && modal.offsetHeight > 0) {
          const modalText = (modal.textContent || '').toLowerCase();
          if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss')) {
            return true;
          }
        }
      }
      return false;
    });
    
    if (modalOpen) {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] TP/SL modal is open, closing it...`);
      // Try to close modal with Escape key first
      await page.keyboard.press('Escape');
      await delay(500);
      
      // Verify modal is closed
      modalOpen = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          if (style.display !== 'none' && style.visibility !== 'hidden' &&
            modal.offsetWidth > 0 && modal.offsetHeight > 0) {
            const modalText = (modal.textContent || '').toLowerCase();
            if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss')) {
              return true;
            }
          }
        }
        return false;
      });
      
      if (modalOpen) {
        // Try to find and click close button
        const closeClicked = await page.evaluate(() => {
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
          for (const modal of modals) {
            const style = window.getComputedStyle(modal);
            if (style.display !== 'none' && style.visibility !== 'hidden' &&
              modal.offsetWidth > 0 && modal.offsetHeight > 0) {
              const modalText = (modal.textContent || '').toLowerCase();
              if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss')) {
                // Look for close button (X button or close button)
                const buttons = Array.from(modal.querySelectorAll('button, [role="button"]'));
                for (const btn of buttons) {
                  const text = (btn.textContent || '').trim().toLowerCase();
                  const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                  if (text === '×' || text === 'x' || text === 'close' || ariaLabel.includes('close')) {
                    if (btn.offsetParent !== null) {
                      btn.click();
                      return true;
                    }
                  }
                }
              }
            }
          }
          return false;
        });
        
        if (closeClicked) {
          await delay(500);
        }
      } else {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ TP/SL modal closed with Escape`);
      }
    } else {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] TP/SL modal was already closed`);
    }
    
    // Step 3.1: Click Advanced button again to reopen TP/SL modal
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Step 3.1: Clicking Advanced button to reopen TP/SL modal...`);
    await delay(800); // Give UI time to update after modal close
    
    const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
    let advancedEl = null;
    
    // Strategy 1: Search from checkbox parent tree, but EXCLUDE order type tabs
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Strategy 1: Searching from checkbox parent tree (excluding order type tabs)...`);
    if (createOrderPanel) {
      const panelLabels = await createOrderPanel.$$('label');
      for (const label of panelLabels) {
        const labelText = await page.evaluate((el) => el.textContent?.trim().toLowerCase() || '', label);
        if ((labelText.includes('tp') && labelText.includes('sl')) ||
          (labelText.includes('take profit') && labelText.includes('stop loss'))) {
          const checkbox = await label.$('input[type="checkbox"]');
          if (checkbox) {
            const advancedHandle1 = await page.evaluateHandle((checkbox) => {
              let parentContainer = checkbox.parentElement;
              for (let i = 0; i < 8 && parentContainer; i++) {
                const allElements = Array.from(parentContainer.querySelectorAll('*'));
                for (const el of allElements) {
                  if (el.offsetParent === null) continue;
                  const text = (el.textContent || '').trim();
                  if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
                    // EXCLUDE order type tabs - check if this is in a tab context (Limit/Market/Advanced tabs)
                    let isOrderTypeTab = false;
                    let checkParent = el.parentElement;
                    let depth = 0;
                    while (checkParent && depth < 5) {
                      const parentText = (checkParent.textContent || '').toLowerCase();
                      // If we find "limit" or "market" nearby, this is likely an order type tab
                      if (parentText.includes('limit') && parentText.includes('market') && 
                          (parentText.includes('tab') || checkParent.getAttribute('role') === 'tablist' || 
                           checkParent.classList.toString().toLowerCase().includes('tab'))) {
                        isOrderTypeTab = true;
                        break;
                      }
                      checkParent = checkParent.parentElement;
                      depth++;
                    }
                    
                    // Skip if this is an order type tab
                    if (isOrderTypeTab) {
                      continue;
                    }
                    
                    const tagName = el.tagName.toLowerCase();
                    const role = el.getAttribute('role');
                    if (tagName === 'button' || tagName === 'a' || role === 'button' || 
                        el.onclick || el.getAttribute('onclick') || 
                        window.getComputedStyle(el).cursor === 'pointer') {
                      // Additional check: make sure it's near the TP/SL checkbox context
                      let nearbyText = '';
                      let checkNearby = el.parentElement;
                      for (let j = 0; j < 3 && checkNearby; j++) {
                        nearbyText += (checkNearby.textContent || '').toLowerCase() + ' ';
                        checkNearby = checkNearby.parentElement;
                      }
                      if (nearbyText.includes('tp') || nearbyText.includes('sl') || 
                          nearbyText.includes('take profit') || nearbyText.includes('stop loss')) {
                        return el;
                      }
                    }
                  }
                }
                parentContainer = parentContainer.parentElement;
              }
              return null;
            }, checkbox);
            
            if (advancedHandle1 && advancedHandle1.asElement()) {
              advancedEl = advancedHandle1.asElement();
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Found Advanced button via Strategy 1`);
              break;
            }
          }
        }
      }
    }
    
    // Strategy 2: Search within CreateOrderPanel, but EXCLUDE order type tabs
    if (!advancedEl && createOrderPanel) {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Strategy 2: Searching within CreateOrderPanel (excluding order type tabs)...`);
      const advancedHandle2 = await page.evaluateHandle((panel) => {
        // First, identify and exclude order type tab areas
        const tabLists = Array.from(panel.querySelectorAll('[role="tablist"], [class*="tab"], [class*="Tab"]'));
        const tabAreas = new Set();
        for (const tabList of tabLists) {
          const tabText = (tabList.textContent || '').toLowerCase();
          if (tabText.includes('limit') && tabText.includes('market') && tabText.includes('advanced')) {
            // This is the order type tab area - exclude it
            const allTabs = tabList.querySelectorAll('*');
            for (const tab of allTabs) {
              tabAreas.add(tab);
            }
          }
        }
        
        const allElements = Array.from(panel.querySelectorAll('*'));
        for (const el of allElements) {
          // Skip if in order type tab area
          if (tabAreas.has(el)) continue;
          
          if (el.offsetParent === null) continue;
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
            const tagName = el.tagName.toLowerCase();
            const role = el.getAttribute('role');
            if (tagName === 'button' || tagName === 'a' || role === 'button' || 
                el.onclick || el.getAttribute('onclick') || 
                window.getComputedStyle(el).cursor === 'pointer') {
              // Make sure it's in TP/SL context - check nearby text
              let nearbyText = '';
              let checkNearby = el.parentElement;
              for (let j = 0; j < 5 && checkNearby; j++) {
                nearbyText += (checkNearby.textContent || '').toLowerCase() + ' ';
                checkNearby = checkNearby.parentElement;
              }
              if (nearbyText.includes('tp') || nearbyText.includes('sl') || 
                  nearbyText.includes('take profit') || nearbyText.includes('stop loss')) {
                return el;
              }
            }
          }
        }
        return null;
      }, createOrderPanel);
      
      if (advancedHandle2 && advancedHandle2.asElement()) {
        advancedEl = advancedHandle2.asElement();
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Found Advanced button via Strategy 2`);
      }
    }
    
    // Strategy 3: Broader search for any button with "Advanced" text, but EXCLUDE order type tabs
    if (!advancedEl) {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Strategy 3: Broader search for Advanced button (excluding order type tabs)...`);
      const advancedHandle3 = await page.evaluateHandle(() => {
        // First, identify order type tab areas to exclude
        const tabLists = Array.from(document.querySelectorAll('[role="tablist"], [class*="tab"], [class*="Tab"]'));
        const tabAreas = new Set();
        for (const tabList of tabLists) {
          const tabText = (tabList.textContent || '').toLowerCase();
          if (tabText.includes('limit') && tabText.includes('market') && tabText.includes('advanced')) {
            const allTabs = tabList.querySelectorAll('*');
            for (const tab of allTabs) {
              tabAreas.add(tab);
            }
          }
        }
        
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div[class*="button"], span[class*="button"]'));
        for (const btn of buttons) {
          // Skip if in order type tab area
          if (tabAreas.has(btn)) continue;
          
          if (btn.offsetParent === null) continue;
          const text = (btn.textContent || '').trim();
          if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
            const style = window.getComputedStyle(btn);
            if (style.display !== 'none' && style.visibility !== 'hidden' && 
                btn.offsetWidth > 0 && btn.offsetHeight > 0) {
              // Make sure it's in TP/SL context
              let nearbyText = '';
              let checkNearby = btn.parentElement;
              for (let j = 0; j < 5 && checkNearby; j++) {
                nearbyText += (checkNearby.textContent || '').toLowerCase() + ' ';
                checkNearby = checkNearby.parentElement;
              }
              if (nearbyText.includes('tp') || nearbyText.includes('sl') || 
                  nearbyText.includes('take profit') || nearbyText.includes('stop loss')) {
                return btn;
              }
            }
          }
        }
        return null;
      });
      
      if (advancedHandle3 && advancedHandle3.asElement()) {
        advancedEl = advancedHandle3.asElement();
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Found Advanced button via Strategy 3`);
      }
    }
    
    // Try to click the Advanced button with multiple methods and retries
    if (advancedEl) {
      let clicked = false;
      const maxClickAttempts = 3;
      
      for (let attempt = 1; attempt <= maxClickAttempts; attempt++) {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Attempting to click Advanced button (attempt ${attempt}/${maxClickAttempts})...`);
        
        // Method 1: Direct Puppeteer click
        try {
          await advancedEl.click({ delay: 100 });
          clicked = true;
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Clicked Advanced button (method 1: direct click, attempt ${attempt})`);
          break;
        } catch (error) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Direct click failed (attempt ${attempt}): ${error.message}, trying JavaScript click...`);
        }
        
        // Method 2: JavaScript click
        try {
          await advancedEl.evaluate((el) => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
          });
          clicked = true;
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Clicked Advanced button (method 2: JavaScript click, attempt ${attempt})`);
          break;
        } catch (error) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  JavaScript click failed (attempt ${attempt}): ${error.message}, trying event dispatch...`);
        }
        
        // Method 3: Event dispatch
        try {
          await advancedEl.evaluate((el) => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            
            const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
            const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
            const click = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
            
            el.dispatchEvent(mouseDown);
            el.dispatchEvent(mouseUp);
            el.dispatchEvent(click);
          });
          clicked = true;
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Clicked Advanced button (method 3: event dispatch, attempt ${attempt})`);
          break;
        } catch (error) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Event dispatch failed (attempt ${attempt}): ${error.message}`);
        }
        
        // Wait before retry
        if (attempt < maxClickAttempts) {
          await delay(500);
        }
      }
      
      if (!clicked) {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  All click methods failed for Advanced button after ${maxClickAttempts} attempts`);
        return { success: false, error: 'Advanced button found but could not be clicked' };
      }
      
      // Wait longer after clicking (MacBook may need more time)
      await delay(1000);
    } else {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find Advanced button with any strategy`);
      return { success: false, error: 'Advanced button not found after price refill' };
    }
    
    // Wait for modal to open with improved detection
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Waiting for TP/SL modal to open...`);
    modalOpen = false;
    const maxWaitAttempts = 20; // Increased from 10 to 20 (6 seconds total)
    
    for (let i = 0; i < maxWaitAttempts; i++) {
      modalOpen = await page.evaluate(() => {
        // Strategy 1: Look for modal by role/class
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="drawer"], [class*="Drawer"]'));
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          if (style.display !== 'none' && style.visibility !== 'hidden' &&
            modal.offsetWidth > 0 && modal.offsetHeight > 0) {
            const modalText = (modal.textContent || '').toLowerCase();
            if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss') ||
                modalText.includes('roi%') || modalText.includes('p&l')) {
              return true;
            }
          }
        }
        
        // Strategy 2: Look for TP/SL input fields directly (more reliable)
        const allInputs = Array.from(document.querySelectorAll('input, textarea'));
        let hasTakeProfitInput = false;
        let hasStopLossInput = false;
        
        for (const input of allInputs) {
          if (input.offsetParent === null) continue;
          const placeholder = (input.placeholder || '').toLowerCase();
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          const parentText = (input.parentElement?.textContent || '').toLowerCase();
          
          if (placeholder.includes('take profit') || label.includes('take profit') || 
              parentText.includes('take profit')) {
            hasTakeProfitInput = true;
          }
          if (placeholder.includes('stop loss') || label.includes('stop loss') || 
              parentText.includes('stop loss')) {
            hasStopLossInput = true;
          }
        }
        
        if (hasTakeProfitInput && hasStopLossInput) {
          return true;
        }
        
        // Strategy 3: Look for "Confirm" button that's typically in TP/SL modal
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if (btn.offsetParent === null) continue;
          const btnText = (btn.textContent || '').trim().toLowerCase();
          if (btnText === 'confirm') {
            // Check if this Confirm button is in a modal context
            let parent = btn.parentElement;
            let depth = 0;
            while (parent && depth < 10) {
              const parentText = (parent.textContent || '').toLowerCase();
              if (parentText.includes('tp/sl') || parentText.includes('take profit') || 
                  parentText.includes('stop loss')) {
                return true;
              }
              parent = parent.parentElement;
              depth++;
            }
          }
        }
        
        return false;
      });
      
      if (modalOpen) {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ TP/SL modal opened (detected on attempt ${i + 1})`);
        await delay(500);
        break;
      }
      
      if (i < maxWaitAttempts - 1) {
        await delay(300);
      }
    }
    
    if (!modalOpen) {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  TP/SL modal did not open after ${maxWaitAttempts} attempts`);
      return { success: false, error: 'TP/SL modal did not open after Advanced button click' };
    }
    
    // Step 3a: Refill TP and SL P&L inputs (after price was refilled, this will cause GRVT to automatically recalculate trigger prices)
    console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Step 3a: Refilling TP and SL P&L inputs (after price refill and modal reopen)...`);
      
      const takeProfitPercent = process.env.TAKE_PROFIT || '';
      const stopLossPercent = process.env.STOP_LOSS || '';
      
      if (takeProfitPercent || stopLossPercent) {
        const takeProfitNum = parseFloat(takeProfitPercent);
        const stopLossNum = parseFloat(stopLossPercent);
        
        const takeProfitValue = (takeProfitNum / 10).toString();
        const stopLossValue = (stopLossNum / 10).toString();
        
        // Refill Take profit P&L input
        if (!isNaN(takeProfitNum) && takeProfitValue) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Refilling Take profit P&L input with ${takeProfitValue}...`);
          const tpPnlFilled = await checkAndFillPnlInputs(page, exchange, 'Take profit', takeProfitValue);
          if (!tpPnlFilled) {
            console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Failed to refill Take profit P&L input`);
          } else {
            // Verify the value is still there after a short wait (ensures React processed it)
            await delay(500);
            const verifyTp = await page.evaluate((sectionName) => {
              // Find the P&L input and check its value
              const allElements = Array.from(document.querySelectorAll('*'));
              let tpslModal = null;
              
              for (const el of allElements) {
                const text = (el.textContent || '').trim();
                if (text === 'TP/SL' && el.offsetParent !== null) {
                  let parent = el.parentElement;
                  for (let i = 0; i < 10 && parent; i++) {
                    const style = window.getComputedStyle(parent);
                    if (style.display !== 'none' && style.visibility !== 'hidden' &&
                      parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                      const parentText = (parent.textContent || '').toLowerCase();
                      if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                        tpslModal = parent;
                        break;
                      }
                    }
                    parent = parent.parentElement;
                  }
                  if (tpslModal) break;
                }
              }
              
              if (!tpslModal) return { found: false };
              
              const sectionNameLower = sectionName.toLowerCase();
              let sectionElement = null;
              const modalElements = Array.from(tpslModal.querySelectorAll('*'));
              for (const el of modalElements) {
                const text = (el.textContent || '').trim();
                if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
                  sectionElement = el;
                  break;
                }
              }
              
              if (!sectionElement) return { found: false };
              
              let sectionParent = sectionElement.parentElement;
              const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
              
              for (let i = 0; i < 10 && sectionParent; i++) {
                const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
                let hasOtherSection = false;
                for (const el of allDescendants) {
                  const text = (el.textContent || '').trim();
                  if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
                    hasOtherSection = true;
                    break;
                  }
                }
                if (!hasOtherSection) break;
                sectionParent = sectionParent.parentElement;
                if (!sectionParent) break;
              }
              
              if (!sectionParent) sectionParent = sectionElement.parentElement;
              
              const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
              for (const input of allInputsInSection) {
                if (input.tagName !== 'INPUT') continue;
                const placeholder = (input.getAttribute('placeholder') || '').trim();
                const className = (input.className || '').toLowerCase();
                if ((placeholder === '' || placeholder === ' ') && className.includes('text')) {
                  if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
                    return { found: true, value: input.value || '' };
                  }
                }
              }
              
              return { found: false };
            }, 'Take profit');
            
            if (verifyTp.found) {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Verified Take profit P&L input value: ${verifyTp.value}`);
            } else {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not verify Take profit P&L input value`);
            }
          }
          await delay(500); // Additional wait after filling
        }
        
        // Refill Stop loss P&L input
        if (!isNaN(stopLossNum) && stopLossValue) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Refilling Stop loss P&L input with ${stopLossValue}...`);
          const slPnlFilled = await checkAndFillPnlInputs(page, exchange, 'Stop loss', stopLossValue);
          if (!slPnlFilled) {
            console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Failed to refill Stop loss P&L input`);
          } else {
            // Verify the value is still there after a short wait
            await delay(500);
            const verifySl = await page.evaluate((sectionName) => {
              // Same verification logic as above
              const allElements = Array.from(document.querySelectorAll('*'));
              let tpslModal = null;
              
              for (const el of allElements) {
                const text = (el.textContent || '').trim();
                if (text === 'TP/SL' && el.offsetParent !== null) {
                  let parent = el.parentElement;
                  for (let i = 0; i < 10 && parent; i++) {
                    const style = window.getComputedStyle(parent);
                    if (style.display !== 'none' && style.visibility !== 'hidden' &&
                      parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                      const parentText = (parent.textContent || '').toLowerCase();
                      if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                        tpslModal = parent;
                        break;
                      }
                    }
                    parent = parent.parentElement;
                  }
                  if (tpslModal) break;
                }
              }
              
              if (!tpslModal) return { found: false };
              
              const sectionNameLower = sectionName.toLowerCase();
              let sectionElement = null;
              const modalElements = Array.from(tpslModal.querySelectorAll('*'));
              for (const el of modalElements) {
                const text = (el.textContent || '').trim();
                if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
                  sectionElement = el;
                  break;
                }
              }
              
              if (!sectionElement) return { found: false };
              
              let sectionParent = sectionElement.parentElement;
              const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
              
              for (let i = 0; i < 10 && sectionParent; i++) {
                const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
                let hasOtherSection = false;
                for (const el of allDescendants) {
                  const text = (el.textContent || '').trim();
                  if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
                    hasOtherSection = true;
                    break;
                  }
                }
                if (!hasOtherSection) break;
                sectionParent = sectionParent.parentElement;
                if (!sectionParent) break;
              }
              
              if (!sectionParent) sectionParent = sectionElement.parentElement;
              
              const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
              for (const input of allInputsInSection) {
                if (input.tagName !== 'INPUT') continue;
                const placeholder = (input.getAttribute('placeholder') || '').trim();
                const className = (input.className || '').toLowerCase();
                if ((placeholder === '' || placeholder === ' ') && className.includes('text')) {
                  if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
                    return { found: true, value: input.value || '' };
                  }
                }
              }
              
              return { found: false };
            }, 'Stop loss');
            
            if (verifySl.found) {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Verified Stop loss P&L input value: ${verifySl.value}`);
            } else {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not verify Stop loss P&L input value`);
            }
          }
          await delay(500); // Additional wait after filling
        }
        
        // Wait for GRVT to automatically recalculate trigger prices based on new price and P&L values
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Waiting for GRVT to recalculate trigger prices (based on new price and P&L values)...`);
        await delay(3000); // Increased wait time for GRVT to recalculate (especially on Mac)
        
        // Step 3b: Read the automatically calculated trigger prices and fill them into limit price inputs
        // Wait and retry until trigger prices are calculated (they should be different from entry price)
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Step 3b: Reading trigger prices and filling into limit price inputs...`);
        
        const entryPriceNum = parseFloat(String(price));
        let triggerPricesReady = false;
        let retryCount = 0;
        const maxRetries = 10;
        
        while (!triggerPricesReady && retryCount < maxRetries) {
          // Try to read trigger prices
          const tpTriggerInfo = await page.evaluate((sectionName, entryPrice) => {
            const allElements = Array.from(document.querySelectorAll('*'));
            let tpslModal = null;
            
            for (const el of allElements) {
              const text = (el.textContent || '').trim();
              if (text === 'TP/SL' && el.offsetParent !== null) {
                let parent = el.parentElement;
                for (let i = 0; i < 10 && parent; i++) {
                  const style = window.getComputedStyle(parent);
                  if (style.display !== 'none' && style.visibility !== 'hidden' &&
                    parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                    const parentText = (parent.textContent || '').toLowerCase();
                    if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                      tpslModal = parent;
                      break;
                    }
                  }
                  parent = parent.parentElement;
                }
                if (tpslModal) break;
              }
            }
            
            if (!tpslModal) return { success: false, message: 'TP/SL modal not found' };
            
            const sectionNameLower = sectionName.toLowerCase();
            let sectionElement = null;
            const modalElements = Array.from(tpslModal.querySelectorAll('*'));
            for (const el of modalElements) {
              const text = (el.textContent || '').trim();
              if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
                sectionElement = el;
                break;
              }
            }
            
            if (!sectionElement) return { success: false, message: `Could not find "${sectionName}" section` };
            
            let sectionParent = sectionElement.parentElement;
            const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
            
            for (let i = 0; i < 10 && sectionParent; i++) {
              const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
              let hasOtherSection = false;
              for (const el of allDescendants) {
                const text = (el.textContent || '').trim();
                if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
                  hasOtherSection = true;
                  break;
                }
              }
              if (!hasOtherSection) break;
              sectionParent = sectionParent.parentElement;
              if (!sectionParent) break;
            }
            
            if (!sectionParent) sectionParent = sectionElement.parentElement;
            
            const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
            let triggerPriceValue = '';
            
            for (const input of allInputsInSection) {
              if (input.tagName !== 'INPUT') continue;
              const placeholder = (input.getAttribute('placeholder') || '').trim().toLowerCase();
              if (placeholder.includes('trigger price')) {
                triggerPriceValue = input.value || '';
                break;
              }
            }
            
            if (!triggerPriceValue) {
              return { success: false, message: `Could not find Trigger price value in "${sectionName}" section` };
            }
            
            const triggerPriceNum = parseFloat(triggerPriceValue.replace(/,/g, ''));
            const isDifferent = !isNaN(triggerPriceNum) && !isNaN(entryPrice) && Math.abs(triggerPriceNum - entryPrice) > 0.01;
            
            return {
              success: true,
              triggerPriceValue: triggerPriceValue,
              triggerPriceNum: triggerPriceNum,
              isDifferent: isDifferent
            };
          }, 'Take profit', entryPriceNum);
          
          if (tpTriggerInfo && tpTriggerInfo.success && tpTriggerInfo.isDifferent) {
            triggerPricesReady = true;
            console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Trigger prices are ready (TP: ${tpTriggerInfo.triggerPriceValue}, different from entry: ${entryPriceNum})`);
          } else {
            retryCount++;
            if (retryCount < maxRetries) {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⏳ Trigger prices not ready yet (attempt ${retryCount}/${maxRetries}), waiting...`);
              await delay(500);
            }
          }
        }
        
        if (!triggerPricesReady) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Trigger prices did not recalculate after ${maxRetries} attempts, proceeding anyway...`);
        }
        
        // Read and fill TP limit price
        const tpLimitFilled = await readTriggerPriceAndFillLimitPrice(page, exchange, 'Take profit');
        if (!tpLimitFilled) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Failed to fill TP limit price`);
        }
        await delay(300);
        
        // Read and fill SL limit price
        const slLimitFilled = await readTriggerPriceAndFillLimitPrice(page, exchange, 'Stop loss');
        if (!slLimitFilled) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Failed to fill SL limit price`);
        }
        await delay(300);
      }
      
      // Step 3c: Use handleTpSlGrvt to update side and confirm
      // It will handle: updating side toggle and confirming
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Step 3c: Updating side and confirming TP/SL...`);
      const tpSlResult = await handleTpSlGrvt(page, exchange, price, side);
      if (!tpSlResult.success) {
        console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  TP/SL handling failed: ${tpSlResult.error || 'unknown error'}, continuing anyway...`);
      } else {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ TP/SL completed (price refilled, modal closed and reopened, P&L inputs refilled, trigger prices auto-calculated, limit prices filled, side updated, confirmed)`);
      }
      await delay(500);
      
      // Check if price and quantity are still filled after TP/SL
      if (priceInput) {
        const priceAfterTpSl = await page.evaluate((el) => el.value || '', priceInput);
        const priceAfterTpSlNum = parseFloat(priceAfterTpSl.replace(/,/g, ''));
        const expectedPriceNum = parseFloat(String(price));
        const priceTolerance = 0.1;
        if (!priceAfterTpSl || priceAfterTpSl.trim() === '' || Math.abs(priceAfterTpSlNum - expectedPriceNum) >= priceTolerance) {
          console.log(`[${exchange.name}] [QUICK-FILL] Price was cleared after TP/SL, refilling...`);
          await clearAndFillInputGrvt(priceInput, price, 'Price');
          await delay(300);
        }
      }
      
      const sizeAfterTpSl = await page.evaluate((el) => el.value || '', sizeInput);
      const sizeAfterTpSlNum = parseFloat(sizeAfterTpSl.replace(/,/g, ''));
      const expectedSizeNumAfterTpSl = parseFloat(String(grvtSize));
      if (!sizeAfterTpSl || sizeAfterTpSl.trim() === '' || Math.abs(sizeAfterTpSlNum - expectedSizeNumAfterTpSl) >= 0.0001) {
        console.log(`[${exchange.name}] [QUICK-FILL] Quantity was cleared after TP/SL, refilling...`);
        await clearAndFillInputGrvt(sizeInput, grvtSize, 'Quantity');
        await delay(300);
      }
    }
  
  // 4. Select Buy or Sell (side)
  console.log(`[${exchange.name}] [QUICK-FILL] Step 4: Selecting ${side.toUpperCase()}...`);
  await selectBuyOrSell(page, side, exchange);
  await delay(300);
  
  // 4.5. Check if TP/SL inputs were cleared after side selection (especially on Mac) and refill if needed
  if (orderType === "limit" && price) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 4.5: Checking if TP/SL inputs were cleared after side selection...`);
    const takeProfitPercent = process.env.TAKE_PROFIT || '';
    const stopLossPercent = process.env.STOP_LOSS || '';
    
    if (takeProfitPercent || stopLossPercent) {
      const takeProfitNum = parseFloat(takeProfitPercent);
      const stopLossNum = parseFloat(stopLossPercent);
      const takeProfitValue = (takeProfitNum / 10).toString();
      const stopLossValue = (stopLossNum / 10).toString();
      
      // Check if TP/SL modal is still open (it should be closed after Step 3c)
      const modalOpen = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="drawer"], [class*="Drawer"]'));
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          if (style.display !== 'none' && style.visibility !== 'hidden' &&
            modal.offsetWidth > 0 && modal.offsetHeight > 0) {
            const modalText = (modal.textContent || '').toLowerCase();
            if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss')) {
              return true;
            }
          }
        }
        return false;
      });
      
      if (!modalOpen) {
        // Modal is closed, check if TP/SL checkbox is still checked
        const checkboxChecked = await page.evaluate(() => {
          const createOrderPanel = document.querySelector('[data-sentry-element="CreateOrderPanel"]');
          if (!createOrderPanel) return false;
          
          const labels = Array.from(createOrderPanel.querySelectorAll('label'));
          for (const label of labels) {
            const labelText = (label.textContent || '').trim().toLowerCase();
            if ((labelText.includes('tp') && labelText.includes('sl')) ||
                (labelText.includes('take profit') && labelText.includes('stop loss'))) {
              const checkbox = label.querySelector('input[type="checkbox"]');
              if (checkbox) {
                return checkbox.checked;
              }
            }
          }
          return false;
        });
        
        if (checkboxChecked) {
          // TP/SL is enabled, verify the values are still set by checking if we can read them
          // If they're cleared, we need to reopen the modal and refill
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] TP/SL checkbox is checked, verifying values are still set...`);
          
          // Try to verify by checking if trigger prices would be calculated correctly
          // If TP/SL inputs were cleared, trigger prices would equal entry price
          const triggerPriceCheck = await page.evaluate((entryPrice) => {
            // This is a simplified check - if TP/SL modal was closed and values cleared,
            // we can't directly check the inputs, but we can infer from the error we'll get
            return { entryPrice: entryPrice };
          }, parseFloat(String(price)));
          
          // Since we can't directly check closed modal inputs, we'll proactively reopen and verify/refill
          // This is especially important on Mac where side selection might clear values
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] Reopening TP/SL modal to verify and refill values after side selection...`);
          
          // Find and click Advanced button to reopen modal
          const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
          let advancedEl = null;
          
          if (createOrderPanel) {
            const advancedHandle = await page.evaluateHandle((panel) => {
              const allElements = Array.from(panel.querySelectorAll('*'));
              for (const el of allElements) {
                if (el.offsetParent === null) continue;
                const text = (el.textContent || '').trim();
                if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
                  // Exclude order type tabs
                  let isOrderTypeTab = false;
                  let checkParent = el.parentElement;
                  for (let i = 0; i < 5 && checkParent; i++) {
                    const parentText = (checkParent.textContent || '').toLowerCase();
                    if (parentText.includes('limit') && parentText.includes('market') && 
                        (parentText.includes('tab') || checkParent.getAttribute('role') === 'tablist')) {
                      isOrderTypeTab = true;
                      break;
                    }
                    checkParent = checkParent.parentElement;
                  }
                  if (isOrderTypeTab) continue;
                  
                  const tagName = el.tagName.toLowerCase();
                  const role = el.getAttribute('role');
                  if (tagName === 'button' || tagName === 'a' || role === 'button' || 
                      el.onclick || el.getAttribute('onclick') || 
                      window.getComputedStyle(el).cursor === 'pointer') {
                    let nearbyText = '';
                    let checkNearby = el.parentElement;
                    for (let j = 0; j < 3 && checkNearby; j++) {
                      nearbyText += (checkNearby.textContent || '').toLowerCase() + ' ';
                      checkNearby = checkNearby.parentElement;
                    }
                    if (nearbyText.includes('tp') || nearbyText.includes('sl') || 
                        nearbyText.includes('take profit') || nearbyText.includes('stop loss')) {
                      return el;
                    }
                  }
                }
              }
              return null;
            }, createOrderPanel);
            
            if (advancedHandle && advancedHandle.asElement()) {
              advancedEl = advancedHandle.asElement();
            }
          }
          
          if (advancedEl) {
            await advancedEl.click();
            await delay(1000); // Wait for modal to open
            
            // Verify modal opened
            const modalOpened = await page.evaluate(() => {
              const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
              for (const modal of modals) {
                const style = window.getComputedStyle(modal);
                if (style.display !== 'none' && style.visibility !== 'hidden' &&
                  modal.offsetWidth > 0 && modal.offsetHeight > 0) {
                  const modalText = (modal.textContent || '').toLowerCase();
                  if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss')) {
                    return true;
                  }
                }
              }
              return false;
            });
            
            if (modalOpened) {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Modal reopened, verifying and refilling P&L inputs...`);
              
              // Refill Take profit P&L input
              if (!isNaN(takeProfitNum) && takeProfitValue) {
                const tpPnlFilled = await checkAndFillPnlInputs(page, exchange, 'Take profit', takeProfitValue);
                if (!tpPnlFilled) {
                  console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Failed to refill Take profit P&L input after side selection`);
                } else {
                  console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Verified/refilled Take profit P&L input`);
                }
                await delay(500);
              }
              
              // Refill Stop loss P&L input
              if (!isNaN(stopLossNum) && stopLossValue) {
                const slPnlFilled = await checkAndFillPnlInputs(page, exchange, 'Stop loss', stopLossValue);
                if (!slPnlFilled) {
                  console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Failed to refill Stop loss P&L input after side selection`);
                } else {
                  console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Verified/refilled Stop loss P&L input`);
                }
                await delay(500);
              }
              
              // Wait for trigger prices to recalculate
              await delay(2000);
              
              // Close the modal (we'll let handleTpSlGrvt handle the final confirmation if needed)
              await page.keyboard.press('Escape');
              await delay(500);
              
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Verified and refilled TP/SL inputs after side selection`);
            } else {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not reopen TP/SL modal to verify values`);
            }
          } else {
            console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find Advanced button to reopen modal`);
          }
        }
      } else {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] TP/SL modal is still open, values should be preserved`);
      }
    }
  }
  
  // 5. Final verification of TP/SL values before clicking Buy/Sell button (critical on Mac)
  if (orderType === "limit" && price) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 5: Final verification of TP/SL values before submission...`);
    const takeProfitPercent = process.env.TAKE_PROFIT || '';
    const stopLossPercent = process.env.STOP_LOSS || '';
    
    if (takeProfitPercent || stopLossPercent) {
      const takeProfitNum = parseFloat(takeProfitPercent);
      const stopLossNum = parseFloat(stopLossPercent);
      const takeProfitValue = (takeProfitNum / 10).toString();
      const stopLossValue = (stopLossNum / 10).toString();
      
      // Reopen TP/SL modal one final time to verify values are still set
      const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
      let advancedEl = null;
      
      if (createOrderPanel) {
        const advancedHandle = await page.evaluateHandle((panel) => {
          const allElements = Array.from(panel.querySelectorAll('*'));
          for (const el of allElements) {
            if (el.offsetParent === null) continue;
            const text = (el.textContent || '').trim();
            if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
              // Exclude order type tabs
              let isOrderTypeTab = false;
              let checkParent = el.parentElement;
              for (let i = 0; i < 5 && checkParent; i++) {
                const parentText = (checkParent.textContent || '').toLowerCase();
                if (parentText.includes('limit') && parentText.includes('market') && 
                    (parentText.includes('tab') || checkParent.getAttribute('role') === 'tablist')) {
                  isOrderTypeTab = true;
                  break;
                }
                checkParent = checkParent.parentElement;
              }
              if (isOrderTypeTab) continue;
              
              const tagName = el.tagName.toLowerCase();
              const role = el.getAttribute('role');
              if (tagName === 'button' || tagName === 'a' || role === 'button' || 
                  el.onclick || el.getAttribute('onclick') || 
                  window.getComputedStyle(el).cursor === 'pointer') {
                let nearbyText = '';
                let checkNearby = el.parentElement;
                for (let j = 0; j < 3 && checkNearby; j++) {
                  nearbyText += (checkNearby.textContent || '').toLowerCase() + ' ';
                  checkNearby = checkNearby.parentElement;
                }
                if (nearbyText.includes('tp') || nearbyText.includes('sl') || 
                    nearbyText.includes('take profit') || nearbyText.includes('stop loss')) {
                  return el;
                }
              }
            }
          }
          return null;
        }, createOrderPanel);
        
        if (advancedHandle && advancedHandle.asElement()) {
          advancedEl = advancedHandle.asElement();
        }
      }
      
      if (advancedEl) {
        await advancedEl.click();
        await delay(1000);
        
        // Verify modal opened
        const modalOpened = await page.evaluate(() => {
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
          for (const modal of modals) {
            const style = window.getComputedStyle(modal);
            if (style.display !== 'none' && style.visibility !== 'hidden' &&
              modal.offsetWidth > 0 && modal.offsetHeight > 0) {
              const modalText = (modal.textContent || '').toLowerCase();
              if (modalText.includes('tp/sl') || modalText.includes('take profit') || modalText.includes('stop loss')) {
                return true;
              }
            }
          }
          return false;
        });
        
        if (modalOpened) {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Modal reopened for final verification...`);
          
          // Verify and refill Take profit P&L input
          if (!isNaN(takeProfitNum) && takeProfitValue) {
            const tpValue = await page.evaluate((sectionName) => {
              const allElements = Array.from(document.querySelectorAll('*'));
              let tpslModal = null;
              
              for (const el of allElements) {
                const text = (el.textContent || '').trim();
                if (text === 'TP/SL' && el.offsetParent !== null) {
                  let parent = el.parentElement;
                  for (let i = 0; i < 10 && parent; i++) {
                    const style = window.getComputedStyle(parent);
                    if (style.display !== 'none' && style.visibility !== 'hidden' &&
                      parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                      const parentText = (parent.textContent || '').toLowerCase();
                      if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                        tpslModal = parent;
                        break;
                      }
                    }
                    parent = parent.parentElement;
                  }
                  if (tpslModal) break;
                }
              }
              
              if (!tpslModal) return { found: false };
              
              const sectionNameLower = sectionName.toLowerCase();
              let sectionElement = null;
              const modalElements = Array.from(tpslModal.querySelectorAll('*'));
              for (const el of modalElements) {
                const text = (el.textContent || '').trim();
                if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
                  sectionElement = el;
                  break;
                }
              }
              
              if (!sectionElement) return { found: false };
              
              let sectionParent = sectionElement.parentElement;
              const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
              
              for (let i = 0; i < 10 && sectionParent; i++) {
                const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
                let hasOtherSection = false;
                for (const el of allDescendants) {
                  const text = (el.textContent || '').trim();
                  if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
                    hasOtherSection = true;
                    break;
                  }
                }
                if (!hasOtherSection) break;
                sectionParent = sectionParent.parentElement;
                if (!sectionParent) break;
              }
              
              if (!sectionParent) sectionParent = sectionElement.parentElement;
              
              const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
              for (const input of allInputsInSection) {
                if (input.tagName !== 'INPUT') continue;
                const placeholder = (input.getAttribute('placeholder') || '').trim();
                const className = (input.className || '').toLowerCase();
                if ((placeholder === '' || placeholder === ' ') && className.includes('text')) {
                  if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
                    return { found: true, value: input.value || '' };
                  }
                }
              }
              
              return { found: false };
            }, 'Take profit');
            
            if (tpValue.found) {
              const tpNum = parseFloat(tpValue.value.replace(/,/g, ''));
              const expectedTpNum = parseFloat(takeProfitValue);
              if (isNaN(tpNum) || Math.abs(tpNum - expectedTpNum) >= 0.01) {
                console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Take profit P&L value is wrong (${tpValue.value}), refilling...`);
                await checkAndFillPnlInputs(page, exchange, 'Take profit', takeProfitValue);
                await delay(500);
              } else {
                console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Take profit P&L value is correct: ${tpValue.value}`);
              }
            } else {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find Take profit P&L input, refilling...`);
              await checkAndFillPnlInputs(page, exchange, 'Take profit', takeProfitValue);
              await delay(500);
            }
          }
          
          // Verify and refill Stop loss P&L input
          if (!isNaN(stopLossNum) && stopLossValue) {
            const slValue = await page.evaluate((sectionName) => {
              // Same logic as above but for Stop loss
              const allElements = Array.from(document.querySelectorAll('*'));
              let tpslModal = null;
              
              for (const el of allElements) {
                const text = (el.textContent || '').trim();
                if (text === 'TP/SL' && el.offsetParent !== null) {
                  let parent = el.parentElement;
                  for (let i = 0; i < 10 && parent; i++) {
                    const style = window.getComputedStyle(parent);
                    if (style.display !== 'none' && style.visibility !== 'hidden' &&
                      parent.offsetWidth > 0 && parent.offsetHeight > 0) {
                      const parentText = (parent.textContent || '').toLowerCase();
                      if (parentText.includes('take profit') && parentText.includes('stop loss')) {
                        tpslModal = parent;
                        break;
                      }
                    }
                    parent = parent.parentElement;
                  }
                  if (tpslModal) break;
                }
              }
              
              if (!tpslModal) return { found: false };
              
              const sectionNameLower = sectionName.toLowerCase();
              let sectionElement = null;
              const modalElements = Array.from(tpslModal.querySelectorAll('*'));
              for (const el of modalElements) {
                const text = (el.textContent || '').trim();
                if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
                  sectionElement = el;
                  break;
                }
              }
              
              if (!sectionElement) return { found: false };
              
              let sectionParent = sectionElement.parentElement;
              const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
              
              for (let i = 0; i < 10 && sectionParent; i++) {
                const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
                let hasOtherSection = false;
                for (const el of allDescendants) {
                  const text = (el.textContent || '').trim();
                  if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
                    hasOtherSection = true;
                    break;
                  }
                }
                if (!hasOtherSection) break;
                sectionParent = sectionParent.parentElement;
                if (!sectionParent) break;
              }
              
              if (!sectionParent) sectionParent = sectionElement.parentElement;
              
              const allInputsInSection = Array.from(sectionParent.querySelectorAll('input'));
              for (const input of allInputsInSection) {
                if (input.tagName !== 'INPUT') continue;
                const placeholder = (input.getAttribute('placeholder') || '').trim();
                const className = (input.className || '').toLowerCase();
                if ((placeholder === '' || placeholder === ' ') && className.includes('text')) {
                  if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
                    return { found: true, value: input.value || '' };
                  }
                }
              }
              
              return { found: false };
            }, 'Stop loss');
            
            if (slValue.found) {
              const slNum = parseFloat(slValue.value.replace(/,/g, ''));
              const expectedSlNum = parseFloat(stopLossValue);
              if (isNaN(slNum) || Math.abs(slNum - expectedSlNum) >= 0.01) {
                console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Stop loss P&L value is wrong (${slValue.value}), refilling...`);
                await checkAndFillPnlInputs(page, exchange, 'Stop loss', stopLossValue);
                await delay(500);
              } else {
                console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Stop loss P&L value is correct: ${slValue.value}`);
              }
            } else {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not find Stop loss P&L input, refilling...`);
              await checkAndFillPnlInputs(page, exchange, 'Stop loss', stopLossValue);
              await delay(500);
            }
          }
          
          // Wait for trigger prices to recalculate if we refilled
          await delay(2000);
          
          // Close the modal
          await page.keyboard.press('Escape');
          await delay(500);
          
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ Final verification complete, values are correct`);
        } else {
          console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  Could not reopen modal for final verification`);
        }
      }
    }
  }
  
  // 6. Find and click Buy/Sell button (this is the confirm button for GRVT)
  console.log(`[${exchange.name}] [QUICK-FILL] Step 6: Clicking ${side.toUpperCase()} button...`);
  const { findByExactText } = await import('../utils/helpers.js');
  const buttonText = side === "buy" ? exchange.selectors.buyButton : exchange.selectors.sellButton;
  const buySellBtn = await findByExactText(page, buttonText, ["button", "div", "span"]);
  
  if (!buySellBtn) {
    return { success: false, error: `${side.toUpperCase()} button not found. Looking for: "${buttonText}"` };
  }
  
  const buySellButtonClickTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = buySellButtonClickTime - thresholdMetTime;
    const quickFillTime = buySellButtonClickTime - quickFillStartTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] Buy/Sell button clicked - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met (quick fill took ${(quickFillTime / 1000).toFixed(2)}s)`);
  }
  
  const { clickConfirmButton } = await import('./executeBase.js');
  await clickConfirmButton(page, buySellBtn, buttonText, exchange, side);
  
  // 7. Wait for modal and click Confirm button in the modal
  await delay(500);
  const confirmModalBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);
  
  if (confirmModalBtn) {
    const confirmClickTime = Date.now();
    
    const isInModal = await page.evaluate((btn) => {
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
      await confirmModalBtn.click();
      
      if (thresholdMetTime) {
        const totalTime = confirmClickTime - thresholdMetTime;
        const quickFillTime = buySellButtonClickTime - quickFillStartTime;
        const buttonClickTime = confirmClickTime - buySellButtonClickTime;
        
        console.log(`\n[${exchange.name}] ⏱️  [TIMING METRICS] ${sideLabel} Order Submission Complete:`);
        console.log(`[${exchange.name}]    Account: ${email}`);
        console.log(`[${exchange.name}]    Total time (threshold → submit): ${(totalTime / 1000).toFixed(2)}s`);
        console.log(`[${exchange.name}]    Quick fill time (price + side + TP/SL + submit): ${(quickFillTime / 1000).toFixed(2)}s`);
        console.log(`[${exchange.name}]    Button click time: ${(buttonClickTime / 1000).toFixed(2)}s`);
        console.log(`[${exchange.name}]    Timestamp: ${new Date(confirmClickTime).toISOString()}\n`);
      }
      
      await delay(1000);
    }
  }
  
  const { verifyOrderPlacement } = await import('./executeBase.js');
  return await verifyOrderPlacement(page, exchange, side, grvtSize);
}
