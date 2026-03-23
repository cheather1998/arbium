import { delay } from '../utils/helpers.js';
import { cancelKrakenOrders } from './orders.js';
import { findByText, findByExactText } from '../utils/helpers.js';
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
import { safeClick, safeType, safeClearAndType } from '../utils/safeActions.js';

/**
 * Kraken specific trade execution logic
 */

/**
 * Set leverage for Kraken
 * 1. Enable "Isolate position" toggle if not already enabled
 * 2. Set leverage value using the slider
 */
export async function setLeverageKraken(page, leverage, exchange) {
  console.log(`[${exchange.name}] Setting leverage to ${leverage}x...`);
  
  try {
    await delay(1000);
    
    // Step 1: Find and enable "Isolate position" toggle
    console.log(`[${exchange.name}] Step 1: Checking and enabling "Isolate position" toggle...`);
    const isolateToggleResult = await page.evaluate(() => {
      // Find all elements that might be the "Isolate position" toggle
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        
        // Look for "Isolate position" text
        if (isVisible && text.toLowerCase().includes('isolate position')) {
          // Find the toggle switch near this text
          // The toggle is usually a button or div with role="switch" or a checkbox-like element
          let toggleElement = null;
          
          // Check if the element itself is clickable
          if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'switch' || el.getAttribute('role') === 'checkbox') {
            toggleElement = el;
          } else {
            // Look for toggle in parent or sibling elements
            let parent = el.parentElement;
            for (let i = 0; i < 3 && parent; i++) {
              const toggle = parent.querySelector('button[role="switch"], button[role="checkbox"], div[role="switch"], div[role="checkbox"], input[type="checkbox"]');
              if (toggle && toggle.offsetParent !== null) {
                toggleElement = toggle;
                break;
              }
              parent = parent.parentElement;
            }
            
            // Also check siblings
            if (!toggleElement && el.parentElement) {
              const siblings = Array.from(el.parentElement.children);
              for (const sibling of siblings) {
                if (sibling !== el && (sibling.tagName === 'BUTTON' || sibling.getAttribute('role') === 'switch' || sibling.getAttribute('role') === 'checkbox')) {
                  const isSiblingVisible = sibling.offsetParent !== null && sibling.offsetWidth > 0 && sibling.offsetHeight > 0;
                  if (isSiblingVisible) {
                    toggleElement = sibling;
                    break;
                  }
                }
              }
            }
          }
          
          if (toggleElement) {
            // Check current state
            const isChecked = toggleElement.getAttribute('aria-checked') === 'true' ||
                            toggleElement.getAttribute('data-state') === 'checked' ||
                            toggleElement.classList.contains('checked') ||
                            (toggleElement.tagName === 'INPUT' && toggleElement.checked);
            
            if (!isChecked) {
              toggleElement.click();
              return { success: true, wasEnabled: false, message: 'Enabled "Isolate position" toggle' };
            } else {
              return { success: true, wasEnabled: true, message: '"Isolate position" toggle already enabled' };
            }
          }
        }
      }
      
      return { success: false, error: 'Could not find "Isolate position" toggle' };
    });
    
    if (isolateToggleResult.success) {
      console.log(`[${exchange.name}] ✓ ${isolateToggleResult.message}`);
      await delay(500);
    } else {
      console.log(`[${exchange.name}] ⚠️  ${isolateToggleResult.error || 'Could not find "Isolate position" toggle'}`);
      // Continue anyway - toggle might not be critical
    }
    
    // Step 2: Find and interact with leverage slider
    console.log(`[${exchange.name}] Step 2: Finding leverage slider...`);
    const leverageSliderResult = await page.evaluate((targetLeverage) => {
      // Find "Leverage" label/text first
      const allElements = Array.from(document.querySelectorAll('*'));
      let leverageSection = null;
      
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        
        // Look for "Leverage" text
        if (isVisible && text.toLowerCase().includes('leverage') && !text.toLowerCase().includes('isolate')) {
          leverageSection = el;
          break;
        }
      }
      
      if (!leverageSection) {
        return { success: false, error: 'Could not find "Leverage" section' };
      }
      
      // Find slider element near the Leverage text
      // Slider is usually an input[type="range"] or a div with slider-like structure
      let sliderElement = null;
      let sliderInput = null;
      
      // Method 1: Look for input[type="range"]
      const rangeInputs = Array.from(document.querySelectorAll('input[type="range"]'));
      for (const input of rangeInputs) {
        const isVisible = input.offsetParent !== null && input.offsetWidth > 0 && input.offsetHeight > 0;
        if (isVisible) {
          // Check if it's near the leverage section
          const inputRect = input.getBoundingClientRect();
          const sectionRect = leverageSection.getBoundingClientRect();
          
          // Check if input is below the leverage section (within reasonable distance)
          if (inputRect.top >= sectionRect.top && inputRect.top <= sectionRect.bottom + 200) {
            sliderInput = input;
            break;
          }
        }
      }
      
      // Method 2: Look for slider-like div structure (if no range input found)
      if (!sliderInput) {
        let parent = leverageSection.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          // Look for slider track (usually has specific classes or structure)
          const sliderTrack = parent.querySelector('[class*="slider"], [class*="Slider"], [role="slider"]');
          if (sliderTrack && sliderTrack.offsetParent !== null) {
            sliderElement = sliderTrack;
            
            // Try to find input inside
            sliderInput = sliderTrack.querySelector('input[type="range"], input[type="number"]');
            break;
          }
          parent = parent.parentElement;
        }
      }
      
      if (!sliderInput && !sliderElement) {
        return { success: false, error: 'Could not find leverage slider' };
      }
      
      // If we found a slider element but no input, try to find the input that controls it
      if (sliderElement && !sliderInput) {
        // Look for hidden input or input in nearby elements
        let searchParent = sliderElement.parentElement;
        for (let i = 0; i < 3 && searchParent; i++) {
          const inputs = searchParent.querySelectorAll('input');
          for (const input of inputs) {
            if (input.type === 'range' || input.type === 'number' || !input.type) {
              sliderInput = input;
              break;
            }
          }
          if (sliderInput) break;
          searchParent = searchParent.parentElement;
        }
      }
      
      // Method 3: Look for any input near the leverage value display (e.g., "10.00x")
      if (!sliderInput) {
        const leverageValueElements = Array.from(document.querySelectorAll('*'));
        for (const el of leverageValueElements) {
          const text = el.textContent?.trim() || '';
          const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          
          // Look for pattern like "10.00x" or "10x"
          if (isVisible && /^\d+(\.\d+)?x$/i.test(text)) {
            // Find input near this element
            let searchEl = el.parentElement;
            for (let i = 0; i < 3 && searchEl; i++) {
              const input = searchEl.querySelector('input[type="range"], input[type="number"]');
              if (input && input.offsetParent !== null) {
                sliderInput = input;
                break;
              }
              searchEl = searchEl.parentElement;
            }
            if (sliderInput) break;
          }
        }
      }
      
      if (!sliderInput) {
        return { success: false, error: 'Could not find leverage slider input' };
      }
      
      // Get current value and slider properties
      const currentValue = sliderInput.value || sliderInput.getAttribute('value') || '0';
      const currentLeverage = parseFloat(currentValue);
      const min = parseFloat(sliderInput.min || '0');
      const max = parseFloat(sliderInput.max || '100');

      // Check if already set to target
      if (Math.abs(currentLeverage - targetLeverage) < 0.01) {
        return { success: true, wasChanged: false, message: `Leverage already set to ${targetLeverage}x`, alreadySet: true };
      }

      // Set value directly via DOM (works when browser is minimized)
      // Use native input value setter to bypass React's synthetic event system
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(sliderInput, targetLeverage);
      sliderInput.dispatchEvent(new Event('input', { bubbles: true }));
      sliderInput.dispatchEvent(new Event('change', { bubbles: true }));

      return {
        success: true,
        alreadySet: false,
        valueSet: true,
        previousValue: currentLeverage,
        newValue: targetLeverage
      };
    }, leverage);

    if (!leverageSliderResult.success) {
      console.log(`[${exchange.name}] ✗ ${leverageSliderResult.error || 'Failed to find leverage slider'}`);
      return { success: false, error: leverageSliderResult.error };
    }

    if (leverageSliderResult.alreadySet) {
      console.log(`[${exchange.name}] ✓ ${leverageSliderResult.message}`);
      return { success: true };
    }

    // Verify the value was set via DOM-level approach
    console.log(`[${exchange.name}] Step 3: Setting leverage to ${leverage}x via DOM value setter...`);
    await delay(500);

    try {
      // Verify the value was updated by checking the displayed value
      const verifyResult = await page.evaluate((targetLeverage) => {
        // Check displayed value in UI (e.g., "14.00x")
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
          const text = el.textContent?.trim() || '';
          if (/^\d+(\.\d+)?x$/i.test(text)) {
            const displayedValue = parseFloat(text.replace(/x/i, ''));
            if (Math.abs(displayedValue - targetLeverage) < 0.01) {
              return { success: true, value: displayedValue, fromDisplay: true };
            }
          }
        }

        // Also check input value
        const rangeInputs = Array.from(document.querySelectorAll('input[type="range"]'));
        for (const input of rangeInputs) {
          const isVisible = (el => el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0))(input);
          if (isVisible) {
            const currentValue = parseFloat(input.value || '0');
            return { success: Math.abs(currentValue - targetLeverage) < 0.01, value: currentValue, expected: targetLeverage };
          }
        }

        return { success: false, error: 'Could not verify leverage value' };
      }, leverage);

      if (verifyResult.success) {
        console.log(`[${exchange.name}] ✓ Leverage set to ${leverage}x (verified: ${verifyResult.value}x)`);
        await delay(300);
        return { success: true };
      } else {
        // Fallback: Try setting value again with additional React compatibility
        console.log(`[${exchange.name}] DOM value setter didn't update UI, trying React-compatible approach...`);

        const retryResult = await page.evaluate((targetLeverage) => {
          const rangeInputs = Array.from(document.querySelectorAll('input[type="range"]'));
          for (const input of rangeInputs) {
            const isVisible = (el => el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0))(input);
            if (isVisible) {
              // Try React's native setter approach
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeInputValueSetter.call(input, targetLeverage);

              // Dispatch multiple event types for React compatibility
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));

              // Also try dispatching a mouse event on the input to simulate interaction
              input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              input.dispatchEvent(new MouseEvent('click', { bubbles: true }));

              const finalValue = parseFloat(input.value || '0');
              return { success: Math.abs(finalValue - targetLeverage) < 0.01, value: finalValue };
            }
          }
          return { success: false, error: 'Could not find slider for retry' };
        }, leverage);

        if (retryResult.success) {
          console.log(`[${exchange.name}] ✓ Leverage set to ${leverage}x via React-compatible approach (verified: ${retryResult.value}x)`);
          await delay(300);
          return { success: true };
        } else {
          console.log(`[${exchange.name}] ✗ Failed to set leverage. Current: ${retryResult.value || 'unknown'}, Expected: ${leverage}`);
          return { success: false, error: `Failed to set leverage. Current: ${retryResult.value || 'unknown'}, Expected: ${leverage}` };
        }
      }
    } catch (error) {
      console.log(`[${exchange.name}] ✗ Error setting leverage: ${error.message}`);
      return { success: false, error: error.message };
    }
    
  } catch (error) {
    console.log(`[${exchange.name}] ✗ Error setting leverage: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Find confirm button for Kraken
 * Uses standard logic - can be overridden if Kraken has special requirements
 */
export async function findConfirmButtonKraken(page, side, exchange) {
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
 * Click Limit or Market option in opened dropdown
 */
async function clickLimitOption(page, optionText, exchange) {
  console.log(`[${exchange.name}] Looking for "${optionText}" option in opened dropdown...`);
  
  // First, try to find option within the opened dropdown menu/listbox
  const optionInMenu = await page.evaluate((text) => {
    // Find all open listboxes and menus
    const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    const allDropdowns = [...listboxes, ...menus];
    
    // Also look for elements with dropdown/menu classes
    const classDropdowns = Array.from(document.querySelectorAll('[class*="dropdown"], [class*="menu"]'));
    for (const el of classDropdowns) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          allDropdowns.push(el);
        }
      }
    }
    
    for (const menu of allDropdowns) {
      const style = window.getComputedStyle(menu);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = menu.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      
      // First, look for elements with role="option" (standard listbox pattern)
      const options = Array.from(menu.querySelectorAll('[role="option"]'));
      for (const option of options) {
        if (option.offsetParent === null) continue;
        const optionText = (option.textContent || '').trim();
        if (optionText.toLowerCase() === text.toLowerCase() || 
            (optionText.toLowerCase().includes(text.toLowerCase()) && optionText.length < 30)) {
          return { found: true, element: option, text: optionText };
        }
      }
      
      // Fallback: Look for any element with the text in this menu
      const allInMenu = Array.from(menu.querySelectorAll('*'));
      for (const el of allInMenu) {
        if (el.offsetParent === null) continue;
        const elText = (el.textContent || '').trim();
        if (elText.toLowerCase() === text.toLowerCase() || 
            (elText.toLowerCase().includes(text.toLowerCase()) && elText.length < 30)) {
          return { found: true, element: el, text: elText };
        }
      }
    }
    return { found: false };
  }, optionText);
  
  let optionBtn = null;
  
  if (optionInMenu.found) {
    console.log(`[${exchange.name}] Found "${optionText}" option in dropdown menu: "${optionInMenu.text}"`);
    const optionHandle = await page.evaluateHandle((el) => el, optionInMenu.element);
    optionBtn = optionHandle.asElement();
  } else {
    // Fallback: Use standard search methods
    optionBtn = await findByExactText(page, optionText, ["button", "div", "span", "option", "li"]);
    
    if (!optionBtn) {
      optionBtn = await findByText(page, optionText, ["button", "div", "span", "option", "li"]);
    }
  }
  
  if (optionBtn) {
    console.log(`[${exchange.name}] Found ${optionText} option, clicking...`);
    
    // Use DOM-level click (works when browser is minimized)
    try {
      await optionBtn.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await delay(200);
      await safeClick(page, optionBtn);
      console.log(`[${exchange.name}] Clicked ${optionText} option`);
    } catch (error1) {
      console.log(`[${exchange.name}] safeClick failed: ${error1.message}, trying JavaScript click...`);
      try {
        await optionBtn.evaluate((el) => {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
        });
        console.log(`[${exchange.name}] Clicked ${optionText} option (JavaScript click)`);
      } catch (error2) {
        console.log(`[${exchange.name}] JavaScript click failed: ${error2.message}`);
        return false;
      }
    }
    
    await delay(500);
    return true;
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find ${optionText} option in dropdown`);
    return false;
  }
}

