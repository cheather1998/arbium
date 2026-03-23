import { delay, findByText, findByExactText, closeNotifyBarWrapperNotifications } from '../utils/helpers.js';
import { safeClick, safeType, safeClearAndType } from '../utils/safeActions.js';
import {
  getCurrentMarketPrice,
  getBestBidAsk,
  getAggressivePrice,
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
 * Handle TP/SL for GRVT Exchange — BASIC SCREEN approach (no Advanced modal)
 * After TP/SL checkbox is checked, trigger price inputs appear directly on CreateOrderPanel.
 * This function calculates TP/SL trigger prices and fills them into those inputs.
 */
export async function handleTpSlGrvt(page, exchange, price = null, side = 'buy') {
  console.log(`[${exchange.name}] [TP/SL] Setting TP/SL on basic screen (Side: ${side.toUpperCase()}, Price: ${price})...`);

  const takeProfitPercent = process.env.TAKE_PROFIT || '';
  const stopLossPercent = process.env.STOP_LOSS || '';

  if (!takeProfitPercent && !stopLossPercent) {
    console.log(`[${exchange.name}] [TP/SL] TAKE_PROFIT and STOP_LOSS env not set, skipping`);
    return { success: false, error: 'TAKE_PROFIT and STOP_LOSS not set' };
  }

  if (!price || isNaN(price)) {
    console.log(`[${exchange.name}] [TP/SL] Price not provided or invalid, skipping`);
    return { success: false, error: 'Price not provided or invalid' };
  }

  // Calculate absolute trigger prices (GRVT requires direct price entry, not distance)
  // Formula: envValue = ROI % → price movement % = ROI% / leverage
  // e.g. STOP_LOSS=5 → 5% ROI / 10x = 0.5% price → BUY SL at $69,650 ($70,000 - $350)
  // e.g. TAKE_PROFIT=10 → 10% ROI / 10x = 1% price → BUY TP at $70,700 ($70,000 + $700)
  const takeProfitNum = parseFloat(takeProfitPercent);
  const stopLossNum = parseFloat(stopLossPercent);
  const leverage = parseFloat(process.env.LEVERAGE) || 10;
  const percentageTP = takeProfitNum / 100 / leverage;
  const percentageSL = stopLossNum / 100 / leverage;

  let calculatedTP = null;
  let calculatedSL = null;

  if (side === 'buy') {
    if (!isNaN(takeProfitNum) && takeProfitNum > 0) {
      calculatedTP = price + (price * percentageTP); // TP above entry for long
    }
    if (!isNaN(stopLossNum) && stopLossNum > 0) {
      calculatedSL = price - (price * percentageSL); // SL below entry for long
      if (calculatedSL <= 0) calculatedSL = null;
    }
  } else {
    if (!isNaN(takeProfitNum) && takeProfitNum > 0) {
      calculatedTP = price - (price * percentageTP); // TP below entry for short
      if (calculatedTP <= 0) calculatedTP = null;
    }
    if (!isNaN(stopLossNum) && stopLossNum > 0) {
      calculatedSL = price + (price * percentageSL); // SL above entry for short
    }
  }

  if (!calculatedTP && !calculatedSL) {
    console.log(`[${exchange.name}] [TP/SL] Could not calculate valid TP/SL prices, skipping`);
    return { success: false, error: 'Could not calculate TP/SL values' };
  }

  console.log(`[${exchange.name}] [TP/SL] Trigger prices: TP=$${calculatedTP?.toFixed(2) || 'none'} (${(percentageTP * 100).toFixed(1)}%), SL=$${calculatedSL?.toFixed(2) || 'none'} (${(percentageSL * 100).toFixed(1)}%) [Side: ${side.toUpperCase()}, Entry: $${price}]`);

  // Step 1: Ensure TP/SL checkbox is checked on CreateOrderPanel
  const checkboxResult = await page.evaluate(() => {
    const panel = document.querySelector('[data-sentry-element="CreateOrderPanel"]');
    if (!panel) return { success: false, error: 'CreateOrderPanel not found' };

    const labels = Array.from(panel.querySelectorAll('label'));
    for (const label of labels) {
      const text = (label.textContent || '').trim().toLowerCase();
      if ((text.includes('tp') && text.includes('sl')) ||
          (text.includes('take profit') && text.includes('stop loss'))) {
        const checkbox = label.querySelector('input[type="checkbox"]');
        if (checkbox) {
          if (!checkbox.checked) {
            checkbox.click();
            return { success: true, action: 'clicked' };
          }
          return { success: true, action: 'already_checked' };
        }
      }
    }
    return { success: false, error: 'TP/SL checkbox not found' };
  });

  if (!checkboxResult.success) {
    console.log(`[${exchange.name}] [TP/SL] ${checkboxResult.error}`);
    return { success: false, error: checkboxResult.error };
  }

  if (checkboxResult.action === 'clicked') {
    console.log(`[${exchange.name}] [TP/SL] Checkbox clicked, waiting for inputs to appear...`);
    await delay(1500);
  } else {
    console.log(`[${exchange.name}] [TP/SL] Checkbox already checked`);
  }

  // Debug: log all visible inputs in CreateOrderPanel to help identify TP/SL fields
  const debugInputs = await page.evaluate(() => {
    const panel = document.querySelector('[data-sentry-element="CreateOrderPanel"]');
    if (!panel) return [];
    const inputs = Array.from(panel.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"])'));
    return inputs.filter(i => i.offsetParent !== null).map(i => ({
      placeholder: i.placeholder || '',
      ariaLabel: i.getAttribute('aria-label') || '',
      name: i.name || '',
      value: i.value || '',
      type: i.type || '',
    }));
  });
  console.log(`[${exchange.name}] [TP/SL] Visible inputs in panel: ${JSON.stringify(debugInputs)}`);

  // Step 2: Find and fill trigger price inputs on the basic screen
  // After checkbox is checked, GRVT shows TP/SL trigger price inputs inline on CreateOrderPanel
  const fillResult = await page.evaluate((tp, sl) => {
    const panel = document.querySelector('[data-sentry-element="CreateOrderPanel"]');
    if (!panel) return { success: false, error: 'CreateOrderPanel not found' };

    const results = { tp: false, sl: false, tpError: '', slError: '' };

    // Find all input groups in the panel that relate to TP/SL
    // Use broad selector + JS filter — CSS [type="text"] may miss React inputs where type is set as DOM property
    const allInputs = Array.from(panel.querySelectorAll('input')).filter(i => {
      const t = (i.type || '').toLowerCase();
      return t !== 'checkbox' && t !== 'hidden' && t !== 'range';
    });

    // Helper: get context text around an input (labels, siblings, parent text)
    const getInputContext = (input) => {
      let context = '';
      // Check placeholder (use .placeholder property — React sets DOM property, not HTML attribute)
      context += (input.placeholder || '').toLowerCase() + ' ';
      // Check aria-label
      context += (input.getAttribute('aria-label') || '').toLowerCase() + ' ';
      // Check parent and sibling text (up 3 levels)
      let parent = input.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        // Get direct text nodes and label text, not deep children text
        for (const child of parent.childNodes) {
          if (child.nodeType === 3) context += (child.textContent || '').toLowerCase() + ' '; // text node
          if (child.tagName === 'LABEL' || child.tagName === 'SPAN' || child.tagName === 'DIV') {
            const childText = (child.textContent || '').trim().toLowerCase();
            if (childText.length < 50) context += childText + ' '; // avoid grabbing entire panel text
          }
        }
        parent = parent.parentElement;
      }
      return context;
    };

    // Helper: set input value with React-compatible event dispatch
    const setInputValue = (input, value) => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Categorize inputs by their context
    let tpInput = null;
    let slInput = null;

    // Debug: log what allInputs query found inside evaluate
    const debugInfo = allInputs.map(i => ({ ph: i.placeholder || '', vis: i.offsetParent !== null, dis: i.disabled }));

    for (const input of allInputs) {
      if (input.offsetParent === null || input.disabled) continue; // skip hidden/disabled

      // Priority 1: Match by placeholder (most reliable — avoids parent text contamination)
      // Use .placeholder property (not getAttribute) — React sets DOM property directly, not HTML attribute
      const ph = (input.placeholder || '').toLowerCase();
      if (!tpInput && ph.includes('tp') && !ph.includes('sl')) {
        tpInput = input;
        continue;
      }
      if (!slInput && ph.includes('sl') && !ph.includes('tp')) {
        slInput = input;
        continue;
      }

      // Priority 2: Match by surrounding context text
      const ctx = getInputContext(input);

      // Skip price and size inputs (they're also in the panel)
      if (ctx.includes('size') || ctx.includes('amount') || ctx.includes('qty')) continue;

      // Match TP input — GRVT shows absolute price inputs near "Take Profit" / "TP" labels
      if (!tpInput && (
        ctx.includes('take profit') ||
        (ctx.includes('tp') && !ctx.includes('stop'))
      )) {
        tpInput = input;
        continue;
      }

      // Match SL input — near "Stop Loss" / "SL" labels
      if (!slInput && (
        ctx.includes('stop loss') ||
        (ctx.includes('sl') && !ctx.includes('take'))
      )) {
        slInput = input;
        continue;
      }
    }

    // Fallback: if we didn't find specific TP/SL inputs, look for inputs near TP/SL text
    if (!tpInput || !slInput) {
      // Find sections with TP/SL labels
      const allElements = Array.from(panel.querySelectorAll('*'));
      for (const el of allElements) {
        if (el.offsetParent === null) continue;
        const text = (el.textContent || '').trim().toLowerCase();

        if (!tpInput && (text === 'take profit' || text === 'tp') && el.children.length === 0) {
          // Find nearest input after this label
          let sibling = el.nextElementSibling;
          let parent = el.parentElement;
          for (let i = 0; i < 3 && parent; i++) {
            const inputs = Array.from(parent.querySelectorAll('input'));
            for (const inp of inputs) {
              if (inp.offsetParent !== null && !inp.disabled && inp.type !== 'checkbox') {
                // Check this isn't an SL input
                const parentText = (parent.textContent || '').toLowerCase();
                if (!parentText.includes('stop loss') || parentText.indexOf('take profit') < parentText.indexOf('stop loss')) {
                  tpInput = inp;
                  break;
                }
              }
            }
            if (tpInput) break;
            parent = parent.parentElement;
          }
        }

        if (!slInput && (text === 'stop loss' || text === 'sl') && el.children.length === 0) {
          let parent = el.parentElement;
          for (let i = 0; i < 3 && parent; i++) {
            const inputs = Array.from(parent.querySelectorAll('input'));
            for (const inp of inputs) {
              if (inp.offsetParent !== null && !inp.disabled && inp.type !== 'checkbox' && inp !== tpInput) {
                slInput = inp;
                break;
              }
            }
            if (slInput) break;
            parent = parent.parentElement;
          }
        }
      }
    }

    // Fill TP
    if (tp && tpInput) {
      try {
        setInputValue(tpInput, tp);
        results.tp = true;
      } catch (e) {
        results.tpError = e.message;
      }
    } else if (tp) {
      results.tpError = 'TP trigger input not found';
    }

    // Fill SL
    if (sl && slInput) {
      try {
        setInputValue(slInput, sl);
        results.sl = true;
      } catch (e) {
        results.slError = e.message;
      }
    } else if (sl) {
      results.slError = 'SL trigger input not found';
    }

    return { success: results.tp || results.sl, ...results, debugInfo };
  }, calculatedTP ? calculatedTP.toFixed(2) : '', calculatedSL ? calculatedSL.toFixed(2) : '');

  if (fillResult.success) {
    console.log(`[${exchange.name}] [TP/SL] Fill result: TP=${fillResult.tp ? 'OK' : fillResult.tpError || 'skipped'}, SL=${fillResult.sl ? 'OK' : fillResult.slError || 'skipped'}`);
  } else {
    console.log(`[${exchange.name}] [TP/SL] Failed to fill trigger prices: TP=${fillResult.tpError}, SL=${fillResult.slError}`);
    if (fillResult.debugInfo) {
      console.log(`[${exchange.name}] [TP/SL] Evaluate fill found ${fillResult.debugInfo.length} inputs: ${JSON.stringify(fillResult.debugInfo)}`);
    }

    // Fallback: try using keyboard input (slower but more reliable)
    console.log(`[${exchange.name}] [TP/SL] Trying keyboard fallback...`);
    const fallbackResult = await fillTpSlWithKeyboard(page, exchange, calculatedTP, calculatedSL);
    if (fallbackResult.success) {
      console.log(`[${exchange.name}] [TP/SL] Keyboard fallback succeeded`);
    } else {
      // TP/SL is mandatory — abort order if all fill methods fail
      console.log(`[${exchange.name}] [TP/SL] ❌ All fill methods failed. TP/SL is mandatory — aborting order.`);
      return { success: false, error: 'All TP/SL fill methods failed — mandatory, cannot place order without TP/SL' };
    }
  }

  // Verify TP/SL values were actually set
  await delay(300);
  const verifyTpSl = async () => {
    return await page.evaluate((expectedTP, expectedSL) => {
      const panel = document.querySelector('[data-sentry-element="CreateOrderPanel"]');
      if (!panel) return { tpOk: false, slOk: false, tpVal: '', slVal: '' };
      const inputs = Array.from(panel.querySelectorAll('input')).filter(i => {
        const t = (i.type || '').toLowerCase();
        return t !== 'checkbox' && t !== 'hidden' && t !== 'range' && i.offsetParent !== null;
      });
      let tpVal = '', slVal = '';
      for (const input of inputs) {
        const ph = (input.placeholder || '').toLowerCase();
        if (ph.includes('tp') && !ph.includes('sl')) tpVal = input.value || '';
        if (ph.includes('sl') && !ph.includes('tp')) slVal = input.value || '';
      }
      const tpOk = !expectedTP || (tpVal && parseFloat(tpVal.replace(/,/g, '')) > 0);
      const slOk = !expectedSL || (slVal && parseFloat(slVal.replace(/,/g, '')) > 0);
      return { tpOk, slOk, tpVal, slVal };
    }, calculatedTP ? calculatedTP.toFixed(2) : '', calculatedSL ? calculatedSL.toFixed(2) : '');
  };

  const verifyResult = await verifyTpSl();
  if (verifyResult.tpOk && verifyResult.slOk) {
    console.log(`[${exchange.name}] [TP/SL] ✅ Verified: TP=${verifyResult.tpVal}, SL=${verifyResult.slVal}`);
    return { success: true };
  }

  // Values not verified — retry up to 2 more times with keyboard fill
  console.log(`[${exchange.name}] [TP/SL] ⚠️  Verification failed (TP=${verifyResult.tpVal || 'empty'}, SL=${verifyResult.slVal || 'empty'}). Retrying...`);
  for (let retry = 1; retry <= 2; retry++) {
    console.log(`[${exchange.name}] [TP/SL] Retry ${retry}/2...`);
    await delay(500);
    const retryResult = await fillTpSlWithKeyboard(page, exchange, calculatedTP, calculatedSL);
    if (retryResult.success) {
      await delay(300);
      const reVerify = await verifyTpSl();
      if (reVerify.tpOk && reVerify.slOk) {
        console.log(`[${exchange.name}] [TP/SL] ✅ Retry ${retry}: Verified TP=${reVerify.tpVal}, SL=${reVerify.slVal}`);
        return { success: true };
      }
    }
  }

  // All retries failed — TP/SL is mandatory, abort
  console.log(`[${exchange.name}] [TP/SL] ❌ All TP/SL fill retries failed. Mandatory — aborting order.`);
  return { success: false, error: 'TP/SL verification failed after retries — mandatory, cannot place order without TP/SL' };
}

/**
 * Fallback: Fill TP/SL trigger prices using keyboard input (slower but more reliable)
 */
async function fillTpSlWithKeyboard(page, exchange, calculatedTP, calculatedSL) {
  const panel = await page.$('[data-sentry-element="CreateOrderPanel"]');
  if (!panel) return { success: false, error: 'CreateOrderPanel not found' };

  // Find all visible non-checkbox inputs in the panel
  const inputs = await panel.$$('input:not([type="checkbox"])');
  let tpFilled = false;
  let slFilled = false;

  for (const input of inputs) {
    const isVisible = await page.evaluate(el => el.offsetParent !== null && !el.disabled, input);
    if (!isVisible) continue;

    const context = await page.evaluate(el => {
      let text = '';
      let parent = el.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        for (const child of parent.childNodes) {
          if (child.nodeType === 3 || (child.tagName && ['LABEL', 'SPAN', 'DIV'].includes(child.tagName))) {
            const t = (child.textContent || '').trim().toLowerCase();
            if (t.length < 50) text += t + ' ';
          }
        }
        parent = parent.parentElement;
      }
      return text;
    }, input);

    // Priority 1: Match by placeholder (avoids parent text contamination)
    // Use .placeholder property (not getAttribute) — React sets DOM property directly, not HTML attribute
    const placeholder = await page.evaluate(el => (el.placeholder || '').toLowerCase(), input);
    const isTPbyPh = !tpFilled && calculatedTP && placeholder.includes('tp') && !placeholder.includes('sl');
    const isSLbyPh = !slFilled && calculatedSL && placeholder.includes('sl') && !placeholder.includes('tp');

    // Priority 2: Match by surrounding context text
    const isTPbyCtx = !tpFilled && calculatedTP && !isTPbyPh && !isSLbyPh && (
      context.includes('take profit') ||
      (context.includes('tp') && !context.includes('stop'))
    );
    const isSLbyCtx = !slFilled && calculatedSL && !isTPbyPh && !isSLbyPh && (
      context.includes('stop loss') ||
      (context.includes('sl') && !context.includes('take'))
    );

    const isTP = isTPbyPh || isTPbyCtx;
    const isSL = isSLbyPh || isSLbyCtx;

    if (isTP || isSL) {
      const value = isTP ? calculatedTP.toFixed(2) : calculatedSL.toFixed(2);
      // DOM-level: focus + select all (instead of coordinate-based triple-click)
      await page.evaluate(el => { el.focus(); el.select(); }, input);
      await delay(50);
      await page.keyboard.press('Backspace');
      await delay(50);
      await safeType(page, input, value, { delay: 10 });
      await delay(100);

      if (isTP) {
        tpFilled = true;
        console.log(`[${exchange.name}] [TP/SL] Keyboard: TP trigger filled = ${value}`);
      } else {
        slFilled = true;
        console.log(`[${exchange.name}] [TP/SL] Keyboard: SL trigger filled = ${value}`);
      }
    }
  }

  return { success: tpFilled || slFilled, tp: tpFilled, sl: slFilled };
}


