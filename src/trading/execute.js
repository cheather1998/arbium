import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay } from '../utils/helpers.js';
import { setLeverage } from './leverage.js';
import { verifyOrderPlaced } from './orders.js';
import { findByText, findByExactText } from '../utils/helpers.js';
import { clickTpSlCheckboxForParadex, fillTpSlValuesForParadex } from './tpsl.js';

async function executeTrade(
    page,
    { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
    exchangeConfig = null
  ) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
    console.log(`\n=== Executing Trade on ${exchange.name} ===`);
  
    // Set leverage first if requested
    if (setLeverageFirst && leverage) {
      // For Extended Exchange, use modal-based leverage setting
      if (exchange.name === 'Extended Exchange') {
        console.log(`Setting leverage for Extended Exchange using modal...`);
        const leverageValue = String(leverage);
        
        // Find and click leverage button
        const leverageButtonClicked = await page.evaluate(() => {
          const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
          const leverageBtn = allButtons.find(btn => {
            const text = btn.textContent?.trim();
            const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
            return isVisible && /^\d+x$/i.test(text);
          });
          
          if (leverageBtn) {
            leverageBtn.click();
            return true;
          }
          return false;
        });
        
        if (leverageButtonClicked) {
          console.log(`✅ Clicked leverage button`);
          await delay(2000);
          
          // Find leverage input in modal
          const leverageInputFound = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
            if (!modal) return null;
            
            const inputs = Array.from(modal.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])'));
            const leverageInput = inputs.find(input => {
              return !input.disabled && !input.readOnly && input.offsetParent !== null;
            });
            
            if (leverageInput) {
              return {
                id: leverageInput.id,
                className: leverageInput.className,
                type: leverageInput.type
              };
            }
            return null;
          });
          
          if (leverageInputFound) {
            // Find input using Puppeteer
            let inputElement = null;
            if (leverageInputFound.id) {
              inputElement = await page.$(`#${leverageInputFound.id}`);
            }
            
            if (!inputElement) {
              const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
              for (const input of inputs) {
                const isVisible = await input.evaluate(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
                if (isVisible) {
                  inputElement = input;
                  break;
                }
              }
            }
            
            if (inputElement) {
              // Click and focus the input
              await inputElement.click({ delay: 100 });
              await delay(200);
              
              // Clear existing value
              await inputElement.click({ clickCount: 3 });
              await page.keyboard.press('Backspace');
              await delay(100);
              
              // Type the leverage value
              await inputElement.type(leverageValue, { delay: 50 });
              await delay(200);
              
              // Press Enter
              await page.keyboard.press('Enter');
              await delay(500);
              
              console.log(`✅ Entered leverage value: ${leverageValue} and pressed Enter`);
              
              // Check if leverage modal is still open
              const leverageModalStillOpen = await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                return modal !== null;
              });
              
              // Find and click Confirm or Cancel button
              const leverageSet = await page.evaluate((modalStillOpen) => {
                const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                if (!modal) return { success: false, reason: 'No modal found' };
                
                const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                
                if (modalStillOpen) {
                  const cancelBtn = buttons.find(btn => {
                    const text = btn.textContent?.trim().toLowerCase();
                    const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                    return isVisible && (text === 'cancel' || text === 'close' || text === 'x');
                  });
                  
                  if (cancelBtn) {
                    cancelBtn.click();
                    return { success: true, cancelled: true };
                  }
                }
                
                const confirmBtn = buttons.find(btn => {
                  const text = btn.textContent?.trim().toLowerCase();
                  const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                  return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                });
                
                if (confirmBtn) {
                  confirmBtn.click();
                  return { success: true, confirmed: true };
                }
                
                return { success: false, reason: 'Confirm/Cancel button not found' };
              }, leverageModalStillOpen);
              
              if (leverageSet.success) {
                console.log(`✅ Leverage modal handled: ${leverageSet.cancelled ? 'Cancelled (unchanged)' : 'Confirmed'}`);
                await delay(1000);
              } else {
                console.log(`⚠️  Could not handle leverage modal: ${leverageSet.reason || 'unknown'}`);
              }
            } else {
              console.log(`⚠️  Could not find leverage input element`);
            }
          } else {
            console.log(`⚠️  Could not find leverage input in modal`);
          }
        } else {
          console.log(`⚠️  Could not find leverage button`);
        }
      } else {
        // For Paradex, use existing setLeverage function
        const leverageResult = await setLeverage(page, leverage);
        if (!leverageResult.success) {
          console.log(`⚠ Failed to set leverage: ${leverageResult.error}`);
          // Continue anyway - leverage setting might not be critical
        }
        await delay(1000);
      }
    }
  
    // If limit order without price, fetch current market price
    if (orderType === "limit" && !price) {
      price = await getCurrentMarketPrice(page);
      if (!price) {
        console.log("❌ Could not fetch market price for limit order");
        return { success: false, error: "Could not fetch market price" };
      }
    }
  
    console.log(
      `Side: ${side}, Type: ${orderType}, Price: ${
        price || "market"
      }, Qty: ${qty}`
    );
  
    // No need to reload - just wait a moment for any previous actions to complete
    await delay(1000); // Reduced from 2000
  
    // 1. Select Buy or Sell
    if (side === "sell") {
      const sellBtn = await findByExactText(page, exchange.selectors.sellButton, ["button", "div"]);
      if (sellBtn) {
        await sellBtn.click();
        console.log("Selected SELL");
        await delay(300); // Reduced from 500ms
      }
    } else {
      const buyBtn = await findByExactText(page, exchange.selectors.buyButton, ["button", "div"]);
      if (buyBtn) {
        await buyBtn.click();
        console.log("Selected BUY");
        await delay(300); // Reduced from 500ms
      }
    }
  
    // 2. Select Market or Limit order type
    if (orderType === "limit") {
      const limitBtn = await findByExactText(page, exchange.selectors.limitButton, ["button", "div"]);
      if (limitBtn) {
        await limitBtn.click();
        console.log("Selected LIMIT order");
        await delay(300); // Reduced from 500ms
      }
    } else {
      const marketBtn = await findByExactText(page, exchange.selectors.marketButton, ["button", "div"]);
      if (marketBtn) {
        await marketBtn.click();
        console.log("Selected MARKET order");
        await delay(300); // Reduced from 500ms
      }
    }
  
    await delay(500); // Reduced from 1000ms
  
    // 3. Find and fill inputs - Look for the Size input in the trading panel
    const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type])');
    let sizeInput = null;
    let priceInput = null;
  
    console.log(`Found ${inputs.length} text input elements on page`);
  
    // Get screen width for percentage-based filtering (works for all screen sizes)
    const screenWidth = await page.evaluate(() => window.innerWidth);
    const rightSideThreshold = screenWidth * 0.5; // Right half of screen
  
    for (const input of inputs) {
      const rect = await input.boundingBox();
      if (!rect) continue;
  
      // Look for inputs in the right panel (trading panel is on the right side)
      // Use percentage-based approach for screen-size independence
      if (rect.x < rightSideThreshold) continue;
  
      const inputInfo = await page.evaluate((el) => {
        // Get all text content around this input
        let parent = el.parentElement;
        let parentText = "";
        let labelText = "";
  
        // Check for label
        const labels = document.querySelectorAll("label");
        for (const label of labels) {
          if (label.control === el || label.contains(el)) {
            labelText = label.textContent?.trim() || "";
          }
        }
  
        // Get parent text
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.innerText) {
            parentText = parent.innerText;
            break;
          }
          parent = parent.parentElement;
        }
  
        return {
          placeholder: el.placeholder || "",
          value: el.value || "",
          id: el.id || "",
          name: el.name || "",
          parentText: parentText,
          labelText: labelText,
        };
      }, input);
  
      console.log(`Input at (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
      console.log(
        `  ID: "${inputInfo.id}", Name: "${inputInfo.name}", Placeholder: "${inputInfo.placeholder}"`
      );
      console.log(
        `  Label: "${
          inputInfo.labelText
        }", Parent: "${inputInfo.parentText.substring(0, 60)}"`
      );
      console.log(`  Current value: "${inputInfo.value}"`);
  
      // Check if this is the Size input (case-insensitive for better matching)
      const isSizeInput =
        inputInfo.parentText.toLowerCase().includes("size") ||
        inputInfo.labelText.toLowerCase().includes("size") ||
        inputInfo.placeholder.toLowerCase().includes("size") ||
        inputInfo.id.toLowerCase().includes("size") ||
        inputInfo.name.toLowerCase().includes("size") ||
        inputInfo.parentText.toLowerCase().includes("quantity") ||
        inputInfo.placeholder.toLowerCase().includes("quantity");
  
      // Check if this is the Price input
      const isPriceInput =
        inputInfo.parentText.includes("Price") ||
        inputInfo.labelText.includes("Price") ||
        inputInfo.placeholder.includes("Price") ||
        inputInfo.id.includes("price") ||
        inputInfo.name.includes("price");
  
      if (isSizeInput && !sizeInput) {
        sizeInput = input;
        console.log("✓ Found size input!");
      } else if (isPriceInput && !priceInput && orderType === "limit") {
        priceInput = input;
        console.log("✓ Found price input!");
      }
    }
  
    // Enter price (for limit orders)
    if (orderType === "limit" && price) {
      if (priceInput) {
        await priceInput.click({ clickCount: 3 });
        await delay(100);
        await page.keyboard.press("Backspace");
        await priceInput.type(String(price), { delay: 30 });
        console.log(`Entered price: ${price}`);
      } else {
        const allInputs = await page.$$("input");
        for (const inp of allInputs) {
          const rect = await inp.boundingBox();
          if (rect && rect.x > 1000 && rect.y > 150 && rect.y < 300) {
            await inp.click({ clickCount: 3 });
            await delay(100);
            await page.keyboard.press("Backspace");
            await inp.type(String(price), { delay: 30 });
            console.log(`Entered price: ${price} (fallback)`);
            break;
          }
        }
      }
      await delay(300);
    }
  
    // Enter quantity/size
    if (!sizeInput) {
      console.log("❌ Size input not found! Cannot proceed with trade.");
      return { success: false, error: "Size input field not found" };
    }
  
    console.log("\n=== Entering Size ===");
  
    // Method 1: Clear and type
    await sizeInput.click();
    await delay(300);
  
    // Select all existing text (using Meta/Command on Mac)
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Meta");
    await delay(100);
  
    // Type the new value
    await page.keyboard.type(String(qty), { delay: 100 });
    await delay(500);
  
    // Verify the value was set
    let actualValue = await page.evaluate((el) => el.value, sizeInput);
    console.log(`Size input value after first attempt: "${actualValue}"`);
  
    // If value wasn't set properly, try alternative method
    if (
      !actualValue ||
      actualValue === "" ||
      Math.abs(parseFloat(actualValue) - parseFloat(qty)) > 0.0001
    ) {
      console.log("First attempt failed, trying alternative method...");
  
      // Focus the input
      await sizeInput.focus();
      await delay(200);
  
      // Clear using JavaScript
      await page.evaluate((el) => {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, sizeInput);
      await delay(200);
  
      // Type again
      await sizeInput.type(String(qty), { delay: 100 });
      await delay(500);
  
      actualValue = await page.evaluate((el) => el.value, sizeInput);
      console.log(`Size input value after second attempt: "${actualValue}"`);
    }
  
    // If still not set, try direct value assignment
    if (
      !actualValue ||
      actualValue === "" ||
      Math.abs(parseFloat(actualValue) - parseFloat(qty)) > 0.0001
    ) {
      console.log("Second attempt failed, using direct assignment...");
  
      await page.evaluate(
        (el, value) => {
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        },
        sizeInput,
        String(qty)
      );
      await delay(500);
  
      actualValue = await page.evaluate((el) => el.value, sizeInput);
      console.log(`Size input value after direct assignment: "${actualValue}"`);
    }
  
    // Final verification
    if (!actualValue || actualValue === "") {
      console.log("❌ Failed to set size value!");
      return { success: false, error: "Failed to enter size value" };
    }
  
    console.log(`✓ Successfully set size to: ${actualValue}`);
    await delay(500); // Reduced from 1000ms
  
    if (exchange.name === 'Paradex') {
      console.log(`[Paradex] Clicking TP/SL checkbox before executing trade...`);
      const tpSlResult = await clickTpSlCheckboxForParadex(page);
      if (tpSlResult.success) {
        console.log(`[Paradex] ✅ TP/SL checkbox clicked successfully`);
        // Wait 100ms before filling TP/SL values
        await delay(100);
        // Fill Take Profit and Stop Loss values from environment variables
        const fillResult = await fillTpSlValuesForParadex(page);
        if (fillResult.success) {
          console.log(`[Paradex] ✅ TP/SL values filled successfully`);
        } else {
          console.log(`[Paradex] ⚠️  Could not fill TP/SL values: ${fillResult.error || 'unknown error'}`);
          // Continue anyway - TP/SL values might not be critical
        }
      } else {
        console.log(`[Paradex] ⚠️  Could not click TP/SL checkbox: ${tpSlResult.error || 'unknown error'}`);
        // Continue anyway - TP/SL checkbox might not be critical
      }
    }
    
    // NOTE: Order cancellation is already done before executeTrade() is called in the trading loop
    // No need to cancel orders here - just proceed to click confirm button
    
    // 4. Click Confirm button (use exchange-specific selectors)
    // For Extended Exchange, the sell button is just "Sell", not "Confirm Sell"
    let confirmText = side === "buy" ? exchange.selectors.confirmBuy : exchange.selectors.confirmSell;
    
    // Extended Exchange uses "Sell" button directly (no "Confirm Sell")
    // Check both exact name match and case-insensitive match
    const isExtendedExchange = exchange.name === 'Extended Exchange' || 
                                exchange.name?.toLowerCase() === 'extended exchange' ||
                                exchange.name?.includes('Extended');
    
    console.log(`[DEBUG] Exchange detection: name="${exchange.name}", isExtendedExchange=${isExtendedExchange}, side=${side}`);
    
    if (isExtendedExchange && side === 'sell') {
      confirmText = "Sell";
      console.log(`✓ Extended Exchange detected - using "Sell" button instead of "Confirm Sell"`);
    }
    
    // For Extended Exchange, use a more robust method to find the confirm button
    // We need to find the actual execute button, not the side selector
    let confirmBtn = null;
    
    // CRITICAL: Check if this is Extended Exchange with sell side
    if (isExtendedExchange && side === 'sell') {
      console.log(`[EXTENDED EXCHANGE] ✅ Entering Extended Exchange Sell button finding logic...`);
      console.log(`[EXTENDED EXCHANGE] Looking for "Sell" button in right 40% of screen (last 40%)...`);
      
      // Method 1: Find "Sell" button in the right 40% of screen (from 60% to 100%)
      const screenWidth = await page.evaluate(() => window.innerWidth);
      const rightSideThreshold = screenWidth * 0.6; // Start from 60% (last 40% of screen)
      console.log(`[EXTENDED EXCHANGE] Method 1: Screen width: ${screenWidth}, Right threshold (60%): ${rightSideThreshold}`);
      
      const allButtons = await page.$$('button, div[role="button"], span[role="button"], a[role="button"]');
      console.log(`[EXTENDED EXCHANGE] Method 1: Checking ${allButtons.length} buttons for "Sell" text in right 40%...`);
      
      let sellButtonsOnRight = [];
      for (const btn of allButtons) {
        const btnText = await page.evaluate((el) => el.textContent?.trim(), btn);
        const rect = await btn.boundingBox();
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, btn);
        
        // Check if it's the "Sell" button, visible, and in the right 40% of screen
        if (btnText === "Sell" && isVisible && rect && rect.x >= rightSideThreshold) {

                  // Check if button is near footer
          const buttonInfo = await page.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            return {
              isNearFooter: rect.bottom > viewportHeight * 0.8,
              viewportHeight
            };
          }, btn);
          const isDisabled = await page.evaluate((el) => {
            return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                   el.classList.contains('disabled') || el.style.pointerEvents === 'none';
          }, btn);
          
          sellButtonsOnRight.push({
            text: btnText,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            onRight: true,
            disabled: isDisabled,
            isNearFooter: buttonInfo.isNearFooter
          });
          
          if (!isDisabled) {
            confirmBtn = btn;
            console.log(`[EXTENDED EXCHANGE] ✓ Method 1 SUCCESS: Found Sell button at (${Math.round(rect.x)}, ${Math.round(rect.y)}) in right 40%`);
            if (buttonInfo.isNearFooter) {
              console.log(`[EXTENDED EXCHANGE] ⚠️  Button is near footer, will scroll into view before clicking`);
            }
            break;
          }
        }
      }
      
      if (!confirmBtn && sellButtonsOnRight.length > 0) {
        console.log(`[EXTENDED EXCHANGE] Method 1: Found ${sellButtonsOnRight.length} "Sell" button(s) in right 40% but all disabled:`, JSON.stringify(sellButtonsOnRight, null, 2));
      } else if (sellButtonsOnRight.length === 0) {
        console.log(`[EXTENDED EXCHANGE] Method 1: No "Sell" buttons found in right 40% of screen`);
      }
      
      // Method 2: Fallback - try findByExactText and filter by right 40%
      if (!confirmBtn) {
        console.log(`[EXTENDED EXCHANGE] Method 2: Trying findByExactText("Sell") and filtering by right 40%...`);
        const foundBtn = await findByExactText(page, "Sell", ["button", "div", "span"]);
        if (foundBtn) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, foundBtn);
          const rect = await foundBtn.boundingBox();
          
          console.log(`[EXTENDED EXCHANGE] Method 2: Found button - visible: ${isVisible}, x: ${Math.round(rect?.x || 0)}, threshold: ${rightSideThreshold}`);
          
          if (isVisible && rect && rect.x >= rightSideThreshold) {
            const isDisabled = await page.evaluate((el) => {
              return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                     el.classList.contains('disabled') || el.style.pointerEvents === 'none';
            }, foundBtn);
            
            if (!isDisabled) {
              confirmBtn = foundBtn;
              console.log(`[EXTENDED EXCHANGE] ✓ Method 2 SUCCESS: Found Sell button via findByExactText at (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
            } else {
              console.log(`[EXTENDED EXCHANGE] Method 2: Found button but it's disabled`);
            }
          } else {
            console.log(`[EXTENDED EXCHANGE] Method 2: Found button but not visible or not in right 40%`);
          }
        } else {
          console.log(`[EXTENDED EXCHANGE] Method 2: findByExactText returned null`);
        }
      }
      
      // Method 3: Final fallback to findByText and filter by right 40%
      if (!confirmBtn) {
        console.log(`[EXTENDED EXCHANGE] Method 3: Trying findByText("Sell") and filtering by right 40%...`);
        confirmBtn = await findByText(page, "Sell", ["button"]); // Use "Sell" not confirmText for Extended Exchange
        if (confirmBtn) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, confirmBtn);
          if (!isVisible) {
            console.log(`[EXTENDED EXCHANGE] Method 3: Found button but it's not visible`);
            confirmBtn = null;
          } else {
            const rect = await confirmBtn.boundingBox();
            
            // Check if it's in the right 40%
            if (rect && rect.x >= rightSideThreshold) {
              const isDisabled = await page.evaluate((el) => {
                return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                       el.classList.contains('disabled') || el.style.pointerEvents === 'none';
              }, confirmBtn);
              
              if (!isDisabled) {
                console.log(`[EXTENDED EXCHANGE] ✓ Method 3 SUCCESS: Found Sell button via findByText at (${Math.round(rect.x)}, ${Math.round(rect.y)}) in right 40%`);
              } else {
                console.log(`[EXTENDED EXCHANGE] Method 3: Found button but it's disabled`);
                confirmBtn = null;
              }
            } else {
              console.log(`[EXTENDED EXCHANGE] Method 3: Found Sell button but it's not in right 40% (x: ${Math.round(rect?.x || 0)}, threshold: ${rightSideThreshold}), skipping...`);
              confirmBtn = null;
            }
          }
        } else {
          console.log(`[EXTENDED EXCHANGE] Method 3: findByText returned null`);
        }
      }
      
      // Final check: if we found the button, log it
      if (confirmBtn) {
        console.log(`[EXTENDED EXCHANGE] ✅ Sell button found and ready to click!`);
      } else {
        console.log(`[EXTENDED EXCHANGE] ❌ FAILED to find Sell button after all methods`);
      }
    } else {
      // For other exchanges (Paradex) or buy side, use improved method
      console.log(`Looking for "${confirmText}" button on ${exchange.name}...`);
      
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
          console.log(`⚠️  Found "${confirmText}" button but it's not visible, trying fallback...`);
          confirmBtn = null;
        } else {
          console.log(`✓ Found "${confirmText}" button at (${Math.round(buttonCheck.x || 0)}, ${Math.round(buttonCheck.y || 0)})`);
          if (buttonCheck.isNearFooter) {
            console.log(`⚠️  Button is near footer (bottom ${Math.round((buttonCheck.y + 100) / buttonCheck.viewportHeight * 100)}% of viewport), will scroll into view before clicking`);
          }
        }
      }
      
      // Method 2: Fallback to findByText if exact match failed
      if (!confirmBtn) {
        console.log(`Exact text match failed, trying partial match...`);
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
            console.log(`✓ Found "${confirmText}" button via partial match at (${Math.round(buttonCheck.x || 0)}, ${Math.round(buttonCheck.y || 0)})`);
            if (buttonCheck.isNearFooter) {
              console.log(`⚠️  Button is near footer (bottom ${Math.round((buttonCheck.y + 100) / buttonCheck.viewportHeight * 100)}% of viewport), will scroll into view before clicking`);
            }
          } else {
            console.log(`⚠️  Found button but it's not visible`);
            confirmBtn = null;
          }
        }
      }
      
    // Method 3: Try case-insensitive search in evaluate with viewport and footer checking
    if (!confirmBtn) {
        console.log(`Partial match failed, trying case-insensitive search...`);
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
          console.log(`✓ Found button via case-insensitive search: "${foundBtn.text}" at (${Math.round(foundBtn.x)}, ${Math.round(foundBtn.y)})`);
          // Try to find it again using Puppeteer
          confirmBtn = await findByText(page, foundBtn.text, ["button"]);
        }
      }
    }
  
    if (confirmBtn) {
      // Log which exchange and button before clicking
      if (isExtendedExchange && side === 'sell') {
        console.log(`[EXTENDED EXCHANGE] 🖱️  Clicking Sell button now...`);
      } else {
        console.log(`[${exchange.name}] 🖱️  Clicking "${confirmText}" button now...`);
      }
      // Scroll button into view and ensure it's not hidden behind footer
      const buttonInfo = await page.evaluate((btn) => {
        const rect = btn.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        
        // Check if button is in viewport
        const isInViewport = rect.top >= 0 && 
                            rect.left >= 0 && 
                            rect.bottom <= viewportHeight && 
                            rect.right <= viewportWidth;
        
        // Check if button might be covered by footer (in bottom 15% of viewport)
        const isNearFooter = rect.bottom > viewportHeight * 0.85;
        
        // Get element at button's center point to check if something is covering it
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const elementAtPoint = document.elementFromPoint(centerX, centerY);
        
        // Check if the element at the point is the button itself or inside it
        const isCovered = elementAtPoint && 
                        !btn.contains(elementAtPoint) && 
                        elementAtPoint !== btn &&
                        !elementAtPoint.closest('button, [role="button"]');
        
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          isInViewport,
          isNearFooter,
          isCovered,
          viewportHeight,
          viewportWidth,
          centerX,
          centerY
        };
      }, confirmBtn);
      
      console.log(`Button position: (${Math.round(buttonInfo.x)}, ${Math.round(buttonInfo.y)}), Viewport: ${buttonInfo.viewportWidth}x${buttonInfo.viewportHeight}`);
      
      // Scroll button into view if needed
      if (!buttonInfo.isInViewport || buttonInfo.isNearFooter) {
        console.log(`📜 Scrolling button into view (isInViewport: ${buttonInfo.isInViewport}, isNearFooter: ${buttonInfo.isNearFooter})...`);
        await confirmBtn.evaluate((btn) => {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        });
        await delay(500); // Wait for scroll to complete
        
        // Re-check position after scroll
        const newButtonInfo = await page.evaluate((btn) => {
          const rect = btn.getBoundingClientRect();
          const viewportHeight = window.innerHeight;
          return {
            y: rect.y,
            bottom: rect.bottom,
            viewportHeight,
            isInViewport: rect.top >= 0 && rect.bottom <= viewportHeight
          };
        }, confirmBtn);
        
        console.log(`After scroll: y=${Math.round(newButtonInfo.y)}, bottom=${Math.round(newButtonInfo.bottom)}, viewport=${newButtonInfo.viewportHeight}`);
        
        // If still too close to footer, scroll up a bit more
        if (newButtonInfo.bottom > newButtonInfo.viewportHeight * 0.9) {
          console.log(`⚠️  Button still too close to footer, scrolling up more...`);
          await page.evaluate(() => {
            window.scrollBy(0, -100); // Scroll up 100px
          });
          await delay(300);
        }
      }
      
      // Check if button is covered by another element
      if (buttonInfo.isCovered) {
        console.log(`⚠️  Button might be covered by another element, trying to click anyway...`);
      }
      
      // Use JavaScript click as fallback if element might be covered
      // First try Puppeteer's click, which handles some coverage cases
      try {
        await confirmBtn.click({ delay: 100 });
        console.log(`✓ Successfully clicked "${confirmText}" button`);
      } catch (clickError) {
        console.log(`⚠️  Puppeteer click failed: ${clickError.message}, trying JavaScript click...`);
        // Fallback to JavaScript click
        await confirmBtn.evaluate((btn) => {
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          btn.click();
        });
        console.log(`✓ Successfully clicked "${confirmText}" button (via JavaScript)`);
      }
      await delay(2000); // Wait for order submission to process
  
      // Check for error messages first
      const errorMsg = await page.evaluate(() => {
        const errors = document.querySelectorAll(
          '[class*="error"], [class*="Error"]'
        );
        for (const err of errors) {
          if (err.textContent) return err.textContent;
        }
        return null;
      });
  
      if (errorMsg) {
        console.log("Trade error:", errorMsg);
        return { success: false, error: errorMsg };
      }
  
      // Verify order was placed and is pending
      console.log("Verifying order placement...");
      const orderVerified = await verifyOrderPlaced(page, exchange, side, qty, maxWaitTime = 10000);
      
      if (orderVerified.success) {
        console.log(`✓ Order confirmed as ${orderVerified.status || 'pending'}`);
        return { success: true, message: "Trade submitted and order confirmed", orderStatus: orderVerified.status };
      } else {
        console.log(`⚠️  Order verification: ${orderVerified.reason || 'Could not verify order placement'}`);
        // Still return success if no error was found (order might be placed but not yet visible)
        return { success: true, message: "Trade submitted (verification inconclusive)", warning: orderVerified.reason };
      }
    } else {
      // Enhanced error message with debugging info
      console.log(`❌ Could not find "${confirmText}" button`);
      console.log(`   Exchange: ${exchange.name}, Side: ${side}`);
      
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
      
      console.log(`   Available buttons (first 10):`, JSON.stringify(availableButtons, null, 2));
      
      return { success: false, error: `Confirm button not found. Looking for: "${confirmText}"` };
    }
  }

  async function getCurrentMarketPrice(page) {
    console.log("Fetching current market price...");
  
    try {
      // Try to get the current price from the page
      const price = await page.evaluate(() => {
        // Look for price displays - common patterns on trading interfaces
        const priceSelectors = [
          // Try to find the main price ticker
          '[class*="price"]',
          '[class*="ticker"]',
          '[class*="mark-price"]',
          '[class*="last-price"]',
          '[data-testid*="price"]',
        ];
  
        // Check all possible price elements
        for (const selector of priceSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            const text = el.textContent?.trim();
            // Look for USD prices (format: $XX,XXX.XX or XX,XXX.XX)
            const match = text?.match(
              /\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/
            );
            if (match) {
              const priceStr = match[1].replace(/,/g, "");
              const price = parseFloat(priceStr);
              // Validate it's a reasonable BTC price (between $1,000 and $500,000)
              if (price >= 1000 && price <= 500000) {
                return price;
              }
            }
          }
        }
  
        // Fallback: look for any large number that looks like a BTC price
        const allText = document.body.innerText;
        const priceMatches = allText.match(
          /\$?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)/g
        );
        if (priceMatches) {
          for (const match of priceMatches) {
            const priceStr = match.replace(/[$,]/g, "");
            const price = parseFloat(priceStr);
            if (price >= 1000 && price <= 500000) {
              return price;
            }
          }
        }
  
        return null;
      });
  
      if (price) {
        console.log(`✓ Current market price: $${price.toLocaleString()}`);
        return price;
      } else {
        console.log("⚠ Could not find market price on page");
        return null;
      }
    } catch (error) {
      console.error("Error fetching market price:", error.message);
      return null;
    }
  }

  export { executeTrade, getCurrentMarketPrice };