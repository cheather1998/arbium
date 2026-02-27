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
              await checkbox.click();
              console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked TP/SL checkbox`);
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
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 2: Finding and clicking Advanced button...`);
    const advancedElement = await page.evaluateHandle((checkbox) => {
      let parentContainer = checkbox.parentElement;
      for (let i = 0; i < 5 && parentContainer; i++) {
        const allElements = Array.from(parentContainer.querySelectorAll('*'));
        for (const el of allElements) {
          if (el.offsetParent === null) continue;
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
            return el;
          }
        }
        parentContainer = parentContainer.parentElement;
      }
      return null;
    }, checkboxElement);
    
    if (advancedElement && advancedElement.asElement()) {
      const advancedEl = advancedElement.asElement();
      await advancedEl.click();
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Clicked Advanced button`);
      await delay(500);
    } else {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Could not find Advanced button`);
      return { success: false, error: 'Advanced button not found' };
    }
    
    // Step 3: Wait for TP/SL modal to open
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 3: Waiting for TP/SL modal to open...`);
    let modalOpened = false;
    for (let i = 0; i < 10; i++) {
      modalOpened = await page.evaluate(() => {
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
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ TP/SL modal opened`);
        await delay(500);
        break;
      }
      await delay(300);
    }
    
    if (!modalOpened) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  TP/SL modal did not open`);
      return { success: false, error: 'TP/SL modal did not open' };
    }
    
    // Step 4: Update dropdown to P&L for both Take profit and Stop loss sections
    console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] Step 4: Updating ROI% dropdown to P&L for both sections...`);
    
    // Helper function to update ROI% dropdown to P&L for a section
    const updateRoiDropdown = async (sectionName) => {
      const roiParentInfo = await page.evaluate((sectionName) => {
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
        
        const sectionParent = sectionElement.parentElement;
        if (!sectionParent) return { success: false, message: `Could not find parent of "${sectionName}" element` };
        
        const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
        let roiElement = null;
        for (const el of allDescendants) {
          const text = (el.textContent || '').trim();
          if (text === 'ROI%' && el.offsetParent !== null) {
            roiElement = el;
            break;
          }
        }
        
        if (!roiElement) return { success: false, message: `Could not find "ROI%" element inside "${sectionName}" parent` };
        
        const rect = roiElement.getBoundingClientRect();
        return {
          success: true,
          clickX: rect.x + rect.width / 2,
          clickY: rect.y + rect.height / 2
        };
      }, sectionName);
      
      if (!roiParentInfo || !roiParentInfo.success) {
        console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Could not find ROI% element for ${sectionName}: ${roiParentInfo?.message || 'unknown'}`);
        return false;
      }
      
      // Click ROI% element
      await page.mouse.click(roiParentInfo.clickX, roiParentInfo.clickY);
      await delay(300);
      
      // Press ArrowDown twice, then Enter to select P&L
      await page.keyboard.press('ArrowDown');
      await delay(300);
      await page.keyboard.press('ArrowDown');
      await delay(300);
      await page.keyboard.press('Enter');
      await delay(500);
      
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Updated ROI% dropdown to P&L for ${sectionName}`);
      return true;
    };
    
    // Update ROI% dropdown to P&L for both sections
    const takeProfitRoiUpdated = await updateRoiDropdown('Take profit');
    await delay(300);
    const stopLossRoiUpdated = await updateRoiDropdown('Stop loss');
    
    if (!takeProfitRoiUpdated || !stopLossRoiUpdated) {
      console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ⚠️  Failed to update one or both ROI% dropdowns`);
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
          await inputElement.focus();
          await delay(200);
          await page.keyboard.down('Control');
          await page.keyboard.press('KeyA');
          await page.keyboard.up('Control');
          await delay(100);
          await page.keyboard.press('Backspace');
          await delay(100);
          await inputElement.type(takeProfitValue, { delay: 50 });
          await delay(200);
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Filled first input for ${sectionName}: ${takeProfitValue}`);
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
          await inputElement.focus();
          await delay(200);
          await page.keyboard.down('Control');
          await page.keyboard.press('KeyA');
          await page.keyboard.up('Control');
          await delay(100);
          await page.keyboard.press('Backspace');
          await delay(100);
          await inputElement.type(stopLossValue, { delay: 50 });
          await delay(200);
          console.log(`[${exchange.name}] [PRE-FILL] [TP/SL] ✅ Filled second input for ${sectionName}: ${stopLossValue}`);
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
  
  // 1. Fill price (for limit orders)
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
  
  // 3. Check if TP/SL modal is still open, then update side, fill values, and confirm
  if (orderType === "limit" && price) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 3: Completing TP/SL (modal should be open from prefill, update side, fill values, confirm)...`);
    
    // Check if TP/SL modal is still open (it should be from prefill)
    let modalOpen = false;
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
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ TP/SL modal is still open from prefill`);
      
      // Use handleTpSlGrvt to update side, fill values, and confirm
      // It will handle: updating side toggle, filling TP/SL inputs, and confirming
      const tpSlResult = await handleTpSlGrvt(page, exchange, price, side);
      if (!tpSlResult.success) {
        console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  TP/SL handling failed: ${tpSlResult.error || 'unknown error'}, continuing anyway...`);
      } else {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ TP/SL completed (side updated, values filled, confirmed)`);
      }
      await delay(500);
    } else {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ⚠️  TP/SL modal is not open. Attempting to reopen...`);
      
      // Fallback: Try to reopen if modal closed somehow
      const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
      let advancedElement = null;
      
      if (createOrderPanel) {
        const panelLabels = await createOrderPanel.$$('label');
        for (const label of panelLabels) {
          const labelText = await page.evaluate((el) => el.textContent?.trim().toLowerCase() || '', label);
          if ((labelText.includes('tp') && labelText.includes('sl')) ||
            (labelText.includes('take profit') && labelText.includes('stop loss'))) {
            const checkbox = await label.$('input[type="checkbox"]');
            if (checkbox) {
              const advancedHandle = await page.evaluateHandle((checkbox) => {
                let parentContainer = checkbox.parentElement;
                for (let i = 0; i < 5 && parentContainer; i++) {
                  const allElements = Array.from(parentContainer.querySelectorAll('*'));
                  for (const el of allElements) {
                    if (el.offsetParent === null) continue;
                    const text = (el.textContent || '').trim();
                    if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
                      return el;
                    }
                  }
                  parentContainer = parentContainer.parentElement;
                }
                return null;
              }, checkbox);
              
              if (advancedHandle && advancedHandle.asElement()) {
                advancedElement = advancedHandle.asElement();
                break;
              }
            }
          }
        }
      }
      
      if (advancedElement) {
        await advancedElement.click();
        await delay(500);
        
        // Wait for modal to open
        for (let i = 0; i < 10; i++) {
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
            console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ TP/SL modal reopened`);
            await delay(500);
            
            // Now use handleTpSlGrvt
            const tpSlResult = await handleTpSlGrvt(page, exchange, price, side);
            if (!tpSlResult.success) {
              console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  TP/SL handling failed: ${tpSlResult.error || 'unknown error'}, continuing anyway...`);
            } else {
              console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ TP/SL completed (side updated, values filled, confirmed)`);
            }
            await delay(500);
            break;
          }
          await delay(300);
        }
      }
    }
    
    // Check if price and quantity are still filled after TP/SL
    if (orderType === "limit" && priceInput) {
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
    const expectedSizeNum = parseFloat(String(grvtSize));
    if (!sizeAfterTpSl || sizeAfterTpSl.trim() === '' || Math.abs(sizeAfterTpSlNum - expectedSizeNum) >= 0.0001) {
      console.log(`[${exchange.name}] [QUICK-FILL] Quantity was cleared after TP/SL, refilling...`);
      await clearAndFillInputGrvt(sizeInput, grvtSize, 'Quantity');
      await delay(300);
    }
  }
  
  // 4. Select Buy or Sell (side)
  console.log(`[${exchange.name}] [QUICK-FILL] Step 4: Selecting ${side.toUpperCase()}...`);
  await selectBuyOrSell(page, side, exchange);
  await delay(300);
  
  // 5. Find and click Buy/Sell button (this is the confirm button for GRVT)
  console.log(`[${exchange.name}] [QUICK-FILL] Step 5: Clicking ${side.toUpperCase()} button...`);
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
  
  // 6. Wait for modal and click Confirm button in the modal
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
