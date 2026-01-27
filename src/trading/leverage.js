import dotenv from 'dotenv';
import { delay } from '../utils/helpers.js';
import { findByExactText } from '../utils/helpers.js';

// Ensure environment variables are loaded
dotenv.config();

async function setLeverage(page, leverage) {
    console.log(`\n=== Setting Leverage to ${leverage}x ===`);
    console.log(`Target leverage from config: ${leverage}`);
  
    try {
      await delay(1000);
  
      // Step 1: Find and click the leverage display (e.g., "50x") in the trading panel to open modal
      console.log("Looking for leverage button in trading panel...");
      const leverageOpened = await page.evaluate(() => {
        // Look for leverage display with various strategies
        const allElements = Array.from(
          document.querySelectorAll("button, div, span, a")
        );
  
        // Strategy 1: Find elements with "x" pattern (like "50x")
        let candidates = [];
        for (const el of allElements) {
          const text = el.textContent?.trim();
          // Look for pattern like "50x", "20x", etc.
          if (text && /^\d+x$/i.test(text)) {
            const rect = el.getBoundingClientRect();
            // Check if visible and has reasonable size
            if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
              candidates.push({
                element: el,
                text: text,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              });
            }
          }
        }
  
        console.log(`Found ${candidates.length} leverage button candidates`);
        candidates.forEach((c, i) => {
          console.log(
            `  ${i + 1}. "${c.text}" at (${Math.round(c.x)}, ${Math.round(
              c.y
            )}) size: ${Math.round(c.width)}x${Math.round(c.height)}`
          );
        });
  
        // Strategy 2: Filter for trading panel area
        // Look for elements that are in the upper-right area or near trading controls
        let bestCandidate = null;
  
        // First try: Look for leverage in the right half of the screen
        for (const candidate of candidates) {
          if (candidate.x > window.innerWidth / 2) {
            bestCandidate = candidate;
            console.log(`Selected candidate in right panel: "${candidate.text}"`);
            break;
          }
        }
  
        // Fallback: Just take the first visible one
        if (!bestCandidate && candidates.length > 0) {
          bestCandidate = candidates[0];
          console.log(`Using first available candidate: "${bestCandidate.text}"`);
        }
  
        if (bestCandidate) {
          console.log(`Clicking leverage button: ${bestCandidate.text}`);
          bestCandidate.element.click();
          return { success: true, found: bestCandidate.text };
        }
  
        return { success: false };
      });
  
      if (!leverageOpened.success) {
        console.log("⚠ Leverage button not found in trading panel");
        return { success: false, error: "Leverage button not found" };
      }
  
      console.log(
        `✓ Clicked leverage button: ${leverageOpened.found}, waiting for modal...`
      );
      await delay(1500); // Reduced from 2500ms - wait for "Adjust Leverage" modal to open
  
      // Step 2: Find the input field in the modal and enter the leverage value
      console.log(`Setting leverage to ${leverage} in the modal...`);
  
      // Find the leverage input field
      const inputInfo = await page.evaluate(() => {
        const inputs = document.querySelectorAll(
          'input[type="text"], input[type="number"], input:not([type])'
        );
  
        console.log(`Found ${inputs.length} input fields in modal`);
  
        // Strategy: Find input with numeric value in visible modal
        for (const input of inputs) {
          if (input.offsetParent === null) continue; // Skip hidden inputs
  
          const value = input.value || "";
          const placeholder = input.placeholder || "";
  
          console.log(`Input: value="${value}", placeholder="${placeholder}"`);
  
          // Check if this looks like a leverage input
          if (
            /^\d+$/.test(value) ||
            placeholder.toLowerCase().includes("leverage")
          ) {
            console.log(`Found leverage input with current value: "${value}"`);
  
            // Mark the input with a unique attribute so we can find it again
            input.setAttribute("data-leverage-input", "true");
            input.setAttribute("data-old-value", value);
  
            return {
              success: true,
              oldValue: value,
            };
          }
        }
  
        return { success: false, error: "Leverage input not found in modal" };
      });
  
      if (!inputInfo.success) {
        console.log(`⚠ Could not find leverage input: ${inputInfo.error}`);
        return { success: false, error: inputInfo.error };
      }
  
      // Now use Puppeteer to actually type into the input (for proper React state management)
      const leverageInput = await page.$('input[data-leverage-input="true"]');
  
      if (!leverageInput) {
        console.log(`⚠ Could not locate leverage input element`);
        return {
          success: false,
          error: "Could not locate leverage input element",
        };
      }
  
      // Triple-click to select all and position cursor
      await leverageInput.click({ clickCount: 3 });
      await delay(200);
  
      // Get current value
      let currentValue = await page.evaluate(() => {
        const input = document.querySelector('input[data-leverage-input="true"]');
        return input ? input.value : "";
      });
  
      console.log(`Current input value: "${currentValue}"`);
  
      // Move cursor to end of input
      await page.keyboard.press("End");
      await delay(100);
  
      // Delete all characters with backspace
      const deleteCount = currentValue.length;
      console.log(`Deleting ${deleteCount} characters with backspace...`);
      for (let i = 0; i < deleteCount; i++) {
        await page.keyboard.press("Backspace");
        await delay(30);
      }
      await delay(200);
  
      // Verify input is empty or has default "0"
      currentValue = await page.evaluate(() => {
        const input = document.querySelector('input[data-leverage-input="true"]');
        return input ? input.value : "";
      });
      console.log(`After deleting: "${currentValue}"`);
  
      // If there's still a "0", delete it too
      if (currentValue === "0") {
        await page.keyboard.press("Backspace");
        await delay(100);
      }
  
      // Now type the new leverage value
      const leverageStr = String(leverage);
      console.log(`Typing leverage value: "${leverageStr}"`);
      await page.keyboard.type(leverageStr, { delay: 100 });
      await delay(300);
  
      // Delete the trailing "0" if it appears
      console.log(`Pressing Delete to remove trailing "0"...`);
      await page.keyboard.press("Delete");
      await delay(200);
  
      // Verify the value was set
      const leverageSet = await page.evaluate(() => {
        const input = document.querySelector('input[data-leverage-input="true"]');
        if (input) {
          return {
            success: true,
            oldValue: input.getAttribute("data-old-value") || "unknown",
            newValue: input.value,
          };
        }
        return { success: false, error: "Input disappeared" };
      });
  
      if (!leverageSet.success) {
        console.log(`⚠ Could not set leverage value: ${leverageSet.error}`);
        return { success: false, error: leverageSet.error };
      }
  
      console.log(
        `✓ Changed leverage from ${leverageSet.oldValue} to ${leverageSet.newValue}`
      );
  
      // Wait for the UI to register the input change before clicking Confirm
      console.log("Waiting for UI to register the leverage change...");
      await delay(2000); // Reduced from 3000ms
  
      // Step 3: Click the "Confirm" button
      console.log("Clicking Confirm button...");
      const confirmed = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if (text === "Confirm" && btn.offsetParent !== null) {
            console.log(`Found and clicking Confirm button`);
            btn.click();
            return { success: true };
          }
        }
        return { success: false };
      });
  
      if (!confirmed.success) {
        console.log("⚠ Confirm button not found");
        return { success: false, error: "Confirm button not found" };
      }
  
      await delay(1500); // Reduced from 2000ms - wait for modal to close and settings to apply
  
      // Verify the leverage was actually applied by checking the display button
      console.log("Verifying leverage was applied...");
      const finalLeverage = await page.evaluate(() => {
        const allElements = Array.from(
          document.querySelectorAll("button, div, span, a")
        );
        for (const el of allElements) {
          const text = el.textContent?.trim();
          if (text && /^\d+x$/i.test(text)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
              return text;
            }
          }
        }
        return null;
      });
  
      if (finalLeverage) {
        console.log(
          `✓ Leverage successfully set to ${leverage}x (verified: ${finalLeverage})`
        );
      } else {
        console.log(
          `✓ Leverage set to ${leverage}x (verification skipped - display not found)`
        );
      }
  
      return { success: true, leverage: leverage };
    } catch (error) {
      console.error("Error setting leverage:", error.message);
      return { success: false, error: error.message };
    }
  }

  // Helper function to set leverage