/**
 * Select order type from dropdown for Kraken
 * The dropdown is located on the right side of Buy/Sell tabs
 */
export async function selectOrderTypeKraken(page, orderType, exchange) {
  console.log(`[${exchange.name}] Looking for order type dropdown (${orderType.toUpperCase()})...`);
  
  // First, try a simple direct search for order type button (exclude TP/SL button)
  try {
    // Use :not([aria-label="TP/SL"]) to avoid clicking the TP/SL dropdown instead
    const dropdownButton = await page.$('button[aria-haspopup="listbox"]:not([aria-label="TP/SL"])');
    if (dropdownButton) {
      // Verify it's the order type dropdown by checking its text content
      const btnText = await page.evaluate(el => (el.textContent || '').trim().toLowerCase(), dropdownButton);
      const isOrderTypeButton = btnText.includes('limit') || btnText.includes('market') || btnText.includes('stop');

      if (!isOrderTypeButton) {
        console.log(`[${exchange.name}] ⚠️  Found button but text "${btnText}" doesn't look like order type, skipping`);
      } else {
        console.log(`[${exchange.name}] ✅ Found order type dropdown button: "${btnText}"`);

        // Click to open dropdown (DOM-level, works when minimized)
        console.log(`[${exchange.name}] Clicking dropdown to open it...`);
        await safeClick(page, dropdownButton);
        await delay(800);

        // Find and click Limit option
        const optionText = orderType === 'limit' ? 'Limit' : 'Market';
        const clicked = await clickLimitOption(page, optionText, exchange);
        if (!clicked) {
          // Close the dropdown if option not found
          await page.keyboard.press('Escape');
          await delay(200);
        }
        return true;
      }
    }
  } catch (error) {
    console.log(`[${exchange.name}] Direct selector search failed: ${error.message}`);
    // Ensure any accidentally opened dropdown is closed
    try { await page.keyboard.press('Escape'); } catch (e) {}
  }
  
  // Fallback: Find the dropdown button by its specific attributes (aria-haspopup="listbox", aria-label="Order type")
  const dropdownInfo = await page.evaluate((orderType) => {
    const debugInfo = [];
    
    // Strategy 1: Find by specific attributes - be more lenient
    const allButtons = Array.from(document.querySelectorAll('button'));
    debugInfo.push(`Total buttons found: ${allButtons.length}`);
    
    for (const btn of allButtons) {
      if (btn.offsetParent === null) continue;
      
      const ariaHaspopup = btn.getAttribute('aria-haspopup');
      const ariaLabel = btn.getAttribute('aria-label');
      const text = (btn.textContent || '').trim();
      
      // Look for button with aria-haspopup="listbox" (exclude TP/SL button)
      if (ariaHaspopup === 'listbox' && ariaLabel !== 'TP/SL') {
        debugInfo.push(`Found button with aria-haspopup="listbox": aria-label="${ariaLabel}", text="${text}"`);
        return { 
          type: 'button', 
          element: btn, 
          text: 'Order type dropdown',
          debug: debugInfo.join('; ')
        };
      }
    }
    
    // Strategy 2: Find Buy/Sell buttons, then find next sibling
    const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
    const buySellButtons = buttons.filter(btn => {
      const text = (btn.textContent || '').trim().toLowerCase();
      return (text === 'buy' || text === 'sell') && btn.offsetParent !== null;
    });
    
    debugInfo.push(`Buy/Sell buttons found: ${buySellButtons.length}`);
    
    if (buySellButtons.length > 0) {
      // Find the active/selected Buy or Sell button
      let activeButton = null;
      for (const btn of buySellButtons) {
        const className = (typeof btn.className === 'string' ? btn.className : (btn.className?.baseVal || String(btn.className) || '')).toLowerCase();
        const ariaSelected = btn.getAttribute('aria-selected');
        const isActive = className.includes('active') || 
                        className.includes('selected') || 
                        ariaSelected === 'true' ||
                        btn.classList.contains('active') ||
                        btn.classList.contains('selected');
        
        if (isActive) {
          activeButton = btn;
          debugInfo.push('Found active Buy/Sell button');
          break;
        }
      }
      
      // If no active button found, use the rightmost one
      if (!activeButton) {
        activeButton = buySellButtons.reduce((rightmost, btn) => {
          const rightmostRect = rightmost.getBoundingClientRect();
          const btnRect = btn.getBoundingClientRect();
          return btnRect.x > rightmostRect.x ? btn : rightmost;
        }, buySellButtons[0]);
        debugInfo.push('Using rightmost Buy/Sell button');
      }
      
      // Find next sibling - this should be the dropdown
      let nextSibling = activeButton.nextElementSibling;
      let attempts = 0;
      while (nextSibling && attempts < 5) {
        if (nextSibling.offsetParent !== null) {
          const ariaHaspopup = nextSibling.getAttribute('aria-haspopup');
          const tagName = nextSibling.tagName;
          debugInfo.push(`Next sibling ${attempts + 1}: tagName=${tagName}, aria-haspopup=${ariaHaspopup}`);
          
          // Accept any button as the dropdown (be more lenient)
          if (tagName === 'BUTTON' || ariaHaspopup === 'listbox') {
            return { 
              type: 'button', 
              element: nextSibling, 
              text: 'Next sibling dropdown',
              debug: debugInfo.join('; ')
            };
          }
        }
        nextSibling = nextSibling.nextElementSibling;
        attempts++;
      }
      
      // If no next sibling, check parent's children (siblings in same parent)
      const parent = activeButton.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const activeIndex = siblings.indexOf(activeButton);
        debugInfo.push(`Active button index: ${activeIndex}, total siblings: ${siblings.length}`);
        
        if (activeIndex >= 0 && activeIndex < siblings.length - 1) {
          const nextSiblingInParent = siblings[activeIndex + 1];
          if (nextSiblingInParent && nextSiblingInParent.offsetParent !== null) {
            const tagName = nextSiblingInParent.tagName;
            debugInfo.push(`Next sibling in parent: tagName=${tagName}`);
            return { 
              type: 'button', 
              element: nextSiblingInParent, 
              text: 'Next sibling in parent',
              debug: debugInfo.join('; ')
            };
          }
        }
      }
    }
    
    return { 
      found: false, 
      debug: debugInfo.join('; ')
    };
  }, orderType);
  
  // Log debug info
  if (dropdownInfo) {
    if (dropdownInfo.debug) {
      console.log(`[${exchange.name}] Dropdown search debug: ${dropdownInfo.debug}`);
    }
    if (dropdownInfo.found === false) {
      console.log(`[${exchange.name}] ⚠️  Could not find order type dropdown (found: false)`);
      // Fallback to standard selectOrderType
      return await selectOrderType(page, orderType, exchange);
    }
    if (!dropdownInfo.element) {
      console.log(`[${exchange.name}] ⚠️  Could not find order type dropdown (no element)`);
      // Fallback to standard selectOrderType
      return await selectOrderType(page, orderType, exchange);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find order type dropdown (null/undefined)`);
    // Fallback to standard selectOrderType
    return await selectOrderType(page, orderType, exchange);
  }
  
  if (dropdownInfo && dropdownInfo.element) {
    console.log(`[${exchange.name}] ✅ Found order type dropdown: type="${dropdownInfo.type}", text="${dropdownInfo.text}"`);
    
    if (dropdownInfo.type === 'select') {
      // It's a select element - set the value directly
      const success = await page.evaluate((select, orderType) => {
        const options = Array.from(select.options);
        const targetOption = options.find(opt => {
          const optText = opt.text.toLowerCase();
          return orderType === 'limit' ? optText.includes('limit') : optText.includes('market');
        });
        
        if (targetOption) {
          select.value = targetOption.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, dropdownInfo.element, orderType);
      
      if (success) {
        console.log(`[${exchange.name}] ✅ Selected ${orderType.toUpperCase()} from dropdown`);
        await delay(300);
        return true;
      }
    } else {
      // It's a button or element that opens a dropdown - click it first
      const dropdownHandle = await page.evaluateHandle((el) => el, dropdownInfo.element);
      const dropdownElement = dropdownHandle.asElement();
      
      if (dropdownElement) {
        console.log(`[${exchange.name}] Clicking dropdown to open it...`);
        
        // Use DOM-level click (works when browser is minimized)
        try {
          await safeClick(page, dropdownElement);
        } catch (error) {
          console.log(`[${exchange.name}] safeClick failed, trying JavaScript click...`);
          await dropdownElement.evaluate((el) => el.click());
        }

        await delay(800); // Wait longer for dropdown to fully open

        // Verify dropdown opened
        const dropdownOpened = await page.evaluate(() => {
          const menus = Array.from(document.querySelectorAll('[role="menu"], [class*="menu"], [class*="dropdown"], [role="listbox"]'));
          for (const menu of menus) {
            const style = window.getComputedStyle(menu);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = menu.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return true; // Dropdown is open
              }
            }
          }
          return false;
        });

        if (!dropdownOpened) {
          console.log(`[${exchange.name}] ⚠️  Dropdown didn't open, trying to click again...`);
          await safeClick(page, dropdownElement);
          await delay(800);
        }
        
        // Now find and click the Limit or Market option
        const optionText = orderType === 'limit' ? 'Limit' : 'Market';
        console.log(`[${exchange.name}] Looking for "${optionText}" option in opened dropdown...`);
        
        // First, try to find option within the opened dropdown menu/listbox
        const optionInMenu = await page.evaluate((text) => {
          // Find all open listboxes and menus
          const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
          const menus = Array.from(document.querySelectorAll('[role="menu"]'));
          const allDropdowns = [...listboxes, ...menus];
          
          // Also look for elements with dropdown/menu classes
          const classDropdowns = Array.from(document.querySelectorAll('[class*="dropdown"], [class*="menu"]'));
          for (const el of classDropdowns) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                allDropdowns.push(el);
              }
            }
          }
          
          for (const menu of allDropdowns) {
            const style = window.getComputedStyle(menu);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = menu.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            
            // First, look for elements with role="option" (standard listbox pattern)
            const options = Array.from(menu.querySelectorAll('[role="option"]'));
            for (const option of options) {
              if (option.offsetParent === null) continue;
              const optionText = (option.textContent || '').trim();
              if (optionText.toLowerCase() === text.toLowerCase() || 
                  (optionText.toLowerCase().includes(text.toLowerCase()) && optionText.length < 30)) {
                return { found: true, element: option, text: optionText };
              }
            }
            
            // Fallback: Look for any element with the text in this menu
            const allInMenu = Array.from(menu.querySelectorAll('*'));
            for (const el of allInMenu) {
              if (el.offsetParent === null) continue;
              const elText = (el.textContent || '').trim();
              if (elText.toLowerCase() === text.toLowerCase() || 
                  (elText.toLowerCase().includes(text.toLowerCase()) && elText.length < 30)) {
                return { found: true, element: el, text: elText };
              }
            }
          }
          return { found: false };
        }, optionText);
        
        let optionBtn = null;
        
        if (optionInMenu.found) {
          console.log(`[${exchange.name}] Found "${optionText}" option in dropdown menu: "${optionInMenu.text}"`);
          const optionHandle = await page.evaluateHandle((el) => el, optionInMenu.element);
          optionBtn = optionHandle.asElement();
        } else {
          // Fallback: Use standard search methods
          optionBtn = await findByExactText(page, optionText, ["button", "div", "span", "option", "li"]);
          
          if (!optionBtn) {
            optionBtn = await findByText(page, optionText, ["button", "div", "span", "option", "li"]);
          }
        }
        
        // Fallback: Look for active/highlighted option or find by evaluating
        if (!optionBtn) {
          console.log(`[${exchange.name}] Standard search failed, trying evaluate to find ${optionText} option...`);
          const optionFound = await page.evaluate((text) => {
            // Look for elements with the text in dropdown menu
            const allElements = Array.from(document.querySelectorAll('*'));
            for (const el of allElements) {
              if (el.offsetParent === null) continue;
              const elText = (el.textContent || '').trim();
              if (elText.toLowerCase() === text.toLowerCase() || elText.toLowerCase().includes(text.toLowerCase())) {
                // Check if it's in a dropdown/menu context
                let parent = el.parentElement;
                let isInDropdown = false;
                for (let i = 0; i < 5 && parent; i++) {
                  const role = parent.getAttribute('role');
                  const className = (parent.className || '').toLowerCase();
                  if (role === 'menu' || role === 'listbox' || 
                      className.includes('menu') || className.includes('dropdown') ||
                      className.includes('select')) {
                    isInDropdown = true;
                    break;
                  }
                  parent = parent.parentElement;
                }
                if (isInDropdown) {
                  return { found: true, element: el };
                }
              }
            }
            return { found: false };
          }, optionText);
          
          if (optionFound.found) {
            const optionHandle = await page.evaluateHandle((el) => el, optionFound.element);
            optionBtn = optionHandle.asElement();
            console.log(`[${exchange.name}] Found ${optionText} option via evaluate`);
          }
        }
        
        if (optionBtn) {
          console.log(`[${exchange.name}] Found ${optionText} option, clicking...`);
          
          // Use DOM-level click (works when browser is minimized)
          try {
            // Method 1: Scroll into view and safeClick
            await optionBtn.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await delay(200);
            await safeClick(page, optionBtn);
            console.log(`[${exchange.name}] Clicked ${optionText} option (method 1: safeClick)`);
          } catch (error1) {
            console.log(`[${exchange.name}] safeClick failed: ${error1.message}, trying JavaScript click...`);
            try {
              // Method 2: JavaScript click
              await optionBtn.evaluate((el) => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
              });
              console.log(`[${exchange.name}] Clicked ${optionText} option (method 2: JavaScript click)`);
            } catch (error2) {
              console.log(`[${exchange.name}] JavaScript click failed: ${error2.message}, trying mousedown/up...`);
              // Method 3: Mouse events (DOM-level, not coordinate-based)
              await optionBtn.evaluate((el) => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
                const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
                const click = new MouseEvent('click', { bubbles: true, cancelable: true });
                el.dispatchEvent(mouseDown);
                el.dispatchEvent(mouseUp);
                el.dispatchEvent(click);
              });
              console.log(`[${exchange.name}] Clicked ${optionText} option (method 3: mouse events)`);
            }
          }
          
          await delay(500); // Wait for dropdown to close and selection to register
          
          // Verify the selection was made by checking if dropdown closed or option is selected
          const dropdownClosed = await page.evaluate(() => {
            // Check if dropdown menu is still visible
            const menus = Array.from(document.querySelectorAll('[role="menu"], [class*="menu"], [class*="dropdown"]'));
            for (const menu of menus) {
              const style = window.getComputedStyle(menu);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                // Check if it's actually visible on screen
                const rect = menu.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return false; // Dropdown still open
                }
              }
            }
            return true; // Dropdown appears closed
          });
          
          if (dropdownClosed) {
            console.log(`[${exchange.name}] ✅ Selected ${orderType.toUpperCase()} from dropdown (dropdown closed)`);
            return true;
          } else {
            console.log(`[${exchange.name}] ⚠️  Dropdown still open, trying to close it...`);
            // Try pressing Escape to close dropdown
            await page.keyboard.press('Escape');
            await delay(300);
            console.log(`[${exchange.name}] ✅ Selected ${orderType.toUpperCase()} from dropdown (closed with Escape)`);
            return true;
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not find ${optionText} option in dropdown`);
        }
      }
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find order type dropdown, trying fallback method...`);
    // Fallback to standard selectOrderType
    return await selectOrderType(page, orderType, exchange);
  }
  
  return false;
}

