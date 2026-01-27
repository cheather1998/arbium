import dotenv from 'dotenv';
import { delay } from '../utils/helpers.js';
import { findByText, findByExactText } from '../utils/helpers.js';
import { handleClosePositionsAndSetLeverage } from '../trading/positions.js';
import { handleSetLeverage } from '../trading/leverage.js';

// Ensure environment variables are loaded
dotenv.config();

// Click on Orders tab for Extended Exchange
async function clickOrdersTab(page, email, skipLeverage = false) {
    console.log(`[${email}] Looking for Orders tab...`);
    if (skipLeverage) {
      console.log(`[${email}] NOTE: Leverage setting will be skipped (already set or will be set later)`);
    }
    
    try {
      let ordersTabClicked = false;
      
      // Strategy 1: Find by exact text "Orders"
      const ordersTab = await findByExactText(page, "Orders", ["button", "div", "span", "a"]);
      if (ordersTab) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, ordersTab);
        if (isVisible) {
          await ordersTab.click();
          console.log(`[${email}] Clicked Orders tab (exact text)`);
          ordersTabClicked = true;
          await delay(300);
        }
      }
      
      // Strategy 2: Find by text containing "orders" (case insensitive)
      if (!ordersTabClicked) {
        const ordersTab2 = await findByText(page, "orders", ["button", "div", "span", "a"]);
        if (ordersTab2) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, ordersTab2);
          if (isVisible) {
            await ordersTab2.click();
            console.log(`[${email}] Clicked Orders tab (text search)`);
            ordersTabClicked = true;
            await delay(400);
          }
        }
      }
      
      // Strategy 3: Use evaluate to find Orders tab
      if (!ordersTabClicked) {
        const clicked = await page.evaluate(() => {
          // Look for tabs or navigation elements
          const allElements = Array.from(document.querySelectorAll('button, div[role="tab"], span[role="tab"], a[role="tab"], div, span, a'));
          for (const el of allElements) {
            const text = el.textContent?.trim();
            const isVisible = el.offsetParent !== null;
            if (isVisible && text && text.toLowerCase() === 'orders') {
              el.click();
              return true;
            }
          }
          return false;
        });
        
        if (clicked) {
          console.log(`[${email}] Clicked Orders tab (via evaluate)`);
          ordersTabClicked = true;
          await delay(300);
        }
      }
      
      if (!ordersTabClicked) {
        console.log(`[${email}] Orders tab not found`);
        return false;
      }
      
      // After clicking Orders tab, check for buttons in Orders tab
      console.log(`[${email}] Checking for buttons in Orders tab (Login, Connect Wallet, CANCEL ALL, Positions)...`);
      await delay(700); // Wait for Orders tab content to load
      
      // Step 1: Check for Login OR Connect Wallet button simultaneously (whichever found first)
      // This is more efficient than checking sequentially
      const authButtonResult = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
        
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase();
          const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
          
          if (!isVisible) continue;
          
          // Check for Login button first (priority)
          if (text === 'log in' || text === 'login') {
            btn.click();
            return { found: true, type: 'login', text: btn.textContent?.trim() };
          }
          
          // Check for Connect Wallet button
          if (text === 'connect wallet' || text.includes('connect wallet')) {
            btn.click();
            return { found: true, type: 'connectWallet', text: btn.textContent?.trim() };
          }
        }
        
        return { found: false };
      });
      
      if (authButtonResult.found) {
        if (authButtonResult.type === 'login') {
          console.log(`[${email}] Clicked ${authButtonResult.text} button in Orders tab`);
          console.log(`[${email}] Login button clicked, waiting for authentication...`);
          await delay(700);
          return ordersTabClicked;
        } else if (authButtonResult.type === 'connectWallet') {
          console.log(`[${email}] Clicked ${authButtonResult.text} button in Orders tab`);
          // Wait for modal to appear
          console.log(`[${email}] Connect Wallet button clicked, waiting for modal to appear...`);
          await delay(700);
          
          // Look for WalletConnect button in modal
          console.log(`[${email}] Looking for WalletConnect button in modal...`);
          const walletConnectClicked = await page.evaluate(() => {
            // Look for modal/dialog
            const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"]');
            if (!modal) return false;
            
            // Find WalletConnect button in modal
            const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"]'));
            for (const btn of buttons) {
              const text = btn.textContent?.trim();
              const isVisible = btn.offsetParent !== null;
              if (isVisible && text && (text.includes('WalletConnect') || text.includes('Wallet Connect'))) {
                btn.click();
                return true;
              }
            }
            return false;
          });
          
          if (walletConnectClicked) {
            console.log(`[${email}] Clicked WalletConnect button in modal`);
            console.log(`[${email}] WalletConnect button clicked, waiting for wallet connection...`);
            await delay(2000);
          } else {
            console.log(`[${email}] Could not find WalletConnect button in modal`);
            console.log(`[${email}] User will need to manually connect wallet`);
          }
        }
      } else {
        console.log(`[${email}] No Login or Connect Wallet button found in Orders tab`);
      }
      
      // Step 2: Check if there are open orders before looking for CANCEL ALL
      console.log(`[${email}] Checking for open orders in Orders tab...`);
      const hasOpenOrders = await page.evaluate(() => {
        // Find tables in Orders tab
        const tables = Array.from(document.querySelectorAll('table'));
        for (const table of tables) {
          const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
          // Check if there are any data rows (indicating open orders)
          if (dataRows.length > 0) {
            const rowsWithData = dataRows.filter(row => {
              const cells = Array.from(row.querySelectorAll('td, th'));
              return cells.length > 0 && row.offsetParent !== null;
            });
            return rowsWithData.length > 0;
          }
        }
        return false;
      });
      
      // Only check for CANCEL ALL if there are open orders
      let cancelAllClicked = false;
      if (hasOpenOrders) {
        console.log(`[${email}] Open orders detected, checking for CANCEL ALL button...`);
      
      // Strategy 1: Find by exact text "CANCEL ALL" or "Cancel All"
      const cancelAllBtn = await findByExactText(page, "CANCEL ALL", ["button", "div", "span", "a"]);
      if (cancelAllBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, cancelAllBtn);
        if (isVisible) {
          await cancelAllBtn.click();
          cancelAllClicked = true;
          console.log(`[${email}] Clicked CANCEL ALL button in Orders tab (exact text)`);
        }
      }
      
      if (!cancelAllClicked) {
        const cancelAllBtn2 = await findByExactText(page, "Cancel All", ["button", "div", "span", "a"]);
        if (cancelAllBtn2) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, cancelAllBtn2);
          if (isVisible) {
            await cancelAllBtn2.click();
            cancelAllClicked = true;
            console.log(`[${email}] Clicked Cancel All button in Orders tab (exact text)`);
          }
        }
      }
      
      // Strategy 2: Find by text containing "cancel all" (case insensitive)
      if (!cancelAllClicked) {
        const cancelAllBtn3 = await findByText(page, "cancel all", ["button", "div", "span", "a"]);
        if (cancelAllBtn3) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, cancelAllBtn3);
          if (isVisible) {
            await cancelAllBtn3.click();
            cancelAllClicked = true;
            console.log(`[${email}] Clicked Cancel All button in Orders tab (text search)`);
          }
        }
      }
      
      // Strategy 3: Use evaluate to find CANCEL ALL button
      if (!cancelAllClicked) {
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toLowerCase();
            const isVisible = btn.offsetParent !== null;
            if (isVisible && text && (
              text === 'cancel all' || 
              text === 'cancelall' ||
              text.includes('cancel all')
            )) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        
        if (clicked) {
          cancelAllClicked = true;
          console.log(`[${email}] Clicked Cancel All button in Orders tab (via evaluate)`);
        }
      }
      } else {
        console.log(`[${email}] No open orders found, skipping CANCEL ALL`);
      }
      
      // Step 3: Switch to Positions tab (either after CANCEL ALL or if no orders)
      let positionsTabClicked = false;
      if (cancelAllClicked) {
        // If CANCEL ALL was clicked, wait then switch to Positions
        console.log(`[${email}] Cancel All button clicked, waiting before clicking Positions tab...`);
        await delay(800); // Wait for cancel operation to complete
      }
      
      // Click on Positions tab
      console.log(`[${email}] Looking for Positions tab...`);
      
      // Strategy 1: Find by exact text "Positions"
      const positionsTab = await findByExactText(page, "Positions", ["button", "div", "span", "a"]);
      if (positionsTab) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, positionsTab);
        if (isVisible) {
          await positionsTab.click();
          positionsTabClicked = true;
          console.log(`[${email}] Clicked Positions tab (exact text)`);
        }
      }
      
      // Strategy 2: Find by text containing "positions" (case insensitive)
      if (!positionsTabClicked) {
        const positionsTab2 = await findByText(page, "positions", ["button", "div", "span", "a"]);
        if (positionsTab2) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, positionsTab2);
          if (isVisible) {
            await positionsTab2.click();
            positionsTabClicked = true;
            console.log(`[${email}] Clicked Positions tab (text search)`);
          }
        }
      }
      
      // Strategy 3: Use evaluate to find Positions tab
      if (!positionsTabClicked) {
        const clicked = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('button, div[role="tab"], span[role="tab"], a[role="tab"], div, span, a'));
          for (const el of allElements) {
            const text = el.textContent?.trim().toLowerCase();
            const isVisible = el.offsetParent !== null;
            if (isVisible && text && text === 'positions') {
              el.click();
              return true;
            }
          }
          return false;
        });
        
        if (clicked) {
          positionsTabClicked = true;
          console.log(`[${email}] Clicked Positions tab (via evaluate)`);
        }
      }
      
      // Step 4: Check for open positions and handle accordingly
      if (positionsTabClicked) {
        console.log(`[${email}] Positions tab clicked`);
        await delay(800); // Wait for Positions tab content to load
        
        // Check if there are open positions
        const hasOpenPositions = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table'));
          for (const table of tables) {
            const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
            if (dataRows.length > 0) {
              const rowsWithData = dataRows.filter(row => {
                const cells = Array.from(row.querySelectorAll('td, th'));
                return cells.length > 0 && row.offsetParent !== null;
              });
              return rowsWithData.length > 0;
            }
          }
          return false;
        });
        
        if (hasOpenPositions) {
          console.log(`[${email}] Open positions detected, proceeding with TP/SL flow...`);
          
          // First, check if TP/SL modal is already open (from auto-click listener)
          console.log(`[${email}] Checking if TP/SL modal is already open...`);
          const tpSlModalAlreadyOpen = await page.evaluate(() => {
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]'));
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              const isVisible = modal.offsetParent !== null && 
                               style.display !== 'none' && 
                               style.visibility !== 'hidden';
              if (isVisible) {
                const text = modal.textContent || '';
                if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) {
                  return true; // TP/SL modal is already open
                }
              }
            }
            return false;
          });
          
          if (tpSlModalAlreadyOpen) {
            console.log(`[${email}] ✅ TP/SL modal is already open (likely from auto-click listener), proceeding to fill it...`);
            // Don't click TP/SL button again, just proceed to fill the modal
          } else {
            // Step 4a: Find TP/SL column and click element to add TP/SL
            // Look for TP/SL column in table and click any element/button in that column
            console.log(`[${email}] TP/SL modal not open, looking for TP/SL column in Positions table...`);
          }
          
          const tpSlClicked = await page.evaluate((skipClick) => {
            if (skipClick) return false; // Skip clicking if modal is already open
            
            // Find all table elements
            const tables = Array.from(document.querySelectorAll('table'));
            
            for (const table of tables) {
              // Find header row
              const headerRow = table.querySelector('thead tr, thead > tr, tr:first-child');
              if (!headerRow) continue;
              
              // Find TP/SL column header
              const headers = Array.from(headerRow.querySelectorAll('th, td'));
              let tpSlColumnIndex = -1;
              
              for (let i = 0; i < headers.length; i++) {
                const headerText = headers[i].textContent?.trim().toLowerCase();
                if (headerText && (headerText.includes('tp/sl') || headerText.includes('tp / sl') || headerText.includes('tpsl'))) {
                  tpSlColumnIndex = i;
                  console.log(`Found TP/SL column at index ${i}`);
                  break;
                }
              }
              
              if (tpSlColumnIndex === -1) continue;
              
              // Find data rows (skip header row)
              const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
              
              // Find first data row and click any clickable element in TP/SL column
              for (const row of dataRows) {
                const cells = Array.from(row.querySelectorAll('td, th'));
                if (cells.length > tpSlColumnIndex) {
                  const tpSlCell = cells[tpSlColumnIndex];
                  
                  // Look for any clickable element in this cell (button, icon, div, span, etc.)
                  const clickableElements = tpSlCell.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"], a, div, span, svg, [onclick], [class*="icon"], [class*="Icon"]');
                  
                  for (const element of clickableElements) {
                    // Check if element is visible
                    if (element.offsetParent !== null && element.offsetWidth > 0 && element.offsetHeight > 0) {
                      // Click the first visible clickable element found
                      element.click();
                      return true;
                    }
                  }
                  
                  // If no clickable element found, try clicking the cell itself
                  if (tpSlCell.offsetParent !== null) {
                    tpSlCell.click();
                    return true;
                  }
                }
              }
            }
            
            return false;
          }, tpSlModalAlreadyOpen);
          
          if (tpSlClicked || tpSlModalAlreadyOpen) {
            if (tpSlModalAlreadyOpen) {
              console.log(`[${email}] ✅ TP/SL modal already open (from auto-click listener), proceeding to fill it...`);
              await delay(600); // Brief delay to ensure modal is ready
            } else {
              console.log(`[${email}] Clicked TP/SL button to add TP/SL`);
              console.log(`[${email}] Clicked element in TP/SL column of Positions table`);
              console.log(`[${email}] Waiting after TP/SL button click...`);
              await delay(1000); // Wait for modal to appear
              console.log(`[${email}] ✓ Delay completed after TP/SL button click`);
            }
            
            // Detect exchange type to use appropriate TP/SL input finding method
            const currentUrl = page.url();
            const isExtendedExchange = currentUrl.includes('extended.exchange');
            const isParadex = currentUrl.includes('paradex.trade') || !isExtendedExchange;
            
            if (isParadex) {
              // For Paradex: Use method from handleTpSlAddButtonClick - find input with "Loss" and "%" in nearby text
              console.log(`[${email}] Paradex detected - using Paradex-specific TP/SL input finding method...`);
              const stopLossValue = process.env.STOP_LOSS || '';
              
              if (!stopLossValue) {
                console.log(`[${email}] ⚠️  STOP_LOSS env variable not set!`);
                return ordersTabClicked;
              }
              
              // Find the input element using evaluateHandle (Paradex method)
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
                
                // Find input with "Loss" and "%" in nearby text (Paradex-specific)
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
              
              if (slInputHandle && slInputHandle.asElement()) {
                try {
                  const inputElement = slInputHandle.asElement();
                  
                  // Focus and clear the input
                  await inputElement.click({ clickCount: 3 }); // Triple click to select all
                  await page.keyboard.press('Backspace'); // Clear selected text
                  await inputElement.type(stopLossValue, { delay: 30 }); // Use exact string value from env
                  await page.keyboard.press('Tab'); // Trigger blur to calculate USD
                  await delay(300);
                  console.log(`[${email}] ✅ Successfully filled Stop Loss percentage using Paradex method`);
                  
                  // Wait 100ms after entering value
                  await delay(100);
                } catch (error) {
                  console.log(`[${email}] ⚠️  Error filling Stop Loss input: ${error.message}`);
                  return ordersTabClicked;
                }
              } else {
                console.log(`[${email}] ⚠️  Could not find Stop Loss input using Paradex method`);
                return ordersTabClicked;
              }
            } else {
              // For Extended Exchange: Use 5th input method
              console.log(`[${email}] Extended Exchange detected - using 5th input method...`);
              const stopLossResult = await page.evaluate((stopLossValue) => {
                // Find modal/dialog
                const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                if (!modal) {
                  console.log('No modal found');
                  return { success: false, reason: 'No modal found' };
                }
                
                // Find all input fields in the modal (excluding hidden inputs)
                const allInputs = Array.from(modal.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"]), input[data-part="input"]'));
                
                // Filter out disabled or readonly inputs that might not be interactive
                const interactiveInputs = allInputs.filter(input => {
                  return !input.disabled && !input.readOnly && input.offsetParent !== null;
                });
                
                console.log(`Found ${interactiveInputs.length} interactive inputs in modal`);
                
                // Get the 5th input (index 4) - Extended Exchange method
                let stopLossInput = null;
                if (interactiveInputs.length >= 5) {
                  stopLossInput = interactiveInputs[4]; // 5th input (index 4)
                  console.log(`Found 5th input in modal (index 4 of ${interactiveInputs.length} inputs)`);
                } else if (interactiveInputs.length > 0) {
                  // If less than 5 inputs, use the last one
                  stopLossInput = interactiveInputs[interactiveInputs.length - 1];
                  console.log(`Only ${interactiveInputs.length} inputs found, using last input (index ${interactiveInputs.length - 1})`);
                } else {
                  // Try to find any input-like elements
                  const allInputLike = Array.from(modal.querySelectorAll('input, [contenteditable="true"], [role="textbox"]'));
                  const interactiveInputLike = allInputLike.filter(el => {
                    return !el.disabled && !el.readOnly && el.offsetParent !== null;
                  });
                  
                  if (interactiveInputLike.length >= 5) {
                    stopLossInput = interactiveInputLike[4];
                    console.log(`Found 5th input-like element in modal`);
                  } else if (interactiveInputLike.length > 0) {
                    stopLossInput = interactiveInputLike[interactiveInputLike.length - 1];
                    console.log(`Using last input-like element (${interactiveInputLike.length} found)`);
                  }
                }
                
                if (!stopLossInput) {
                  console.log(`Could not find 5th input in modal. Total inputs found: ${allInputs.length}`);
                  return { success: false, reason: `Input #5 not found. Only ${allInputs.length} inputs available.` };
                }
                
                // Return the input element info so we can use Puppeteer to type
                const inputInfo = {
                  id: stopLossInput.id,
                  className: stopLossInput.className,
                  dataPart: stopLossInput.getAttribute('data-part'),
                  placeholder: stopLossInput.placeholder,
                  type: stopLossInput.type
                };
                
                console.log(`Found input to fill:`, inputInfo);
                return { success: true, inputInfo: inputInfo, inputFound: true };
              }, process.env.STOP_LOSS || '');
              
              if (stopLossResult.success && stopLossResult.inputFound) {
                // Use Puppeteer to click and type into the input
                console.log(`[${email}] Clicking and typing into the 5th input (Extended Exchange method)...`);
                const stopLossValue = process.env.STOP_LOSS || '';
                
                try {
                  // Find the input using the info we got
                  let inputElement = null;
                  
                  // Try multiple strategies to find the input
                  if (stopLossResult.inputInfo.id) {
                    inputElement = await page.$(`#${stopLossResult.inputInfo.id}`);
                  }
                  
                  if (!inputElement && stopLossResult.inputInfo.dataPart) {
                    inputElement = await page.$(`input[data-part="${stopLossResult.inputInfo.dataPart}"]`);
                  }
                  
                  // Fallback: find 5th input again using Puppeteer
                  if (!inputElement) {
                    const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"]), input[data-part="input"]');
                    const interactiveInputs = [];
                    for (const input of inputs) {
                      const isVisible = await input.evaluate(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
                      if (isVisible) {
                        interactiveInputs.push(input);
                      }
                    }
                    if (interactiveInputs.length >= 5) {
                      inputElement = interactiveInputs[4]; // 5th input
                    } else if (interactiveInputs.length > 0) {
                      inputElement = interactiveInputs[interactiveInputs.length - 1];
                    }
                  }
                  
                  if (inputElement) {
                    // Click the input to focus it
                    await inputElement.click({ delay: 100 });
                    await delay(300);
                    
                    // Clear existing value
                    await inputElement.click({ clickCount: 3 }); // Triple click to select all
                    await page.keyboard.press('Backspace');
                    await delay(200);
                    
                    // Type the value
                    await inputElement.type(stopLossValue, { delay: 50 });
                    
                    // Trigger additional events
                    await inputElement.evaluate((el, val) => {
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                      el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }, stopLossValue);
                    
                    console.log(`[${email}] ✅ Successfully filled stop loss input with value: ${stopLossValue}`);
                    
                    // Wait 100ms after entering value
                    await delay(100);
                  } else {
                    console.log(`[${email}] ⚠️  Could not find input element to fill`);
                    return ordersTabClicked;
                  }
                } catch (error) {
                  console.log(`[${email}] ⚠️  Error filling input: ${error.message}`);
                  return ordersTabClicked;
                }
              } else {
                console.log(`[${email}] ⚠️  Could not find 5th input: ${stopLossResult.reason || 'unknown'}`);
                return ordersTabClicked;
              }
            }
            
            // Common code for both exchanges: Find and click Confirm button
            try {
              // Find and click Confirm button in modal
              console.log(`[${email}] Looking for Confirm button in modal...`);
                  const confirmButton = await page.evaluate(() => {
                    const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                    if (!modal) {
                      console.log('No modal found when looking for Confirm button');
                      return null;
                    }
                    const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                    const confirmBtn = buttons.find(btn => {
                      const text = btn.textContent?.trim().toLowerCase();
                      const isVisible = btn.offsetParent !== null;
                      return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                    });
                    if (confirmBtn) {
                      console.log('Found Confirm button');
                      return true; // Return true to indicate button was found
                    }
                    console.log('Confirm button not found');
                    return false;
                  });
                  
                  if (confirmButton) {
                    // CRITICAL: Click the TP/SL Confirm button and wait for it to complete
                    // This MUST happen BEFORE clicking Limit button
                    console.log(`[${email}] Clicking TP/SL Confirm button...`);
                    const confirmClicked = await page.evaluate(() => {
                      // Find TP/SL modal specifically (not Limit modal)
                      const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]'));
                      let tpslModal = null;
                      for (const m of modals) {
                        const style = window.getComputedStyle(m);
                        const isVisible = m.offsetParent !== null && 
                                         style.display !== 'none' && 
                                         style.visibility !== 'hidden';
                        if (isVisible) {
                          const text = m.textContent || '';
                          // Make sure this is TP/SL modal, not Limit modal
                          if ((text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) && 
                              !text.includes('Close Position') && !text.includes('Limit')) {
                            tpslModal = m;
                            break;
                          }
                        }
                      }
                      
                      if (!tpslModal) {
                        console.log('TP/SL modal not found when trying to click Confirm');
                        return false;
                      }
                      
                      // Find Confirm button in TP/SL modal
                      const buttons = Array.from(tpslModal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                      const confirmBtn = buttons.find(btn => {
                        const text = btn.textContent?.trim().toLowerCase();
                        const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                        return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                      });
                      
                      if (confirmBtn) {
                        confirmBtn.click();
                        console.log('Clicked TP/SL Confirm button');
                        return true;
                      }
                      
                      console.log('Confirm button not found in TP/SL modal');
                      return false;
                    });
                    
                    if (!confirmClicked) {
                      console.log(`[${email}] ⚠️  Failed to click TP/SL Confirm button - NOT proceeding to Limit button`);
                      // Don't proceed to Limit if Confirm wasn't clicked
                      return ordersTabClicked;
                    }
                    
                    console.log(`[${email}] ✅ Successfully clicked TP/SL Confirm button`);
                    console.log(`[${email}] Waiting 3-4 seconds after TP/SL confirm click before proceeding to Limit...`);
                    await delay(500); // Wait 3.5 seconds after confirming TP/SL (3-4 second range)
                    console.log(`[${email}] ✓ 3.5 second delay completed after TP/SL confirm`);
                    
                    // CRITICAL: Verify TP/SL modal is actually closed before clicking Limit button
                    console.log(`[${email}] Verifying TP/SL modal is closed before proceeding to Limit button...`);
                    let tpSlModalClosed = false;
                    let modalCheckAttempts = 0;
                    const maxModalChecks = 15; // Check up to 15 times (15 seconds)
                    
                    while (!tpSlModalClosed && modalCheckAttempts < maxModalChecks) {
                      await delay(700); // Wait 1 second between checks
                      modalCheckAttempts++;
                      
                      tpSlModalClosed = await page.evaluate(() => {
                        const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]'));
                        // Check if any modal contains TP/SL related text
                        for (const modal of modals) {
                          const style = window.getComputedStyle(modal);
                          const isVisible = modal.offsetParent !== null && 
                                           style.display !== 'none' && 
                                           style.visibility !== 'hidden';
                          if (isVisible) {
                            const text = modal.textContent || '';
                            if (text.includes('TP/SL') || text.includes('Take Profit') || text.includes('Stop Loss')) {
                              return false; // TP/SL modal still open
                            }
                          }
                        }
                        return true; // No TP/SL modal found, it's closed
                      });
                      
                      if (!tpSlModalClosed) {
                        console.log(`[${email}] TP/SL modal still open (attempt ${modalCheckAttempts}/${maxModalChecks}), waiting...`);
                      }
                    }
                    
                    if (tpSlModalClosed) {
                      console.log(`[${email}] ✅ TP/SL modal is confirmed closed, proceeding to Limit button...`);
                    } else {
                      console.log(`[${email}] ⚠️  TP/SL modal may still be open after ${maxModalChecks} seconds, but proceeding to Limit button...`);
                    }
                    
                    // Only proceed to click Limit button after TP/SL modal is confirmed closed
                    // After TP/SL modal is closed, find and click Limit button in the same row as TP/SL button
                    console.log(`[${email}] Looking for Limit button in Positions table (same row as TP/SL)...`);
                    const limitButtonResult = await page.evaluate(() => {
                      // Find all table elements
                      const tables = Array.from(document.querySelectorAll('table'));
                      
                      for (const table of tables) {
                        // Find header row
                        const headerRow = table.querySelector('thead tr, thead > tr, tr:first-child');
                        if (!headerRow) continue;
                        
                        // Find TP/SL column header
                        const headers = Array.from(headerRow.querySelectorAll('th, td'));
                        let tpSlColumnIndex = -1;
                        
                        for (let i = 0; i < headers.length; i++) {
                          const headerText = headers[i].textContent?.trim().toLowerCase();
                          if (headerText && (headerText.includes('tp/sl') || headerText.includes('tp / sl') || headerText.includes('tpsl'))) {
                            tpSlColumnIndex = i;
                            break;
                          }
                        }
                        
                        if (tpSlColumnIndex === -1) continue;
                        
                        // Find data rows
                        const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
                        
                        // Find first data row that has a TP/SL column
                        for (const row of dataRows) {
                          const cells = Array.from(row.querySelectorAll('td, th'));
                          if (cells.length > tpSlColumnIndex) {
                            const tpSlCell = cells[tpSlColumnIndex];
                            
                            // Check if this row has a TP/SL element (indicating it's the row we clicked)
                            const hasTpSlElement = tpSlCell.querySelector('button, div[role="button"], span[role="button"], a, svg, [onclick], [class*="icon"]');
                            
                            if (hasTpSlElement) {
                              // Now find Limit button in this same row (with capital L)
                              const limitButton = Array.from(row.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"], a')).find(btn => {
                                const text = btn.textContent?.trim();
                                const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                                return isVisible && (text === 'Limit' || text.includes('Limit'));
                              });
                              
                              if (limitButton) {
                                limitButton.click();
                                console.log('Found and clicked Limit button in same row as TP/SL');
                                return true;
                              }
                            }
                          }
                        }
                      }
                      
                      return false;
                    });
                    
                    if (limitButtonResult) {
                      console.log(`[${email}] ✅ Successfully clicked Limit button in Positions table`);
                      console.log(`[${email}] Waiting after Limit button click...`);
                      await delay(2000); // Wait for modal to appear
                      console.log(`[${email}] ✓ Delay completed after Limit button click`);
                      
                      // Find and click Close Position button in the modal
                      console.log(`[${email}] Looking for Close Position button in modal...`);
                      const closePositionClicked = await page.evaluate(() => {
                        // Find modal/dialog
                        const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                        if (!modal) {
                          console.log('No modal found when looking for Close Position button');
                          return false;
                        }
                        
                        // Find Close Position button
                        const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                        const closePositionBtn = buttons.find(btn => {
                          const text = btn.textContent?.trim();
                          const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                          return isVisible && (text === 'Close Position' || text.includes('Close Position'));
                        });
                        
                        if (closePositionBtn) {
                          closePositionBtn.click();
                          console.log('Found and clicked Close Position button');
                          return true;
                        }
                        
                        console.log('Close Position button not found in modal');
                        return false;
                      });
                      
                      if (closePositionClicked) {
                        console.log(`[${email}] ✅ Successfully clicked Close Position button in modal`);
                        await delay(300); // Brief delay before looking for Confirm button
                        
                        // Find and click Confirm button in the Limit modal (after Close Position)
                        console.log(`[${email}] Looking for Confirm button in Limit modal...`);
                        const confirmInLimitModal = await page.evaluate(() => {
                          const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                          if (!modal) return false;
                          const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                          const confirmBtn = buttons.find(btn => {
                            const text = btn.textContent?.trim().toLowerCase();
                            const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                            return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                          });
                          if (confirmBtn) {
                            confirmBtn.click();
                            return true;
                          }
                          return false;
                        });
                        
                        if (confirmInLimitModal) {
                          console.log(`[${email}] ✅ Successfully clicked Confirm button in Limit modal`);
                          await delay(800);
                        } else {
                          console.log(`[${email}] ⚠️  Could not find Confirm button in Limit modal, continuing...`);
                          await delay(500);
                        }
                        
                        // Wait 10 seconds after confirming Limit close, then check if positions are still open
                        console.log(`[${email}] Waiting 10 seconds after confirming Limit close...`);
                        await delay(10000); // Wait 10 seconds
                        console.log(`[${email}] ✓ 10 second wait completed after Limit close`);
                        
                        // Now check if there are any open positions still remaining
                        console.log(`[${email}] Checking if positions are still open after 10 seconds...`);
                        const hasOpenPositions = await page.evaluate(() => {
                          // Find Positions table
                          const tables = Array.from(document.querySelectorAll('table'));
                          for (const table of tables) {
                            const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
                            // Check if there are any data rows (indicating open positions)
                            if (dataRows.length > 0) {
                              // Check if rows have actual position data (not just empty rows)
                              const rowsWithData = dataRows.filter(row => {
                                const cells = Array.from(row.querySelectorAll('td, th'));
                                return cells.length > 0 && row.offsetParent !== null;
                              });
                              return rowsWithData.length > 0;
                            }
                          }
                          return false;
                        });
                        
                        if (hasOpenPositions) {
                          console.log(`[${email}] Positions still open after 10 seconds, clicking CLOSE ALL POSITIONS...`);
                          
                          // Find and click CLOSE ALL POSITIONS button in Positions tab
                          console.log(`[${email}] Looking for CLOSE ALL POSITIONS button...`);
                          const closeAllClicked = await page.evaluate(() => {
                            // Find button with text "CLOSE ALL POSITIONS" or "Close All Positions"
                            const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                            const closeAllBtn = allButtons.find(btn => {
                              const text = btn.textContent?.trim();
                              const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                              return isVisible && (
                                text === 'CLOSE ALL POSITIONS' || 
                                text === 'Close All Positions' ||
                                text.toLowerCase() === 'close all positions' ||
                                text.includes('CLOSE ALL POSITIONS') ||
                                text.includes('Close All Positions')
                              );
                            });
                            
                            if (closeAllBtn) {
                              closeAllBtn.click();
                              console.log('Found and clicked CLOSE ALL POSITIONS button');
                              return true;
                            }
                            
                            console.log('CLOSE ALL POSITIONS button not found');
                            return false;
                          });
                          
                          if (closeAllClicked) {
                            console.log(`[${email}] ✅ Successfully clicked CLOSE ALL POSITIONS button`);
                            await delay(2000); // Wait for modal to appear and render
                            
                            // Find and click Close Positions button in the modal
                            console.log(`[${email}] Looking for Close Positions button in modal...`);
                            const closePositionsClicked = await page.evaluate(() => {
                              // Find modal/dialog
                              const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                              if (!modal) {
                                console.log('No modal found when looking for Close Positions button');
                                return false;
                              }
                              
                              // Find Close Positions button
                              const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                              const closePositionsBtn = buttons.find(btn => {
                                const text = btn.textContent?.trim();
                                const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                                return isVisible && (
                                  text === 'Close Positions' || 
                                  text.includes('Close Positions')
                                );
                              });
                              
                              if (closePositionsBtn) {
                                closePositionsBtn.click();
                                console.log('Found and clicked Close Positions button');
                                return true;
                              }
                              
                              console.log('Close Positions button not found in modal');
                              return false;
                            });
                            
                            if (closePositionsClicked) {
                              console.log(`[${email}] ✅ Successfully clicked Close Positions button in modal`);
                              await delay(2000); // Wait for modal to close
                              
                              // Find and click leverage button (e.g., "10x") in right sidebar (only if not skipping)
                              if (skipLeverage) {
                                console.log(`[${email}] Skipping leverage setting after CLOSE ALL (will be set in post-trade flow)`);
                              } else {
                                console.log(`[${email}] Looking for leverage button (e.g., "10x") in right sidebar...`);
                                const leverageButtonClicked = await page.evaluate(() => {
                                // Find button with text matching pattern like "10x", "20x", etc.
                                const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                                const leverageBtn = allButtons.find(btn => {
                                  const text = btn.textContent?.trim();
                                  const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                                  // Match pattern: number followed by "x" (e.g., "10x", "20x", "5x")
                                  return isVisible && /^\d+x$/i.test(text);
                                });
                                
                                if (leverageBtn) {
                                  leverageBtn.click();
                                  console.log(`Found and clicked leverage button: ${leverageBtn.textContent?.trim()}`);
                                  return true;
                                }
                                
                                console.log('Leverage button not found');
                                return false;
                              });
                              
                              if (leverageButtonClicked) {
                                console.log(`[${email}] ✅ Successfully clicked leverage button`);
                                await delay(2000); // Wait for modal to appear
                                
                                // Find input in modal and set LEVERAGE value, then click Confirm
                                console.log(`[${email}] Looking for leverage input in modal...`);
                                const leverageValue = process.env.LEVERAGE || '20';
                                
                                const leverageSet = await page.evaluate((leverageVal) => {
                                  // Find modal/dialog
                                  const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                                  if (!modal) {
                                    console.log('No modal found when looking for leverage input');
                                    return { success: false, reason: 'No modal found' };
                                  }
                                  
                                  // Find input field in modal
                                  const inputs = Array.from(modal.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])'));
                                  const leverageInput = inputs.find(input => {
                                    return !input.disabled && !input.readOnly && input.offsetParent !== null;
                                  });
                                  
                                  if (!leverageInput) {
                                    console.log('Leverage input not found in modal');
                                    return { success: false, reason: 'Input not found' };
                                  }
                                  
                                  // Clear and set value
                                  leverageInput.focus();
                                  leverageInput.click();
                                  leverageInput.value = '';
                                  leverageInput.value = leverageVal;
                                  
                                  // Trigger events
                                  leverageInput.dispatchEvent(new Event('input', { bubbles: true }));
                                  leverageInput.dispatchEvent(new Event('change', { bubbles: true }));
                                  
                                  console.log(`Set leverage input to: ${leverageVal}`);
                                  
                                  // Find and click Confirm button
                                  const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                                  const confirmBtn = buttons.find(btn => {
                                    const text = btn.textContent?.trim().toLowerCase();
                                    const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                                    return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                                  });
                                  
                                  if (confirmBtn) {
                                    confirmBtn.click();
                                    console.log('Clicked Confirm button in leverage modal');
                                    return { success: true, inputSet: true, confirmed: true };
                                  }
                                  
                                  console.log('Confirm button not found in leverage modal');
                                  return { success: true, inputSet: true, confirmed: false, reason: 'Confirm button not found' };
                                }, leverageValue);
                                
                                if (leverageSet.success && leverageSet.inputSet) {
                                  console.log(`[${email}] ✅ Successfully set leverage to: ${leverageValue}`);
                                  if (leverageSet.confirmed) {
                                    console.log(`[${email}] ✅ Successfully clicked Confirm button in leverage modal`);
                                    await delay(2000);
                                  } else {
                                    console.log(`[${email}] ⚠️  Could not find Confirm button: ${leverageSet.reason || 'unknown'}`);
                                  }
                                } else {
                                  console.log(`[${email}] ⚠️  Could not set leverage: ${leverageSet.reason || 'unknown'}`);
                                }
                              } else {
                                console.log(`[${email}] ⚠️  Could not find leverage button in right sidebar`);
                              }
                              } // End of else block for skipLeverage check
                            } else {
                              console.log(`[${email}] ⚠️  Could not find Close Positions button in modal`);
                            }
                          } else {
                            console.log(`[${email}] ⚠️  Could not find CLOSE ALL POSITIONS button`);
                          }
                        } else {
                          console.log(`[${email}] No open positions found, skipping CLOSE ALL POSITIONS`);
                        }
                      } else {
                        console.log(`[${email}] ⚠️  Could not find Close Position button in modal`);
                      }
                    } else {
                      console.log(`[${email}] ⚠️  Could not find Limit button in same row as TP/SL`);
                      // If Limit button not found, try to close all positions
                      if (!skipLeverage) {
                        await handleClosePositionsAndSetLeverage(page, email);
                      }
                    }
                  } else {
                    console.log(`[${email}] ⚠️  Could not find Confirm button in modal`);
                    // If Confirm not found, try to close all positions
                    if (!skipLeverage) {
                      await handleClosePositionsAndSetLeverage(page, email);
                    }
                  }
            } catch (error) {
              console.log(`[${email}] ⚠️  Error in TP/SL flow: ${error.message}`);
              // On error, try to close all positions
              if (!skipLeverage) {
                await handleClosePositionsAndSetLeverage(page, email);
              }
            }
          } else {
            console.log(`[${email}] No open positions found${skipLeverage ? ', skipping leverage (will be set later)' : ', proceeding to set leverage...'}`);
            // No positions found, directly set leverage (unless skipped)
            if (!skipLeverage) {
              await handleSetLeverage(page, email);
            }
          }
        } else {
          console.log(`[${email}] Positions tab not found${skipLeverage ? ', skipping leverage (will be set later)' : ', trying to set leverage...'}`);
          // Try to set leverage anyway (unless skipped)
          if (!skipLeverage) {
            await handleSetLeverage(page, email);
          }
        }
      } else {
        // If we didn't switch to Positions tab, try to set leverage (unless skipped)
        console.log(`[${email}] Could not switch to Positions tab${skipLeverage ? ', skipping leverage (will be set later)' : ', trying to set leverage...'}`);
        if (!skipLeverage) {
          await handleSetLeverage(page, email);
        }
      }
      
      return ordersTabClicked;
    } catch (error) {
      console.log(`[${email}] Error clicking Orders tab: ${error.message}`);
      return false;
    }
  }

  export { clickOrdersTab };