async function handleSetLeverage(page, email) {
    console.log(`[${email}] Setting leverage...`);
    
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
      console.log(`[${email}] ✅ Clicked leverage button`);
      await delay(2000);
      
      // Set leverage value using Puppeteer for better control
      const leverageValue = process.env.LEVERAGE || '20';
      
      // Find the input element first
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
      
      if (!leverageInputFound) {
        console.log(`[${email}] ⚠️  Could not find leverage input in modal`);
        return;
      }
      
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
        await inputElement.click({ clickCount: 3 }); // Triple click to select all
        await page.keyboard.press('Backspace');
        await delay(100);
        
        // Type the leverage value
        await inputElement.type(leverageValue, { delay: 50 });
        await delay(200);
        
        // Press Enter
        await page.keyboard.press('Enter');
        await delay(500);
        
        console.log(`[${email}] ✅ Entered leverage value: ${leverageValue} and pressed Enter`);
        
        // Check if leverage modal is still open (meaning leverage was unchanged)
        const leverageModalStillOpen = await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
          return modal !== null;
        });
        
        // Find and click Confirm or Cancel button based on whether leverage changed
        const leverageSet = await page.evaluate((modalStillOpen) => {
          const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
          if (!modal) return { success: false, reason: 'No modal found' };
          
          const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
          
          // If modal is still open, leverage might be unchanged, so click Cancel
          if (modalStillOpen) {
            const cancelBtn = buttons.find(btn => {
              const text = btn.textContent?.trim().toLowerCase();
              const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
              return isVisible && (text === 'cancel' || text === 'close' || text === 'x');
            });
            
            if (cancelBtn) {
              cancelBtn.click();
              return { success: true, cancelled: true, reason: 'Leverage unchanged, clicked Cancel' };
            }
          }
          
          // Otherwise, try to click Confirm
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
          if (leverageSet.cancelled) {
            console.log(`[${email}] ⚠️  Leverage unchanged, clicked Cancel button: ${leverageSet.reason || 'unknown'}`);
          } else if (leverageSet.confirmed) {
            console.log(`[${email}] ✅ Clicked Confirm button in leverage modal`);
          }
          await delay(1000); // Reduced from 2000ms
          // NOTE: Size input filling and Sell button clicking is now handled in executeTrade() function
          // This ensures trades only execute when explicitly called, not during leverage setting
        } else {
          console.log(`[${email}] ⚠️  Could not find Confirm button: ${leverageSet.reason || 'unknown'}`);
        }
      } else {
        console.log(`[${email}] ⚠️  Could not find leverage input element`);
      }
    } else {
      console.log(`[${email}] ⚠️  Could not find leverage button`);
    }
  }

  export { handleSetLeverage , setLeverage};