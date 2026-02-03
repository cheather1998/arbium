import { delay } from '../utils/helpers.js';
import { cancelKrakenOrders } from './orders.js';
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

/**
 * Kraken specific trade execution logic
 */

/**
 * Set leverage for Kraken
 * TODO: Implement Kraken-specific leverage setting after UI inspection
 */
export async function setLeverageKraken(page, leverage, exchange) {
  console.log(`[${exchange.name}] Setting leverage...`);
  // TODO: Implement Kraken-specific leverage setting logic
  // This will be implemented after inspecting Kraken UI
  console.log(`[${exchange.name}] ⚠️  Leverage setting not yet implemented for Kraken`);
  await delay(1000);
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
    
    // Try multiple click methods to ensure it works
    try {
      await optionBtn.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await delay(200);
      await optionBtn.click();
      console.log(`[${exchange.name}] Clicked ${optionText} option`);
    } catch (error1) {
      console.log(`[${exchange.name}] Direct click failed: ${error1.message}, trying JavaScript click...`);
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
async function selectOrderTypeKraken(page, orderType, exchange) {
  console.log(`[${exchange.name}] Looking for order type dropdown (${orderType.toUpperCase()})...`);
  
  // First, try a simple direct search for button with aria-haspopup="listbox"
  try {
    const dropdownButton = await page.$('button[aria-haspopup="listbox"]');
    if (dropdownButton) {
      console.log(`[${exchange.name}] ✅ Found dropdown button using selector: button[aria-haspopup="listbox"]`);
      const dropdownElement = dropdownButton;
      
      // Click to open dropdown
      console.log(`[${exchange.name}] Clicking dropdown to open it...`);
      await dropdownElement.click();
      await delay(800);
      
      // Find and click Limit option
      const optionText = orderType === 'limit' ? 'Limit' : 'Market';
      await clickLimitOption(page, optionText, exchange);
      return true;
    }
  } catch (error) {
    console.log(`[${exchange.name}] Direct selector search failed: ${error.message}`);
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
      
      // Look for button with aria-haspopup="listbox" (more lenient - don't require aria-label)
      if (ariaHaspopup === 'listbox') {
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
        
        // Try multiple methods to open dropdown
        try {
          await dropdownElement.click();
        } catch (error) {
          console.log(`[${exchange.name}] Direct click failed, trying JavaScript click...`);
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
          await dropdownElement.click();
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
          
          // Try multiple click methods to ensure it works
          try {
            // Method 1: Scroll into view and click
            await optionBtn.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await delay(200);
            await optionBtn.click();
            console.log(`[${exchange.name}] Clicked ${optionText} option (method 1: direct click)`);
          } catch (error1) {
            console.log(`[${exchange.name}] Direct click failed: ${error1.message}, trying JavaScript click...`);
            try {
              // Method 2: JavaScript click
              await optionBtn.evaluate((el) => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
              });
              console.log(`[${exchange.name}] Clicked ${optionText} option (method 2: JavaScript click)`);
            } catch (error2) {
              console.log(`[${exchange.name}] JavaScript click failed: ${error2.message}, trying mousedown/up...`);
              // Method 3: Mouse events
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
async function findKrakenInputs(page, orderType) {
  console.log(`[Kraken] Finding inputs for Kraken (order type: ${orderType})...`);
  
  const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
  let sizeInput = null;
  let priceInput = null;
  
  console.log(`[Kraken] Found ${inputs.length} input elements on page`);
  
  for (const input of inputs) {
    const rect = await input.boundingBox();
    if (!rect) continue;
    
    const isVisible = await page.evaluate((el) => {
      return el.offsetParent !== null && !el.disabled && !el.readOnly;
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
  if (orderType === "limit" && sizeInput && !priceInput) {
    const sizeRect = await sizeInput.boundingBox();
    if (sizeRect) {
      for (const input of inputs) {
        if (input === sizeInput) continue;
        const inputRect = await input.boundingBox();
        if (!inputRect) continue;
        
        // Price is usually above quantity
        const isAbove = inputRect.y < sizeRect.y && Math.abs(inputRect.x - sizeRect.x) < 200;
        if (isAbove) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && !el.disabled && !el.readOnly;
          }, input);
          if (isVisible) {
            priceInput = input;
            console.log(`[Kraken] ✅ Found Limit price input via position (above quantity)`);
            break;
          }
        }
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
  exchange
) {
  console.log(`\n=== Executing Trade on ${exchange.name} ===`);

  // Step 0: Cancel all existing orders first (modal-based flow for Kraken)
  console.log(`[${exchange.name}] Step 0: Canceling all existing orders...`);
  // await cancelKrakenOrders(page);
  console.log(`[${exchange.name}] ✅ Order cancellation completed\n`);

  // Set leverage first if requested
  if (setLeverageFirst && leverage) {
    await setLeverageKraken(page, leverage, exchange);
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

  // Step 1: Select Buy or Sell tabs (already correct)
  console.log(`[${exchange.name}] Step 1: Selecting ${side.toUpperCase()}...`);
  await selectBuyOrSell(page, side, exchange);
  await delay(300);

  // Step 2: Select order type from dropdown (on the right of Buy/Sell tabs)
  console.log(`[${exchange.name}] Step 2: Selecting ${orderType.toUpperCase()} from dropdown...`);
  await selectOrderTypeKraken(page, orderType, exchange);
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
        
        // Click to open the dropdown
        await tpSlButton.click();
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
            await simpleOption.click();
            await delay(300); // Wait for inputs to appear
            console.log(`[${exchange.name}] ✅ Selected "Simple" from TP/SL dropdown`);
          } catch (error) {
            console.log(`[${exchange.name}] Direct click failed, trying JavaScript click...`);
            await simpleOption.evaluate((el) => el.click());
            await delay(300); // Wait for inputs to appear
            console.log(`[${exchange.name}] ✅ Selected "Simple" from TP/SL dropdown (JavaScript click)`);
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not find "Simple" option in TP/SL dropdown`);
        }
      }
      
      // Step 5.1: Find and fill Stop Loss and Take Profit "Entry Distance" inputs (% inputs)
      console.log(`[${exchange.name}] Step 5.1: Finding and filling TP/SL "Entry Distance" inputs...`);
      
      // Get values from environment variables
      const takeProfitValue = process.env.TAKE_PROFIT || '';
      const stopLossValue = process.env.STOP_LOSS || '';
      
      if (!takeProfitValue && !stopLossValue) {
        console.log(`[${exchange.name}] ⚠️  TAKE_PROFIT and STOP_LOSS env variables not set, skipping TP/SL inputs`);
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
        
        // Fill Take Profit "Entry Distance" input
        if (takeProfitValue && takeProfitInput) {
          console.log(`[${exchange.name}] Filling Take Profit "Entry Distance" input with value: ${takeProfitValue}`);
          try {
            await takeProfitInput.click({ clickCount: 3 }); // Select all
            await delay(100);
            await takeProfitInput.type(takeProfitValue, { delay: 50 });
            await delay(300);
            console.log(`[${exchange.name}] ✅ Filled Take Profit "Entry Distance" input`);
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error filling Take Profit input: ${error.message}`);
          }
        } else if (takeProfitValue) {
          console.log(`[${exchange.name}] ⚠️  Take Profit value set but "Entry Distance" input not found`);
        }
        
        // Fill Stop Loss "Entry Distance" input
        if (stopLossValue && stopLossInput) {
          console.log(`[${exchange.name}] Filling Stop Loss "Entry Distance" input with value: ${stopLossValue}`);
          try {
            await stopLossInput.click({ clickCount: 3 }); // Select all
            await delay(100);
            await stopLossInput.type(stopLossValue, { delay: 50 });
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
      try {
        await confirmModalBtn.click();
        console.log(`[${exchange.name}] ✅ Clicked Confirm button in modal`);
      } catch (error) {
        console.log(`[${exchange.name}] Direct click failed, trying JavaScript click...`);
        await confirmModalBtn.evaluate((el) => el.click());
        console.log(`[${exchange.name}] ✅ Clicked Confirm button in modal (JavaScript click)`);
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
        await openOrdersTab.click();
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