/**
 * Find size and price inputs for Kraken
 * Kraken has inputs in the order form panel (can be on left side)
 */
export async function findKrakenInputs(page, orderType) {
  console.log(`[Kraken] Finding inputs for Kraken (order type: ${orderType})...`);
  
  const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
  let sizeInput = null;
  let priceInput = null;
  
  console.log(`[Kraken] Found ${inputs.length} input elements on page`);
  
  for (const input of inputs) {
    // Use DOM-level visibility check (works when browser is minimized — boundingBox() returns null when minimized)
    const isVisible = await page.evaluate((el) => {
      return (el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0)) && !el.disabled && !el.readOnly;
    }, input);

    if (!isVisible) continue;
    
    const inputInfo = await page.evaluate((el) => {
      // Get placeholder, label, and nearby text
      const placeholder = (el.placeholder || '').toLowerCase();
      const name = (el.name || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const value = (el.value || '').toLowerCase();
      
      // Find label
      let labelText = '';
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        if (label.control === el || label.getAttribute('for') === el.id || label.contains(el)) {
          labelText = (label.textContent || '').toLowerCase();
          break;
        }
      }
      
      // Check parent text
      let parent = el.parentElement;
      let parentText = '';
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.textContent) {
          parentText = (parent.textContent || '').toLowerCase();
          break;
        }
        parent = parent.parentElement;
      }
      
      return {
        placeholder,
        name,
        id,
        value,
        labelText,
        parentText
      };
    }, input);
    
    // Check for Limit price input
    if (!priceInput && orderType === "limit") {
      if (inputInfo.placeholder.includes('limit price') ||
          inputInfo.placeholder.includes('price') ||
          inputInfo.labelText.includes('limit price') ||
          inputInfo.labelText.includes('price') ||
          inputInfo.parentText.includes('limit price') ||
          inputInfo.parentText.includes('price')) {
        priceInput = input;
        console.log(`[Kraken] ✅ Found Limit price input (placeholder: "${inputInfo.placeholder}", label: "${inputInfo.labelText}")`);
      }
    }
    
    // Check for Quantity/Size input
    if (!sizeInput) {
      if (inputInfo.placeholder.includes('quantity') ||
          inputInfo.placeholder.includes('size') ||
          inputInfo.placeholder.includes('qty') ||
          inputInfo.labelText.includes('quantity') ||
          inputInfo.labelText.includes('size') ||
          inputInfo.labelText.includes('qty') ||
          inputInfo.parentText.includes('quantity') ||
          inputInfo.parentText.includes('size')) {
        sizeInput = input;
        console.log(`[Kraken] ✅ Found Quantity input (placeholder: "${inputInfo.placeholder}", label: "${inputInfo.labelText}")`);
      }
    }
    
    // If both found, break early
    if (sizeInput && (orderType === "market" || priceInput)) {
      break;
    }
  }
  
  // If not found by text, try position-based (for limit orders, price is usually above quantity)
  // Uses DOM-level getBoundingClientRect inside page.evaluate (works when minimized)
  if (orderType === "limit" && sizeInput && !priceInput) {
    for (const input of inputs) {
      if (input === sizeInput) continue;
      const isAboveResult = await page.evaluate((el, sizeEl) => {
        const isVisible = (el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0)) && !el.disabled && !el.readOnly;
        if (!isVisible) return { isAbove: false };
        const inputRect = el.getBoundingClientRect();
        const sizeRect = sizeEl.getBoundingClientRect();
        // If rects are empty (minimized), skip position-based detection
        if (inputRect.width === 0 && inputRect.height === 0) return { isAbove: false };
        if (sizeRect.width === 0 && sizeRect.height === 0) return { isAbove: false };
        const isAbove = inputRect.y < sizeRect.y && Math.abs(inputRect.x - sizeRect.x) < 200;
        return { isAbove };
      }, input, sizeInput);
      if (isAboveResult.isAbove) {
        priceInput = input;
        console.log(`[Kraken] ✅ Found Limit price input via position (above quantity)`);
        break;
      }
    }
  }
  
  return { sizeInput, priceInput };
}

