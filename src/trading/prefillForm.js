import { selectBuyOrSell, enterSize } from './executeBase.js';
import { selectOrderTypeKraken, findKrakenInputs } from './executeKraken.js';
import { delay } from '../utils/helpers.js';

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
