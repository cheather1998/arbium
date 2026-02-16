import { delay, findByText, findByExactText, closeNotifyBarWrapperNotifications } from '../utils/helpers.js';
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
    // const panelCheckboxes = await createOrderPanel.$$('input[type="checkbox"]');
    // for (const checkbox of panelCheckboxes) {
    //   const isVisible = await page.evaluate((el) => el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0, checkbox);
    //   if (!isVisible) continue;

    //   // Check parent text for TP/SL
    //   const parentText = await page.evaluate((el) => {
    //     let parent = el.parentElement;
    //     for (let i = 0; i < 5 && parent; i++) {
    //       if (parent.textContent) {
    //         const text = parent.textContent.toLowerCase();
    //         if (text.includes('tp') && text.includes('sl')) {
    //           return text;
    //         }
    //       }
    //       parent = parent.parentElement;
    //     }
    //     return '';
    //   }, checkbox);

    //   if (parentText.includes('tp') && parentText.includes('sl')) {
    //     checkboxElement = checkbox;
    //     isChecked = await page.evaluate((el) => el.checked, checkbox);
    //     console.log(`[${exchange.name}] ✅ Found TP/SL : 1 checkbox in CreateOrderPanel (checked: ${isChecked})`);
    //     break;
    //   }
    // }

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
            console.log(`[${exchange.name}] ✅ Found TP/SL : 2 checkbox via label in CreateOrderPanel (checked: ${isChecked})`);
            break;
          }
        }
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

  // Find and click "Advanced" element in the same parent container as TP/SL checkbox
  if (checkboxElement) {
    console.log(`[${exchange.name}] Looking for "Advanced" element in the same parent container as TP/SL checkbox...`);

    try {
      const advancedElement = await page.evaluateHandle((checkbox) => {
        // Find the parent container that contains the checkbox
        let parentContainer = checkbox.parentElement;

        // Try to find a common parent container (go up a few levels if needed)
        for (let i = 0; i < 5 && parentContainer; i++) {
          // Search for "Advanced" element within this parent container
          const allElements = Array.from(parentContainer.querySelectorAll('*'));

          for (const el of allElements) {
            // Skip if not visible
            if (el.offsetParent === null || el.offsetWidth === 0 || el.offsetHeight === 0) continue;

            // Check if element contains "Advanced" text (case-insensitive, exact match preferred)
            const text = (el.textContent || '').trim();
            if (text.toLowerCase() === 'advanced' || text.toLowerCase().includes('advanced')) {
              return el;
            }
          }

          // If not found, try the next parent level
          parentContainer = parentContainer.parentElement;
        }

        return null;
      }, checkboxElement);

      if (advancedElement && advancedElement.asElement()) {
        const advancedEl = advancedElement.asElement();
        console.log(`[${exchange.name}] ✅ Found "Advanced" element in same parent container, clicking...`);

        try {
          await advancedEl.click();
          console.log(`[${exchange.name}] ✅ Clicked "Advanced" element successfully`);
          await delay(500);
        } catch (clickError) {
          console.log(`[${exchange.name}] ⚠️  Direct click failed: ${clickError.message}, trying JavaScript click...`);
          try {
            await advancedEl.evaluate(el => {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.click();
            });
            console.log(`[${exchange.name}] ✅ Clicked "Advanced" element via JavaScript`);
            await delay(500);
          } catch (jsError) {
            console.log(`[${exchange.name}] ⚠️  Failed to click "Advanced" element: ${jsError.message}`);
          }
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Could not find "Advanced" element in same parent container as TP/SL checkbox`);
      }
    } catch (error) {
      console.log(`[${exchange.name}] ⚠️  Error searching for "Advanced" element: ${error.message}`);
    }
  }

  // Wait for TP/SL modal to open after clicking Advanced
  console.log(`[${exchange.name}] Waiting for TP/SL modal to open...`);
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
      console.log(`[${exchange.name}] ✅ TP/SL modal opened`);
      await delay(500);
      break;
    }
    await delay(300);
  }

  if (modalOpened) {
    // First, select Buy/Long or Sell/Short based on side parameter (before other operations)
    console.log(`[${exchange.name}] 🔄 [TOGGLE SELECTION] Selecting ${side === 'buy' ? 'Buy/Long' : 'Sell/Short'} option in TP/SL modal...`);
    try {
      const toggleOptionHandle = await page.evaluateHandle((side) => {
        // Find toggle container first (usually has class containing "toggle")
        const toggleContainers = Array.from(document.querySelectorAll('[class*="toggle"], [class*="Toggle"]'));
        
        for (const container of toggleContainers) {
          // Look for toggle items inside the container
          const toggleItems = Array.from(container.querySelectorAll('[class*="toggleItem"], div[class*="toggleItem"]'));
          
          for (const item of toggleItems) {
            const text = (item.textContent || '').trim();
            
            // Check if this is the target option
            if (side === 'buy') {
              if (text === 'Buy/Long' || text === 'Buy' || text === 'Long') {
                if (item.offsetParent !== null) return item;
              }
            } else if (side === 'sell') {
              if (text === 'Sell/Short' || text === 'Sell' || text === 'Short') {
                if (item.offsetParent !== null) return item;
              }
            }
          }
        }
        
        // Fallback: search all elements for toggle items
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          const className = el.className || '';
          
          if (className.includes('toggleItem') && el.offsetParent !== null) {
            if (side === 'buy' && (text === 'Buy/Long' || text === 'Buy' || text === 'Long')) {
              return el;
            } else if (side === 'sell' && (text === 'Sell/Short' || text === 'Sell' || text === 'Short')) {
              return el;
            }
          }
        }
        
        return null;
      }, side);
      
      const toggleOption = toggleOptionHandle.asElement();
      if (toggleOption) {
        // Check if it's already selected (has active class or green background)
        const isAlreadySelected = await page.evaluate((element) => {
          const className = element.className || '';
          const style = window.getComputedStyle(element);
          const bgColor = style.backgroundColor || '';
          
          // Check for active class
          if (className.includes('active') || className.includes('Active')) {
            return true;
          }
          
          // Check for green background (Buy/Long is usually green when active)
          if (bgColor.includes('rgb')) {
            const rgbMatch = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (rgbMatch) {
              const r = parseInt(rgbMatch[1]);
              const g = parseInt(rgbMatch[2]);
              const b = parseInt(rgbMatch[3]);
              // Green color typically has high green value
              if (g > 150 && r < 100 && b < 100) {
                return true;
              }
            }
          }
          
          return false;
        }, toggleOption);
        
        if (!isAlreadySelected) {
          // Use JavaScript click to avoid triggering unwanted events
          await toggleOption.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await delay(300);
          
          // Click using JavaScript to prevent event propagation issues
          await toggleOption.evaluate((el) => {
            const clickEvent = new MouseEvent('click', {
              view: window,
              bubbles: true,
              cancelable: true,
              buttons: 1
            });
            el.dispatchEvent(clickEvent);
          });
          
          console.log(`[${exchange.name}] ✅ [TOGGLE SELECTION] Selected ${side === 'buy' ? 'Buy/Long' : 'Sell/Short'} option`);
          await delay(300);
        } else {
          console.log(`[${exchange.name}] ✅ [TOGGLE SELECTION] ${side === 'buy' ? 'Buy/Long' : 'Sell/Short'} option is already selected`);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  [TOGGLE SELECTION] Could not find ${side === 'buy' ? 'Buy/Long' : 'Sell/Short'} toggle option`);
      }
    } catch (error) {
      console.log(`[${exchange.name}] ⚠️  [TOGGLE SELECTION] Error selecting ${side === 'buy' ? 'Buy/Long' : 'Sell/Short'} option: ${error.message}`);
      // Continue with the flow even if toggle selection fails
    }
    
    // Verify modal is still open before proceeding
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
      console.log(`[${exchange.name}] ⚠️  Modal closed after toggle selection, cannot proceed with TP/SL configuration`);
      return { success: false, error: 'Modal closed after toggle selection' };
    }
    
    // Small delay to ensure modal is fully ready after toggle selection
    await delay(200);
    
    const takeProfitPercent = process.env.TAKE_PROFIT || '';
    const stopLossPercent = process.env.STOP_LOSS || '';

    console.log(`[${exchange.name}] Configuring TP/SL modal with TAKE_PROFIT=${takeProfitPercent}, STOP_LOSS=${stopLossPercent}...`);

    // Helper function to find and click ROI% element for a section
    // Phase 1: Only find and click ROI% - no dropdown selection or input filling yet
    const fillRoiInput = async (sectionName, value) => {
      console.log(`[${exchange.name}] [PHASE 1] Finding and clicking ROI% element for ${sectionName}...`);

      // Step 1: Find ROI% element's parent to click (following the specified approach)
      console.log(`[${exchange.name}] [ROI% FINDING] Starting evaluation to find ROI% parent element...`);
      let roiParentInfo;
      try {
        roiParentInfo = await page.evaluate((sectionName) => {
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
        
        // Search all elements in modal for section header
        const modalElements = Array.from(tpslModal.querySelectorAll('*'));
        for (const el of modalElements) {
          const text = (el.textContent || '').trim();
          // Match exact text (case-insensitive) - "Take profit" or "Stop loss"
          if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
            sectionElement = el;
            break;
          }
        }

        if (!sectionElement) {
          return { 
            success: false, 
            step: 2, 
            message: `Could not find element with text "${sectionName}"`
          };
        }

        // Step 3: Find sectionElement's parent (the section container)
        const sectionParent = sectionElement.parentElement;
        if (!sectionParent) {
          return { success: false, step: 3, message: `Could not find parent of "${sectionName}" element` };
        }

        // Step 4: Inside sectionParent, find element with text "ROI%" and click on it directly
        const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
        let roiElement = null;
        
        for (const el of allDescendants) {
          const text = (el.textContent || '').trim();
          // Match exact "ROI%" text
          if (text === 'ROI%' && el.offsetParent !== null) {
            roiElement = el;
            break;
          }
        }

        if (!roiElement) {
          return { 
            success: false, 
            step: 4, 
            message: `Could not find "ROI%" element inside "${sectionName}" parent`
          };
        }

        // Get the ROI% element's bounding rect for clicking
        const rect = roiElement.getBoundingClientRect();
        
        // DEBUG: Find all inputs (not labels) with empty or whitespace placeholder and className containing "text"
        const allInputsInModal = Array.from(tpslModal.querySelectorAll('input'));
        const emptyPlaceholderInputs = [];
        for (const input of allInputsInModal) {
          // Only process input elements (not labels)
          if (input.tagName !== 'INPUT') continue;
          
          const placeholder = input.getAttribute('placeholder') || '';
          const className = input.className || '';
          
          // Check if placeholder is empty or only whitespace AND className contains "text"
          if ((placeholder.trim() === '' || placeholder === ' ') && className.toLowerCase().includes('text')) {
            emptyPlaceholderInputs.push({
              className: className
            });
          }
        }
        
        return {
          success: true,
          clickX: rect.x + rect.width / 2,
          clickY: rect.y + rect.height / 2,
          debugInfo: {
            emptyPlaceholderInputsCount: emptyPlaceholderInputs.length,
            emptyPlaceholderInputs: emptyPlaceholderInputs
          }
        };
      }, sectionName);
      } catch (error) {
        console.log(`[${exchange.name}] ❌ [ROI% FINDING] Error during page.evaluate: ${error.message}`);
        return false;
      }

      if (!roiParentInfo) {
        console.log(`[${exchange.name}] [ROI% FINDING] Evaluation returned null/undefined`);
        return false;
      }

      if (!roiParentInfo.success) {
        console.log(`[${exchange.name}] [ROI% FINDING] ❌ Step ${roiParentInfo.step} failed: ${roiParentInfo.message}`);
        if (roiParentInfo.sampleTexts) {
          console.log(`[${exchange.name}] [ROI% FINDING] Sample texts found in modal: ${roiParentInfo.sampleTexts.join(', ')}`);
        }
        if (roiParentInfo.roiTexts) {
          console.log(`[${exchange.name}] [ROI% FINDING] ROI-related texts found: ${roiParentInfo.roiTexts.join(', ')}`);
        }
        return false;
      }

      console.log(`[${exchange.name}] [ROI% FINDING] ✅ Successfully found ROI% element`);
      console.log(`[${exchange.name}] 🔍 [ROI% ELEMENT] Found ROI% element for ${sectionName} at coordinates (${roiParentInfo.clickX}, ${roiParentInfo.clickY})`);
      
      // Log debug info about inputs with empty placeholders (from browser context)
      if (roiParentInfo.debugInfo) {
        console.log(`[${exchange.name}] [DEBUG] Found ${roiParentInfo.debugInfo.emptyPlaceholderInputsCount} input(s) with empty or whitespace placeholder in TP/SL modal`);
        roiParentInfo.debugInfo.emptyPlaceholderInputs.forEach((input, idx) => {
          console.log(`[${exchange.name}] [DEBUG] Input ${idx + 1} class: "${input.className}"`);
        });
      }

      try {
        // Phase 1: Click on ROI% element, then press ArrowDown twice and Enter
        console.log(`[${exchange.name}] 🔧 [PHASE 1] Clicking on ROI% element for ${sectionName}...`);
        await page.mouse.click(roiParentInfo.clickX, roiParentInfo.clickY);
        await delay(300);
        console.log(`[${exchange.name}] ✅ Clicked ROI% element for ${sectionName}`);
        
        // Press ArrowDown twice, then press Enter to select P&L
        console.log(`[${exchange.name}] ⌨️  Pressing ArrowDown x2 for ${sectionName} ROI%...`);
        await page.keyboard.press('ArrowDown');
        await delay(300);
        await page.keyboard.press('ArrowDown');
        await delay(300);
        
        // Wait for dropdown to be ready
        console.log(`[${exchange.name}] ⏳ Waiting for ROI% dropdown to be ready...`);
        let dropdownReady = false;
        for (let i = 0; i < 10; i++) {
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
          console.log(`[${exchange.name}] ⚠️  ROI% dropdown not ready, proceeding anyway...`);
        }
        
        await delay(200);
        
        // Press Enter to select P&L option
        console.log(`[${exchange.name}] ⌨️  Pressing Enter to select P&L option...`);
        await page.keyboard.press('Enter');
        await delay(500);
        
        // Wait for ROI% dropdown to close and P&L to be selected
        console.log(`[${exchange.name}] ⏳ Waiting for ROI% dropdown to close and P&L to be selected...`);
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
          console.log(`[${exchange.name}] ⚠️  ROI% dropdown did not close within timeout`);
        }
        
        await delay(300); // Additional delay to ensure UI is stable
        
        // Check if modal is still open after selection
        const modalStillOpenAfter = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
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
                    return true; // Modal is still open
                  }
                }
                parent = parent.parentElement;
              }
            }
          }
          return false; // Modal not found or closed
        });
        
        if (!modalStillOpenAfter) {
          console.log(`[${exchange.name}] ⚠️  Modal closed after ROI% dropdown selection`);
          return false;
        }
        
        console.log(`[${exchange.name}] ✅ [PHASE 1] Completed ROI% dropdown selection for ${sectionName} (modal still open)`);
        
        await delay(500); // Wait before moving to Phase 2
        
        // Phase 2: Find Market dropdown within the specific section and click it
        console.log(`[${exchange.name}] 🔧 [PHASE 2] Finding Market dropdown Select element for ${sectionName}...`);
        const selectElementInfo = await page.evaluate((sectionName) => {
          // Find the TP/SL modal
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
          
          // Step 1: Find the section element (Take profit or Stop loss)
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
            return { success: false, message: `Could not find "${sectionName}" section` };
          }
          
          // Step 2: Find the section parent container that contains this section's Market dropdown
          // Walk up to find a container that has Market dropdown but doesn't have the other section
          let sectionParent = sectionElement.parentElement;
          const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
          
          for (let i = 0; i < 10 && sectionParent; i++) {
            const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
            let hasMarketSelect = false;
            let hasOtherSection = false;
            
            for (const el of allDescendants) {
              // Check for Market text in a singleValue element (the actual Market dropdown value)
              const text = (el.textContent || '').trim();
              if (text === 'Market' && el.offsetParent !== null) {
                // Check if this is inside a Select element with data-sentry-component="Select"
                let parent = el.parentElement;
                for (let j = 0; j < 5 && parent; j++) {
                  if (parent.getAttribute && parent.getAttribute('data-sentry-component') === 'Select') {
                    hasMarketSelect = true;
                    break;
                  }
                  parent = parent.parentElement;
                }
              }
              // Check if this container has the OTHER section (we don't want that)
              if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
                hasOtherSection = true;
                break;
              }
            }
            
            // If this container has Market Select and doesn't have the other section, it's the right container
            if (hasMarketSelect && !hasOtherSection) {
              break;
            }
            
            sectionParent = sectionParent.parentElement;
            if (!sectionParent) break;
          }
          
          if (!sectionParent) {
            sectionParent = sectionElement.parentElement;
          }
          
          // Step 3: Find the Market dropdown Select element within this section
          // Look for element with data-sentry-component="Select" that has "Market" in style_singleValue__arIDb
          const allSelectElements = Array.from(sectionParent.querySelectorAll('[data-sentry-component="Select"]'));
          
          for (const selectEl of allSelectElements) {
            if (selectEl.offsetParent === null) continue;
            const style = window.getComputedStyle(selectEl);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (selectEl.offsetWidth === 0 || selectEl.offsetHeight === 0) continue;
            
            // Check if this Select element contains "Market" text in a singleValue element
            // Look for div with class containing "singleValue" that has "Market" text
            const singleValueElements = Array.from(selectEl.querySelectorAll('[class*="singleValue"]'));
            for (const svEl of singleValueElements) {
              const svText = (svEl.textContent || '').trim();
              if (svText === 'Market') {
                // Found the Market dropdown! Get the clickable area (the Select wrapper or control)
                // Click on the control element (the clickable part of the dropdown)
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
          console.log(`[${exchange.name}] ⚠️  Could not find Select element: ${selectElementInfo?.message || 'unknown error'}`);
          return false;
        }
        
        console.log(`[${exchange.name}] ✅ Found Market Select element for ${selectElementInfo.sectionName || sectionName}`);
        
        // Check if modal is still open before clicking
        const modalStillOpenBeforeSelect = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
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
                    return true;
                  }
                }
                parent = parent.parentElement;
              }
            }
          }
          return false;
        });
        
        if (!modalStillOpenBeforeSelect) {
          console.log(`[${exchange.name}] ⚠️  Modal closed before clicking Select element`);
          return false;
        }
        
        // Click the Select element
        console.log(`[${exchange.name}] 🔧 Clicking Market Select element for ${sectionName} at coordinates (${selectElementInfo.clickX}, ${selectElementInfo.clickY})...`);
        await page.mouse.click(selectElementInfo.clickX, selectElementInfo.clickY);
        await delay(500);
        console.log(`[${exchange.name}] ✅ Clicked Market Select element for ${sectionName}`);
        
        // Wait for Select dropdown to open
        console.log(`[${exchange.name}] ⏳ Waiting for Select dropdown to open...`);
        let dropdownOpened = false;
        for (let i = 0; i < 10; i++) {
          const checkResult = await page.evaluate(() => {
            // Check if dropdown is open
            const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
            const menus = Array.from(document.querySelectorAll('[role="menu"]'));
            const allDropdowns = [...listboxes, ...menus];
            
            // Also check for aria-expanded="true"
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
          console.log(`[${exchange.name}] ⚠️  Select dropdown did not open within timeout, proceeding anyway...`);
        } else {
          console.log(`[${exchange.name}] ✅ Select dropdown opened`);
        }
        
        await delay(300); // Additional delay to ensure dropdown is fully open
        
        // Press ArrowDown once, then press Enter to select the option
        console.log(`[${exchange.name}] ⌨️  Pressing ArrowDown x1, then Enter to select option...`);
        await page.keyboard.press('ArrowDown');
        await delay(300);
        await page.keyboard.press('Enter');
        await delay(300);
        console.log(`[${exchange.name}] ✅ Pressed Enter to select option in Select dropdown`);
        
        // Check if modal is still open after selection
        const modalStillOpenAfterSelect = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
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
                    return true;
                  }
                }
                parent = parent.parentElement;
              }
            }
          }
          return false;
        });
        
        if (!modalStillOpenAfterSelect) {
          console.log(`[${exchange.name}] ⚠️  Modal closed after Select dropdown selection`);
          return false;
        }
        
        console.log(`[${exchange.name}] ✅ [PHASE 2] Completed Market dropdown selection for ${sectionName} (modal still open)`);
        
        await delay(500); // Wait before moving to Phase 3
        
        // Phase 3: Fill input values - first input gets TAKE_PROFIT/10, second gets STOP_LOSS/10
        console.log(`[${exchange.name}] 🔧 [PHASE 3] Filling input values for ${sectionName}...`);
        
        // Find input elements and get their selectors/identifiers
        const inputInfo = await page.evaluate((sectionName) => {
          // Find the TP/SL modal
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
          
          // Find all inputs with empty/whitespace placeholder and className containing "text"
          const allInputsInModal = Array.from(tpslModal.querySelectorAll('input'));
          const emptyPlaceholderInputs = [];
          for (const input of allInputsInModal) {
            if (input.tagName !== 'INPUT') continue;
            const placeholder = input.getAttribute('placeholder') || '';
            const className = input.className || '';
            if ((placeholder.trim() === '' || placeholder === ' ') && className.toLowerCase().includes('text')) {
              if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
                // Get unique identifier for the input (prefer ID, fallback to generating a selector)
                let identifier = input.id || '';
                if (!identifier) {
                  // Generate a selector based on position and parent
                  const parent = input.closest('[data-sentry-component]') || input.parentElement;
                  const index = Array.from(parent.querySelectorAll('input')).indexOf(input);
                  identifier = `input-${index}`;
                }
                emptyPlaceholderInputs.push({
                  id: input.id || '',
                  identifier: identifier,
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
          console.log(`[${exchange.name}] ⚠️  Could not find inputs: ${inputInfo?.message || 'unknown error'}`);
          return false;
        }
        
        const takeProfitValue = (parseFloat(takeProfitPercent) / 10).toString();
        const stopLossValue = (parseFloat(stopLossPercent) / 10).toString();
        
        // Type into first input (TAKE_PROFIT/10)
        if (inputInfo.inputs.length >= 1) {
          const firstInputInfo = inputInfo.inputs[0];
          console.log(`[${exchange.name}] ⌨️  Typing into first input: ${takeProfitValue}...`);
          
          try {
            // Find the input element using evaluateHandle (works with any ID, including colons)
            let inputElement = null;
            if (firstInputInfo.id) {
              // Use evaluateHandle to get element by ID directly (handles special characters)
              inputElement = await page.evaluateHandle((id) => {
                return document.getElementById(id);
              }, firstInputInfo.id);
              
              // Check if element was found
              const isValid = await page.evaluate(el => el !== null && el !== undefined, inputElement);
              if (!isValid) {
                inputElement = null;
              }
            }
            
            // Fallback: find by className and position
            if (!inputElement) {
              const allInputs = await page.$$('input');
              console.log(`[${exchange.name}] [DEBUG] Found ${allInputs.length} total input elements, searching for first matching input...`);
              for (let i = 0; i < allInputs.length; i++) {
                const input = allInputs[i];
                const className = await page.evaluate(el => el.className || '', input);
                const placeholder = await page.evaluate(el => el.getAttribute('placeholder') || '', input);
                const id = await page.evaluate(el => el.id || '', input);
                const isVisible = await page.evaluate(el => {
                  const style = window.getComputedStyle(el);
                  return el.offsetParent !== null && 
                         style.display !== 'none' && 
                         style.visibility !== 'hidden' &&
                         !el.disabled && 
                         !el.readOnly;
                }, input);
                
                console.log(`[${exchange.name}] [DEBUG] Input ${i}: id="${id}", className="${className}", placeholder="${placeholder}", visible=${isVisible}`);
                
                if (className.toLowerCase().includes('text') && (placeholder.trim() === '' || placeholder === ' ') && isVisible) {
                  inputElement = input;
                  console.log(`[${exchange.name}] [DEBUG] Found first matching input at index ${i}`);
                  break;
                }
              }
            }
            
            if (inputElement) {
              // Focus the input
              await inputElement.focus();
              await delay(200);
              
              // Select all existing text
              await page.keyboard.down('Control');
              await page.keyboard.press('KeyA');
              await page.keyboard.up('Control');
              await delay(100);
              
              // Clear existing value
              await page.keyboard.press('Backspace');
              await delay(100);
              
              // Type the value character by character using inputElement.type()
              await inputElement.type(takeProfitValue, { delay: 50 }); // 50ms delay between characters
              await delay(200);
              
              console.log(`[${exchange.name}] ✅ Typed into first input: ${takeProfitValue}`);
            } else {
              console.log(`[${exchange.name}] ⚠️  Could not find first input element to type into`);
            }
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error typing into first input: ${error.message}`);
          }
        }
        
        // Type into second input (STOP_LOSS/10)
        if (inputInfo.inputs.length >= 2) {
          const secondInputInfo = inputInfo.inputs[1];
          console.log(`[${exchange.name}] ⌨️  Typing into second input: ${stopLossValue}...`);
          
          try {
            // Find the input element using evaluateHandle (works with any ID, including colons)
            let inputElement = null;
            if (secondInputInfo.id) {
              // Use evaluateHandle to get element by ID directly (handles special characters)
              inputElement = await page.evaluateHandle((id) => {
                return document.getElementById(id);
              }, secondInputInfo.id);
              
              // Check if element was found
              const isValid = await page.evaluate(el => el !== null && el !== undefined, inputElement);
              if (!isValid) {
                inputElement = null;
              }
            }
            
            // Fallback: find by className and position (second one)
            if (!inputElement) {
              const allInputs = await page.$$('input');
              let foundFirst = false;
              for (const input of allInputs) {
                const className = await page.evaluate(el => el.className || '', input);
                const placeholder = await page.evaluate(el => el.getAttribute('placeholder') || '', input);
                if (className.toLowerCase().includes('text') && (placeholder.trim() === '' || placeholder === ' ')) {
                  const isVisible = await page.evaluate(el => {
                    const style = window.getComputedStyle(el);
                    return el.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden' &&
                           !el.disabled && 
                           !el.readOnly;
                  }, input);
                  
                  if (isVisible) {
                    if (foundFirst) {
                      inputElement = input;
                      break;
                    } else {
                      foundFirst = true;
                    }
                  }
                }
              }
            }
            
            if (inputElement) {
              // Focus the input
              await inputElement.focus();
              await delay(200);
              
              // Select all existing text
              await page.keyboard.down('Control');
              await page.keyboard.press('KeyA');
              await page.keyboard.up('Control');
              await delay(100);
              
              // Clear existing value
              await page.keyboard.press('Backspace');
              await delay(100);
              
              // Type the value character by character using inputElement.type()
              await inputElement.type(stopLossValue, { delay: 50 }); // 50ms delay between characters
              await delay(200);
              
              console.log(`[${exchange.name}] ✅ Typed into second input: ${stopLossValue}`);
            } else {
              console.log(`[${exchange.name}] ⚠️  Could not find second input element to type into`);
            }
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error typing into second input: ${error.message}`);
          }
        }
        
        const inputFillResult = {
          success: true,
          inputsFound: inputInfo.inputsFound,
          results: [
            { index: 1, value: takeProfitValue, filled: inputInfo.inputs.length >= 1 },
            { index: 2, value: stopLossValue, filled: inputInfo.inputs.length >= 2 }
          ]
        };
        
        if (inputFillResult && inputFillResult.success) {
          console.log(`[${exchange.name}] ✅ Filled ${inputFillResult.results.length} input(s) with values`);
          inputFillResult.results.forEach((result) => {
            console.log(`[${exchange.name}]    Input ${result.index}: ${result.value}`);
          });
          
          // Wait for inputs to be filled and UI to update
          console.log(`[${exchange.name}] ⏳ Waiting for inputs to be filled and UI to update...`);
          await delay(500);
          
          // Verify inputs are actually filled
          const verifyInputs = await page.evaluate((sectionName, takeProfitValue, stopLossValue) => {
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
            
            if (!tpslModal) return { verified: false, message: 'Modal not found' };
            
            const allInputsInModal = Array.from(tpslModal.querySelectorAll('input'));
            const filledInputs = [];
            for (const input of allInputsInModal) {
              if (input.tagName !== 'INPUT') continue;
              const placeholder = input.getAttribute('placeholder') || '';
              const className = input.className || '';
              if ((placeholder.trim() === '' || placeholder === ' ') && className.toLowerCase().includes('text')) {
                if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
                  const value = input.value || '';
                  if (value.trim() !== '') {
                    filledInputs.push({ value: value });
                  }
                }
              }
            }
            
            return { verified: filledInputs.length > 0, filledCount: filledInputs.length };
          }, sectionName, (parseFloat(takeProfitPercent) / 10).toString(), (parseFloat(stopLossPercent) / 10).toString());
          
          if (!verifyInputs.verified) {
            console.log(`[${exchange.name}] ⚠️  Inputs verification failed, waiting longer...`);
            await delay(500);
          } else {
            console.log(`[${exchange.name}] ✅ Verified ${verifyInputs.filledCount} input(s) are filled`);
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not fill inputs: ${inputFillResult?.message || 'unknown error'}`);
          return false;
        }
        
        console.log(`[${exchange.name}] ✅ [PHASE 3] Completed input filling for ${sectionName}`);
        return true;
      } catch (error) {
        console.log(`[${exchange.name}] ⚠️  Error clicking ROI% element for ${sectionName}: ${error.message}`);
        return false;
      }
    };

    // OLD Helper function to select "Limit" in Market dropdown for a section - REMOVED
    // Market dropdown logic is now integrated into fillRoiInput function
    const selectLimitInMarketDropdown_OLD = async (sectionName) => {
      console.log(`[${exchange.name}] Finding and clicking Market element for ${sectionName}...`);
      
      let marketInfo;
      try {
        // Find the Market element for the section using text-based approach
        marketInfo = await page.evaluate((sectionName) => {
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
          
          // Search all elements in modal for section header
          const modalElements = Array.from(tpslModal.querySelectorAll('*'));
          for (const el of modalElements) {
            const text = (el.textContent || '').trim();
            // Match exact text (case-insensitive) - "Take profit" or "Stop loss"
            if (text.toLowerCase() === sectionNameLower && el.offsetParent !== null) {
              sectionElement = el;
              break;
            }
          }

          if (!sectionElement) {
            return { 
              success: false, 
              step: 2, 
              message: `Could not find element with text "${sectionName}"`
            };
          }

          // Step 3: Find sectionElement's parent (the section container)
          // We need to find a container that has this section's Market but NOT the other section
          let sectionParent = sectionElement.parentElement;
          const otherSectionName = sectionNameLower.includes('profit') ? 'stop loss' : 'take profit';
          
          // Walk up to find a container that has Market but doesn't have the other section
          for (let i = 0; i < 10 && sectionParent; i++) {
            const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
            let hasMarket = false;
            let hasOtherSection = false;
            
            for (const el of allDescendants) {
              const text = (el.textContent || '').trim();
              if (text === 'Market' && el.offsetParent !== null) {
                hasMarket = true;
              }
              // Check if this container has the OTHER section (we don't want that)
              if (text.toLowerCase() === otherSectionName && el.offsetParent !== null) {
                hasOtherSection = true;
                break;
              }
            }
            
            // If this container has Market and doesn't have the other section, it's the right container
            if (hasMarket && !hasOtherSection) {
              break;
            }
            
            sectionParent = sectionParent.parentElement;
          }
          
          if (!sectionParent) {
            // Fallback: use immediate parent
            sectionParent = sectionElement.parentElement;
            if (!sectionParent) {
              return { success: false, step: 3, message: `Could not find parent of "${sectionName}" element` };
            }
          }

          // Step 4: Inside sectionParent, find element with text "Market"
          const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
          let marketElement = null;
          
          for (const el of allDescendants) {
            if (el.offsetParent === null) continue;
            
            // Get text content - try both direct text and full textContent
            const directText = Array.from(el.childNodes)
              .filter(node => node.nodeType === Node.TEXT_NODE)
              .map(node => node.textContent)
              .join('')
              .trim();
            const fullText = (el.textContent || '').trim();
            
            // Match exact "Market" text (check both direct text and full text)
            if ((directText === 'Market' || fullText === 'Market')) {
              marketElement = el;
              console.log(`[DEBUG] Found Market element for ${sectionName}: directText="${directText}", fullText="${fullText}", tagName="${el.tagName}", className="${el.className || ''}"`);
              break;
            }
          }

          if (!marketElement) {
            return { 
              success: false, 
              step: 4, 
              message: `Could not find "Market" element inside "${sectionName}" parent`
            };
          }

          // Log Market element details for debugging
          const marketElementInfo = {
            tagName: marketElement.tagName,
            className: marketElement.className || '',
            id: marketElement.id || '',
            role: marketElement.getAttribute('role') || '',
            textContent: marketElement.textContent || '',
            offsetWidth: marketElement.offsetWidth,
            offsetHeight: marketElement.offsetHeight
          };

          // Step 5: Find clickable parent of Market element
          // Walk up to find a clickable container (similar to ROI%)
          let clickableElement = marketElement.parentElement;
          let levelsUp = 0;
          const parentInfo = [];
          
          while (clickableElement && levelsUp < 5) {
            const style = window.getComputedStyle(clickableElement);
            const parentInfoItem = {
              level: levelsUp,
              tagName: clickableElement.tagName,
              className: clickableElement.className || '',
              id: clickableElement.id || '',
              display: style.display,
              visibility: style.visibility,
              offsetWidth: clickableElement.offsetWidth,
              offsetHeight: clickableElement.offsetHeight,
              hasMarketText: (clickableElement.textContent || '').includes('Market')
            };
            parentInfo.push(parentInfoItem);
            
            if (style.display !== 'none' && style.visibility !== 'hidden' &&
              clickableElement.offsetWidth > 0 && clickableElement.offsetHeight > 0) {
              // Check if this element contains "Market" text (to ensure we're in the right container)
              const parentText = (clickableElement.textContent || '').trim();
              if (parentText.includes('Market')) {
                // This is likely the clickable control
                break;
              }
            }
            clickableElement = clickableElement.parentElement;
            levelsUp++;
          }
          
          // If we didn't find a clickable parent, use the Market element itself
          if (!clickableElement) {
            clickableElement = marketElement;
          }

          // Get the clickable element's bounding rect for clicking
          const rect = clickableElement.getBoundingClientRect();
          const clickableElementInfo = {
            tagName: clickableElement.tagName,
            className: clickableElement.className || '',
            id: clickableElement.id || '',
            offsetWidth: clickableElement.offsetWidth,
            offsetHeight: clickableElement.offsetHeight
          };
          
          return {
            success: true,
            clickX: rect.x + rect.width / 2,
            clickY: rect.y + rect.height / 2,
            marketElementInfo: marketElementInfo,
            clickableElementInfo: clickableElementInfo,
            parentInfo: parentInfo
          };
        }, sectionName);
      } catch (error) {
        console.log(`[${exchange.name}] ❌ [MARKET FINDING] Error during page.evaluate: ${error.message}`);
        return false;
      }

      if (!marketInfo) {
        console.log(`[${exchange.name}] [MARKET FINDING] Evaluation returned null/undefined`);
        return false;
      }

      if (!marketInfo.success) {
        console.log(`[${exchange.name}] [MARKET FINDING] ❌ Step ${marketInfo.step} failed: ${marketInfo.message}`);
        return false;
      }

      console.log(`[${exchange.name}] [MARKET FINDING] ✅ Successfully found Market element`);
      console.log(`[${exchange.name}] 🔍 [MARKET ELEMENT] Found Market element for ${sectionName}:`);
      console.log(`[${exchange.name}]    - Tag: ${marketInfo.marketElementInfo.tagName}`);
      console.log(`[${exchange.name}]    - Class: "${marketInfo.marketElementInfo.className}"`);
      console.log(`[${exchange.name}]    - ID: "${marketInfo.marketElementInfo.id}"`);
      console.log(`[${exchange.name}]    - Role: "${marketInfo.marketElementInfo.role}"`);
      console.log(`[${exchange.name}]    - Size: ${marketInfo.marketElementInfo.offsetWidth}x${marketInfo.marketElementInfo.offsetHeight}`);
      console.log(`[${exchange.name}] 🔍 [CLICKABLE ELEMENT] Will click on:`);
      console.log(`[${exchange.name}]    - Tag: ${marketInfo.clickableElementInfo.tagName}`);
      console.log(`[${exchange.name}]    - Class: "${marketInfo.clickableElementInfo.className}"`);
      console.log(`[${exchange.name}]    - ID: "${marketInfo.clickableElementInfo.id}"`);
      console.log(`[${exchange.name}]    - Size: ${marketInfo.clickableElementInfo.offsetWidth}x${marketInfo.clickableElementInfo.offsetHeight}`);
      console.log(`[${exchange.name}]    - Coordinates: (${marketInfo.clickX}, ${marketInfo.clickY})`);
      if (marketInfo.parentInfo && marketInfo.parentInfo.length > 0) {
        console.log(`[${exchange.name}] 🔍 [PARENT CHAIN] Parent elements:`);
        marketInfo.parentInfo.forEach((parent, idx) => {
          console.log(`[${exchange.name}]    Level ${parent.level}: ${parent.tagName}, class="${parent.className}", hasMarket=${parent.hasMarketText}, visible=${parent.display !== 'none' && parent.visibility !== 'hidden'}`);
        });
      }

      try {
        // Click on Market element, then press ArrowDown once and Enter
        console.log(`[${exchange.name}] 🔧 Clicking on Market element for ${sectionName}...`);
        await page.mouse.click(marketInfo.clickX, marketInfo.clickY);
        await delay(300);
        console.log(`[${exchange.name}] ✅ Clicked Market element for ${sectionName}`);
        
        // Press ArrowDown once, then click the "Limit" option directly
        console.log(`[${exchange.name}] ⌨️  Pressing ArrowDown x1 for ${sectionName} Market...`);
        await page.keyboard.press('ArrowDown');
        await delay(200);
        
        // Find and click the "Limit" option in the opened dropdown
        const optionInfo = await page.evaluate(() => {
          // Find all open listboxes and menus
          const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
          const menus = Array.from(document.querySelectorAll('[role="menu"]'));
          const allDropdowns = [...listboxes, ...menus];
          
          // Also look for elements with aria-expanded="true" that might be dropdowns
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
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = menu.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            
            // Look for "Limit" option
            const allInMenu = Array.from(menu.querySelectorAll('*'));
            for (const el of allInMenu) {
              if (el.offsetParent === null) continue;
              const elText = (el.textContent || '').trim();
              if (elText === 'Limit' || elText.toLowerCase() === 'limit') {
                const rect = el.getBoundingClientRect();
                return {
                  found: true,
                  x: rect.x + rect.width / 2,
                  y: rect.y + rect.height / 2,
                  text: elText
                };
              }
            }
          }
          return { found: false };
        });
        
        if (!optionInfo.found) {
          console.log(`[${exchange.name}] ⚠️  Could not find "Limit" option to click in Market dropdown`);
          return false;
        }
        
        // Click the option using Puppeteer's mouse click
        console.log(`[${exchange.name}] 🖱️  Clicking "Limit" option at coordinates (${optionInfo.x}, ${optionInfo.y})...`);
        await page.mouse.click(optionInfo.x, optionInfo.y);
        await delay(300);
        
        // Check if modal is still open after selection
        const modalStillOpenAfter = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
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
                    return true; // Modal is still open
                  }
                }
                parent = parent.parentElement;
              }
            }
          }
          return false; // Modal not found or closed
        });
        
        if (!modalStillOpenAfter) {
          console.log(`[${exchange.name}] ⚠️  Modal closed after Market dropdown selection`);
          return false;
        }
        
        console.log(`[${exchange.name}] ✅ Completed Market dropdown selection for ${sectionName} (modal still open)`);
        return true;
      } catch (error) {
        console.log(`[${exchange.name}] ⚠️  Error selecting Limit in Market dropdown for ${sectionName}: ${error.message}`);
        return false;
      }
    };
    
    // Combined function to configure a section: Select P&L in ROI% dropdown, fill input, and select Limit in Market dropdown
    const configureTpSlSection = async (sectionName, value) => {
      console.log(`[${exchange.name}] 🔄 [SECTION CONFIG] Configuring ${sectionName} section (P&L dropdown → Fill input → Limit dropdown)...`);
      
      // Step 1: Select P&L in ROI% dropdown and fill input (using existing fillRoiInput function)
      await fillRoiInput(sectionName, value);
      await delay(100);
      
      // Step 2: Select Limit in Market dropdown - NOW HANDLED INSIDE fillRoiInput
      // await selectLimitInMarketDropdown(sectionName); // REMOVED - logic is now in fillRoiInput
      await delay(100);
      
      console.log(`[${exchange.name}] ✅ [SECTION CONFIG] Completed configuration for ${sectionName}`);
    };
    
    // Configure both sections in one go (each section does all 3 operations)
    console.log(`[${exchange.name}] 🔄 [TP/SL CONFIG] Configuring both sections in one go...`);
    if (takeProfitPercent) {
      await configureTpSlSection('Take profit', takeProfitPercent);
      await delay(150);
    }
    if (stopLossPercent) {
      await configureTpSlSection('Stop loss', stopLossPercent);
      await delay(150);
    }
    console.log(`[${exchange.name}] ✅ [TP/SL CONFIG] Completed configuration for both sections`);
    
    // Fill Take profit Limit price with Trigger price value
    console.log(`[${exchange.name}] 🔧 [LIMIT PRICE] Filling Take profit Limit price with Trigger price value...`);
    await delay(500); // Wait for auto-fill to complete
    
    try {
      // Find Trigger price value and TP limit price input
      const limitPriceInfo = await page.evaluate(() => {
        // Find the TP/SL modal
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
        
        // Find Take profit section
        let takeProfitSection = null;
        const modalElements = Array.from(tpslModal.querySelectorAll('*'));
        for (const el of modalElements) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === 'take profit' && el.offsetParent !== null) {
            takeProfitSection = el;
            break;
          }
        }
        
        if (!takeProfitSection) return { success: false, message: 'Take profit section not found' };
        
        // Find section parent
        let sectionParent = takeProfitSection.parentElement;
        for (let i = 0; i < 10 && sectionParent; i++) {
          const allDescendants = Array.from(sectionParent.querySelectorAll('*'));
          let hasStopLoss = false;
          for (const el of allDescendants) {
            const text = (el.textContent || '').trim();
            if (text.toLowerCase() === 'stop loss' && el.offsetParent !== null) {
              hasStopLoss = true;
              break;
            }
          }
          if (!hasStopLoss) break;
          sectionParent = sectionParent.parentElement;
          if (!sectionParent) break;
        }
        
        if (!sectionParent) sectionParent = takeProfitSection.parentElement;
        
        // Find Trigger price input in Take profit section
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
          return { success: false, message: 'Could not find Trigger price input or value in Take profit section' };
        }
        
        // Find TP limit price input (or Take profit Limit price)
        let limitPriceInput = null;
        let limitPriceInputId = '';
        
        for (const input of allInputsInSection) {
          if (input.tagName !== 'INPUT') continue;
          const placeholder = (input.getAttribute('placeholder') || '').trim().toLowerCase();
          if (placeholder.includes('tp limit price') || placeholder.includes('take profit limit price') || 
              placeholder.includes('limit price')) {
            // Make sure it's not the trigger price input
            if (!placeholder.includes('trigger')) {
              limitPriceInput = input;
              limitPriceInputId = input.id || '';
              break;
            }
          }
        }
        
        if (!limitPriceInput) {
          return { success: false, message: 'Could not find TP limit price input' };
        }
        
        return {
          success: true,
          triggerPriceValue: triggerPriceValue,
          limitPriceInputId: limitPriceInputId
        };
      });
      
      if (!limitPriceInfo || !limitPriceInfo.success) {
        console.log(`[${exchange.name}] ⚠️  Could not find limit price input: ${limitPriceInfo?.message || 'unknown error'}`);
      } else {
        console.log(`[${exchange.name}] ✅ Found Trigger price value: ${limitPriceInfo.triggerPriceValue}`);
        console.log(`[${exchange.name}] ⌨️  Typing Trigger price into TP limit price input...`);
        
        // Get the limit price input element
        let limitPriceElement = null;
        if (limitPriceInfo.limitPriceInputId) {
          limitPriceElement = await page.evaluateHandle((id) => {
            return document.getElementById(id);
          }, limitPriceInfo.limitPriceInputId);
          
          const isValid = await page.evaluate(el => el !== null && el !== undefined, limitPriceElement);
          if (!isValid) {
            limitPriceElement = null;
          }
        }
        
        // Fallback: find by placeholder
        if (!limitPriceElement) {
          const allInputs = await page.$$('input');
          for (const input of allInputs) {
            const placeholder = await page.evaluate(el => (el.getAttribute('placeholder') || '').trim().toLowerCase(), input);
            if ((placeholder.includes('tp limit price') || placeholder.includes('take profit limit price') || 
                 placeholder.includes('limit price')) && !placeholder.includes('trigger')) {
              const isVisible = await page.evaluate(el => {
                const style = window.getComputedStyle(el);
                return el.offsetParent !== null && 
                       style.display !== 'none' && 
                       style.visibility !== 'hidden' &&
                       !el.disabled && 
                       !el.readOnly;
              }, input);
              
              if (isVisible) {
                limitPriceElement = input;
                break;
              }
            }
          }
        }
        
        if (limitPriceElement) {
          // Focus the input
          await limitPriceElement.focus();
          await delay(200);
          
          // Select all existing text
          await page.keyboard.down('Control');
          await page.keyboard.press('KeyA');
          await page.keyboard.up('Control');
          await delay(100);
          
          // Clear existing value
          await page.keyboard.press('Backspace');
          await delay(100);
          
          // Type the trigger price value character by character
          await limitPriceElement.type(limitPriceInfo.triggerPriceValue, { delay: 50 });
          await delay(200);
          
          console.log(`[${exchange.name}] ✅ Typed Trigger price (${limitPriceInfo.triggerPriceValue}) into TP limit price input`);
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not find TP limit price input element to type into`);
        }
      }
    } catch (error) {
      console.log(`[${exchange.name}] ⚠️  Error filling TP limit price: ${error.message}`);
    }
    
    // Wait for UI to update after filling all inputs
    console.log(`[${exchange.name}] ⏳ Waiting for UI to update after filling all inputs...`);
    await delay(500);
    
    // Find and click the Confirm button in TP/SL modal (this saves TP/SL settings)
    console.log(`[${exchange.name}] 🔍 [TP/SL CONFIRM] Looking for Confirm button in TP/SL modal...`);
    let confirmButtonClicked = false;
    
    // Try multiple times to find and click the Confirm button (it might be disabled initially)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // First verify TP/SL modal is still open
        const modalStillOpen = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
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
                    return true;
                  }
                }
                parent = parent.parentElement;
              }
            }
          }
          return false;
        });
        
        if (!modalStillOpen) {
          console.log(`[${exchange.name}] ⚠️  [TP/SL CONFIRM] TP/SL modal is not open, cannot find Confirm button`);
          break;
        }
        
        const confirmButtonInfo = await page.evaluate(() => {
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
          
          if (!tpslModal) return { found: false, message: 'TP/SL modal not found' };
          
          // Find Confirm button within TP/SL modal only
          const allButtons = Array.from(tpslModal.querySelectorAll('button'));
          for (const button of allButtons) {
            const text = (button.textContent || '').trim();
            if (text === 'Confirm' && button.offsetParent !== null) {
              const rect = button.getBoundingClientRect();
              return {
                found: true,
                disabled: button.disabled,
                id: button.id || '',
                className: button.className || '',
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2
              };
            }
          }
          return { found: false, message: 'Confirm button not found in TP/SL modal' };
        });
        
        if (confirmButtonInfo.found) {
          if (!confirmButtonInfo.disabled) {
            // Button is enabled, click it
            console.log(`[${exchange.name}] ✅ [CONFIRM BUTTON] Found enabled Confirm button, clicking...`);
            
            // Try to get element handle by ID first
            let confirmButton = null;
            if (confirmButtonInfo.id) {
              try {
                const handle = await page.evaluateHandle((id) => {
                  return document.getElementById(id);
                }, confirmButtonInfo.id);
                const isValid = await page.evaluate(el => el !== null && el !== undefined, handle);
                if (isValid) {
                  confirmButton = handle.asElement();
                }
              } catch (e) {
                // ID might contain special characters, fall back to coordinate click
              }
            }
            
            if (confirmButton) {
              await confirmButton.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
              await delay(100);
              await confirmButton.click();
            } else {
              // Fallback: click by coordinates
              await page.mouse.click(confirmButtonInfo.x, confirmButtonInfo.y);
            }
            
            console.log(`[${exchange.name}] ✅ [TP/SL CONFIRM] Clicked Confirm button in TP/SL modal`);
            confirmButtonClicked = true;
            
            // Wait for modal to close after clicking Confirm
            await delay(500);
            break;
          } else {
            console.log(`[${exchange.name}] ⏳ [TP/SL CONFIRM] Confirm button found but is disabled, waiting... (attempt ${attempt + 1}/5)`);
            await delay(300);
          }
        } else {
          console.log(`[${exchange.name}] ⏳ [TP/SL CONFIRM] Confirm button not found yet: ${confirmButtonInfo?.message || 'unknown'}, waiting... (attempt ${attempt + 1}/5)`);
          await delay(300);
        }
      } catch (error) {
        console.log(`[${exchange.name}] ⚠️  [TP/SL CONFIRM] Error finding Confirm button (attempt ${attempt + 1}/5): ${error.message}`);
        await delay(300);
      }
    }
    
    if (!confirmButtonClicked) {
      console.log(`[${exchange.name}] ⚠️  [TP/SL CONFIRM] Could not click Confirm button after all attempts`);
    } else {
      console.log(`[${exchange.name}] ✅ [TP/SL CONFIG] TP/SL settings confirmed and modal should be closed`);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  TP/SL modal did not open after clicking Advanced button`);
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

  // Close any NotifyBarWrapper notifications before setting leverage
  await delay(1000); // Wait for notifications to appear
  await closeNotifyBarWrapperNotifications(page, exchange, 'before setting leverage');

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
  await clickConfirmButton(page, buySellBtn, buttonText, exchange, side);

  // Step 6: Wait for modal to open and click Confirm button in the modal
  console.log(`[${exchange.name}] ===== STARTING CONFIRM BUTTON FINDING PROCESS =====`);
  console.log(`[${exchange.name}] Waiting 500ms for confirmation modal to open...`);
  await delay(500);

  // Check if a modal opened and find the Confirm button
  console.log(`[${exchange.name}] Looking for Confirm button in the modal...`);

  // METHOD 1: Try to find Confirm button in modal with exact match (this is the only method that works based on logs)
  console.log(`[${exchange.name}] [CONFIRM METHOD 1] Attempting exact text match: "Confirm"`);
  const confirmModalBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);

  // Summary of Confirm button finding
  console.log(`[${exchange.name}] ===== CONFIRM BUTTON FINDING SUMMARY =====`);
  if (confirmModalBtn) {
    console.log(`[${exchange.name}] ✅ Confirm Button: FOUND via METHOD 1: Exact text match (findByExactText)`);
  } else {
    console.log(`[${exchange.name}] ❌ Confirm Button: NOT FOUND`);
  }
  console.log(`[${exchange.name}] =========================================`);

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
      console.log(`[${exchange.name}] ✅ Found Confirm button in modal (via METHOD 1: Exact text match (findByExactText)), clicking...`);
      try {
        await confirmModalBtn.click();
        console.log(`[${exchange.name}] ✅ Clicked Confirm button in modal (direct click)`);
        await delay(1000); // Wait for order to be processed
      } catch (error) {
        console.log(`[${exchange.name}] ⚠️  Direct click failed, trying JavaScript click: ${error.message}`);
        await confirmModalBtn.evaluate((el) => el.click());
        console.log(`[${exchange.name}] ✅ Clicked Confirm button via JavaScript`);
        await delay(1000);
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Found Confirm button (via METHOD 1) but it's not in a modal, may have already been processed`);
      await delay(1000);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find Confirm button in modal, order may have been processed without confirmation`);
    await delay(1000);
  }

  // Verify order placement (use grvtSize instead of qty parameter)
   return await verifyOrderPlacement(page, exchange, side, grvtSize);
}
