import dotenv from 'dotenv';
import { delay } from '../utils/helpers.js';
import { cancelAllOrders } from '../trading/orders.js';
import { clickOrdersTab } from '../ui/tabs.js';
import { handleSetLeverage } from '../trading/leverage.js';
import { safeClick, safeType } from '../utils/safeActions.js';

// Ensure environment variables are loaded
dotenv.config();

// Extended Exchange pre/post-trade flow: cancel orders, positions, TP/SL, close positions, set leverage
// This runs both BEFORE and AFTER trade execution for Extended Exchange
async function extendedExchangePrePostTradeFlow(page, email) {
    console.log(`[${email}] Starting Extended Exchange pre/post-trade flow...`);
    
    try {
      // Step 1: Cancel all open orders first
      console.log(`[${email}] Step 1: Canceling all open orders...`);
      const cancelResult = await cancelAllOrders(page);
      if (cancelResult.success) {
        console.log(`[${email}] ✅ Orders canceled: ${cancelResult.message || 'completed'}`);
      } else {
        console.log(`[${email}] ⚠️  Order cancellation: ${cancelResult.error || 'check failed'}`);
      }
      await delay(1000);
      
      // Step 2: Click Orders tab (skip login checks - we're already logged in)
      console.log(`[${email}] Step 2: Clicking Orders tab...`);
      let ordersTabClicked = false;
      
      const ordersTab = await findByExactText(page, "Orders", ["button", "div", "span", "a"]);
      if (ordersTab) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, ordersTab);
        if (isVisible) {
          await safeClick(page, ordersTab);
          ordersTabClicked = true;
          console.log(`[${email}] ✅ Clicked Orders tab`);
          await delay(1500);
        }
      }
      
      if (!ordersTabClicked) {
        console.log(`[${email}] ⚠️  Could not click Orders tab, trying alternative...`);
        const clicked = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('button, div[role="tab"], span[role="tab"], a[role="tab"], div, span, a'));
          for (const el of allElements) {
            const text = el.textContent?.trim().toLowerCase();
            const isVisible = el.offsetParent !== null;
            if (isVisible && text === 'orders') {
              el.click();
              return true;
            }
          }
          return false;
        });
        if (clicked) {
          ordersTabClicked = true;
          await delay(1500);
        }
      }
      
      if (!ordersTabClicked) {
        console.log(`[${email}] ⚠️  Could not click Orders tab, continuing to Positions...`);
      }
      
      // Step 3: Check for open orders and click CANCEL ALL if found
      console.log(`[${email}] Step 3: Checking for open orders...`);
      const hasOpenOrders = await page.evaluate(() => {
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
      
      if (hasOpenOrders) {
        console.log(`[${email}] Open orders detected, clicking CANCEL ALL...`);
        const cancelAllClicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toLowerCase();
            const isVisible = btn.offsetParent !== null;
            if (isVisible && (text === 'cancel all' || text === 'cancelall' || text.includes('cancel all'))) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        
        if (cancelAllClicked) {
          console.log(`[${email}] ✅ Clicked CANCEL ALL`);
          await delay(2000);
        }
      } else {
        console.log(`[${email}] No open orders found`);
      }
      
      // Step 4: Switch to Positions tab
      console.log(`[${email}] Step 4: Switching to Positions tab...`);
      let positionsTabClicked = false;
      
      const positionsTab = await findByExactText(page, "Positions", ["button", "div", "span", "a"]);
      if (positionsTab) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, positionsTab);
        if (isVisible) {
          await safeClick(page, positionsTab);
          positionsTabClicked = true;
          console.log(`[${email}] ✅ Clicked Positions tab`);
          await delay(2000);
        }
      }
      
      if (!positionsTabClicked) {
        const clicked = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('button, div[role="tab"], span[role="tab"], a[role="tab"], div, span, a'));
          for (const el of allElements) {
            const text = el.textContent?.trim().toLowerCase();
            const isVisible = el.offsetParent !== null;
            if (isVisible && text === 'positions') {
              el.click();
              return true;
            }
          }
          return false;
        });
        if (clicked) {
          positionsTabClicked = true;
          await delay(2000);
        }
      }
      
      if (positionsTabClicked) {
        // Step 5: Check for open positions and handle TP/SL, close positions flow
        console.log(`[${email}] Step 5: Checking for open positions...`);
        
        // Wait a bit for positions to load after clicking Positions tab
        await delay(1500);
        
        // Retry checking for positions (they might take time to load)
        let hasOpenPositions = false;
        for (let retry = 0; retry < 3; retry++) {
          hasOpenPositions = await page.evaluate(() => {
            const tables = Array.from(document.querySelectorAll('table'));
            for (const table of tables) {
              const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
              if (dataRows.length > 0) {
                const rowsWithData = dataRows.filter(row => {
                  const cells = Array.from(row.querySelectorAll('td, th'));
                  const isVisible = row.offsetParent !== null;
                  // More specific check: look for position-related content
                  const rowText = row.textContent?.toLowerCase() || '';
                  const hasPositionIndicators = (
                    rowText.includes('position') || 
                    rowText.includes('pnl') || 
                    rowText.includes('size') ||
                    rowText.includes('entry') ||
                    cells.length >= 3 // Positions table typically has multiple columns
                  );
                  return isVisible && cells.length > 0 && hasPositionIndicators;
                });
                if (rowsWithData.length > 0) {
                  console.log(`Found ${rowsWithData.length} position row(s)`);
                  return true;
                }
              }
            }
            return false;
          });
          
          if (hasOpenPositions) {
            console.log(`[${email}] ✅ Open positions detected (attempt ${retry + 1}/3)`);
            break;
          }
          
          if (retry < 2) {
            console.log(`[${email}] No positions found yet (attempt ${retry + 1}/3), waiting...`);
            await delay(1000);
          }
        }
        
        if (hasOpenPositions) {
          console.log(`[${email}] ✅ Open positions detected, proceeding with TP/SL flow...`);
          console.log(`[${email}] [POST-TRADE] CRITICAL: TP/SL MUST be added before closing positions!`);
          
          // Step 5a: Find TP/SL column and click element to add TP/SL
          // CRITICAL: This MUST run before Limit button - positions cannot be closed without TP/SL
          // Using EXACT same method as clickOrdersTab flow (initial bot startup)
          console.log(`[${email}] [POST-TRADE] Step 5a: Looking for TP/SL column in Positions table...`);
          let tpSlClicked = false;
          try {
            // Add timeout protection for evaluate call (30 second timeout)
            tpSlClicked = await Promise.race([
              page.evaluate(() => {
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
              }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('TP/SL search timeout after 30s')), 30000)
              )
            ]);
          } catch (error) {
            console.log(`[${email}] [POST-TRADE] ⚠️  Error or timeout finding TP/SL button: ${error.message}`);
            tpSlClicked = false;
          }
          
          console.log(`[${email}] [POST-TRADE] TP/SL button click result: ${tpSlClicked ? 'SUCCESS' : 'FAILED'}`);
          
          if (tpSlClicked) {
            console.log(`[${email}] [POST-TRADE] ✅ TP/SL button clicked successfully, proceeding with TP/SL modal flow...`);
            console.log(`[${email}] [POST-TRADE] Clicked TP/SL button to add TP/SL`);
            console.log(`[${email}] [POST-TRADE] Clicked element in TP/SL column of Positions table`);
            await delay(2000); // Wait for modal to appear (same as clickOrdersTab flow)
            
            // Handle TP/SL modal: Find the 5th input and fill with STOP_LOSS value
            console.log(`[${email}] [POST-TRADE] Looking for TP/SL modal and 5th input...`);
            const stopLossResult = await page.evaluate((stopLossValue) => {
              const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
              if (!modal) {
                return { success: false, reason: 'No modal found' };
              }
              
              const allInputs = Array.from(modal.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"]), input[data-part="input"]'));
              const interactiveInputs = allInputs.filter(input => {
                return !input.disabled && !input.readOnly && input.offsetParent !== null;
              });
              
              let stopLossInput = null;
              if (interactiveInputs.length >= 5) {
                stopLossInput = interactiveInputs[4];
              } else if (interactiveInputs.length > 0) {
                stopLossInput = interactiveInputs[interactiveInputs.length - 1];
              } else {
                const allInputLike = Array.from(modal.querySelectorAll('input, [contenteditable="true"], [role="textbox"]'));
                const interactiveInputLike = allInputLike.filter(el => {
                  return !el.disabled && !el.readOnly && el.offsetParent !== null;
                });
                
                if (interactiveInputLike.length >= 5) {
                  stopLossInput = interactiveInputLike[4];
                } else if (interactiveInputLike.length > 0) {
                  stopLossInput = interactiveInputLike[interactiveInputLike.length - 1];
                }
              }
              
              if (!stopLossInput) {
                return { success: false, reason: `Input #5 not found. Only ${allInputs.length} inputs available.` };
              }
              
              const inputInfo = {
                id: stopLossInput.id,
                className: stopLossInput.className,
                dataPart: stopLossInput.getAttribute('data-part'),
                placeholder: stopLossInput.placeholder,
                type: stopLossInput.type
              };
              
              return { success: true, inputInfo: inputInfo, inputFound: true };
            }, process.env.STOP_LOSS || '');
            
            if (stopLossResult.success && stopLossResult.inputFound) {
              console.log(`[${email}] [POST-TRADE] ✅ Found TP/SL modal and 5th input, filling STOP_LOSS value...`);
              const stopLossValue = process.env.STOP_LOSS || '';
              
              if (!stopLossValue) {
                console.log(`[${email}] [POST-TRADE] ❌ STOP_LOSS env variable not set! Cannot proceed without STOP_LOSS value`);
                await handleSetLeverage(page, email);
                return { success: false, error: 'STOP_LOSS env variable not set' };
              }
              
              try {
                let inputElement = null;
                
                if (stopLossResult.inputInfo.id) {
                  inputElement = await page.$(`#${stopLossResult.inputInfo.id}`);
                }
                
                if (!inputElement && stopLossResult.inputInfo.dataPart) {
                  inputElement = await page.$(`input[data-part="${stopLossResult.inputInfo.dataPart}"]`);
                }
                
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
                    inputElement = interactiveInputs[4];
                  } else if (interactiveInputs.length > 0) {
                    inputElement = interactiveInputs[interactiveInputs.length - 1];
                  }
                }
                
                if (inputElement) {
                  await safeClick(page, inputElement);
                  await delay(300);
                  await page.evaluate(el => { el.focus(); el.select(); }, inputElement);
                  await page.keyboard.press('Backspace');
                  await delay(200);
                  await safeType(page, inputElement, stopLossValue, { delay: 50 });
                  await inputElement.evaluate((el, val) => {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                  }, stopLossValue);

                  console.log(`[${email}] ✅ Successfully filled stop loss input with value: ${stopLossValue}`);
                  await delay(100);

                  // Find and click Confirm button in modal
                  console.log(`[${email}] Looking for Confirm button in modal...`);
                  const confirmButton = await page.evaluate(() => {
                    const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                    if (!modal) return null;
                    const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                    const confirmBtn = buttons.find(btn => {
                      const text = btn.textContent?.trim().toLowerCase();
                      const isVisible = btn.offsetParent !== null;
                      return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                    });
                    if (confirmBtn) {
                      return true;
                    }
                    return false;
                  });
                  
                  if (confirmButton) {
                    await page.evaluate(() => {
                      const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                      if (!modal) return;
                      const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                      const confirmBtn = buttons.find(btn => {
                        const text = btn.textContent?.trim().toLowerCase();
                        const isVisible = btn.offsetParent !== null;
                        return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                      });
                      if (confirmBtn) {
                        confirmBtn.click();
                      }
                    });
                    console.log(`[${email}] [POST-TRADE] ✅ Successfully clicked Confirm button in TP/SL modal`);
                    await delay(2000);
                    
                    // Verify TP/SL modal closed before proceeding to Limit
                    const tpSlModalClosed = await page.evaluate(() => {
                      const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                      return modal === null;
                    });
                    
                    if (!tpSlModalClosed) {
                      console.log(`[${email}] [POST-TRADE] ⚠️  TP/SL modal still open after Confirm, waiting...`);
                      await delay(2000);
                    }
                    
                    // Find and click Limit button in the same row as TP/SL button
                    // CRITICAL: Only proceed to Limit AFTER TP/SL has been successfully added
                    console.log(`[${email}] [POST-TRADE] TP/SL added successfully, now looking for Limit button in Positions table (same row as TP/SL)...`);
                    const limitButtonClicked = await page.evaluate(() => {
                      const tables = Array.from(document.querySelectorAll('table'));
                      
                      for (const table of tables) {
                        const headerRow = table.querySelector('thead tr, thead > tr, tr:first-child');
                        if (!headerRow) continue;
                        
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
                        
                        const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
                        
                        for (const row of dataRows) {
                          const cells = Array.from(row.querySelectorAll('td, th'));
                          if (cells.length > tpSlColumnIndex) {
                            const tpSlCell = cells[tpSlColumnIndex];
                            const hasTpSlElement = tpSlCell.querySelector('button, div[role="button"], span[role="button"], a, svg, [onclick], [class*="icon"]');
                            
                            if (hasTpSlElement) {
                              const limitButton = Array.from(row.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"], a')).find(btn => {
                                const text = btn.textContent?.trim();
                                const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                                return isVisible && (text === 'Limit' || text.includes('Limit'));
                              });
                              
                              if (limitButton) {
                                limitButton.click();
                                return true;
                              }
                            }
                          }
                        }
                      }
                      
                      return false;
                    });
                    
                    if (limitButtonClicked) {
                      console.log(`[${email}] ✅ Successfully clicked Limit button`);
                      await delay(2000);
                      
                      // Find and click Close Position button in the modal
                      console.log(`[${email}] Looking for Close Position button in modal...`);
                      const closePositionClicked = await page.evaluate(() => {
                        const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                        if (!modal) return false;
                        
                        const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                        const closePositionBtn = buttons.find(btn => {
                          const text = btn.textContent?.trim();
                          const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                          return isVisible && (text === 'Close Position' || text.includes('Close Position'));
                        });
                        
                        if (closePositionBtn) {
                          closePositionBtn.click();
                          return true;
                        }
                        
                        return false;
                      });
                      
                      if (closePositionClicked) {
                        console.log(`[${email}] ✅ Successfully clicked Close Position button`);
                        await delay(1000);
                        
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
                          await delay(2000);
                        } else {
                          console.log(`[${email}] ⚠️  Could not find Confirm button in Limit modal, continuing...`);
                          await delay(1000);
                        }
                        
                        // Wait 10 seconds after closing position, then check if positions are still open
                        console.log(`[${email}] Waiting 10 seconds after closing position...`);
                        await delay(10000);
                        
                        // Check if positions are still open
                        console.log(`[${email}] Checking if positions are still open after 10 seconds...`);
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
                          console.log(`[${email}] Positions still open after 10 seconds, clicking CLOSE ALL POSITIONS...`);
                          
                          const closeAllClicked = await page.evaluate(() => {
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
                              return true;
                            }
                            
                            return false;
                          });
                          
                          if (closeAllClicked) {
                            console.log(`[${email}] ✅ Successfully clicked CLOSE ALL POSITIONS button`);
                            await delay(2000);
                            
                            // Find and click Close Positions button in the modal
                            const closePositionsClicked = await page.evaluate(() => {
                              const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                              if (!modal) return false;
                              const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                              const closePositionsBtn = buttons.find(btn => {
                                const text = btn.textContent?.trim();
                                const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                                return isVisible && (text === 'Close Positions' || text.includes('Close Positions'));
                              });
                              if (closePositionsBtn) {
                                closePositionsBtn.click();
                                return true;
                              }
                              return false;
                            });
                            
                            if (closePositionsClicked) {
                              console.log(`[${email}] ✅ Successfully clicked Close Positions button in modal`);
                              await delay(2000);
                            }
                          }
                        } else {
                          console.log(`[${email}] No open positions found after 10 seconds`);
                        }
                      } else {
                        console.log(`[${email}] ⚠️  Could not find Close Position button in modal`);
                      }
                    } else {
                      console.log(`[${email}] ⚠️  Could not find Limit button`);
                    }
                  } else {
                    console.log(`[${email}] ⚠️  Could not find Confirm button in modal`);
                  }
                } else {
                  console.log(`[${email}] ⚠️  Could not find input element to fill`);
                }
              } catch (error) {
                console.log(`[${email}] ⚠️  Error filling input: ${error.message}`);
              }
            } else {
              console.log(`[${email}] ⚠️  Could not find 5th input: ${stopLossResult.reason || 'unknown'}`);
            }
          } else {
            console.log(`[${email}] [POST-TRADE] ❌ CRITICAL: Could not find TP/SL button!`);
            console.log(`[${email}] [POST-TRADE] Retrying TP/SL search with more specific method...`);
            
            // Retry with a more aggressive search - wait and try again
            await delay(2000);
            
            // Try one more time with the exact same method as clickOrdersTab
            let retryTpSlClicked = false;
            try {
              retryTpSlClicked = await page.evaluate(() => {
                const tables = Array.from(document.querySelectorAll('table'));
                for (const table of tables) {
                  const headerRow = table.querySelector('thead tr, thead > tr, tr:first-child');
                  if (!headerRow) continue;
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
                  const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
                  for (const row of dataRows) {
                    const cells = Array.from(row.querySelectorAll('td, th'));
                    if (cells.length > tpSlColumnIndex) {
                      const tpSlCell = cells[tpSlColumnIndex];
                      const clickableElements = tpSlCell.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"], a, div, span, svg, [onclick], [class*="icon"], [class*="Icon"]');
                      for (const element of clickableElements) {
                        if (element.offsetParent !== null && element.offsetWidth > 0 && element.offsetHeight > 0) {
                          element.click();
                          return true;
                        }
                      }
                      if (tpSlCell.offsetParent !== null) {
                        tpSlCell.click();
                        return true;
                      }
                    }
                  }
                }
                return false;
              });
            } catch (error) {
              console.log(`[${email}] [POST-TRADE] Retry also failed: ${error.message}`);
            }
            
            if (!retryTpSlClicked) {
              console.log(`[${email}] [POST-TRADE] ❌ CRITICAL: Could not find TP/SL button after retry!`);
              console.log(`[${email}] [POST-TRADE] Will NOT proceed to Limit or close positions without TP/SL`);
              console.log(`[${email}] [POST-TRADE] Positions will remain open - TP/SL must be added first`);
              // Do NOT proceed to close positions if TP/SL button was not found
              // Set leverage anyway so next cycle can try again
              await handleSetLeverage(page, email);
              return { success: false, error: 'TP/SL button not found - positions remain open, cannot proceed without TP/SL' };
            } else {
              console.log(`[${email}] [POST-TRADE] ✅ TP/SL button found on retry! Continuing with TP/SL flow...`);
              await delay(2000); // Wait for modal
              
              // Execute the full TP/SL modal flow here since retry succeeded
              // This is the same flow as in the main if (tpSlClicked) block
              console.log(`[${email}] [POST-TRADE] Looking for TP/SL modal and 5th input...`);
              const stopLossResult = await page.evaluate((stopLossValue) => {
                const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                if (!modal) {
                  return { success: false, reason: 'No modal found' };
                }
                
                const allInputs = Array.from(modal.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"]), input[data-part="input"]'));
                const interactiveInputs = allInputs.filter(input => {
                  return !input.disabled && !input.readOnly && input.offsetParent !== null;
                });
                
                let stopLossInput = null;
                if (interactiveInputs.length >= 5) {
                  stopLossInput = interactiveInputs[4];
                } else if (interactiveInputs.length > 0) {
                  stopLossInput = interactiveInputs[interactiveInputs.length - 1];
                } else {
                  const allInputLike = Array.from(modal.querySelectorAll('input, [contenteditable="true"], [role="textbox"]'));
                  const interactiveInputLike = allInputLike.filter(el => {
                    return !el.disabled && !el.readOnly && el.offsetParent !== null;
                  });
                  
                  if (interactiveInputLike.length >= 5) {
                    stopLossInput = interactiveInputLike[4];
                  } else if (interactiveInputLike.length > 0) {
                    stopLossInput = interactiveInputLike[interactiveInputLike.length - 1];
                  }
                }
                
                if (!stopLossInput) {
                  return { success: false, reason: `Input #5 not found. Only ${allInputs.length} inputs available.` };
                }
                
                const inputInfo = {
                  id: stopLossInput.id,
                  className: stopLossInput.className,
                  dataPart: stopLossInput.getAttribute('data-part'),
                  placeholder: stopLossInput.placeholder,
                  type: stopLossInput.type
                };
                
                return { success: true, inputInfo: inputInfo, inputFound: true };
              }, process.env.STOP_LOSS || '');
              
              if (stopLossResult.success && stopLossResult.inputFound) {
                console.log(`[${email}] [POST-TRADE] ✅ Found TP/SL modal and 5th input, filling STOP_LOSS value...`);
                const stopLossValue = process.env.STOP_LOSS || '';
                
                if (!stopLossValue) {
                  console.log(`[${email}] [POST-TRADE] ❌ STOP_LOSS env variable not set! Cannot proceed without STOP_LOSS value`);
                  await handleSetLeverage(page, email);
                  return { success: false, error: 'STOP_LOSS env variable not set' };
                }
                
                try {
                  let inputElement = null;
                  
                  if (stopLossResult.inputInfo.id) {
                    inputElement = await page.$(`#${stopLossResult.inputInfo.id}`);
                  }
                  
                  if (!inputElement && stopLossResult.inputInfo.dataPart) {
                    inputElement = await page.$(`input[data-part="${stopLossResult.inputInfo.dataPart}"]`);
                  }
                  
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
                      inputElement = interactiveInputs[4];
                    } else if (interactiveInputs.length > 0) {
                      inputElement = interactiveInputs[interactiveInputs.length - 1];
                    }
                  }
                  
                  if (inputElement) {
                    await safeClick(page, inputElement);
                    await delay(300);
                    await page.evaluate(el => { el.focus(); el.select(); }, inputElement);
                    await page.keyboard.press('Backspace');
                    await delay(200);
                    await safeType(page, inputElement, stopLossValue, { delay: 50 });
                    await inputElement.evaluate((el, val) => {
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                      el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }, stopLossValue);
                    
                    console.log(`[${email}] ✅ Successfully filled stop loss input with value: ${stopLossValue}`);
                    await delay(100);
                    
                    // Find and click Confirm button in modal
                    console.log(`[${email}] Looking for Confirm button in modal...`);
                    const confirmButton = await page.evaluate(() => {
                      const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                      if (!modal) return null;
                      const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                      const confirmBtn = buttons.find(btn => {
                        const text = btn.textContent?.trim().toLowerCase();
                        const isVisible = btn.offsetParent !== null;
                        return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                      });
                      if (confirmBtn) {
                        return true;
                      }
                      return false;
                    });
                    
                    if (confirmButton) {
                      await page.evaluate(() => {
                        const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                        if (!modal) return;
                        const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                        const confirmBtn = buttons.find(btn => {
                          const text = btn.textContent?.trim().toLowerCase();
                          const isVisible = btn.offsetParent !== null;
                          return isVisible && (text === 'confirm' || text === 'apply' || text === 'save');
                        });
                        if (confirmBtn) {
                          confirmBtn.click();
                        }
                      });
                      console.log(`[${email}] [POST-TRADE] ✅ Successfully clicked Confirm button in TP/SL modal`);
                      await delay(2000);
                      
                      // Verify TP/SL modal closed before proceeding to Limit
                      const tpSlModalClosed = await page.evaluate(() => {
                        const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
                        return modal === null;
                      });
                      
                      if (!tpSlModalClosed) {
                        console.log(`[${email}] [POST-TRADE] ⚠️  TP/SL modal still open after Confirm, waiting...`);
                        await delay(2000);
                      }
                      
                      // Now continue with Limit button flow (same as main flow)
                      console.log(`[${email}] [POST-TRADE] TP/SL added successfully, now looking for Limit button in Positions table (same row as TP/SL)...`);
                      // ... continue with Limit button code from the main flow
                      // (I'll need to extract this into a reusable function or duplicate the logic)
                    } else {
                      console.log(`[${email}] ⚠️  Could not find Confirm button in modal`);
                    }
                  } else {
                    console.log(`[${email}] ⚠️  Could not find input element to fill`);
                  }
                } catch (error) {
                  console.log(`[${email}] ⚠️  Error filling input: ${error.message}`);
                }
              } else {
                console.log(`[${email}] ⚠️  Could not find 5th input: ${stopLossResult.reason || 'unknown'}`);
              }
            }
          }
          
          // Set leverage after handling positions (only reached if TP/SL flow completed)
          await handleSetLeverage(page, email);
        } else {
          console.log(`[${email}] No open positions found, setting leverage...`);
          // No positions, just set leverage
          await handleSetLeverage(page, email);
        }
      } else {
        console.log(`[${email}] ⚠️  Could not click Positions tab, trying to set leverage anyway...`);
        await handleSetLeverage(page, email);
      }
      
      console.log(`[${email}] ✅ Extended Exchange pre/post-trade flow completed`);
      return { success: true };
    } catch (error) {
      console.log(`[${email}] ⚠️  Error in Extended Exchange pre/post-trade flow: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  export { extendedExchangePrePostTradeFlow };