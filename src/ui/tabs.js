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
          if (!skipLeverage) {
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