/**
 * Execute trade for GRVT
 * @param {number} thresholdMetTime - Timestamp when opening threshold was met (for timing metrics)
 * @param {number} cycleCount - Current cycle number (for logging)
 * @param {string} sideLabel - Trade side label ('BUY' or 'SELL') for logging
 * @param {string} email - Account email (for logging)
 */
export async function executeTradeGrvt(
  page,
  { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
  exchange,
  thresholdMetTime = null,
  cycleCount = null,
  sideLabel = '',
  email = ''
) {
  // ⏱️ TIMING: Track form fill start time
  const formFillStartTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = formFillStartTime - thresholdMetTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] Form filling started - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met`);
  }
  console.log(`\n=== Executing Trade on ${exchange.name} ===`);

  // Close any NotifyBarWrapper notifications before setting leverage
  await delay(1000); // Wait for notifications to appear
  await closeNotifyBarWrapperNotifications(page, exchange, 'before setting leverage');

  // Set leverage first if requested
  if (setLeverageFirst && leverage) {
    await setLeverageGrvt(page, leverage, exchange);
  }

  // If limit order without price, fetch aggressive price based on ORDER_AGGRESSIVENESS
  if (orderType === "limit" && !price) {
    price = await getAggressivePrice(page, exchange, side);
    if (!price) {
      console.log(`[${exchange.name}] Could not fetch market price for limit order`);
      return { success: false, error: "Could not fetch market price" };
    }
  }

  // GRVT: Use quantity from env if >= 0.002, otherwise default to 0.002
  const envQty = side === 'buy'
    ? parseFloat(process.env.BUY_QTY) || 0
    : parseFloat(process.env.SELL_QTY) || 0;

  const grvtSize = envQty >= 0.002 ? envQty : 0.002;

  if (envQty >= 0.002) {
    console.log(`[${exchange.name}] GRVT: Using quantity from env (${side.toUpperCase()}_QTY=${envQty}): ${grvtSize} BTC`);
  } else {
    console.log(`[${exchange.name}] GRVT: Env quantity (${envQty}) < 0.002, using default: ${grvtSize} BTC`);
  }

  console.log(
    `[${exchange.name}] Side: ${side}, Type: ${orderType}, Price: ${price || "market"
    }, Qty: ${grvtSize}`
  );

  // For GRVT: Limit/Market are tabs at the top, inputs (Price, Quantity) are always visible below
  // So we select the tab first, then fill inputs

  // 1. Select Limit or Market tab (tabs are at the top)
  // GRVT-specific: Scope search to CreateOrderPanel to avoid clicking deposit buttons
  console.log(`[${exchange.name}] Step 0: Selecting ${orderType.toUpperCase()} tab...`);
  
  // Check URL before starting - make sure we're on the trading page
  const initialUrl = page.url();
  if (initialUrl.includes('/deposit') || initialUrl.includes('/withdraw')) {
    console.log(`[${exchange.name}] ⚠️  Already on ${initialUrl}, navigating to trading page first...`);
    await page.goto(exchange.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);
  }
  
  // Scroll to top to ensure Limit/Market buttons are in viewport (they're at the top)
  // This is important because cleanup might have scrolled the page down
  console.log(`[${exchange.name}] Scrolling to top to ensure ${orderType.toUpperCase()} button is in viewport...`);
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  await delay(500); // Wait for scroll to complete
  
  try {
    // First, try to find CreateOrderPanel and search within it
    const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');
    let orderTypeResult = false;
    
    if (!createOrderPanel) {
      console.log(`[${exchange.name}] ⚠️  CreateOrderPanel not found, waiting and retrying...`);
      await delay(1000);
      const createOrderPanelRetry = await page.$('[data-sentry-element="CreateOrderPanel"]');
      if (!createOrderPanelRetry) {
        console.log(`[${exchange.name}] ❌ CreateOrderPanel still not found after retry`);
      }
    }
    
    if (createOrderPanel) {
      console.log(`[${exchange.name}] ✅ Found CreateOrderPanel, searching for ${orderType.toUpperCase()} button within it...`);
      const buttonText = orderType === "limit" ? exchange.selectors.limitButton : exchange.selectors.marketButton;
      
      // Search for button within CreateOrderPanel
      const orderTypeBtn = await createOrderPanel.evaluateHandle((panel, searchText, orderType) => {
        const buttons = Array.from(panel.querySelectorAll('button, div[role="button"], span[role="button"]'));
        for (const btn of buttons) {
          if (btn.offsetParent === null) continue; // Skip hidden buttons
          
          const btnText = (btn.textContent || '').trim();
          const btnTextLower = btnText.toLowerCase();
          const href = btn.getAttribute('href') || '';
          const isLink = btn.tagName === 'A' || href !== '';
          
          // Skip links and deposit/withdraw buttons
          if (isLink) continue;
          if (btnTextLower.includes('deposit') || btnTextLower.includes('withdraw')) continue;
          
          // Match Limit or Market (case-insensitive, allows partial match)
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
        // Basic verification before clicking
        const buttonInfo = await page.evaluate((el) => {
          const text = (el.textContent || '').trim();
          const href = el.getAttribute('href') || '';
          const isLink = el.tagName === 'A' || href !== '';
          return {
            text: text,
            isLink: isLink,
            href: href
          };
        }, orderTypeElement);
        
        // Skip if it's a link or contains deposit/withdraw
        if (buttonInfo.isLink || buttonInfo.text.toLowerCase().includes('deposit') || buttonInfo.text.toLowerCase().includes('withdraw')) {
          console.log(`[${exchange.name}] ⚠️  Found button but it's a link or contains deposit/withdraw (${buttonInfo.text}), skipping...`);
        } else {
          // Ensure button is in viewport before clicking
          const isInViewport = await page.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            // Fallback: if rect has zero dimensions (minimized), check offsetParent
            if (rect.width === 0 && rect.height === 0) {
              return el.offsetParent !== null;
            }
            return (
              rect.top >= 0 &&
              rect.left >= 0 &&
              rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
              rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );
          }, orderTypeElement);

          if (!isInViewport) {
            console.log(`[${exchange.name}] ${orderType.toUpperCase()} button is not in viewport, scrolling it into view...`);
            await page.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), orderTypeElement);
            await delay(500); // Wait for scroll to complete
          }

          console.log(`[${exchange.name}] ✅ Found ${orderType.toUpperCase()} button in CreateOrderPanel (text: "${buttonInfo.text}"), clicking...`);
          await safeClick(page, orderTypeElement);
          console.log(`[${exchange.name}] Selected ${orderType.toUpperCase()} order`);
          orderTypeResult = true;
          await delay(300);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  ${orderType.toUpperCase()} button not found in CreateOrderPanel, trying fallback...`);
      }
    }
    
    // Fallback: If not found in CreateOrderPanel, use standard selectOrderType
    if (!orderTypeResult) {
      console.log(`[${exchange.name}] Falling back to standard selectOrderType for ${orderType.toUpperCase()} button...`);
      const { selectOrderType } = await import('./executeBase.js');
      const orderTypePromise = selectOrderType(page, orderType, exchange);
      const orderTypeTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('selectOrderType timeout after 5 seconds')), 5000)
      );

      const result = await Promise.race([orderTypePromise, orderTypeTimeout]);
      if (result) {
        orderTypeResult = true;
      } else {
        console.log(`[${exchange.name}] ⚠️  Failed to select order type tab via fallback`);
      }
    }
  } catch (error) {
    console.log(`[${exchange.name}] ⚠️  Error selecting order type tab: ${error.message}`);
  }

  // CRITICAL: If Limit was requested but not selected, abort to prevent Market order
  if (!orderTypeResult && orderType === 'limit') {
    console.log(`[${exchange.name}] ❌ Failed to select LIMIT order type — aborting to prevent Market order`);
    return { success: false, error: "Failed to select Limit order type on GRVT" };
  }
  await delay(200); // Small delay for tab to activate

  // 2. Find inputs - GRVT has "Price" and "Quantity" inputs within CreateOrderPanel
  console.log(`[${exchange.name}] ===== STARTING INPUT FINDING PROCESS =====`);
  console.log(`[${exchange.name}] Looking for Price and Quantity inputs...`);

  let sizeInput = null;
  let priceInput = null;
  let sizeInputMethod = null; // Track which method found sizeInput
  let priceInputMethod = null; // Track which method found priceInput

  // METHOD 1: GRVT-specific: Find inputs within data-sentry-element="CreateOrderPanel"
  console.log(`[${exchange.name}] [METHOD 1] Attempting CreateOrderPanel search...`);
  const createOrderPanel = await page.$('[data-sentry-element="CreateOrderPanel"]');

  if (createOrderPanel) {
    console.log(`[${exchange.name}] [METHOD 1] ✅ Found CreateOrderPanel, searching for inputs within it...`);

    // Find all inputs within the CreateOrderPanel
    const panelInputs = await createOrderPanel.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
    console.log(`[${exchange.name}] Found ${panelInputs.length} input(s) in CreateOrderPanel`);

    for (const input of panelInputs) {
      const rect = await input.boundingBox();
      // When minimized, boundingBox() returns null — use DOM visibility check as fallback
      if (!rect) {
        const isDomVisible = await page.evaluate(el => el.offsetParent !== null && !el.disabled, input);
        if (!isDomVisible) continue;
      }

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
        sizeInputMethod = 'METHOD 1: CreateOrderPanel (text matching)';
        console.log(`[${exchange.name}] ✅ [${sizeInputMethod}] Found Quantity input in CreateOrderPanel`);
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
        priceInputMethod = 'METHOD 1: CreateOrderPanel (text matching)';
        console.log(`[${exchange.name}] ✅ [${priceInputMethod}] Found Price input in CreateOrderPanel`);
      }
    }

    // If we found one but not the other, try position-based matching within the panel
    if (sizeInput && !priceInput && orderType === "limit") {
      console.log(`[${exchange.name}] [METHOD 1] Found Quantity but not Price, trying position-based search within panel...`);
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
            priceInputMethod = 'METHOD 1: CreateOrderPanel (position-based)';
            console.log(`[${exchange.name}] ✅ [${priceInputMethod}] Found Price input via position-based search near Quantity`);
            break;
          }
        }
      } else {
        // Minimized: boundingBox() returns null — try DOM-based fallback using placeholder/label
        console.log(`[${exchange.name}] [METHOD 1] boundingBox() returned null (minimized?), trying DOM-based price input search...`);
        for (const input of panelInputs) {
          if (input === sizeInput) continue;
          const isDomVisible = await page.evaluate(el => el.offsetParent !== null && !el.disabled, input);
          if (!isDomVisible) continue;
          const inputInfo = await page.evaluate(el => ({
            placeholder: (el.placeholder || '').toLowerCase(),
            parentText: (el.parentElement?.textContent || '').toLowerCase().substring(0, 100)
          }), input);
          if (inputInfo.placeholder.includes('price') || inputInfo.parentText.includes('price')) {
            priceInput = input;
            priceInputMethod = 'METHOD 1: CreateOrderPanel (DOM-based fallback)';
            console.log(`[${exchange.name}] ✅ [${priceInputMethod}] Found Price input via DOM fallback`);
            break;
          }
        }
      }
    }
    console.log(`[${exchange.name}] [METHOD 1] Result: Quantity=${sizeInput ? 'FOUND' : 'NOT FOUND'}, Price=${priceInput ? 'FOUND' : 'NOT FOUND'}`);
  } else {
    console.log(`[${exchange.name}] [METHOD 1] ❌ CreateOrderPanel not found, skipping this method`);
  }

  // Summary of input finding results
  console.log(`[${exchange.name}] ===== INPUT FINDING SUMMARY =====`);
  if (sizeInput) {
    console.log(`[${exchange.name}] ✅ Quantity Input: FOUND via ${sizeInputMethod || 'UNKNOWN METHOD'}`);
  } else {
    console.log(`[${exchange.name}] ❌ Quantity Input: NOT FOUND after trying all methods`);
  }
  if (orderType === "limit") {
    if (priceInput) {
      console.log(`[${exchange.name}] ✅ Price Input: FOUND via ${priceInputMethod || 'UNKNOWN METHOD'}`);
    } else {
      console.log(`[${exchange.name}] ❌ Price Input: NOT FOUND after trying all methods`);
    }
  }
  console.log(`[${exchange.name}] =========================================`);

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

    // Method 1: Focus and select all (DOM-level)
    await page.evaluate(el => el.focus(), input);
    await delay(300);

    // Method 2: Select all text (DOM-level, replaces coordinate-based triple-click)
    await page.evaluate(el => { el.focus(); el.select(); }, input);
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

    // Focus the input first (DOM-level)
    await page.evaluate(el => el.focus(), input);
    await delay(200);

    // Select all existing text (DOM-level, replaces coordinate-based triple-click)
    await page.evaluate(el => { el.focus(); el.select(); }, input);
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
      await safeType(page, input, valueStr, { delay: 30 });
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
      await page.evaluate(el => el.focus(), input);
      await delay(200);
      await page.evaluate(el => { el.focus(); el.select(); }, input);
      await delay(100);
      await page.keyboard.press('Backspace');
      await delay(100);
      await safeType(page, input, valueStr, { delay: 50 });
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
      await safeClick(page, coinsOption);
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
        await safeClick(page, dropdownElement);
        await delay(500);
        // Try to find and click "Number of Coins" after opening
        const coinsOptionAfterOpen = await findByText(page, "Number of Coins", ["button", "div", "span", "option"]);
        if (coinsOptionAfterOpen) {
          await safeClick(page, coinsOptionAfterOpen);
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

  // Step 4.6: Update price input value to (current value - 10) before clicking Buy/Sell button
  // if (orderType === "limit" && priceInput) {
  //   console.log(`[${exchange.name}] Step 4.6: Updating price input value to (current value - 10) before clicking Buy/Sell button...`);
    
  //   // Get current price input value
  //   const currentPriceValue = await page.evaluate((el) => el.value || '', priceInput);
  //   const currentPriceNum = parseFloat(currentPriceValue.replace(/,/g, '').replace(/ /g, ''));
    
  //   if (currentPriceValue && !isNaN(currentPriceNum)) {
  //     const newPrice = currentPriceNum - 10;
  //     console.log(`[${exchange.name}] Current price: ${currentPriceNum}, New price (current - 10): ${newPrice}`);
      
  //     // Update the price input with the new value
  //     const priceUpdateSuccess = await clearAndFillInputGrvt(priceInput, newPrice, 'Price');
  //     if (!priceUpdateSuccess) {
  //       console.log(`[${exchange.name}] ⚠️  Price update failed, retrying...`);
  //       await delay(500);
  //       const retrySuccess = await clearAndFillInputGrvt(priceInput, newPrice, 'Price');
  //       if (!retrySuccess) {
  //         console.log(`[${exchange.name}] ❌ Price update failed after retry, continuing anyway...`);
  //       }
  //     }
      
  //     // Verify the updated price persists
  //     await delay(500);
  //     const updatedPriceCheck = await page.evaluate((el) => el.value || '', priceInput);
  //     const updatedPriceNum = parseFloat(updatedPriceCheck.replace(/,/g, ''));
  //     const priceTolerance = 0.1;
      
  //     if (updatedPriceCheck && Math.abs(updatedPriceNum - newPrice) < priceTolerance) {
  //       console.log(`[${exchange.name}] ✅ Price updated successfully: "${updatedPriceCheck}" (expected: ${newPrice}, got: ${updatedPriceNum})`);
  //     } else {
  //       console.log(`[${exchange.name}] ⚠️  Price update verification failed. Expected: ${newPrice}, Got: "${updatedPriceCheck}" (${updatedPriceNum})`);
  //     }
  //     await delay(300);
  //   } else {
  //     console.log(`[${exchange.name}] ⚠️  Could not read current price value: "${currentPriceValue}", skipping price update`);
  //   }
  // } else {
  //   console.log(`[${exchange.name}] Skipping price update - only applies to limit orders with price input`);
  // }

  // Step 5: Click Buy/Sell button - FOR GRVT, THIS IS THE FINAL CONFIRM BUTTON
  // GRVT: "Buy / Long" or "Sell / Short" button IS the confirm button (no separate confirm step)
  console.log(`[${exchange.name}] ===== STARTING BUY/SELL BUTTON FINDING PROCESS =====`);
  console.log(`[${exchange.name}] Step 5: Clicking ${side.toUpperCase()} button (this IS the confirm button for GRVT)...`);
  console.log(`[${exchange.name}]    Looking for: "${side === 'buy' ? exchange.selectors.buyButton : exchange.selectors.sellButton}"`);

  // Find the Buy/Sell button element directly (for GRVT, this is the final confirm)
  const buttonText = side === "buy" ? exchange.selectors.buyButton : exchange.selectors.sellButton;

  // METHOD 1: Try exact text match (this is the only method that works based on logs)
  console.log(`[${exchange.name}] [BUY/SELL METHOD 1] Attempting exact text match: "${buttonText}"`);
  const buySellBtn = await findByExactText(page, buttonText, ["button", "div", "span"]);

  // Summary of Buy/Sell button finding
  console.log(`[${exchange.name}] ===== BUY/SELL BUTTON FINDING SUMMARY =====`);
  if (buySellBtn) {
    console.log(`[${exchange.name}] ✅ Buy/Sell Button: FOUND via METHOD 1: Exact text match (findByExactText)`);
  } else {
    console.log(`[${exchange.name}] ❌ Buy/Sell Button: NOT FOUND`);
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
  console.log(`[${exchange.name}] =========================================`);

  // For GRVT, the Buy/Sell button click opens a modal - use clickConfirmButton for proper scrolling/visibility
  console.log(`[${exchange.name}] ✅ Found ${side.toUpperCase()} button via METHOD 1: Exact text match (findByExactText), clicking (this will open a confirmation modal for GRVT)...`);
  
  // ⏱️ TIMING: Track Buy/Sell button click time
  const buySellButtonClickTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = buySellButtonClickTime - thresholdMetTime;
    const formFillTime = buySellButtonClickTime - formFillStartTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] Buy/Sell button clicked - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met (form fill took ${(formFillTime / 1000).toFixed(2)}s)`);
  }
  
  await clickConfirmButton(page, buySellBtn, buttonText, exchange, side);

  // GRVT auto-confirms orders on Buy/Sell click — NO separate confirm modal.
  // Previously searched for "Confirm" button and clicked it, causing DOUBLE ORDERS
  // (the found "Confirm" triggered a second order placement). Removed in Change #86.
  await delay(300);

  // Verify order placement (use grvtSize instead of qty parameter)
   return await verifyOrderPlacement(page, exchange, side, grvtSize);
}
