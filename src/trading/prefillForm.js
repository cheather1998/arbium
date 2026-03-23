import { selectBuyOrSell, enterSize } from './executeBase.js';
import { selectOrderTypeKraken, findKrakenInputs } from './executeKraken.js';
import { delay, closeNotifyBarWrapperNotifications } from '../utils/helpers.js';
import { handleTpSlGrvt } from './executeGrvt.js';
import { safeClick, safeClearAndType } from '../utils/safeActions.js';

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
        await safeClick(page, tpSlButton);
        await delay(800);

        const { findByExactText } = await import('../utils/helpers.js');
        let simpleOption = await findByExactText(page, "Simple", ["button", "div", "span", "option", "li"]);

        if (simpleOption) {
          await safeClick(page, simpleOption);
          await delay(300);
        } else {
          // Dropdown opened but "Simple" not found — close it with Escape
          console.log(`[${exchange.name}] [PRE-FILL] ⚠️  "Simple" option not found, closing dropdown`);
          await page.keyboard.press('Escape');
          await delay(200);
        }
      }
    }
  } catch (error) {
    console.log(`[${exchange.name}] [PRE-FILL] ⚠️  TP/SL setup error: ${error.message}`);
    // Ensure any open dropdown is closed
    try { await page.keyboard.press('Escape'); } catch (e) {}
  }
  
  // 5. TP/SL Entry Distance values will be calculated and filled during quick-fill (when price is known)
  // "Simple" dropdown was set up in Step 4 above. Distance = price × percentage.
  console.log(`[${exchange.name}] [PRE-FILL] Step 5: TP/SL distances deferred to quick-fill (needs entry price for calculation)`);
  
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
  await delay(150);
  
  // 1.5. (GRVT) TP/SL values handled by handleTpSlGrvt in Step 4 (absolute trigger prices)
  // No dropdown or value fill needed here — GRVT uses checkbox + price inputs, not Kraken's "Simple" dropdown
  
  // 2. Fill price only
  if (orderType === "limit" && prefillData.priceInput) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 2: Filling price: ${price}`);
    const { enterPrice } = await import('./executeBase.js');
    await enterPrice(page, prefillData.priceInput, price, orderType);
    await delay(300);
  }

  // 2.5. Calculate and fill TP/SL entry distances (now that price is known)
  // ROI% → price movement% = ROI% / leverage
  // If entry distance mode is "%": enter price movement % directly
  // If entry distance mode is "USD": enter price × price movement %
  const tpPercent = parseFloat(process.env.TAKE_PROFIT) || 0;
  const slPercent = parseFloat(process.env.STOP_LOSS) || 0;
  const leverage = parseFloat(process.env.LEVERAGE) || 10;
  if (price && (tpPercent > 0 || slPercent > 0)) {
    const priceNum = parseFloat(String(price).replace(/,/g, ''));
    const tpPriceMovementPct = tpPercent / leverage; // e.g. 10% ROI / 10x = 1%
    const slPriceMovementPct = slPercent / leverage; // e.g. 5% ROI / 10x = 0.5%

    let takeProfitInput = await page.$('input[aria-label="Distance for Take profit"]');
    let stopLossInput = await page.$('input[aria-label="Distance for Stop loss"]');

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

    // Detect if entry distance mode is "%" or "USD" by checking the TP/SL input context
    const isPercentMode = await page.evaluate(() => {
      // Strategy 1: Find the TP/SL entry distance input and check its sibling/parent for "%" or "USD" suffix
      const tpInput = document.querySelector('input[aria-label="Distance for Take profit"]');
      if (tpInput) {
        // Walk up to find the container, then look for "%" or "USD" text siblings
        let parent = tpInput.parentElement;
        for (let i = 0; i < 3 && parent; i++) {
          const children = Array.from(parent.children);
          for (const child of children) {
            if (child === tpInput || child.contains(tpInput)) continue;
            const text = (child.textContent || '').trim();
            if (text === '%') return true;
            if (text === 'USD') return false;
          }
          parent = parent.parentElement;
        }
      }

      // Strategy 2: Check for active "%" toggle button near TP/SL area
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        if (btn.offsetParent === null) continue;
        const text = (btn.textContent || '').trim();
        if (text === '%') {
          const className = (typeof btn.className === 'string' ? btn.className : '').toLowerCase();
          const ariaSelected = btn.getAttribute('aria-selected');
          const ariaPressed = btn.getAttribute('aria-pressed');
          if (className.includes('active') || className.includes('selected') ||
              ariaSelected === 'true' || ariaPressed === 'true') {
            return true;
          }
        }
      }

      // Strategy 3: Check for "%" suffix/unit elements near TP/SL inputs
      const allElements = document.querySelectorAll('span, div, label');
      for (const el of allElements) {
        if (el.offsetParent === null) continue;
        const text = (el.textContent || '').trim();
        if (text === '%' && el.children.length === 0) {
          // Check if near a TP/SL related element
          let p = el.parentElement;
          for (let i = 0; i < 5 && p; i++) {
            const pText = (p.textContent || '').toLowerCase();
            if (pText.includes('take profit') || pText.includes('stop loss') || pText.includes('entry distance')) {
              return true;
            }
            p = p.parentElement;
          }
        }
      }
      return false;
    });

    let tpValue, slValue;
    if (isPercentMode) {
      // In % mode: enter price movement percentage directly
      tpValue = tpPriceMovementPct > 0 ? String(tpPriceMovementPct) : '';
      slValue = slPriceMovementPct > 0 ? String(slPriceMovementPct) : '';
      console.log(`[${exchange.name}] [QUICK-FILL] Step 2.5: Entry distance in % mode — TP=${tpPriceMovementPct}%, SL=${slPriceMovementPct}% (${tpPercent}%/${slPercent}% ROI at ${leverage}x)`);
    } else {
      // In USD mode: enter dollar distance
      const tpDistanceUsd = Math.round(priceNum * tpPriceMovementPct / 100);
      const slDistanceUsd = Math.round(priceNum * slPriceMovementPct / 100);
      tpValue = tpDistanceUsd > 0 ? String(tpDistanceUsd) : '';
      slValue = slDistanceUsd > 0 ? String(slDistanceUsd) : '';
      console.log(`[${exchange.name}] [QUICK-FILL] Step 2.5: Entry distance in USD mode — TP=$${tpDistanceUsd}, SL=$${slDistanceUsd} (${tpPercent}%/${slPercent}% ROI at ${leverage}x from $${priceNum})`);
    }

    if (tpValue && takeProfitInput) {
      await safeClearAndType(page, takeProfitInput, tpValue, { delay: 50 });
      await delay(200);
      console.log(`[${exchange.name}] [QUICK-FILL] ✅ TP distance filled: ${isPercentMode ? tpValue + '%' : '$' + tpValue}`);
    } else if (tpPriceMovementPct > 0) {
      console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  TP distance input not found`);
    }

    if (slValue && stopLossInput) {
      await safeClearAndType(page, stopLossInput, slValue, { delay: 50 });
      await delay(200);
      console.log(`[${exchange.name}] [QUICK-FILL] ✅ SL distance filled: ${isPercentMode ? slValue + '%' : '$' + slValue}`);
    } else if (slPriceMovementPct > 0) {
      console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  SL distance input not found`);
    }
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
  await delay(300);
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
      await safeClick(page, confirmModalBtn);

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
      
      await delay(300);
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
          // Scroll into view before clicking (minimize-safe: use evaluate)
          await page.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), orderTypeElement);
          await delay(300);
          
          await safeClick(page, orderTypeElement);
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
      // Fallback: find price input by placeholder or by being the first non-size input
      for (const input of panelInputs) {
        if (input === sizeInput) continue;
        const ph = await page.evaluate(el => (el.placeholder || '').toLowerCase(), input);
        if (ph.includes('price') || ph.includes('mid')) {
          priceInput = input;
          break;
        }
      }
      // If still not found, take the first non-size, non-hidden input
      if (!priceInput) {
        for (const input of panelInputs) {
          if (input === sizeInput) continue;
          const isVisible = await page.evaluate(el => el.offsetParent !== null && !el.disabled, input);
          if (isVisible) {
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
  
  // 4. Set up TP/SL: Just enable the checkbox on basic screen (values will be filled after price is known)
  // NOTE: Using basic screen approach instead of Advanced modal for reliability
  console.log(`[${exchange.name}] [PRE-FILL] Step 4: Enabling TP/SL checkbox on basic screen...`);
  try {
    const tpSlCheckboxResult = await page.evaluate(() => {
      const createOrderPanel = document.querySelector('[data-sentry-element="CreateOrderPanel"]');
      if (!createOrderPanel) return { success: false, error: 'CreateOrderPanel not found' };

      const labels = Array.from(createOrderPanel.querySelectorAll('label'));
      for (const label of labels) {
        const labelText = (label.textContent || '').trim().toLowerCase();
        if ((labelText.includes('tp') && labelText.includes('sl')) ||
            (labelText.includes('take profit') && labelText.includes('stop loss'))) {
          const checkbox = label.querySelector('input[type="checkbox"]');
          if (checkbox) {
            if (!checkbox.checked) {
              checkbox.click();
              return { success: true, wasChecked: false, message: 'TP/SL checkbox clicked' };
            } else {
              return { success: true, wasChecked: true, message: 'TP/SL checkbox already checked' };
            }
          }
        }
      }
      return { success: false, error: 'TP/SL checkbox not found' };
    });

    if (tpSlCheckboxResult.success) {
      console.log(`[${exchange.name}] [PRE-FILL] ✅ ${tpSlCheckboxResult.message}`);
    } else {
      console.log(`[${exchange.name}] [PRE-FILL] ⚠️  TP/SL checkbox setup failed: ${tpSlCheckboxResult.error}, continuing anyway...`);
    }
    await delay(500);
  } catch (error) {
    console.log(`[${exchange.name}] [PRE-FILL] ⚠️  TP/SL checkbox error: ${error.message}, continuing anyway...`);
  }
  
  return {
    success: true,
    sizeInput,
    priceInput
  };
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
  
  let { sizeInput, priceInput } = prefillData;

  // Validate pre-fill handles are still attached (React re-renders can detach DOM nodes)
  const validateHandle = async (handle, name) => {
    try {
      await page.evaluate(el => el.tagName, handle);
      return true;
    } catch (e) {
      console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  ${name} handle is stale (${e.message}), re-finding...`);
      return false;
    }
  };

  const sizeValid = sizeInput && await validateHandle(sizeInput, 'sizeInput');
  const priceValid = priceInput && await validateHandle(priceInput, 'priceInput');

  if (!sizeValid || (orderType === "limit" && !priceValid)) {
    // Re-find inputs from CreateOrderPanel
    console.log(`[${exchange.name}] [QUICK-FILL] Re-finding inputs due to stale handles...`);
    const panel = await page.$('[data-sentry-element="CreateOrderPanel"]');
    if (panel) {
      const inputs = await panel.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
      sizeInput = null;
      priceInput = null;
      for (const input of inputs) {
        const info = await page.evaluate(el => ({
          parentText: (() => { let p = el.parentElement; for (let i = 0; i < 5 && p; i++) { if (p.textContent) return (p.textContent || '').toLowerCase(); p = p.parentElement; } return ''; })(),
          placeholder: (el.placeholder || '').toLowerCase()
        }), input);
        if (!sizeInput && (info.parentText.includes('btc') || info.parentText.includes('quantity') || info.placeholder.includes('quantity') || info.placeholder.includes('size'))) {
          sizeInput = input;
        }
        if (!priceInput && orderType === "limit" && (info.parentText.includes('price') || info.placeholder.includes('price') || info.parentText.includes('mid'))) {
          priceInput = input;
        }
      }
    }
  }

  if (!sizeInput) {
    return { success: false, error: "Size input not found (stale handle, re-find failed)" };
  }

  if (orderType === "limit" && !priceInput) {
    return { success: false, error: "Price input not found (stale handle, re-find failed)" };
  }
  
  // GRVT: Use quantity from env if >= 0.002, otherwise default to 0.002
  const envQty = side === 'buy'
    ? parseFloat(process.env.BUY_QTY) || 0
    : parseFloat(process.env.SELL_QTY) || 0;
  const grvtSize = envQty >= 0.002 ? envQty : 0.002;
  
  // Helper function to clear and fill input (optimized for speed)
  const clearAndFillInputGrvt = async (input, value, inputName) => {
    const valueStr = String(value);

    // Method 1 (fast): JS clear + DOM-level type (minimize-safe)
    await page.evaluate(el => el.focus(), input);
    await delay(50);
    await page.evaluate((el) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, input);
    await delay(50);
    await page.evaluate(el => el.focus(), input);
    await page.keyboard.type(valueStr, { delay: 10 });
    await delay(100);

    // Verify
    const finalValue = await page.evaluate((el) => el.value || '', input);
    const finalNum = parseFloat(finalValue.replace(/,/g, '').replace(/ /g, ''));
    const expectedNum = parseFloat(valueStr);
    const tolerance = inputName === 'Price' ? 0.1 : 0.0001;

    if (finalValue && !isNaN(finalNum) && Math.abs(finalNum - expectedNum) < tolerance) {
      return true;
    }

    // Method 2 (fallback): select all + type to replace (no Backspace — React re-renders can clear selection)
    console.log(`[${exchange.name}] [QUICK-FILL] Input ${inputName} JS fill failed (got "${finalValue}"), using keyboard fallback...`);
    await page.evaluate(el => { el.focus(); el.select(); }, input);
    await page.keyboard.type(valueStr, { delay: 20 });
    await delay(100);

    const retryValue = await page.evaluate((el) => el.value || '', input);
    const retryNum = parseFloat(retryValue.replace(/,/g, '').replace(/ /g, ''));
    return retryValue && !isNaN(retryNum) && Math.abs(retryNum - expectedNum) < tolerance;
  };
  
  // CHANGE #88: REMOVED selectBuyOrSell (Step 1) — ROOT CAUSE OF DOUBLE ORDERS (0.004 BTC).
  // On GRVT, "Buy / Long" is BOTH the side selector AND the submit button (no separate confirm).
  // Step 1 clicked "Buy / Long" → submitted order #1 (with auto-populated price, no TP/SL).
  // Step 4 clicked "Buy / Long" again → submitted order #2 (with correct price + TP/SL).
  // Result: 0.004 BTC instead of 0.002 BTC. Fix: side is selected by Step 4's click only.
  // TP/SL uses absolute prices calculated from the `side` parameter, not the form's current mode.

  // 1.5. Verify quantity is correct (pre-fill may have used max(buyQty, sellQty))
  if (sizeInput) {
    const currentQty = await page.evaluate(el => el.value || '', sizeInput).catch(() => '');
    const expectedQty = grvtSize;
    const currentQtyNum = parseFloat(currentQty.replace(/,/g, ''));
    if (!currentQty || isNaN(currentQtyNum) || Math.abs(currentQtyNum - expectedQty) > 0.0001) {
      console.log(`[${exchange.name}] [QUICK-FILL] Step 1.5: Quantity needs correction (was "${currentQty}", need ${expectedQty}), re-filling...`);
      await clearAndFillInputGrvt(sizeInput, expectedQty, 'Quantity');
    }
  }

  // 2. Fill price (for limit orders)
  if (orderType === "limit" && priceInput) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 2: Filling price: ${price}`);
    const priceSuccess = await clearAndFillInputGrvt(priceInput, price, 'Price');
    if (!priceSuccess) {
      console.log(`[${exchange.name}] [QUICK-FILL] ⚠️  Price fill failed, retrying...`);
      await delay(300);
      const retrySuccess = await clearAndFillInputGrvt(priceInput, price, 'Price');
      if (!retrySuccess) {
        return { success: false, error: "Failed to fill price input after retry" };
      }
    }
    await delay(200);

    const priceFinalCheck = await page.evaluate((el) => el.value || '', priceInput);
    const priceFinalNum = parseFloat(priceFinalCheck.replace(/,/g, ''));
    const expectedPriceNum = parseFloat(String(price));
    const priceTolerance = 0.1;
    if (!priceFinalCheck || Math.abs(priceFinalNum - expectedPriceNum) >= priceTolerance) {
      return { success: false, error: `Price input not persisting. Expected: ${price}, Got: "${priceFinalCheck}"` };
    }
  }

  // 3. Handle TP/SL (mandatory — abort on failure)
  if (orderType === "limit" && price) {
    console.log(`[${exchange.name}] [QUICK-FILL] Step 3: Setting TP/SL...`);
    try {
      const tpSlResult = await handleTpSlGrvt(page, exchange, price, side);
      if (tpSlResult && tpSlResult.success) {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ✅ TP/SL set successfully`);
      } else {
        console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ❌ TP/SL mandatory but failed: ${JSON.stringify(tpSlResult)}`);
        return { success: false, error: 'TP/SL is mandatory but failed to set — aborting order' };
      }
    } catch (tpSlError) {
      console.log(`[${exchange.name}] [QUICK-FILL] [TP/SL] ❌ TP/SL error: ${tpSlError.message}`);
      return { success: false, error: `TP/SL is mandatory but error: ${tpSlError.message}` };
    }
  }

  // 4. Find and click Buy/Sell button → Confirm modal → verify
  // NO RETRY — retrying causes duplicate orders (0.004 BTC instead of 0.002)
  console.log(`[${exchange.name}] [QUICK-FILL] Step 4: Clicking ${side.toUpperCase()} submit button...`);
  const { findByExactText } = await import('../utils/helpers.js');
  const { clickConfirmButton, verifyOrderPlacement } = await import('./executeBase.js');
  const buttonText = side === "buy" ? exchange.selectors.buyButton : exchange.selectors.sellButton;

  const buySellBtn = await findByExactText(page, buttonText, ["button", "div", "span"]);

  if (!buySellBtn) {
    await delay(500);
    const retryBtn = await findByExactText(page, buttonText, ["button", "div", "span"]);
    if (!retryBtn) {
      return { success: false, error: `${side.toUpperCase()} button not found. Looking for: "${buttonText}"` };
    }
  }

  const actualBtn = buySellBtn || await findByExactText(page, buttonText, ["button", "div", "span"]);

  const buySellButtonClickTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = buySellButtonClickTime - thresholdMetTime;
    const quickFillTime = buySellButtonClickTime - quickFillStartTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] Buy/Sell button clicked - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met (quick fill took ${(quickFillTime / 1000).toFixed(2)}s)`);
  }

  await clickConfirmButton(page, actualBtn, buttonText, exchange, side);

  // GRVT auto-confirms orders on Buy/Sell click — NO confirm modal search.
  // Previously searched for "Confirm" button and clicked it, which caused DOUBLE ORDERS
  // (the found "Confirm" triggered a second order placement).
  await delay(300);

  if (thresholdMetTime) {
    const submitTime = Date.now();
    const totalTime = submitTime - thresholdMetTime;
    const quickFillTime = buySellButtonClickTime - quickFillStartTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] ${sideLabel} order submitted - ${(totalTime / 1000).toFixed(2)}s after threshold (quick fill: ${(quickFillTime / 1000).toFixed(2)}s)`);
  }

  // Verify order placement
  const result = await verifyOrderPlacement(page, exchange, side, grvtSize);
  return result;
}