/**
 * Execute trade for Kraken
 */
export async function executeTradeKraken(
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

  // Step 0: Cancel all existing orders first (modal-based flow for Kraken)
  console.log(`[${exchange.name}] Step 0: Canceling all existing orders...`);
  // await cancelKrakenOrders(page);
  console.log(`[${exchange.name}] ✅ Order cancellation completed\n`);

  // Set leverage first if requested
  if (setLeverageFirst && leverage) {
    await setLeverageKraken(page, leverage, exchange);
  }

  // If limit order without price, fetch aggressive price based on ORDER_AGGRESSIVENESS
  if (orderType === "limit" && !price) {
    price = await getAggressivePrice(page, exchange, side);
    if (!price) {
      console.log(`[${exchange.name}] Could not fetch market price for limit order`);
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

  // Step 1: Select Buy or Sell tabs (already correct)
  console.log(`[${exchange.name}] Step 1: Selecting ${side.toUpperCase()}...`);
  await selectBuyOrSell(page, side, exchange);
  await delay(300);

  // Step 2: Select order type from dropdown (on the right of Buy/Sell tabs)
  console.log(`[${exchange.name}] Step 2: Selecting ${orderType.toUpperCase()} from dropdown...`);
  let orderTypeSelected = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await selectOrderTypeKraken(page, orderType, exchange);
    if (result) {
      orderTypeSelected = true;
      break;
    }
    console.log(`[${exchange.name}] ⚠️  Order type selection attempt ${attempt} failed, retrying...`);
    await delay(500);
  }
  if (!orderTypeSelected && orderType === 'limit') {
    console.log(`[${exchange.name}] ❌ Failed to select LIMIT order type after retries — aborting to prevent Market order`);
    return { success: false, error: "Failed to select Limit order type" };
  }
  await delay(500);

  // Step 3: Find and fill Limit price input (for limit orders)
  // Use Kraken-specific input finder that doesn't filter by position
  console.log(`[${exchange.name}] Step 3: Finding and filling Limit price input...`);
  const { sizeInput, priceInput } = await findKrakenInputs(page, orderType);
  
  if (orderType === "limit") {
    if (priceInput) {
      await enterPrice(page, priceInput, price, orderType);
      await delay(300);
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find Limit price input`);
      return { success: false, error: "Limit price input not found" };
    }
  }

  // Step 4: Find and fill Quantity input
  console.log(`[${exchange.name}] Step 4: Finding and filling Quantity input...`);
  if (sizeInput) {
    const sizeResult = await enterSize(page, sizeInput, qty, exchange);
    if (!sizeResult.success) {
      return sizeResult;
    }
    await delay(300);
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find Quantity input`);
    return { success: false, error: "Quantity input not found" };
  }

  await delay(500);

  // Step 5: Handle TP/SL dropdown - find TP/SL element, click it, and select "Simple"
  console.log(`[${exchange.name}] Step 5: Handling TP/SL dropdown...`);
  try {
    // First, try direct selector for button with aria-label="TP/SL"
    let tpSlButton = await page.$('button[aria-label="TP/SL"][aria-haspopup="listbox"]');
    
    if (!tpSlButton) {
      // Fallback: Find by label text, then find button nearby
      const buttonInfo = await page.evaluate(() => {
        // Find TP/SL label
        const labels = Array.from(document.querySelectorAll('label'));
        for (const label of labels) {
          const text = (label.textContent || '').trim();
          if (text === 'TP/SL' && label.offsetParent !== null) {
            // Look for button in the same parent or nearby
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
      // Check if "Simple" is already selected before opening dropdown
      const isSimpleSelected = await page.evaluate((button) => {
        // Check the button's text to see if it shows "Simple"
        const buttonText = (button.textContent || '').trim();
        return buttonText.toLowerCase().includes('simple');
      }, tpSlButton);
      
      if (isSimpleSelected) {
        console.log(`[${exchange.name}] ✅ "Simple" is already selected in TP/SL dropdown, skipping click`);
        await delay(300); // Wait for inputs to be ready
      } else {
        console.log(`[${exchange.name}] ✅ Found TP/SL dropdown button, clicking...`);
        
        // Click to open the dropdown (DOM-level, works when minimized)
        await safeClick(page, tpSlButton);
        await delay(800); // Wait for dropdown to open
        
        // Find and click "Simple" option in the opened dropdown
        console.log(`[${exchange.name}] Looking for "Simple" option in TP/SL dropdown...`);
        let simpleOption = await findByExactText(page, "Simple", ["button", "div", "span", "option", "li"]);
        
        if (!simpleOption) {
          simpleOption = await findByText(page, "Simple", ["button", "div", "span", "option", "li"]);
        }
        
        // Fallback: Search in opened listbox/menu
        if (!simpleOption) {
          const simpleFound = await page.evaluate(() => {
            const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
            const menus = Array.from(document.querySelectorAll('[role="menu"]'));
            const allDropdowns = [...listboxes, ...menus];
            
            for (const menu of allDropdowns) {
              const style = window.getComputedStyle(menu);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const rect = menu.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              
              const options = Array.from(menu.querySelectorAll('[role="option"], button, div, span'));
              for (const option of options) {
                if (option.offsetParent === null) continue;
                const optionText = (option.textContent || '').trim();
                if (optionText.toLowerCase() === 'simple') {
                  return { found: true, element: option };
                }
              }
            }
            return { found: false };
          });
          
          if (simpleFound.found) {
            const simpleHandle = await page.evaluateHandle((el) => el, simpleFound.element);
            simpleOption = simpleHandle.asElement();
          }
        }
        
        if (simpleOption) {
          console.log(`[${exchange.name}] ✅ Found "Simple" option, clicking...`);
          try {
            await safeClick(page, simpleOption);
            await delay(300); // Wait for inputs to appear
            console.log(`[${exchange.name}] ✅ Selected "Simple" from TP/SL dropdown`);
          } catch (error) {
            console.log(`[${exchange.name}] safeClick failed, trying JavaScript click...`);
            await simpleOption.evaluate((el) => el.click());
            await delay(300); // Wait for inputs to appear
            console.log(`[${exchange.name}] ✅ Selected "Simple" from TP/SL dropdown (JavaScript click)`);
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not find "Simple" option in TP/SL dropdown`);
        }
      }
      
      // Step 5.1: Find and fill Stop Loss and Take Profit "Entry Distance" inputs
      console.log(`[${exchange.name}] Step 5.1: Finding and filling TP/SL "Entry Distance" inputs...`);

      // Calculate price movement%: ROI% / leverage
      const tpPercent = parseFloat(process.env.TAKE_PROFIT) || 0;
      const slPercent = parseFloat(process.env.STOP_LOSS) || 0;
      const leverage = parseFloat(process.env.LEVERAGE) || 10;
      const priceNum = price ? parseFloat(String(price).replace(/,/g, '')) : 0;
      const tpPriceMovementPct = tpPercent / leverage; // e.g. 10% ROI / 10x = 1%
      const slPriceMovementPct = slPercent / leverage; // e.g. 5% ROI / 10x = 0.5%

      // Detect if entry distance mode is "%" or "USD"
      const isPercentMode = await page.evaluate(() => {
        // Strategy 1: Check TP input sibling/parent for "%" or "USD" suffix
        const tpInput = document.querySelector('input[aria-label="Distance for Take profit"]');
        if (tpInput) {
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
        // Strategy 2: Check for active "%" toggle button
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
        // Strategy 3: Check for "%" suffix near TP/SL area
        const allElements = document.querySelectorAll('span, div, label');
        for (const el of allElements) {
          if (el.offsetParent === null) continue;
          const text = (el.textContent || '').trim();
          if (text === '%' && el.children.length === 0) {
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

      let takeProfitValue, stopLossValue;
      if (isPercentMode) {
        takeProfitValue = tpPriceMovementPct > 0 ? String(tpPriceMovementPct) : '';
        stopLossValue = slPriceMovementPct > 0 ? String(slPriceMovementPct) : '';
        console.log(`[${exchange.name}] Entry distance in % mode — TP=${tpPriceMovementPct}%, SL=${slPriceMovementPct}%`);
      } else {
        takeProfitValue = tpPercent > 0 && priceNum > 0 ? String(Math.round(priceNum * tpPriceMovementPct / 100)) : '';
        stopLossValue = slPercent > 0 && priceNum > 0 ? String(Math.round(priceNum * slPriceMovementPct / 100)) : '';
        console.log(`[${exchange.name}] Entry distance in USD mode — TP=$${takeProfitValue}, SL=$${stopLossValue}`);
      }

      if (!takeProfitValue && !stopLossValue) {
        console.log(`[${exchange.name}] ⚠️  TAKE_PROFIT/STOP_LOSS env vars not set or price unavailable, skipping TP/SL inputs`);
      } else {
        // Find inputs using aria-label attributes (most reliable)
        let takeProfitInput = null;
        let stopLossInput = null;
        
        // Method 1: Find by aria-label
        try {
          takeProfitInput = await page.$('input[aria-label="Distance for Take profit"]');
          stopLossInput = await page.$('input[aria-label="Distance for Stop loss"]');
          
          if (takeProfitInput) {
            console.log(`[${exchange.name}] ✅ Found Take Profit "Entry Distance" input via aria-label`);
          }
          if (stopLossInput) {
            console.log(`[${exchange.name}] ✅ Found Stop Loss "Entry Distance" input via aria-label`);
          }
        } catch (error) {
          console.log(`[${exchange.name}] ⚠️  Error finding inputs by aria-label: ${error.message}`);
        }
        
        // Method 2: Fallback - Find by name attribute pattern
        if (!takeProfitInput || !stopLossInput) {
          try {
            const inputs = await page.$$('input[name*="priceDeviationValue"]');
            for (const input of inputs) {
              const ariaLabel = await page.evaluate((el) => el.getAttribute('aria-label'), input);
              const name = await page.evaluate((el) => el.getAttribute('name'), input);
              
              if (ariaLabel && ariaLabel.includes('Take profit') && !takeProfitInput) {
                takeProfitInput = input;
                console.log(`[${exchange.name}] ✅ Found Take Profit "Entry Distance" input via name: ${name}`);
              } else if (ariaLabel && ariaLabel.includes('Stop loss') && !stopLossInput) {
                stopLossInput = input;
                console.log(`[${exchange.name}] ✅ Found Stop Loss "Entry Distance" input via name: ${name}`);
              }
            }
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error finding inputs by name: ${error.message}`);
          }
        }
        
        // Method 3: Fallback - Find by label text "Entry distance" and nearby "Take profit"/"Stop loss"
        if (!takeProfitInput || !stopLossInput) {
          try {
            const distanceInputs = await page.evaluate(() => {
              const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])'));
              const found = { takeProfit: null, stopLoss: null };
              
              for (const input of inputs) {
                if (input.offsetParent === null || input.disabled || input.readOnly) continue;
                
                // Check aria-label first
                const ariaLabel = input.getAttribute('aria-label') || '';
                if (ariaLabel.toLowerCase().includes('distance for take profit')) {
                  found.takeProfit = input;
                  continue;
                }
                if (ariaLabel.toLowerCase().includes('distance for stop loss')) {
                  found.stopLoss = input;
                  continue;
                }
                
                // Check label
                const labels = document.querySelectorAll('label');
                let labelText = '';
                for (const label of labels) {
                  if (label.control === input || label.getAttribute('for') === input.id || label.contains(input)) {
                    labelText = (label.textContent || '').trim().toLowerCase();
                    break;
                  }
                }
                
                // Check if label is "Entry distance"
                if (labelText === 'entry distance' || labelText.includes('entry distance')) {
                  // Find nearby "Take profit" or "Stop loss" text
                  let parent = input.parentElement;
                  let nearbyText = '';
                  for (let i = 0; i < 10 && parent; i++) {
                    const text = (parent.textContent || '').trim().toLowerCase();
                    if (text.includes('take profit')) {
                      nearbyText = 'take profit';
                      break;
                    }
                    if (text.includes('stop loss')) {
                      nearbyText = 'stop loss';
                      break;
                    }
                    parent = parent.parentElement;
                  }
                  
                  if (nearbyText === 'take profit' && !found.takeProfit) {
                    found.takeProfit = input;
                  } else if (nearbyText === 'stop loss' && !found.stopLoss) {
                    found.stopLoss = input;
                  }
                }
              }
              
              return {
                takeProfit: found.takeProfit ? { found: true, element: found.takeProfit } : { found: false },
                stopLoss: found.stopLoss ? { found: true, element: found.stopLoss } : { found: false }
              };
            });
            
            if (distanceInputs && distanceInputs.takeProfit && distanceInputs.takeProfit.found && !takeProfitInput) {
              const tpHandle = await page.evaluateHandle((el) => el, distanceInputs.takeProfit.element);
              takeProfitInput = tpHandle.asElement();
              console.log(`[${exchange.name}] ✅ Found Take Profit "Entry Distance" input via label search`);
            }
            
            if (distanceInputs && distanceInputs.stopLoss && distanceInputs.stopLoss.found && !stopLossInput) {
              const slHandle = await page.evaluateHandle((el) => el, distanceInputs.stopLoss.element);
              stopLossInput = slHandle.asElement();
              console.log(`[${exchange.name}] ✅ Found Stop Loss "Entry Distance" input via label search`);
            }
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error in fallback search: ${error.message}`);
          }
        }
        
        // Fill Take Profit "Entry Distance" input (DOM-level, works when minimized)
        if (takeProfitValue && takeProfitInput) {
          console.log(`[${exchange.name}] Filling Take Profit distance: ${isPercentMode ? takeProfitValue + '%' : '$' + takeProfitValue}`);
          try {
            await safeClearAndType(page, takeProfitInput, takeProfitValue, { delay: 50 });
            await delay(300);
            console.log(`[${exchange.name}] ✅ Filled Take Profit "Entry Distance" input`);
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error filling Take Profit input: ${error.message}`);
          }
        } else if (takeProfitValue) {
          console.log(`[${exchange.name}] ⚠️  Take Profit value set but "Entry Distance" input not found`);
        }

        // Fill Stop Loss "Entry Distance" input (DOM-level, works when minimized)
        if (stopLossValue && stopLossInput) {
          console.log(`[${exchange.name}] Filling Stop Loss distance: ${isPercentMode ? stopLossValue + '%' : '$' + stopLossValue}`);
          try {
            await safeClearAndType(page, stopLossInput, stopLossValue, { delay: 50 });
            await delay(300);
            console.log(`[${exchange.name}] ✅ Filled Stop Loss "Entry Distance" input`);
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error filling Stop Loss input: ${error.message}`);
          }
        } else if (stopLossValue) {
          console.log(`[${exchange.name}] ⚠️  Stop Loss value set but "Entry Distance" input not found`);
        }
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find TP/SL dropdown button`);
    }
  } catch (error) {
    console.log(`[${exchange.name}] ⚠️  Error handling TP/SL dropdown: ${error.message}`);
  }

  await delay(500);

  // Step 5.5: Update price input value to (current value - 10) before clicking confirm button
  // if (orderType === "limit" && priceInput) {
  //   console.log(`[${exchange.name}] Step 5.5: Updating price input value to (current value - 10) before clicking confirm button...`);
    
  //   // Get current price input value
  //   const currentPriceValue = await page.evaluate((el) => el.value || '', priceInput);
  //   const currentPriceNum = parseFloat(currentPriceValue.replace(/,/g, '').replace(/ /g, ''));
    
  //   if (currentPriceValue && !isNaN(currentPriceNum)) {
  //     const newPrice = currentPriceNum - 10;
  //     console.log(`[${exchange.name}] Current price: ${currentPriceNum}, New price (current - 10): ${newPrice}`);
      
  //     // Update the price input with the new value using enterPrice function
  //     await enterPrice(page, priceInput, newPrice, orderType);
      
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

  // Step 6: Find and click Confirm button
  const { confirmBtn, confirmText } = await findConfirmButtonKraken(page, side, exchange);

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

  // ⏱️ TIMING: Track first Confirm button click time
  const firstConfirmButtonClickTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = firstConfirmButtonClickTime - thresholdMetTime;
    const formFillTime = firstConfirmButtonClickTime - formFillStartTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] First Confirm button clicked - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met (form fill took ${(formFillTime / 1000).toFixed(2)}s)`);
  }
  
  // Click confirm button
  await clickConfirmButton(page, confirmBtn, confirmText, exchange, side);

  // Step 7: Wait for confirmation modal to open and click Confirm button in the modal
  console.log(`[${exchange.name}] Waiting 500ms for confirmation modal to open...`);
  await delay(500);
  
  // Check if a modal opened and find the Confirm button
  console.log(`[${exchange.name}] Looking for Confirm button in the modal...`);
  let confirmModalBtn = null;
  
  // Try to find Confirm button in modal
  confirmModalBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);
  
  if (!confirmModalBtn) {
    confirmModalBtn = await findByText(page, "Confirm", ["button", "div", "span"]);
  }
  
  if (confirmModalBtn) {
    // Verify it's inside a modal/dialog
    const isInModal = await page.evaluate((el) => {
      let parent = el.parentElement;
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
      console.log(`[${exchange.name}] ✅ Found Confirm button in modal, clicking...`);
      
      // ⏱️ TIMING: Track final Confirm button click (order submission)
      const confirmButtonClickTime = Date.now();
      
      try {
        await safeClick(page, confirmModalBtn);
        console.log(`[${exchange.name}] ✅ Clicked Confirm button in modal`);

        // ⏱️ TIMING: Log total time metrics
        if (thresholdMetTime) {
          const totalTime = confirmButtonClickTime - thresholdMetTime;
          const formFillTime = firstConfirmButtonClickTime - formFillStartTime;
          const buttonClickTime = confirmButtonClickTime - firstConfirmButtonClickTime;

          console.log(`\n[${exchange.name}] ⏱️  [TIMING METRICS] ${sideLabel} Order Submission Complete:`);
          console.log(`[${exchange.name}]    Account: ${email}`);
          console.log(`[${exchange.name}]    Total time (threshold → submit): ${(totalTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Form fill time: ${(formFillTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Button click time: ${(buttonClickTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Timestamp: ${new Date(confirmButtonClickTime).toISOString()}\n`);
        }
      } catch (error) {
        console.log(`[${exchange.name}] safeClick failed, trying JavaScript click...`);
        await confirmModalBtn.evaluate((el) => el.click());
        console.log(`[${exchange.name}] ✅ Clicked Confirm button in modal (JavaScript click)`);
        
        // ⏱️ TIMING: Log total time metrics (for JS click fallback)
        if (thresholdMetTime) {
          const totalTime = Date.now() - thresholdMetTime;
          const formFillTime = firstConfirmButtonClickTime - formFillStartTime;
          const buttonClickTime = Date.now() - firstConfirmButtonClickTime;
          
          console.log(`\n[${exchange.name}] ⏱️  [TIMING METRICS] ${sideLabel} Order Submission Complete (JS click):`);
          console.log(`[${exchange.name}]    Account: ${email}`);
          console.log(`[${exchange.name}]    Total time (threshold → submit): ${(totalTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Form fill time: ${(formFillTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Button click time: ${(buttonClickTime / 1000).toFixed(2)}s\n`);
        }
      }
      
      // Wait for modal to close
      console.log(`[${exchange.name}] Waiting for confirmation modal to close...`);
      let modalClosed = false;
      for (let i = 0; i < 10; i++) {
        const modalStillOpen = await page.evaluate(() => {
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="overlay"]'));
          for (const modal of modals) {
            const style = window.getComputedStyle(modal);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = modal.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return true; // Modal still open
              }
            }
          }
          return false; // Modal closed
        });
        
        if (!modalStillOpen) {
          modalClosed = true;
          console.log(`[${exchange.name}] ✅ Confirmation modal closed`);
          break;
        }
        await delay(200);
      }
      
      if (!modalClosed) {
        console.log(`[${exchange.name}] ⚠️  Modal may still be open, but proceeding...`);
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Found Confirm button but it's not in a modal, may have already been processed`);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find Confirm button in modal, order may have been processed without confirmation`);
  }

  // Step 8: Find and click "Open orders" tab after modal closes
  console.log(`[${exchange.name}] Step 8: Finding and clicking "Open orders" tab...`);
  await delay(500); // Additional delay to ensure modal is fully closed
  
  // Try "Open orders" (with lowercase 'o' in orders) first
  let openOrdersTab = await findByExactText(page, "Open orders", ["button", "div", "span", "a"]);
  
  if (!openOrdersTab) {
    // Try "Open Orders" (with capital 'O' in Orders)
    openOrdersTab = await findByExactText(page, "Open Orders", ["button", "div", "span", "a"]);
  }
  
  if (!openOrdersTab) {
    // Try case-insensitive search
    openOrdersTab = await findByText(page, "Open orders", ["button", "div", "span", "a"]);
  }
  
  if (!openOrdersTab) {
    // Try "Order History" as fallback
    openOrdersTab = await findByExactText(page, "Order History", ["button", "div", "span", "a"]);
  }
  
  if (!openOrdersTab) {
    // Try just "Orders" as last resort
    openOrdersTab = await findByExactText(page, "Orders", ["button", "div", "span", "a"]);
  }
  
  if (openOrdersTab) {
    const isVisible = await page.evaluate((el) => {
      return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
    }, openOrdersTab);
    
    if (isVisible) {
      console.log(`[${exchange.name}] ✅ Found "Open orders" tab, clicking...`);
      try {
        await safeClick(page, openOrdersTab);
        console.log(`[${exchange.name}] ✅ Clicked "Open orders" tab`);
        await delay(1000); // Wait for tab content to load
      } catch (error) {
        console.log(`[${exchange.name}] ⚠️  Error clicking "Open orders" tab: ${error.message}`);
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  "Open orders" tab found but not visible`);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find "Open orders" tab`);
  }

  // Verify order placement
  return await verifyOrderPlacement(page, exchange, side, qty);
}
