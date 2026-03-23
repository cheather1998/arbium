import dotenv from 'dotenv';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay } from '../utils/helpers.js';
import { findByExactText } from '../utils/helpers.js';
import { safeClick } from '../utils/safeActions.js';

// Ensure environment variables are loaded
dotenv.config();


/**
 * Navigate to Positions tab and click on the column under "TP / SL" header
 * @param {Page} page - Puppeteer page object
 * @param {Object} exchangeConfig - Exchange configuration object
 * @returns {Promise<Object>} - { success: boolean, message: string }
 */
async function clickTpSlColumnInPositions(page, exchangeConfig = null) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex;
    console.log(`\n[${exchange.name}] Step 1: Navigating to Positions tab...`);
    
    try {
      // Step 1: Go to Positions tab
      const positionsTab = await findByExactText(page, exchange.selectors.positionsTab || "Positions", [
        "button",
        "div",
        "span",
        "a"
      ]);
      
      if (!positionsTab) {
        console.log(`[${exchange.name}] ⚠️  Could not find Positions tab`);
        return { success: false, message: "Positions tab not found" };
      }
      
      await safeClick(page, positionsTab);
      console.log(`[${exchange.name}] ✅ Clicked Positions tab`);
      await delay(300); // Wait for positions table to load
      
      // Check if there are open positions by checking if table has data rows (not just header row)
      console.log(`[${exchange.name}] Checking if there are open positions (checking for data rows in table)...`);
      const hasPositions = await page.evaluate(() => {
        // Find all tables
        const tables = Array.from(document.querySelectorAll('table'));
        
        for (const table of tables) {
          // Find header row
          const headerRow = table.querySelector('thead tr, thead > tr, tr:first-child');
          if (!headerRow) continue;
          
          // Find data rows (exclude header row)
          const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
          
          // Check if there are any data rows with actual content
          for (const row of dataRows) {
            const cells = Array.from(row.querySelectorAll('td, th'));
            // Check if row has cells and is not empty
            if (cells.length > 0) {
              const rowText = row.textContent?.trim();
              // If row has some text content (not just whitespace), it's a data row
              if (rowText && rowText.length > 0) {
                console.log(`Found data row with content: "${rowText.substring(0, 50)}..."`);
                return true; // Found at least one data row = positions exist
              }
            }
          }
        }
        
        return false; // No data rows found = no positions
      });
      
      if (!hasPositions) {
        console.log(`[${exchange.name}] ✅ No open positions found (only header row in table) - skipping TP/SL flow`);
        return { success: true, message: "No open positions - TP/SL not needed" };
      }
      
      console.log(`[${exchange.name}] ✅ Open positions found (data rows exist in table) - proceeding with TP/SL flow`);
      
      // Step 2: Find the column under "TP / SL" header and click it
      console.log(`[${exchange.name}] Step 2: Looking for column under "TP / SL" header...`);
      const clicked = await page.evaluate(() => {
        // Find all table elements
        const tables = Array.from(document.querySelectorAll('table'));
        console.log(`Found ${tables.length} tables on page`);
        
        for (let tableIdx = 0; tableIdx < tables.length; tableIdx++) {
          const table = tables[tableIdx];
          console.log(`Checking table ${tableIdx + 1}/${tables.length}`);
          
          // Find header row
          const headerRow = table.querySelector('thead tr, thead > tr, tr:first-child');
          if (!headerRow) {
            console.log(`  Table ${tableIdx + 1}: No header row found`);
            continue;
          }
          
          // Find TP/SL column header
          const headers = Array.from(headerRow.querySelectorAll('th, td'));
          console.log(`  Table ${tableIdx + 1}: Found ${headers.length} headers`);
          
          // Log all header texts for debugging
          headers.forEach((h, idx) => {
            const text = h.textContent?.trim();
            console.log(`    Header ${idx}: "${text}"`);
          });
          
          let tpSlColumnIndex = -1;
          
          for (let i = 0; i < headers.length; i++) {
            const headerText = headers[i].textContent?.trim();
            // Look for "TP / SL" or variations
            if (headerText && (
              headerText.toLowerCase().includes('tp/sl') || 
              headerText.toLowerCase().includes('tp / sl') || 
              headerText.toLowerCase().includes('tpsl') ||
              headerText === 'TP / SL' ||
              headerText === 'TP/SL'
            )) {
              tpSlColumnIndex = i;
              console.log(`Found TP/SL column at index ${i}: "${headerText}"`);
              break;
            }
          }
          
          if (tpSlColumnIndex === -1) {
            console.log(`  Table ${tableIdx + 1}: TP/SL column not found in headers`);
            continue;
          }
          
          // Find data rows
          const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
          
          // Find first data row and click the cell in TP/SL column
          for (const row of dataRows) {
            const cells = Array.from(row.querySelectorAll('td, th'));
            if (cells.length > tpSlColumnIndex) {
              const tpSlCell = cells[tpSlColumnIndex];
              
              // Look for any clickable element in this cell first
              const clickableElements = tpSlCell.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"], a, div, span, svg, [onclick], [class*="icon"], [class*="Icon"]');
              
              for (const element of clickableElements) {
                if (element.offsetParent !== null || (element.offsetWidth > 0 && element.offsetHeight > 0)) {
                  element.click();
                  console.log(`Clicked clickable element in TP/SL column`);
                  return true;
                }
              }
              
              // If no clickable element found, click the cell itself
              if (tpSlCell.offsetParent !== null) {
                tpSlCell.click();
                console.log(`Clicked TP/SL column cell directly`);
                return true;
              }
            }
          }
        }
        
        return false;
      });
      
      if (!clicked) {
        console.log(`[${exchange.name}] ⚠️  Could not find or click column under "TP / SL" header`);
        return { success: false, message: "TP/SL column not found or not clickable" };
      }
      
      console.log(`[${exchange.name}] ✅ Successfully clicked column under "TP / SL" header`);
      console.log(`[${exchange.name}] Waiting for modal to appear...`);
      
      // Simple: Wait for ANY modal to appear after clicking TP/SL button
      let modalFound = false;
      const maxModalWaitAttempts = 10;
      let modalWaitAttempt = 0;
      
      while (!modalFound && modalWaitAttempt < maxModalWaitAttempts) {
        modalWaitAttempt++;
        await delay(300); // Wait 500ms between checks
        
        const modalCheck = await page.evaluate(() => {
          // Find ANY visible modal/dialog
          const allModals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="Dialog"], [class*="overlay"], [class*="Overlay"]'));
          
          for (const m of allModals) {
            const style = window.getComputedStyle(m);
            const isVisible = (m.offsetParent !== null || (m.offsetWidth > 0 && m.offsetHeight > 0)) &&
                             style.display !== 'none' &&
                             style.visibility !== 'hidden' &&
                             style.opacity !== '0';
            if (isVisible) {
              return true; // Found any visible modal
            }
          }
          return false; // No modal found yet
        });
        
        if (modalCheck) {
          modalFound = true;
          console.log(`[${exchange.name}] ✅ Modal appeared! (waited ${modalWaitAttempt * 500}ms)`);
          break;
        } else {
          if (modalWaitAttempt < maxModalWaitAttempts) {
            console.log(`[${exchange.name}] ⏳ No modal visible yet (attempt ${modalWaitAttempt}/${maxModalWaitAttempts}), waiting...`);
          }
        }
      }
      
      if (!modalFound) {
        console.log(`[${exchange.name}] ⚠️  Modal did not appear after ${maxModalWaitAttempts * 500}ms`);
        return { success: false, message: "Modal did not appear" };
      }
      
      // Wait a bit more for modal to be fully rendered
      await delay(500);
      
      // Step 3: Fill STOP_LOSS value in the modal
      const stopLossValue = process.env.STOP_LOSS || '';
      if (!stopLossValue) {
        console.log(`[${exchange.name}] ⚠️  STOP_LOSS env variable not set, skipping TP/SL fill`);
        return { success: false, message: "STOP_LOSS not set" };
      }
      
      console.log(`[${exchange.name}] Step 3: Finding modal and Stop Loss input...`);
      
      // Find the modal - just get the first visible modal
      const modalHandle = await page.evaluateHandle(() => {
        const allModals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="Dialog"], [class*="overlay"], [class*="Overlay"]'));
        
        for (const m of allModals) {
          const style = window.getComputedStyle(m);
          const isVisible = (m.offsetParent !== null || (m.offsetWidth > 0 && m.offsetHeight > 0)) &&
                           style.display !== 'none' &&
                           style.visibility !== 'hidden' &&
                           style.opacity !== '0';
          if (isVisible) {
            return m; // Return first visible modal
          }
        }
        return null;
      });
      
      if (!modalHandle || !modalHandle.asElement()) {
        console.log(`[${exchange.name}] ⚠️  Could not find modal`);
        return { success: false, message: "Modal not found" };
      }
      
      console.log(`[${exchange.name}] ✅ Found modal - using same modal for input and submit button`);
      
      // Find the Stop Loss input within the SAME modal - with retry logic
      let slInputHandle = null;
      const maxInputFindAttempts = 5;
      let inputFindAttempt = 0;
      
      while (!slInputHandle && inputFindAttempt < maxInputFindAttempts) {
        inputFindAttempt++;
        console.log(`[${exchange.name}] Attempt ${inputFindAttempt}/${maxInputFindAttempts}: Looking for Stop Loss input in modal...`);
        
        slInputHandle = await page.evaluateHandle((modal) => {
          if (!modal) return null;
          
          // Find all inputs in modal
          const inputs = Array.from(modal.querySelectorAll('input'));
          console.log(`Found ${inputs.length} inputs in modal`);
          
          // Log all inputs for debugging
          inputs.forEach((input, idx) => {
            const parentText = input.parentElement?.textContent || '';
            const nearbyText = parentText + ' ' + (input.previousElementSibling?.textContent || '') + ' ' + (input.nextElementSibling?.textContent || '');
            console.log(`  Input ${idx}: value="${input.value}", placeholder="${input.placeholder}", nearby text: "${nearbyText.substring(0, 50)}..."`);
          });
          
          // Find input with "Loss" and "%" in nearby text (Paradex-specific)
          for (const input of inputs) {
            const parentText = input.parentElement?.textContent || '';
            const nearbyText = parentText + ' ' + (input.previousElementSibling?.textContent || '') + ' ' + (input.nextElementSibling?.textContent || '');
            
            // Look for input near "Loss" label with "%" dropdown
            if (nearbyText.includes('Loss') && nearbyText.includes('%') && !nearbyText.includes('USD')) {
              console.log(`Found Stop Loss input with nearby text: "${nearbyText.substring(0, 100)}..."`);
              return input;
            }
          }
          return null;
        }, modalHandle.asElement());
        
        if (!slInputHandle || !slInputHandle.asElement()) {
          if (inputFindAttempt < maxInputFindAttempts) {
            console.log(`[${exchange.name}] ⚠️  Stop Loss input not found (attempt ${inputFindAttempt}), waiting 1 second before retry...`);
            await delay(300);
          }
        } else {
          console.log(`[${exchange.name}] ✅ Found Stop Loss input! (attempt ${inputFindAttempt})`);
        }
      }
      
      if (slInputHandle && slInputHandle.asElement()) {
        try {
          const inputElement = slInputHandle.asElement();
          
          // Focus and select all text (DOM-level, minimize-safe)
          await page.evaluate(el => { el.focus(); el.select(); }, inputElement);
          await page.keyboard.press('Backspace'); // Clear selected text
          await page.evaluate(el => el.focus(), inputElement); // Re-focus after clear
          await page.keyboard.type(stopLossValue, { delay: 30 }); // Use exact string value from env
          await page.keyboard.press('Tab'); // Trigger blur to calculate USD
          await delay(200);
          console.log(`[${exchange.name}] ✅ Successfully filled Stop Loss percentage`);
          
          // NOTE: Don't press Enter - it might close the modal or trigger unwanted actions
          // Instead, just ensure the value is set and proceed to click Confirm button
          console.log(`[${exchange.name}] Value filled - proceeding to Confirm button (not pressing Enter to avoid closing modal)`);
          
          // Verify the value was actually set in the input
          const actualValue = await inputElement.evaluate(el => el.value);
          console.log(`[${exchange.name}] Verified input value: "${actualValue}" (expected: "${stopLossValue}")`);
          if (actualValue !== stopLossValue && !actualValue.includes(stopLossValue)) {
            console.log(`[${exchange.name}] ⚠️  Warning: Input value doesn't match expected value!`);
          }
          
          // Wait for USD calculation
          await delay(400);
        } catch (error) {
          console.log(`[${exchange.name}] ⚠️  Error filling Stop Loss input: ${error.message}`);
          return { success: false, message: `Error filling input: ${error.message}` };
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Could not find Stop Loss input in modal`);
        return { success: false, message: "Stop Loss input not found" };
      }
      
      // Step 4: Click Submit/Confirm button in the SAME modal we used for the input
      console.log(`[${exchange.name}] Step 4: Looking for Submit/Confirm button in the SAME modal...`);
      await delay(1000); // Wait a bit longer to ensure modal is ready after value entry
      
      // Verify modal is still available before proceeding
      const modalStillValid = await page.evaluate((modal) => {
        if (!modal) return false;
        const style = window.getComputedStyle(modal);
        return modal.offsetParent !== null && 
               style.display !== 'none' && 
               style.visibility !== 'hidden';
      }, modalHandle.asElement());
      
      if (!modalStillValid) {
        console.log(`[${exchange.name}] ⚠️  Modal is no longer valid, trying to find it again...`);
        // Try to find modal again
        const newModalHandle = await page.evaluateHandle(() => {
          const allModals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="Dialog"], [class*="overlay"], [class*="Overlay"]'));
          for (const m of allModals) {
            const style = window.getComputedStyle(m);
            const isVisible = (m.offsetParent !== null || (m.offsetWidth > 0 && m.offsetHeight > 0)) &&
                             style.display !== 'none' &&
                             style.visibility !== 'hidden' &&
                             style.opacity !== '0';
            if (isVisible) {
              return m;
            }
          }
          return null;
        });
        
        if (newModalHandle && newModalHandle.asElement()) {
          modalHandle = newModalHandle;
          console.log(`[${exchange.name}] ✅ Found modal again`);
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not find modal again`);
          return { success: false, message: "Modal lost after entering value" };
        }
      }
      
      let submitClicked = false;
      
      // Use the SAME modal reference to find Submit button
      const submitResult = await page.evaluate((modal) => {
        if (!modal) {
          return { found: false, reason: 'Modal reference lost' };
        }
        
        // Verify modal is still visible
        const style = window.getComputedStyle(modal);
        const isVisible = modal.offsetParent !== null && 
                         style.display !== 'none' && 
                         style.visibility !== 'hidden';
        if (!isVisible) {
          return { found: false, reason: 'Modal no longer visible' };
        }
        
        // Find all buttons in the SAME modal
        const allButtons = Array.from(modal.querySelectorAll('button'));
        console.log(`Found ${allButtons.length} buttons in modal`);
        
        // Filter to only visible buttons
        const visibleButtons = allButtons.filter(btn => {
          const isVisible = btn.offsetParent !== null || (btn.offsetWidth > 0 && btn.offsetHeight > 0);
          const isDisabled = btn.disabled || btn.getAttribute('disabled') !== null;
          return isVisible && !isDisabled;
        });
        
        console.log(`Found ${visibleButtons.length} visible, enabled buttons in modal`);
        
        // Log all buttons for debugging
        visibleButtons.forEach((btn, idx) => {
          const text = btn.textContent?.trim();
          console.log(`  Button ${idx}: "${text}"`);
        });
        
        // Simple: Get the LAST button in the modal - that's the Confirm button
        if (visibleButtons.length > 0) {
          const submitBtn = visibleButtons[visibleButtons.length - 1]; // Last button
          const buttonText = submitBtn.textContent?.trim();
          
          console.log(`Found last button (Confirm): "${buttonText}"`);
          submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Trigger multiple events to ensure click is registered
          submitBtn.focus();
          submitBtn.click();
          
          // Also trigger mouse events
          const mouseEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          submitBtn.dispatchEvent(mouseEvent);
          
          console.log('Clicked last button (Confirm)');
          return { found: true, buttonText: buttonText };
        }
        
        console.log('No visible buttons found in modal');
        return { found: false, reason: 'No visible buttons found', buttonCount: allButtons.length };
      }, modalHandle.asElement());
      
      if (submitResult.found) {
        submitClicked = true;
        console.log(`[${exchange.name}] ✅ Successfully clicked Submit button: "${submitResult.buttonText}"`);
      } else {
        console.log(`[${exchange.name}] ⚠️  Failed to find Submit button: ${submitResult.reason || 'unknown'}`);
      }
      
      if (submitClicked) {
        console.log(`[${exchange.name}] ✅ Successfully clicked Submit button`);
        console.log(`[${exchange.name}] Waiting 2-3 seconds, then verifying TP/SL was added to table...`);
        await delay(900); // Wait 2.5 seconds after submitting
        
        // CRITICAL: Verify TP/SL was actually added to the table
        console.log(`[${exchange.name}] 🔍 Verifying TP/SL value is set in Positions table...`);
        let tpSlAddedToTable = false;
        const maxVerificationAttempts = 10; // Try up to 10 times
        
        for (let i = 0; i < maxVerificationAttempts; i++) {
          await delay(400); // Wait 1 second between checks
          tpSlAddedToTable = await page.evaluate((stopLossValue) => {
            // Find all tables
            const tables = Array.from(document.querySelectorAll('table'));
            
            for (const table of tables) {
              // Find header row to locate TP/SL column
              const headerRow = table.querySelector('thead tr, thead > tr, tr:first-child');
              if (!headerRow) continue;
              
              const headers = Array.from(headerRow.querySelectorAll('th, td'));
              let tpSlColumnIndex = -1;
              
              // Find TP/SL column
              for (let j = 0; j < headers.length; j++) {
                const headerText = headers[j].textContent?.trim().toLowerCase();
                if (headerText && (headerText.includes('tp/sl') || headerText.includes('tp / sl') || headerText.includes('tpsl'))) {
                  tpSlColumnIndex = j;
                  break;
                }
              }
              
              if (tpSlColumnIndex === -1) continue;
              
              // Check data rows for TP/SL value
              const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
              for (const row of dataRows) {
                const cells = Array.from(row.querySelectorAll('td, th'));
                if (cells.length > tpSlColumnIndex) {
                  const tpSlCell = cells[tpSlColumnIndex];
                  const cellText = tpSlCell.textContent || '';
                  
                  // Check if TP/SL value is present (could be percentage or formatted text)
                  if (cellText.includes(stopLossValue) || 
                      (cellText.trim() !== '' && cellText.trim() !== '-' && !cellText.toLowerCase().includes('add'))) {
                    console.log(`Found TP/SL value in table: "${cellText.trim()}"`);
                    return true; // TP/SL is in the table
                  }
                }
              }
            }
            
            return false; // TP/SL not found in table
          }, stopLossValue);
          
          if (tpSlAddedToTable) {
            console.log(`[${exchange.name}] ✅ TP/SL value confirmed in table! (check ${i + 1}/${maxVerificationAttempts})`);
            break;
          } else {
            if (i < maxVerificationAttempts - 1) {
              console.log(`[${exchange.name}] ⏳ TP/SL not yet in table (check ${i + 1}/${maxVerificationAttempts}), waiting...`);
            }
          }
        }
        
        if (!tpSlAddedToTable) {
          console.log(`[${exchange.name}] ⚠️  TP/SL value not found in table after ${maxVerificationAttempts} checks`);
          console.log(`[${exchange.name}] ⚠️  Confirm button was clicked but TP/SL may not have been saved`);
          return { success: false, message: "TP/SL not confirmed in table after clicking Confirm" };
        }
        
        console.log(`[${exchange.name}] ✅ TP/SL flow completed successfully - value confirmed in table!`);
        return { success: true, message: "TP/SL added successfully and confirmed in table" };
      } else {
        console.log(`[${exchange.name}] ⚠️  Failed to click Submit button`);
        return { success: false, message: "Submit button not clicked" };
      }
      
    } catch (error) {
      console.log(`[${exchange.name}] ⚠️  Error in TP/SL flow: ${error.message}`);
      return { success: false, message: error.message };
    }
  }
  
  async function clickTpSlCheckboxForParadex(page) {
    try {
      console.log(`[Paradex] Looking for TP/SL checkbox in right 50% of screen...`);
      
      const result = await page.evaluate(() => {
        const screenWidth = window.innerWidth;
        const rightSideThreshold = screenWidth * 0.5; // Right 50% of screen
        
        // Find all labels that contain "TP/SL" text
        const labels = Array.from(document.querySelectorAll('label'));
        
        for (const label of labels) {
          const labelText = label.textContent?.trim() || '';
          
          // Check if label contains "TP/SL" text (case-insensitive)
          if (labelText.toLowerCase().includes('tp/sl') || labelText.toLowerCase().includes('tp / sl')) {
            // Get label position
            const rect = label.getBoundingClientRect();

            // Check if label is in the right 50% of screen
            // Fallback: when minimized, getBoundingClientRect returns all zeros — skip position check
            const isMinimized = rect.width === 0 && rect.height === 0;
            if (isMinimized || rect.x >= rightSideThreshold) {
              // Find the button with role="checkbox" inside this label
              const checkboxButton = label.querySelector('button[role="checkbox"]');

              if (checkboxButton) {
                // Check if it's visible and not disabled
                // Fallback: use offsetParent !== null when width/height are 0 (minimized browser)
                const isVisible = checkboxButton.offsetParent !== null ||
                                 (checkboxButton.offsetWidth > 0 && checkboxButton.offsetHeight > 0);

                if (isVisible) {
                  // Check current state
                  const isChecked = checkboxButton.getAttribute('aria-checked') === 'true' ||
                                   checkboxButton.getAttribute('data-state') === 'checked';
                  
                  // Click the checkbox button
                  checkboxButton.click();
                  console.log(`Found and clicked TP/SL checkbox. Was ${isChecked ? 'checked' : 'unchecked'}, now ${isChecked ? 'unchecked' : 'checked'}`);
                  return { success: true, wasChecked: isChecked };
                }
              }
            }
          }
        }
        
        return { success: false, error: 'TP/SL checkbox not found in right 50% of screen' };
      });
      
      if (result.success) {
        console.log(`[Paradex] ✅ Successfully clicked TP/SL checkbox`);
        await delay(300); // Brief delay after clicking
        return { success: true };
      } else {
        console.log(`[Paradex] ⚠️  ${result.error || 'Could not find TP/SL checkbox'}`);
        return { success: false, error: result.error };
      }
    } catch (error) {
      console.log(`[Paradex] ⚠️  Error clicking TP/SL checkbox: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
  
  // Function to fill Take Profit and Stop Loss values for Paradex
  async function fillTpSlValuesForParadex(page) {
    try {
      const takeProfitValue = process.env.TAKE_PROFIT || '';
      const stopLossValue = process.env.STOP_LOSS || '';
      
      if (!takeProfitValue && !stopLossValue) {
        console.log(`[Paradex] ⚠️  TAKE_PROFIT and STOP_LOSS env variables not set, skipping TP/SL fill`);
        return { success: false, error: 'TAKE_PROFIT and STOP_LOSS not set' };
      }
      
      console.log(`[Paradex] Filling TP/SL values - Take Profit: ${takeProfitValue || 'not set'}, Stop Loss: ${stopLossValue || 'not set'}`);
      
      let profitFilled = false;
      let lossFilled = false;
      const errors = [];
      
      // First, fill Take Profit (Profit input)
      if (takeProfitValue) {
        try {
          // Find Profit input by aria-label using Puppeteer
          const profitInputs = await page.$$('input[aria-label="Profit"]');
          
          for (const input of profitInputs) {
            const isVisible = await input.evaluate(el => {
              return el.offsetParent !== null && !el.disabled && !el.readOnly;
            });
            
            if (isVisible) {
              // Focus and select all existing text (DOM-level, minimize-safe)
              await page.evaluate(el => { el.focus(); el.select(); }, input);
              await delay(100);

              // Clear the selected text
              await page.keyboard.press('Backspace');
              await delay(50);

              // Type the value
              await page.evaluate(el => el.focus(), input); // Re-focus after clear
              await page.keyboard.type(takeProfitValue, { delay: 50 });
              await delay(100);
              
              profitFilled = true;
              console.log(`[Paradex] ✅ Filled Profit input with value: ${takeProfitValue}`);
              break;
            }
          }
          
          if (!profitFilled) {
            errors.push('Profit input not found or not visible');
          }
        } catch (error) {
          console.log(`[Paradex] ⚠️  Error filling Profit input: ${error.message}`);
          errors.push(`Profit input error: ${error.message}`);
        }
      }
      
      // Wait 50ms before filling Stop Loss
      if (takeProfitValue && profitFilled) {
        await delay(50);
      }
      
      // Then, fill Stop Loss (Loss input)
      if (stopLossValue) {
        try {
          // Find Loss input by aria-label using Puppeteer
          const lossInputs = await page.$$('input[aria-label="Loss"]');
          
          for (const input of lossInputs) {
            const isVisible = await input.evaluate(el => {
              return el.offsetParent !== null && !el.disabled && !el.readOnly;
            });
            
            if (isVisible) {
              // Focus and select all existing text (DOM-level, minimize-safe)
              await page.evaluate(el => { el.focus(); el.select(); }, input);
              await delay(100);

              // Clear the selected text
              await page.keyboard.press('Backspace');
              await delay(50);

              // Type the value
              await page.evaluate(el => el.focus(), input); // Re-focus after clear
              await page.keyboard.type(stopLossValue, { delay: 50 });
              await delay(100);
              
              lossFilled = true;
              console.log(`[Paradex] ✅ Filled Loss input with value: ${stopLossValue}`);
              break;
            }
          }
          
          if (!lossFilled) {
            errors.push('Loss input not found or not visible');
          }
        } catch (error) {
          console.log(`[Paradex] ⚠️  Error filling Loss input: ${error.message}`);
          errors.push(`Loss input error: ${error.message}`);
        }
      }
      
      const success = (takeProfitValue ? profitFilled : true) && (stopLossValue ? lossFilled : true);
      
      if (success) {
        const filled = [];
        if (profitFilled) filled.push('Profit');
        if (lossFilled) filled.push('Loss');
        console.log(`[Paradex] ✅ Successfully filled TP/SL values: ${filled.join(', ')}`);
        return { success: true, profitFilled, lossFilled };
      } else {
        const errorMsg = errors.length > 0 ? errors.join(', ') : 'Could not fill TP/SL values';
        console.log(`[Paradex] ⚠️  ${errorMsg}`);
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      console.log(`[Paradex] ⚠️  Error filling TP/SL values: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Sets up click listener for TP/SL add button
   * Monitors for clicks on button with aria-label="Add tpsl order"
   */
  async function setupTpSlAddButtonListener(page, email) {
    console.log(`[${email}] Setting up TP/SL add button click listener and auto-click...`);
  
    // Set up click listener on current page
    const setupOnPage = async () => {
      await page.evaluate(() => {
        // Remove existing listener to avoid duplicates
        if (window._tpslClickHandler) {
          document.removeEventListener('click', window._tpslClickHandler, true);
        }
        
        // Remove existing observer to avoid duplicates
        if (window._tpslObserver) {
          window._tpslObserver.disconnect();
        }
  
        // Create click handler
        window._tpslClickHandler = (event) => {
          const button = event.target.closest('button');
          if (button) {
            const ariaLabel = button.getAttribute('aria-label') || '';
            const buttonText = button.textContent?.trim() || '';
            
            // Debug: log all button clicks (remove this later)
            if (ariaLabel.toLowerCase().includes('tpsl') || buttonText.includes('Add')) {
              console.log('[Button Click Debug ---]', {
                ariaLabel: ariaLabel,
                text: buttonText,
                tag: button.tagName
              });
            }
            
            // Check if this is our target button
            if (ariaLabel && (ariaLabel.includes('Add tpsl') || ariaLabel.includes('add tpsl'))) {
              console.log('[TP/SL Add Button Clicked]', ariaLabel);
            }
          }
        };
  
        // Attach listener with capture phase
        document.addEventListener('click', window._tpslClickHandler, true);
        console.log('[TP/SL Listener] Click listener attached to document');
        
        // Track clicked buttons to avoid re-clicking
        window._tpslClickedButtons = window._tpslClickedButtons || new Set();
        
        // Function to find and auto-click TP/SL button
        const findAndClickTpSlButton = () => {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const button of buttons) {
            const ariaLabel = button.getAttribute('aria-label') || '';
            if (ariaLabel && (ariaLabel.includes('Add tpsl') || ariaLabel.includes('add tpsl'))) {
              // Check if button is visible
              const style = window.getComputedStyle(button);
              const isVisible = button.offsetParent !== null &&
                              style.display !== 'none' &&
                              style.visibility !== 'hidden' &&
                              !button.disabled;
              
              if (isVisible) {
                // Create unique identifier for this button instance
                const buttonId = `${ariaLabel}-${button.offsetTop}-${button.offsetLeft}`;
                
                // Check if we've already clicked this button instance
                if (!window._tpslClickedButtons.has(buttonId)) {
                  console.log('[TP/SL Auto-Click] Button found and visible, auto-clicking...', ariaLabel);
                  window._tpslClickedButtons.add(buttonId);
                  
                  // Click the button
                  button.click();
                  console.log('[TP/SL Add Button Clicked]', ariaLabel);
                  
                  // Clean up old button IDs after 10 seconds (in case button moves)
                  setTimeout(() => {
                    window._tpslClickedButtons.delete(buttonId);
                  }, 10000);
                  
                  return true;
                }
              }
            }
          }
          return false;
        };
        
        // Initial check for existing button
        findAndClickTpSlButton();
        
        // Set up MutationObserver to watch for button appearance
        window._tpslObserver = new MutationObserver((mutations) => {
          // Check if button appeared
          findAndClickTpSlButton();
        });
        
        // Start observing
        window._tpslObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'aria-label']
        });
        
        console.log('[TP/SL Listener] MutationObserver set up for auto-click');
        
        // Also check periodically (as backup)
        if (window._tpslCheckInterval) {
          clearInterval(window._tpslCheckInterval);
        }
        window._tpslCheckInterval = setInterval(() => {
          findAndClickTpSlButton();
        }, 2000); // Check every 2 seconds
      });
    };
  
    // Set up on new documents
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (button) {
          const ariaLabel = button.getAttribute('aria-label') || '';
          if (ariaLabel && (ariaLabel.includes('Add tpsl') || ariaLabel.includes('add tpsl'))) {
            console.log('[TP/SL Add Button Clicked]', ariaLabel);
          }
        }
      }, true);
    });
  
    // Set up on current page
    await delay(2000);
    await setupOnPage();
  
    // Re-setup after navigation
    page.on('framenavigated', async () => {
      await delay(1000);
      await setupOnPage();
    });
  
    // Listen for ALL console messages for debugging
    page.on('console', async (msg) => {
      const text = msg.text();
      
      // Log all console messages for debugging (you can remove this later)
      if (text.includes('Button Click') || text.includes('TP/SL') || text.includes('Listener')) {
        console.log(`[${email}] [Browser Console] ${text}`);
      }
      
      if (text.includes('[TP/SL Add Button Clicked]')) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[${email}] 🎯 TP/SL ADD BUTTON CLICKED!`);
        console.log(`${'='.repeat(60)}`);
        console.log(`Message: ${text}`);
        console.log(`${'='.repeat(60)}\n`);
        // Perform your action here
        await handleTpSlAddButtonClick(page, email);
      }
    });
  
    // Test: Check if button exists on page
    await delay(1000);
    const buttonExists = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const tpslButtons = buttons.filter(btn => {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        return ariaLabel.includes('Add tpsl') || ariaLabel.includes('add tpsl');
      });
      return {
        found: tpslButtons.length > 0,
        count: tpslButtons.length,
        ariaLabels: tpslButtons.map(btn => btn.getAttribute('aria-label'))
      };
    });
    
    if (buttonExists.found) {
      console.log(`[${email}] ✓ Found ${buttonExists.count} TP/SL button(s) on page`);
      console.log(`[${email}] Button aria-labels:`, buttonExists.ariaLabels);
    } else {
      console.log(`[${email}] ⚠ TP/SL button not found on current page (may appear later)`);
    }
  
    console.log(`[${email}] ✓ TP/SL add button listener set up`);
    console.log(`[${email}] ✓ Auto-click enabled - button will be clicked automatically when it appears`);
    console.log(`[${email}] Debug: All button clicks with 'tpsl' or 'Add' will be logged`);
    
    // Also check for button immediately and periodically from Node.js side (backup)
    const checkAndClickButton = async () => {
      try {
        const buttonInfo = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const button of buttons) {
            const ariaLabel = button.getAttribute('aria-label') || '';
            if (ariaLabel && (ariaLabel.includes('Add tpsl') || ariaLabel.includes('add tpsl'))) {
              const style = window.getComputedStyle(button);
              const isVisible = button.offsetParent !== null &&
                              style.display !== 'none' &&
                              style.visibility !== 'hidden' &&
                              !button.disabled;
              
              if (isVisible) {
                return { found: true, ariaLabel };
              }
            }
          }
          return { found: false };
        });
        
        if (buttonInfo.found) {
          console.log(`[${email}] 🔍 TP/SL button detected, clicking automatically...`);
          const clicked = await page.evaluate((ariaLabel) => {
            const buttons = Array.from(document.querySelectorAll('button'));
            for (const button of buttons) {
              if (button.getAttribute('aria-label') === ariaLabel) {
                const style = window.getComputedStyle(button);
                const isVisible = button.offsetParent !== null &&
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                !button.disabled;
                if (isVisible) {
                  button.click();
                  return true;
                }
              }
            }
            return false;
          }, buttonInfo.ariaLabel);
          
          if (clicked) {
            console.log(`[${email}] ✓ TP/SL button auto-clicked from Node.js side`);
            // Trigger handler after a short delay
            await delay(500);
            await handleTpSlAddButtonClick(page, email);
          }
        }
      } catch (error) {
        // Silently handle errors (button might not exist yet)
      }
    };
    
    // Check immediately
    await checkAndClickButton();
    
    // Check periodically (every 3 seconds) as backup
    const checkInterval = setInterval(async () => {
     await checkAndClickButton();
    }, 3000);
    
    // Store interval ID so it can be cleared if needed
    if (!page._tpslCheckInterval) {
      page._tpslCheckInterval = checkInterval;
    }
  }

  /**
 * Handler function - perform actions when TP/SL add button is clicked
 * Fills the modal with TP/SL values from environment variables
 */
// Helper function to check if TP/SL modal is still open
async function isTpSlModalOpen(page) {
    return await page.evaluate(() => {
      const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"]'));
      for (const modal of modals) {
        const style = window.getComputedStyle(modal);
        const isVisible = modal.offsetParent !== null && 
                         style.display !== 'none' && 
                         style.visibility !== 'hidden';
        if (isVisible) {
          const text = modal.textContent || '';
          if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) {
            return true;
          }
        }
      }
      return false;
    });
  }
  
  async function handleTpSlAddButtonClick(page, email) {
    // Prevent multiple executions
    const lockKey = `${email}-tpsl-handler`;
    if (handlerLocks.get(lockKey)) {
      console.log(`[${email}] Handler already running, skipping...`);
      return;
    }
    handlerLocks.set(lockKey, true);
    
    try {
      console.log(`[${email}] Handling TP/SL modal - filling Stop Loss only...`);
      
      // Get Stop Loss percentage value from environment variables
      // Take Profit is NOT filled - only Stop Loss for both BUY and SELL
      const stopLossPercentStr = process.env.STOP_LOSS || '';
      const stopLossPercent = stopLossPercentStr ? parseFloat(stopLossPercentStr) : null;
      
      if (!stopLossPercent) {
        console.log(`[${email}] ⚠ No STOP_LOSS value configured in env`);
        handlerLocks.set(lockKey, false);
        return;
      }
      
      console.log(`[${email}] Stop Loss Value: SL=${stopLossPercent}% (from env: "${stopLossPercentStr}")`);
      
      // Use the exact value from env - Paradex UI accepts decimals in percentage input
      // The bot should type exactly what's in the env file, no conversion needed
      let valueToType = stopLossPercentStr;
      
      console.log(`[${email}] Will type exact value from env: "${valueToType}"`);
      console.log(`[${email}] Note: Paradex UI accepts decimals in percentage input, so using env value as-is`);
    
    // Wait for modal to appear - check specifically for TP/SL modal
    console.log(`[${email}] Waiting for TP/SL modal to appear...`);
    let modal = null;
    for (let i = 0; i < 10; i++) {
      const modalCheck = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="Dialog"]'));
        for (const m of modals) {
          const style = window.getComputedStyle(m);
          const isVisible = m.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden';
          if (isVisible) {
            const text = m.textContent || '';
            if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss') || text.includes('Edit TP/SL')) {
              return true;
            }
          }
        }
        return false;
      });
      
      if (modalCheck) {
        modal = await page.$('[class*="modal"], [role="dialog"]');
        console.log(`[${email}] ✓ TP/SL modal appeared (attempt ${i + 1})`);
        break;
      }
      await delay(300); // Faster checks
    }
    
    if (!modal) {
      console.log(`[${email}] ⚠ TP/SL modal did not appear`);
      handlerLocks.set(lockKey, false);
      return;
    }
    
    await delay(500); // Reduced wait for modal content to load
    
    // Check if modal is still open
    if (!(await isTpSlModalOpen(page))) {
      console.log(`[${email}] ⚠ TP/SL modal closed before filling, exiting...`);
      handlerLocks.set(lockKey, false);
      return;
    }
    
    // Skip Take Profit - only fill Stop Loss for both BUY and SELL
    // Fill Stop Loss percentage
    if (stopLossPercent) {
      console.log(`[${email}] Filling Stop Loss percentage: ${stopLossPercent}%`);
      
      // Find the input element using evaluateHandle
      const slInputHandle = await page.evaluateHandle(() => {
        // Find TP/SL modal specifically
        const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"]'));
        let modal = null;
        for (const m of modals) {
          const style = window.getComputedStyle(m);
          const isVisible = m.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden';
          if (isVisible) {
            const text = m.textContent || '';
            if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) {
              modal = m;
              break;
            }
          }
        }
        
        if (!modal) return null;
        
        // Find all inputs in modal
        const inputs = Array.from(modal.querySelectorAll('input'));
        
        // Find input with "Loss" and "%" in nearby text
        for (const input of inputs) {
          const parentText = input.parentElement?.textContent || '';
          const nearbyText = parentText + ' ' + (input.previousElementSibling?.textContent || '') + ' ' + (input.nextElementSibling?.textContent || '');
          
          // Look for input near "Loss" label with "%" dropdown
          if (nearbyText.includes('Loss') && nearbyText.includes('%') && !nearbyText.includes('USD')) {
            return input;
          }
        }
        return null;
      });
      
      let slFilled = false;
      if (slInputHandle && slInputHandle.asElement()) {
        try {
          const inputElement = slInputHandle.asElement();
          
          // Focus and select all text (DOM-level, minimize-safe)
          await page.evaluate(el => { el.focus(); el.select(); }, inputElement);
          await page.keyboard.press('Backspace'); // Clear selected text
          await page.evaluate(el => el.focus(), inputElement); // Re-focus after clear
          await page.keyboard.type(stopLossPercentStr, { delay: 30 }); // Use exact string value from env
          await page.keyboard.press('Tab'); // Trigger blur to calculate USD
          await delay(300); // Reduced wait
          console.log(`[${email}] ✓ Stop Loss percentage filled using Puppeteer type`);
          slFilled = true;
          
          // Check if modal is still open
          if (!(await isTpSlModalOpen(page))) {
            console.log(`[${email}] ⚠ TP/SL modal closed after filling Stop Loss, exiting...`);
            handlerLocks.set(lockKey, false);
            return;
          }
        } catch (error) {
          console.log(`[${email}] ⚠ Error typing Stop Loss value:`, error.message);
        }
      } else {
        console.log(`[${email}] ⚠ Could not find Stop Loss percentage input`);
      }
      
      await delay(500);
    }
    
    // Check if modal is still open before waiting for USD
    if (!(await isTpSlModalOpen(page))) {
      console.log(`[${email}] ⚠ TP/SL modal closed before USD calculation, exiting...`);
      handlerLocks.set(lockKey, false);
      return;
    }
    
    // Wait for Stop Loss USD value to be calculated (only SL, not TP)
    console.log(`[${email}] Waiting for Stop Loss USD value to be calculated...`);
    await delay(1000); // Reduced initial wait
    
    // Check if Stop Loss USD value is calculated, wait more if needed
    let slUsdCalculated = false;
    for (let i = 0; i < 20; i++) { // More retries
      const debugInfo = await page.evaluate(() => {
        // Find TP/SL modal
        const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"]'));
        let modal = null;
        for (const m of modals) {
          const style = window.getComputedStyle(m);
          const isVisible = m.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden';
          if (isVisible) {
            const text = m.textContent || '';
            if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) {
              modal = m;
              break;
            }
          }
        }
        
        if (!modal) return { slCalculated: false, inputs: [] };
        
        const inputs = Array.from(modal.querySelectorAll('input'));
        const inputInfo = inputs.map(input => ({
          value: input.value,
          placeholder: input.placeholder,
          type: input.type,
          nearbyText: input.parentElement?.textContent?.substring(0, 100) || ''
        }));
        
        // Check for Stop Loss USD value only (Take Profit not filled)
        let slUsdFound = false;
        
        for (const input of inputs) {
          const value = input.value || '';
          const parentText = input.parentElement?.textContent || '';
          const cleanValue = value.replace(/[$,]/g, '');
          const numValue = parseFloat(cleanValue);
          
          // Check if this is a USD input (has decimals, is a number > 0.01)
          if (!isNaN(numValue) && numValue > 0.01 && cleanValue.includes('.')) {
            // Check if it's Stop Loss USD (has "Stop Loss" and "USD" nearby, not "%")
            if (parentText.includes('Stop Loss') && parentText.includes('USD') && !parentText.includes('Loss%')) {
              slUsdFound = true;
            }
          }
        }
        
        return { 
          slCalculated: slUsdFound,
          inputs: inputInfo 
        };
      });
      
      if (debugInfo.slCalculated) {
        slUsdCalculated = true;
        console.log(`[${email}] ✓ Stop Loss USD value calculated (attempt ${i + 1})`);
        break;
      }
      
      if (i === 3 || i === 7 || i === 12) {
        // Log debug info periodically
        console.log(`[${email}] Debug (attempt ${i + 1}) - SL: ${debugInfo.slCalculated}`);
        if (i === 7) {
          console.log(`[${email}] Debug - Input values:`, JSON.stringify(debugInfo.inputs, null, 2));
        }
      }
      
      await delay(500);
    }
    
    if (!slUsdCalculated) {
      console.log(`[${email}] ⚠ Stop Loss USD value not calculated yet, proceeding anyway...`);
    }
    
    // Check if TP/SL modal is still open (might be closed by leverage modal)
    if (!(await isTpSlModalOpen(page))) {
      console.log(`[${email}] ⚠ TP/SL modal closed (possibly by other bot feature), skipping USD update`);
      handlerLocks.set(lockKey, false);
      return;
    }
    
    // Remove decimals from Stop Loss USD value input (Take Profit not filled)
    console.log(`[${email}] Removing decimals from Stop Loss USD value input...`);
    const result = await page.evaluate(() => {
      // Find TP/SL modal specifically (not leverage modal)
      const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"]'));
      let modal = null;
      for (const m of modals) {
        const style = window.getComputedStyle(m);
        const isVisible = m.offsetParent !== null && 
                         style.display !== 'none' && 
                         style.visibility !== 'hidden';
        if (isVisible) {
          const text = m.textContent || '';
          if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) {
            modal = m;
            break;
          }
        }
      }
      
      if (!modal) return { updated: 0, found: [], error: 'TP/SL modal not found' };
      
      let updated = 0;
      const found = [];
      
      // Find Stop Loss section only (Take Profit not filled)
      const allElements = Array.from(modal.querySelectorAll('*'));
      let slSection = null;
      
      // Find Stop Loss section
      for (const el of allElements) {
        const text = el.textContent || '';
        if (text.includes('Stop Loss') && el.offsetParent !== null && !slSection) {
          slSection = el;
        }
      }
      
      // Process Stop Loss USD input - find input near "USD" button/dropdown
      if (slSection) {
        let container = slSection;
        for (let i = 0; i < 8; i++) {
          if (!container || !container.parentElement) break;
          container = container.parentElement;
        }
        
        if (!container) {
          return { updated, found, error: 'Stop Loss container not found' };
        }
        
        // Find "USD" text/label
        const allElements = Array.from(container.querySelectorAll('*'));
        let usdLabel = null;
        for (const el of allElements) {
          const text = el.textContent?.trim() || '';
          if (text === 'USD' && el.offsetParent !== null) {
            usdLabel = el;
            break;
          }
        }
        
        if (usdLabel) {
          // Find input near USD label
          let inputContainer = usdLabel;
          for (let i = 0; i < 5; i++) {
            inputContainer = inputContainer.parentElement;
            if (!inputContainer) break;
          }
          
          const inputs = Array.from(inputContainer.querySelectorAll('input'));
          for (const input of inputs) {
            const value = input.value || '';
            const parentText = input.parentElement?.textContent || '';
            
            // This is the USD input (has USD nearby, not %)
            if (parentText.includes('USD') && !parentText.includes('Profit%') && !parentText.includes('Loss%')) {
              const cleanValue = value.replace(/[$,]/g, '');
              const numValue = parseFloat(cleanValue);
              // Check if it has decimals and is a reasonable USD amount
              if (!isNaN(numValue) && numValue > 0.01 && cleanValue.includes('.')) {
                found.push({ type: 'Stop Loss', original: value, numValue });
                const intValue = Math.floor(numValue); // Remove decimal and everything after
                if (intValue !== numValue) { // Only update if it has decimals
                  input.focus();
                  input.click();
                  // Select all text to ensure we replace everything
                  input.select();
                  input.setSelectionRange(0, input.value.length);
                  // Clear and set as integer string (no decimal point, no commas)
                  input.value = '';
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  input.value = String(intValue); // Plain integer, no decimals
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  input.dispatchEvent(new Event('blur', { bubbles: true }));
                  // Also trigger keyup for React
                  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                  updated++;
                  break;
                }
              }
            }
          }
        }
      }
      
      // Fallback: If we didn't find both, try a simpler approach - find all inputs with USD values
      if (updated < 2) {
        const allInputs = Array.from(modal.querySelectorAll('input'));
        for (const input of allInputs) {
          const value = input.value || '';
          const parentText = input.parentElement?.textContent || '';
          const cleanValue = value.replace(/[$,]/g, '');
          const numValue = parseFloat(cleanValue);
          
          // Check if this is a USD input with decimals
          if (!isNaN(numValue) && numValue > 0.01 && cleanValue.includes('.')) {
            // Check if we already processed this one
            const alreadyProcessed = found.some(f => f.original === value);
            if (alreadyProcessed) continue;
            
            // Determine if it's TP or SL based on nearby text
            let type = 'Unknown';
            if (parentText.includes('Take Profit') && parentText.includes('USD') && !parentText.includes('Profit%')) {
              type = 'Take Profit';
            } else if (parentText.includes('Stop Loss') && parentText.includes('USD') && !parentText.includes('Loss%')) {
              type = 'Stop Loss';
            } else {
              // Skip if we can't determine the type
              continue;
            }
            
            const intValue = Math.floor(numValue); // Remove decimal and everything after
            if (intValue !== numValue) {
              found.push({ type, original: value, numValue });
              input.focus();
              input.click();
              // Select all text to ensure we replace everything
              input.select();
              input.setSelectionRange(0, input.value.length);
              // Clear and set as integer string (no decimal point, no commas)
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.value = String(intValue); // Plain integer, no decimals
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('blur', { bubbles: true }));
              // Also trigger keyup for React
              input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
              updated++;
            }
          }
        }
      }
      
      return { updated, found };
    });
    
      if (result.updated > 0) {
        console.log(`[${email}] ✓ Removed decimals from ${result.updated} USD input(s)`);
        console.log(`[${email}] Updated values:`, result.found);
      } else {
        console.log(`[${email}] ⚠ No USD inputs found to update`);
        if (result.found && result.found.length > 0) {
          console.log(`[${email}] Debug - Found inputs:`, result.found);
        }
        if (result.error) {
          console.log(`[${email}] Error: ${result.error}`);
        }
      }
      
      // Check if modal is still open before validation
      if (!(await isTpSlModalOpen(page))) {
        console.log(`[${email}] ⚠ TP/SL modal closed before validation, exiting...`);
        handlerLocks.set(lockKey, false);
        return;
      }
      
      await delay(300); // Reduced wait
      
      // Validate that USD values are calculated and there are no errors before confirming
      console.log(`[${email}] Validating form before confirming...`);
      const validation = await page.evaluate(() => {
        // Find TP/SL modal specifically
        const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"]'));
        let tpslModal = null;
        for (const m of modals) {
          const style = window.getComputedStyle(m);
          const isVisible = m.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden';
          if (isVisible) {
            const text = m.textContent || '';
            if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) {
              tpslModal = m;
              break;
            }
          }
        }
        
        if (!tpslModal) return { valid: false, error: 'Modal not found' };
        
        // Check for error messages
        const errorTexts = [
          'must be less than',
          'must be greater than',
          'invalid',
          'error',
          'required'
        ];
        const modalText = tpslModal.textContent || '';
        const hasError = errorTexts.some(errorText => 
          modalText.toLowerCase().includes(errorText.toLowerCase())
        );
        
        if (hasError) {
          // Find the error message
          const errorElements = Array.from(tpslModal.querySelectorAll('*'));
          const errorMsg = errorElements.find(el => {
            const text = el.textContent || '';
            return errorTexts.some(errorText => 
              text.toLowerCase().includes(errorText.toLowerCase())
            );
          });
          return { 
            valid: false, 
            error: errorMsg ? errorMsg.textContent.substring(0, 100) : 'Error message found' 
          };
        }
        
        // Check that Stop Loss USD input has value (Take Profit not required)
        const inputs = Array.from(tpslModal.querySelectorAll('input'));
        let slUsdHasValue = false;
        
        for (const input of inputs) {
          const value = input.value || '';
          const parentText = input.parentElement?.textContent || '';
          const cleanValue = value.replace(/[$,]/g, '');
          const numValue = parseFloat(cleanValue);
          
          if (!isNaN(numValue) && numValue > 0.01) {
            if (parentText.includes('Stop Loss') && parentText.includes('USD') && !parentText.includes('Loss%')) {
              slUsdHasValue = true;
            }
          }
        }
        
        return { 
          valid: slUsdHasValue, 
          slUsdHasValue,
          error: null 
        };
      });
      
      if (!validation.valid) {
        console.log(`[${email}] ⚠ Form validation failed:`, validation.error || `SL USD: ${validation.slUsdHasValue}`);
        console.log(`[${email}] ⚠ Not clicking Confirm - form has errors or Stop Loss USD value not ready`);
        handlerLocks.set(lockKey, false);
        return;
      }
      
      console.log(`[${email}] ✓ Form validated - Stop Loss USD value is ready, clicking Confirm...`);
      
      // CRITICAL: For TP/SL modal, ONLY click "Confirm" button - NEVER look for "close" button
      // The TP/SL modal should be submitted using "Confirm", not closed
      console.log(`[${email}] Clicking Confirm button in TP/SL modal (NOT looking for close button)...`);
      const confirmClicked = await page.evaluate(() => {
        // Find TP/SL modal specifically
        const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"]'));
        let tpslModal = null;
        for (const m of modals) {
          const style = window.getComputedStyle(m);
          const isVisible = m.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden';
          if (isVisible) {
            const text = m.textContent || '';
            if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) {
              tpslModal = m;
              break;
            }
          }
        }
        
        if (!tpslModal) {
          console.log('TP/SL modal not found');
          return false;
        }
        
        // ONLY look for "Confirm" button - NEVER look for "close" button in TP/SL modal
        const buttons = Array.from(tpslModal.querySelectorAll('button'));
        for (const btn of buttons) {
          const text = btn.textContent?.trim() || '';
          const isVisible = btn.offsetParent !== null || (btn.offsetWidth > 0 && btn.offsetHeight > 0);
          // Only click Confirm button - ignore any close/X buttons
          if (isVisible && (text === 'Confirm' || text.includes('Confirm'))) {
            btn.click();
            console.log(`Clicked Confirm button: "${text}"`);
            return true;
          }
        }
        console.log('Confirm button not found in TP/SL modal');
        return false;
      });
    
    if (confirmClicked) {
      console.log(`[${email}] ✓ Confirm button clicked`);
      // Add delay after TP/SL confirm button click for Paradex (especially for buy positions)
      console.log(`[${email}] Waiting after TP/SL confirm click...`);
      await delay(2000); // Wait 2 seconds after confirming TP/SL
      console.log(`[${email}] ✓ Delay completed after TP/SL confirm`);
    } else {
      console.log(`[${email}] ⚠ Confirm button not found`);
    }
    
    console.log(`[${email}] ✓ Stop Loss form completed`);
    } finally {
      // Release lock after 3 seconds
      setTimeout(() => {
        handlerLocks.set(lockKey, false);
      }, 3000);
    }
  }
  
  /**
   * Alternative approach: Direct function to click TP/SL add button and perform action
   * This is more reliable for automation - use this if you want to programmatically click the button
   */
  async function clickTpSlAddButtonAndPerformAction(page, email) {
    console.log(`[${email}] Looking for TP/SL add button...`);
    
    try {
      // Find the button using Puppeteer (same pattern as other bot functions)
      const button = await page.$('button[aria-label*="Add tpsl"], button[aria-label*="add tpsl"]');
      
      if (button) {
        console.log(`[${email}] Found TP/SL add button, clicking...`);
        await safeClick(page, button);
        console.log(`[${email}] ✓ TP/SL add button clicked`);
        
        // Perform your actions after click
        await handleTpSlAddButtonClick(page, email);
        
        return { success: true };
      } else {
        console.log(`[${email}] TP/SL add button not found`);
        return { success: false, error: 'Button not found' };
      }
    } catch (error) {
      console.error(`[${email}] Error clicking TP/SL button:`, error.message);
      return { success: false, error: error.message };
    }
  }

  
  export { clickTpSlAddButtonAndPerformAction, clickTpSlCheckboxForParadex, fillTpSlValuesForParadex, setupTpSlAddButtonListener, handleTpSlAddButtonClick, isTpSlModalOpen ,clickTpSlColumnInPositions};