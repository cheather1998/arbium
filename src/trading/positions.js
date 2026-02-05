import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay } from '../utils/helpers.js';
import { findByExactText, findByText } from '../utils/helpers.js';
import { handleSetLeverage } from './leverage.js';

async function closeAllPositions(page, percent = 100, exchangeConfig = null) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
    console.log(`\n=== Closing Position (${percent}%) on ${exchange.name} ===`);
  
    // Wait a moment for any previous actions to complete
    await delay(700);
  
    // ============================================================================
    // GRVT-SPECIFIC CLOSE POSITION FLOW
    // This block ONLY runs for GRVT exchange - all other exchanges are unaffected
    // ============================================================================
    if (exchange.name === 'GRVT') {
      console.log(`[${exchange.name}] 🔵 GRVT-SPECIFIC CLOSE POSITION FLOW STARTING...`);
      
      // Step 0: Cancel all open orders before closing positions
      console.log(`[${exchange.name}] Step 0: Canceling all open orders before closing positions...`);
      
      // Navigate to Open orders tab
      // GRVT structure: <div data-text="Open orders (1)" class="style_label__3WVdr...">Open orders (1)</div>
      console.log(`[${exchange.name}] Step 0.1: Navigating to Open orders tab...`);
      let openOrdersTabClicked = false;
      
      // Strategy 1: Find by data-text attribute containing "Open orders"
      const clickedByDataText = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
        for (const el of allElements) {
          const dataText = el.getAttribute('data-text');
          if (dataText && dataText.toLowerCase().includes('open orders') && el.offsetParent !== null) {
            el.click();
            return true;
          }
        }
        return false;
      });
      
      if (clickedByDataText) {
        openOrdersTabClicked = true;
        console.log(`[${exchange.name}] ✓ Clicked Open orders tab (via data-text attribute)`);
        await delay(500);
      }
      
      // Strategy 2: Find by text starting with "Open orders" (handles "Open orders (1)" format)
      if (!openOrdersTabClicked) {
        const clickedByText = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
            // Match "Open orders" or "Open orders (1)" or "Open orders (2)" etc.
            if (isVisible && text.toLowerCase().startsWith('open orders')) {
              el.click();
              return true;
            }
          }
          return false;
        });
        
        if (clickedByText) {
          openOrdersTabClicked = true;
          console.log(`[${exchange.name}] ✓ Clicked Open orders tab (via text content)`);
          await delay(500);
        }
      }
      
      // Strategy 3: Find by exact text "Open orders" using helper functions
      if (!openOrdersTabClicked) {
        const openOrdersTab = await findByExactText(page, "Open orders", ["button", "div", "span", "a"]);
        if (openOrdersTab) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, openOrdersTab);
          if (isVisible) {
            await openOrdersTab.click();
            console.log(`[${exchange.name}] ✓ Clicked Open orders tab (exact text helper)`);
            openOrdersTabClicked = true;
            await delay(500);
          }
        }
      }
      
      // Strategy 4: Find by text containing "open orders" (case insensitive) using helper functions
      if (!openOrdersTabClicked) {
        const openOrdersTab2 = await findByText(page, "open orders", ["button", "div", "span", "a"]);
        if (openOrdersTab2) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, openOrdersTab2);
          if (isVisible) {
            await openOrdersTab2.click();
            console.log(`[${exchange.name}] ✓ Clicked Open orders tab (text search helper)`);
            openOrdersTabClicked = true;
            await delay(500);
          }
        }
      }
      
      if (!openOrdersTabClicked) {
        console.log(`[${exchange.name}] ⚠️  Could not find Open orders tab, skipping order cancellation...`);
      }
      
      // Wait for Open orders tab to load
      await delay(1000);
      
      // Find and click "Cancel all orders" button
      console.log(`[${exchange.name}] Step 0.2: Looking for "Cancel all orders" button...`);
      let cancelAllOrdersBtnClicked = false;
      const cancelAllOrdersBtn = await findByExactText(page, "Cancel all orders", ["button", "div", "span"]);
      
      if (cancelAllOrdersBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, cancelAllOrdersBtn);
        if (isVisible) {
          console.log(`[${exchange.name}] ✅ Found "Cancel all orders" button, clicking...`);
          await cancelAllOrdersBtn.click();
          cancelAllOrdersBtnClicked = true;
        }
      }
      
      if (!cancelAllOrdersBtnClicked) {
        const cancelAllOrdersBtn2 = await findByText(page, "Cancel all orders", ["button", "div", "span"]);
        if (cancelAllOrdersBtn2) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, cancelAllOrdersBtn2);
          if (isVisible) {
            console.log(`[${exchange.name}] ✅ Found "Cancel all orders" button, clicking...`);
            await cancelAllOrdersBtn2.click();
            cancelAllOrdersBtnClicked = true;
          }
        }
      }
      
      if (!cancelAllOrdersBtnClicked) {
        console.log(`[${exchange.name}] ⚠️  Could not find "Cancel all orders" button, no orders to cancel - proceeding to close positions...`);
      }
      
      // Wait for confirmation modal to open (only if button was clicked)
      if (cancelAllOrdersBtnClicked) {
        // Wait a moment for modal to appear
        await delay(500);
        
        // Check if confirmation modal opened
        const modalCheck = await page.evaluate(() => {
          const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
          for (const modal of modals) {
            const style = window.getComputedStyle(modal);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              return true;
            }
          }
          return false;
        });
        
        if (modalCheck) {
          console.log(`[${exchange.name}] Step 0.3: Waiting for confirmation modal to open...`);
          let modalOpen = false;
          for (let i = 0; i < 10; i++) {
            await delay(300);
            modalOpen = await page.evaluate(() => {
              const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
              for (const modal of modals) {
                const style = window.getComputedStyle(modal);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  return true;
                }
              }
              return false;
            });
            if (modalOpen) {
              console.log(`[${exchange.name}] ✅ Confirmation modal opened`);
              break;
            }
          }
          
          if (modalOpen) {
            // Find and click Confirm button in modal
            console.log(`[${exchange.name}] Step 0.4: Looking for Confirm button in cancellation modal...`);
            await delay(500); // Wait for modal content to render
            
            let confirmBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);
            if (!confirmBtn) {
              confirmBtn = await findByText(page, "Confirm", ["button", "div", "span"]);
            }
            
            if (confirmBtn) {
              // Verify it's in the modal
              const confirmInModal = await page.evaluate((btn) => {
                let parent = btn.parentElement;
                for (let i = 0; i < 10 && parent; i++) {
                  const role = parent.getAttribute('role');
                  const className = (parent.className || '').toLowerCase();
                  if (role === 'dialog' || 
                      className.includes('modal') || 
                      className.includes('dialog')) {
                    return true;
                  }
                  parent = parent.parentElement;
                }
                return false;
              }, confirmBtn);
              
              if (confirmInModal) {
                console.log(`[${exchange.name}] ✅ Found Confirm button in cancellation modal, clicking...`);
                await confirmBtn.click();
                
                // Wait for modal to close
                console.log(`[${exchange.name}] Step 0.5: Waiting for cancellation modal to close...`);
                let modalClosed = false;
                for (let i = 0; i < 15; i++) {
                  await delay(300);
                  modalClosed = await page.evaluate(() => {
                    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
                    for (const modal of modals) {
                      const style = window.getComputedStyle(modal);
                      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                        return false;
                      }
                    }
                    return true;
                  });
                  if (modalClosed) {
                    console.log(`[${exchange.name}] ✅ Cancellation modal closed`);
                    break;
                  }
                }
                
                // Wait a bit more after cancellation
                await delay(500);
                console.log(`[${exchange.name}] ✅ All orders canceled, proceeding to close positions...`);
              } else {
                console.log(`[${exchange.name}] ⚠️  Found Confirm button but it's not in modal`);
              }
            } else {
              console.log(`[${exchange.name}] ⚠️  Could not find Confirm button in cancellation modal`);
            }
          } else {
            console.log(`[${exchange.name}] ⚠️  Confirmation modal did not open after clicking Cancel all orders, continuing to close positions...`);
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Confirmation modal did not open, continuing to close positions...`);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Cancel all orders button not clicked, proceeding to close positions...`);
      }
      
      // IMPORTANT: Always proceed with close positions flow after order cancellation (or if no orders to cancel)
      console.log(`[${exchange.name}] 🔵 Proceeding to close positions flow after order cancellation...`);
      
      // Now proceed with close positions flow
      // Navigate to Positions tab (GRVT uses similar structure to Open orders tab)
      console.log(`[${exchange.name}] Step 1: Navigating to Positions tab...`);
      let positionsTabClicked = false;
      
      // Strategy 1: Find by data-text attribute containing "Positions"
      const positionsClickedByDataText = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
        for (const el of allElements) {
          const dataText = el.getAttribute('data-text');
          if (dataText && dataText.toLowerCase().includes('positions') && el.offsetParent !== null) {
            el.click();
            return true;
          }
        }
        return false;
      });
      
      if (positionsClickedByDataText) {
        positionsTabClicked = true;
        console.log(`[${exchange.name}] ✓ Clicked Positions tab (via data-text attribute)`);
        await delay(500);
      }
      
      // Strategy 2: Find by text starting with "Positions" (handles "Positions (1)" format)
      if (!positionsTabClicked) {
        const positionsClickedByText = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
            // Match "Positions" or "Positions (1)" or "Positions (2)" etc.
            if (isVisible && text.toLowerCase().startsWith('positions')) {
              el.click();
              return true;
            }
          }
          return false;
        });
        
        if (positionsClickedByText) {
          positionsTabClicked = true;
          console.log(`[${exchange.name}] ✓ Clicked Positions tab (via text content)`);
          await delay(500);
        }
      }
      
      // Strategy 3: Find by exact text "Positions" using helper functions
      if (!positionsTabClicked) {
        const positionsTab = await findByExactText(page, "Positions", ["button", "div", "span", "a"]);
        if (positionsTab) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, positionsTab);
          if (isVisible) {
            await positionsTab.click();
            console.log(`[${exchange.name}] ✓ Clicked Positions tab (exact text helper)`);
            positionsTabClicked = true;
            await delay(500);
          }
        }
      }
      
      // Strategy 4: Find by text containing "positions" (case insensitive) using helper functions
      if (!positionsTabClicked) {
        const positionsTab2 = await findByText(page, "positions", ["button", "div", "span", "a"]);
        if (positionsTab2) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, positionsTab2);
          if (isVisible) {
            await positionsTab2.click();
            console.log(`[${exchange.name}] ✓ Clicked Positions tab (text search helper)`);
            positionsTabClicked = true;
            await delay(500);
          }
        }
      }
      
      if (!positionsTabClicked) {
        console.log(`[${exchange.name}] ⚠️  Could not find Positions tab, continuing anyway...`);
        await delay(500); // Wait a bit for page to stabilize
      }
      
      // Check if there are any open positions by looking for Close buttons in table
      console.log(`[${exchange.name}] Step 2: Checking for open positions by looking for Close buttons...`);
      const hasPositionsCheck = await page.evaluate(() => {
        // GRVT uses div-based table structure, not standard <table>
        // Look for Close buttons in the Actions column
        const allButtons = Array.from(document.querySelectorAll('button'));
        for (const btn of allButtons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'close' && btn.offsetParent !== null) {
            // Verify it's in a positions table (check for nearby "Actions" text or table structure)
            let parent = btn.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              const parentText = parent.textContent || '';
              const parentClass = (parent.className || '').toLowerCase();
              // Check if it's in a positions table structure
              if (parentText.includes('Actions') || 
                  parentClass.includes('tablerow') ||
                  parent.getAttribute('data-sentry-component') === 'TablePositions' ||
                  parent.querySelector('[data-sentry-component="TablePositions"]')) {
                return true;
              }
              parent = parent.parentElement;
            }
          }
        }
        return false;
      });
      
      if (!hasPositionsCheck) {
        console.log(`[${exchange.name}] ✓ No open positions found (no Close buttons in table) - nothing to close`);
        return { success: true, message: "No positions to close" };
      }
      
      console.log(`[${exchange.name}] ✓ Positions found (Close buttons detected) - proceeding to close via modal...`);
      await delay(300); // Wait for UI to fully render
      
      // Step 3: Find Close button in Actions column (last column of table)
      console.log(`[${exchange.name}] Step 3: Looking for Close button in Actions column (last column)...`);
      
      const closeButtonInActions = await page.evaluate(() => {
        // GRVT uses div-based table structure, not standard <table>
        // Look for Close buttons directly
        const allButtons = Array.from(document.querySelectorAll('button'));
        
        for (const btn of allButtons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'close' && btn.offsetParent !== null) {
            // Verify it's in a positions table (check for nearby "Actions" text or table structure)
            let parent = btn.parentElement;
            let inActionsColumn = false;
            for (let i = 0; i < 10 && parent; i++) {
              const parentText = parent.textContent || '';
              const parentClass = (parent.className || '').toLowerCase();
              // Check if it's in Actions column (has "Actions" text nearby or is in last column)
              if (parentText.includes('Actions') || 
                  parentClass.includes('cell-ping-right') || // Last column class
                  parent.querySelector('span')?.textContent?.trim() === 'Actions') {
                inActionsColumn = true;
                break;
              }
              parent = parent.parentElement;
            }
            
            if (inActionsColumn) {
              return {
                found: true,
                text: btn.textContent?.trim() || 'Close'
              };
            }
          }
        }
        
        return { found: false };
      });
      
      if (closeButtonInActions.found) {
        console.log(`[${exchange.name}] ✅ Found Close button in Actions column: "${closeButtonInActions.text}"`);
        
        // Click the Close button
        const closeBtnElement = await page.evaluateHandle(() => {
          // GRVT uses div-based table structure
          const allButtons = Array.from(document.querySelectorAll('button'));
          
          for (const btn of allButtons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'close' && btn.offsetParent !== null) {
              // Verify it's in Actions column
              let parent = btn.parentElement;
              let inActionsColumn = false;
              for (let i = 0; i < 10 && parent; i++) {
                const parentText = parent.textContent || '';
                const parentClass = (parent.className || '').toLowerCase();
                if (parentText.includes('Actions') || 
                    parentClass.includes('cell-ping-right') ||
                    parent.querySelector('span')?.textContent?.trim() === 'Actions') {
                  inActionsColumn = true;
                  break;
                }
                parent = parent.parentElement;
              }
              
              if (inActionsColumn) {
                return btn;
              }
            }
          }
          return null;
        });
        
        if (closeBtnElement && closeBtnElement.asElement()) {
          // Step 1.5: Close any other modals that might be open
          console.log(`[${exchange.name}] Step 1.5: Checking for and closing any other open modals...`);
          const closedOtherModals = await page.evaluate(() => {
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'));
            let closed = false;
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                // Try to find and click close button (X) in modal
                const closeButtons = Array.from(modal.querySelectorAll('button, [role="button"]'));
                const closeBtn = closeButtons.find(btn => {
                  const text = (btn.textContent || '').trim().toLowerCase();
                  const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                  return text === '×' || text === 'x' || text === 'close' || 
                         ariaLabel.includes('close') || 
                         (btn.querySelector('svg') && text === '');
                });
                if (closeBtn) {
                  closeBtn.click();
                  closed = true;
                } else {
                  // Try pressing Escape key
                  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
                  closed = true;
                }
              }
            }
            return closed;
          });
          
          if (closedOtherModals) {
            console.log(`[${exchange.name}] ✅ Closed other open modal(s), waiting a moment...`);
            await delay(500);
          }
          
          console.log(`[${exchange.name}] Clicking Close button to open modal...`);
          await closeBtnElement.asElement().click();
          
          // Step 4: Wait for modal to fully render after Close button click
          console.log(`[${exchange.name}] Step 4: Waiting for modal to fully render...`);
          
          // Wait for modal to appear and be visible
          let modalOpen = false;
          for (let i = 0; i < 10; i++) {
            await delay(300);
            modalOpen = await page.evaluate(() => {
              const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
              for (const modal of modals) {
                const style = window.getComputedStyle(modal);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  return true;
                }
              }
              return false;
            });
            
            if (modalOpen) {
              console.log(`[${exchange.name}] ✅ Modal detected and visible`);
              break;
            }
          }
          
          if (!modalOpen) {
            console.log(`[${exchange.name}] ⚠️  Modal not detected after waiting, but continuing anyway...`);
            await delay(500); // Give it a bit more time
          } else {
            // Wait a bit more for modal content to fully render
            await delay(500);
          }
          
          // Find and click Limit option in modal - ALWAYS select Limit before Confirm
          // Structure: <div class="style_toggleItem__ZIcFf">Limit</div> with data-active="false"
          // After click, it should have data-active="true" and class "style_active__vVGd1"
          console.log(`[${exchange.name}] Step 5: Looking for Limit option in modal using toggle structure...`);
          
          // Find Limit button using the specific toggle structure
          const limitButtonHandle = await page.evaluateHandle(() => {
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'));
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                // Look for toggle container with class "style_toggle__j_fck"
                const toggleContainer = modal.querySelector('.style_toggle__j_fck, [class*="toggle"]');
                if (toggleContainer) {
                  // Find Limit div inside toggle container
                  const toggleItems = Array.from(toggleContainer.querySelectorAll('.style_toggleItem__ZIcFf, [class*="toggleItem"], div'));
                  for (const item of toggleItems) {
                    const text = (item.textContent || '').trim();
                    if (text === 'Limit' && item.offsetParent !== null) {
                      return item; // Found Limit toggle item
                    }
                  }
                }
                
                // Fallback: Find any div with text "Limit" that has toggle-related classes
                const allDivs = Array.from(modal.querySelectorAll('div'));
                for (const div of allDivs) {
                  const text = (div.textContent || '').trim();
                  const className = (div.className || '').toLowerCase();
                  if (text === 'Limit' && 
                      (className.includes('toggle') || 
                       div.getAttribute('data-active') !== null ||
                       div.parentElement?.className?.includes('toggle'))) {
                    if (div.offsetParent !== null) {
                      return div;
                    }
                  }
                }
                
                // Last fallback: Find any element with text "Limit" in modal
                const allElements = Array.from(modal.querySelectorAll('div, button, span'));
                for (const el of allElements) {
                  const text = (el.textContent || '').trim();
                  if (text === 'Limit' && el.offsetParent !== null) {
                    return el;
                  }
                }
              }
            }
            return null;
          });
          
          let limitSelected = false;
          
          if (limitButtonHandle && limitButtonHandle.asElement()) {
            console.log(`[${exchange.name}] ✅ Found Limit toggle button in modal, clicking to switch from Market to Limit...`);
            await limitButtonHandle.asElement().click();
            await delay(500); // Wait for Limit option to activate
            limitSelected = true;
          } else {
            // Fallback: Try using helper functions
            console.log(`[${exchange.name}] ⚠️  Could not find Limit using toggle structure, trying helper functions...`);
            let limitOption = await findByExactText(page, "Limit", ["button", "div", "span", "a"]);
            
            if (!limitOption) {
              limitOption = await findByText(page, "Limit", ["button", "div", "span", "a"]);
            }
            
            if (limitOption) {
              console.log(`[${exchange.name}] ✅ Found Limit option using helper functions, clicking...`);
              await limitOption.click();
              await delay(500);
              limitSelected = true;
            } else {
              console.log(`[${exchange.name}] ⚠️  Could not find Limit option in modal`);
            }
          }
          
          // Verify Limit is selected before proceeding to Confirm
          if (limitSelected) {
            // Wait a moment for UI to update
            await delay(300);
            
            // Verify that Limit is now selected using data-active="true" and style_active__vVGd1 class
            const limitVerified = await page.evaluate(() => {
              const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'));
              for (const modal of modals) {
                const style = window.getComputedStyle(modal);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  // Look for Limit toggle item with data-active="true" and style_active__vVGd1 class
                  const toggleContainer = modal.querySelector('.style_toggle__j_fck, [class*="toggle"]');
                  if (toggleContainer) {
                    const toggleItems = Array.from(toggleContainer.querySelectorAll('.style_toggleItem__ZIcFf, [class*="toggleItem"], div'));
                    for (const item of toggleItems) {
                      const text = (item.textContent || '').trim();
                      if (text === 'Limit') {
                        const dataActive = item.getAttribute('data-active');
                        const className = (item.className || '').toLowerCase();
                        // Check if Limit is selected: data-active="true" or has style_active__vVGd1 class
                        if (dataActive === 'true' || className.includes('style_active__vvgd1') || className.includes('active')) {
                          return true; // Limit is selected
                        }
                      }
                    }
                  }
                  
                  // Fallback: Check any Limit element
                  const allElements = Array.from(modal.querySelectorAll('div, button, span'));
                  for (const el of allElements) {
                    const text = (el.textContent || '').trim();
                    if (text === 'Limit') {
                      const dataActive = el.getAttribute('data-active');
                      const className = (el.className || '').toLowerCase();
                      const btnStyle = window.getComputedStyle(el);
                      if (dataActive === 'true' || 
                          className.includes('active') || 
                          className.includes('selected') ||
                          btnStyle.backgroundColor.includes('255') ||
                          btnStyle.backgroundColor === 'rgb(255, 255, 255)') {
                        return true; // Limit is selected
                      }
                    }
                  }
                }
              }
              return false; // Limit not selected
            });
            
            if (!limitVerified) {
              console.log(`[${exchange.name}] ⚠️  Limit clicked but not verified as selected, clicking again...`);
              // Click Limit again
              if (limitButtonHandle && limitButtonHandle.asElement()) {
                await limitButtonHandle.asElement().click();
              } else {
                const limitOption = await findByExactText(page, "Limit", ["button", "div", "span", "a"]);
                if (limitOption) {
                  await limitOption.click();
                }
              }
              await delay(500);
              
              // Final verification using data-active attribute
              const stillNotSelected = await page.evaluate(() => {
                const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]'));
                for (const modal of modals) {
                  const style = window.getComputedStyle(modal);
                  if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    const toggleContainer = modal.querySelector('.style_toggle__j_fck, [class*="toggle"]');
                    if (toggleContainer) {
                      const toggleItems = Array.from(toggleContainer.querySelectorAll('div'));
                      for (const item of toggleItems) {
                        const text = (item.textContent || '').trim();
                        if (text === 'Limit') {
                          const dataActive = item.getAttribute('data-active');
                          const className = (item.className || '').toLowerCase();
                          // Return true if still not selected (data-active !== 'true')
                          return dataActive !== 'true' && !className.includes('style_active__vvgd1') && !className.includes('active');
                        }
                      }
                    }
                  }
                }
                return true; // Couldn't verify, assume not selected
              });
              
              if (stillNotSelected) {
                console.log(`[${exchange.name}] ⚠️  CRITICAL: Limit still not selected after clicking! Cannot proceed to Confirm.`);
                return { success: false, message: "Could not select Limit option in modal - still showing Market" };
              } else {
                console.log(`[${exchange.name}] ✅ Limit verified as selected after second click (data-active="true")`);
              }
            } else {
              console.log(`[${exchange.name}] ✅ Limit option verified as selected (data-active="true" or style_active__vVGd1 class)`);
            }
          } else {
            console.log(`[${exchange.name}] ⚠️  CRITICAL: Limit option not clicked! Cannot proceed to Confirm.`);
            return { success: false, message: "Could not find or click Limit option in modal" };
          }
          
          // Small delay after Limit selection before clicking Confirm
          console.log(`[${exchange.name}] Waiting a moment after Limit selection before Confirm...`);
          await delay(500); // Increased wait time after Limit selection
          
          // Step 6: Find and click Confirm button in modal (ONLY after Limit is selected)
          console.log(`[${exchange.name}] Step 6: Looking for Confirm button in modal (Limit is selected)...`);
          await delay(300); // Additional wait before looking for Confirm
          
          let confirmBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);
          
          if (!confirmBtn) {
            confirmBtn = await findByText(page, "Confirm", ["button", "div", "span"]);
          }
          
          if (confirmBtn) {
            // Verify it's in the modal
            const confirmInModal = await page.evaluate((btn) => {
              let parent = btn.parentElement;
              for (let i = 0; i < 10 && parent; i++) {
                const role = parent.getAttribute('role');
                const className = (parent.className || '').toLowerCase();
                if (role === 'dialog' || 
                    className.includes('modal') || 
                    className.includes('dialog')) {
                  return true;
                }
                parent = parent.parentElement;
              }
              return false;
            }, confirmBtn);
            
            if (confirmInModal) {
              console.log(`[${exchange.name}] ✅ Found Confirm button in modal, clicking...`);
              try {
                await confirmBtn.click();
                console.log(`[${exchange.name}] ✅ Clicked Confirm button`);
                
                // Step 7: Wait for modal to close automatically after Confirm click
                // When Limit is selected and Confirm is clicked, the modal closes automatically
                console.log(`[${exchange.name}] Step 7: Waiting for modal to close automatically after Confirm click...`);
                let modalClosed = false;
                const maxWaitIterations = 30; // Wait up to 9 seconds (30 * 300ms) for automatic close
                for (let i = 0; i < maxWaitIterations; i++) {
                  await delay(300);
                  modalClosed = await page.evaluate(() => {
                    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
                    for (const modal of modals) {
                      const style = window.getComputedStyle(modal);
                      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                        return false; // Modal still open
                      }
                    }
                    return true; // All modals closed automatically
                  });
                  
                  if (modalClosed) {
                    console.log(`[${exchange.name}] ✅ Modal closed automatically - position close order placed (waited ${(i + 1) * 300}ms)`);
                    break;
                  }
                  
                  // Log progress every 3 seconds
                  if ((i + 1) % 10 === 0) {
                    console.log(`[${exchange.name}] ⏳ Still waiting for modal to close automatically... (${(i + 1) * 300}ms elapsed)`);
                  }
                }
                
                if (!modalClosed) {
                  console.log(`[${exchange.name}] ⚠️  Modal still open after ${maxWaitIterations * 300}ms - it should close automatically after Limit + Confirm`);
                  console.log(`[${exchange.name}] ⚠️  Waiting a bit more for automatic close...`);
                  await delay(2000); // Wait 2 more seconds
                  
                  // Final check
                  modalClosed = await page.evaluate(() => {
                    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
                    for (const modal of modals) {
                      const style = window.getComputedStyle(modal);
                      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                        return false;
                      }
                    }
                    return true;
                  });
                  
                  if (!modalClosed) {
                    console.log(`[${exchange.name}] ❌ CRITICAL: Modal still open after waiting! Cannot proceed to leverage setting.`);
                    return { success: false, message: "Modal did not close automatically after Confirm click - cannot proceed" };
                  }
                }
                
                // Wait a bit more for UI to stabilize before proceeding to leverage
                await delay(500);
                console.log(`[${exchange.name}] ✅ Position close flow complete, modal closed automatically, ready for leverage setting`);
                return { success: true, message: "GRVT position closed via modal flow, modal closed automatically" };
              } catch (error) {
                console.log(`[${exchange.name}] ⚠️  Error clicking Confirm: ${error.message}, trying JavaScript click...`);
                await confirmBtn.evaluate((el) => el.click());
                
                // Wait for modal to close automatically after JavaScript click
                console.log(`[${exchange.name}] Waiting for modal to close automatically after JavaScript click...`);
                let modalClosed = false;
                const maxWaitIterations = 30; // Wait up to 9 seconds
                for (let i = 0; i < maxWaitIterations; i++) {
                  await delay(300);
                  modalClosed = await page.evaluate(() => {
                    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
                    for (const modal of modals) {
                      const style = window.getComputedStyle(modal);
                      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                        return false;
                      }
                    }
                    return true;
                  });
                  if (modalClosed) {
                    console.log(`[${exchange.name}] ✅ Modal closed automatically after JavaScript click`);
                    break;
                  }
                }
                
                if (!modalClosed) {
                  console.log(`[${exchange.name}] ⚠️  Modal still open, waiting a bit more for automatic close...`);
                  await delay(2000);
                  
                  // Final check
                  modalClosed = await page.evaluate(() => {
                    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
                    for (const modal of modals) {
                      const style = window.getComputedStyle(modal);
                      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                        return false;
                      }
                    }
                    return true;
                  });
                  
                  if (!modalClosed) {
                    console.log(`[${exchange.name}] ❌ CRITICAL: Modal still open after JavaScript click! Cannot proceed.`);
                    return { success: false, message: "Modal did not close automatically after Confirm click - cannot proceed" };
                  }
                }
                
                await delay(500);
                console.log(`[${exchange.name}] ✅ Position close flow complete, modal closed automatically, ready for leverage setting`);
                return { success: true, message: "Confirm clicked via JavaScript, modal closed automatically" };
              }
            } else {
              console.log(`[${exchange.name}] ⚠️  Found Confirm button but it's not in modal`);
            }
          } else {
            console.log(`[${exchange.name}] ⚠️  Could not find Confirm button in modal`);
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not get Close button element handle`);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Could not find Close button in Actions column`);
      }
      
      // If GRVT flow failed, fall through to general flow (shouldn't happen if flow is correct)
      console.log(`[${exchange.name}] ⚠️  GRVT-specific flow failed or incomplete, continuing with general flow...`);
    }
    
    // ============================================================================
    // GENERIC CLOSE POSITION FLOW (for Paradex, Extended, Kraken, etc.)
    // This code runs for all non-GRVT exchanges
    // ============================================================================
    
    // Step 1 (for Paradex): Look for Limit button in Positions table Close column BEFORE any Close All button logic
    // The Close column has buttons with text "Market" and "Limit" in MarketCloseButton__Container
    // IMPORTANT: This must happen BEFORE looking for "Close All" button
    console.log(`Step 1: Looking for Limit button in Positions table Close column (before Close All button)...`);
    
    // Make sure we're on the Positions tab before looking for Limit button
    // IMPORTANT: Do NOT navigate to Orders tab - stay on Positions tab
    const isOnPositionsTab = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes("Positions") && (
        text.includes("Market") ||
        text.includes("Size") ||
        text.includes("Entry Price") ||
        text.includes("Unrealized P&L")
      );
    });
    
    if (!isOnPositionsTab) {
      console.log(`[Paradex] ⚠️  Not on Positions tab after TP/SL setup, switching to Positions tab...`);
      console.log(`[Paradex] ⚠️  CRITICAL: Must stay on Positions tab to find Limit button - DO NOT navigate to Orders tab`);
      const positionsTab = await findByExactText(page, exchange.selectors.positionsTab, [
        "button",
        "div",
        "span",
      ]);
      if (positionsTab) {
        await positionsTab.click();
        console.log(`[Paradex] ✓ Clicked Positions tab - staying on Positions tab to find Limit button`);
        await delay(300); // Wait for positions to load
      } else {
        console.log(`[Paradex] ⚠️  Could not find Positions tab - this will prevent finding Limit button`);
      }
    } else {
      console.log(`[Paradex] ✓ Already on Positions tab - ready to find Limit button`);
    }
    
    // Wait a bit more for the table to fully render
    await delay(300);
    
    // CRITICAL: After TP/SL is set, we MUST find and click Limit button
    // Do NOT navigate to Orders tab - stay on Positions tab
    console.log(`[Paradex] 🔍 Now searching for Limit button in Positions table Close column (after TP/SL setup)...`);
    console.log(`[Paradex] ⚠️  IMPORTANT: Must stay on Positions tab - DO NOT navigate to Orders tab`);
    
    // Try multiple strategies to find and click Limit button (similar to Close All button detection)
    let limitBtn = null;
    let limitBtnClicked = false;
    
    // Strategy 1: Find Limit button in the same row as TP/SL button (in Close column)
    console.log(`[Paradex] Strategy 1: Searching for Limit button in Close column (same row as TP/SL)...`);
    const limitButtonInCloseColumn = await page.evaluate(() => {
      // Find all tables
      const tables = Array.from(document.querySelectorAll('table'));
      
      for (const table of tables) {
        // Find header row to locate Close column
        const headerRow = table.querySelector('thead tr, thead > tr, tr:first-child');
        if (!headerRow) continue;
        
        const headers = Array.from(headerRow.querySelectorAll('th, td'));
        let closeColumnIndex = -1;
        
        // Find Close column (usually has "Market" and "Limit" buttons)
        for (let i = 0; i < headers.length; i++) {
          const headerText = headers[i].textContent?.trim().toLowerCase();
          if (headerText && (headerText.includes('close') || headerText.includes('action'))) {
            closeColumnIndex = i;
            break;
          }
        }
        
        // If Close column not found by header, look for column with Market and Limit buttons
        if (closeColumnIndex === -1) {
          const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
          for (const row of dataRows) {
            const cells = Array.from(row.querySelectorAll('td, th'));
            for (let i = 0; i < cells.length; i++) {
              const cell = cells[i];
              const hasMarketBtn = Array.from(cell.querySelectorAll('button')).some(
                btn => btn.textContent?.trim() === 'Market'
              );
              const hasLimitBtn = Array.from(cell.querySelectorAll('button')).some(
                btn => btn.textContent?.trim() === 'Limit'
              );
              if (hasMarketBtn && hasLimitBtn) {
                closeColumnIndex = i;
                break;
              }
            }
            if (closeColumnIndex !== -1) break;
          }
        }
        
        if (closeColumnIndex === -1) {
          console.log('Close column not found in table');
          return null;
        }
        
        // Find data rows
        const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
        
        // Find first data row and get Limit button from Close column
        for (const row of dataRows) {
          const cells = Array.from(row.querySelectorAll('td, th'));
          if (cells.length > closeColumnIndex) {
            const closeCell = cells[closeColumnIndex];
            
            // Find Limit button in this cell
            const limitBtn = Array.from(closeCell.querySelectorAll('button')).find(
              btn => {
                const text = btn.textContent?.trim();
                const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                return isVisible && text === 'Limit';
              }
            );
            
            if (limitBtn) {
              console.log('Found Limit button in Close column');
              limitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              limitBtn.click();
              return { found: true, text: 'Limit' };
            }
          }
        }
      }
      
      return null;
    });
    
    if (limitButtonInCloseColumn && limitButtonInCloseColumn.found) {
      limitBtnClicked = true;
      console.log(`[Paradex] ✅ Successfully clicked Limit button in Close column!`);
    } else {
      console.log(`[Paradex] ⚠️  Limit button not found in Close column of Positions table`);
      console.log(`[Paradex] ⚠️  This likely means no positions exist or table structure is different`);
    }
    
    // Strategy 2: If not found, try to find by evaluating the page and click directly (same as Close All Strategy 2)
    if (!limitBtn && !limitBtnClicked) {
      console.log(`[Paradex] Strategy 2: Searching for Limit button via page.evaluate...`);
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll(
            'button, div[role="button"], a[role="button"]'
          )
        );
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          const isVisible = btn.offsetParent !== null;
          
          if (isVisible && text === "Limit") {
            // Verify it's in Close column (has Market button nearby)
            let parent = btn.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              if (parent.tagName?.toLowerCase() === "td") {
                // Check if there's also a "Market" button in the same container or td
                const container = parent.querySelector('[class*="MarketCloseButton"]');
                if (container) {
                  const marketBtn = Array.from(container.querySelectorAll('button')).find(
                    b => b.textContent?.trim() === "Market"
                  );
                  if (marketBtn) {
                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    btn.click();
                    return true;
                  }
                }
                // Also check if there's a Market button in the same td
                const marketBtn = Array.from(parent.querySelectorAll('button')).find(
                  b => b.textContent?.trim() === "Market"
                );
                if (marketBtn) {
                  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  btn.click();
                  return true;
                }
              }
              parent = parent.parentElement;
            }
          }
        }
        return false;
      });
      
      if (clicked) {
        limitBtnClicked = true;
        console.log("✓ Clicked Limit button (via evaluate)");
      }
    }
    
    // Strategy 3: Try finding by aria-label (same as Close All Strategy 3)
    if (!limitBtn && !limitBtnClicked) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll(
            'button, div[role="button"], a[role="button"]'
          )
        );
        for (const btn of buttons) {
          const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";
          const isVisible = btn.offsetParent !== null;
          if (
            isVisible &&
            (ariaLabel.includes("limit") || ariaLabel === "limit")
          ) {
            // Verify it's in Close column (has Market button nearby)
            let parent = btn.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              if (parent.tagName?.toLowerCase() === "td") {
                const marketBtn = Array.from(parent.querySelectorAll('button')).find(
                  b => b.textContent?.trim() === "Market"
                );
                if (marketBtn) {
                  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  btn.click();
                  return true;
                }
              }
              parent = parent.parentElement;
            }
          }
        }
        return false;
      });
      
      if (clicked) {
        limitBtnClicked = true;
        console.log("✓ Clicked Limit button (via aria-label)");
      }
    }
    
    // Strategy 4: Fallback - Look for button with text "Limit" inside MarketCloseButton__Container divs
    if (!limitBtn && !limitBtnClicked) {
      const limitButtonByText = await page.evaluate(() => {
        // Look for button with text "Limit" inside MarketCloseButton__Container divs
        const containers = Array.from(document.querySelectorAll('[class*="MarketCloseButton__Container"]'));
        console.log(`Found ${containers.length} MarketCloseButton containers`);
        
        for (const container of containers) {
          const buttons = Array.from(container.querySelectorAll('button'));
          for (const btn of buttons) {
            const text = btn.textContent?.trim();
            const isVisible = btn.offsetParent !== null;
            if (isVisible && text === "Limit") {
              console.log(`Found Limit button in MarketCloseButton container`);
              return { element: btn, text: text };
            }
          }
        }
        
        // Also try finding by looking for buttons in td elements
        const allTds = Array.from(document.querySelectorAll('td'));
        for (const td of allTds) {
          const buttons = Array.from(td.querySelectorAll('button'));
          if (buttons.length >= 2) {
            const buttonTexts = buttons.map(b => b.textContent?.trim()).filter(Boolean);
            if (buttonTexts.includes('Market') && buttonTexts.includes('Limit')) {
              const limitBtn = buttons.find(b => b.textContent?.trim() === 'Limit');
              if (limitBtn && limitBtn.offsetParent !== null) {
                console.log(`Found Limit button in TD with Market button`);
                return { element: limitBtn, text: 'Limit' };
              }
            }
          }
        }
        
        return null;
      });
      
      if (limitButtonByText) {
        console.log(`✓ Found Limit button in Close column: "${limitButtonByText.text}"`);
        await page.evaluate((btn) => {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          btn.click();
        }, limitButtonByText.element);
        limitBtnClicked = true;
      }
    }
    
    // Set result based on whether Limit button was clicked
    if (limitBtnClicked) {
      var limitButtonClicked = { success: true, text: "Limit" };
    } else {
      console.log(`⚠ Limit button not found in Close column`);
      var limitButtonClicked = { success: false, error: "Limit button not found in Close column" };
    }
    
    if (limitButtonClicked.success) {
      console.log(`✓ Clicked Limit button: "${limitButtonClicked.text}"`);
      
      // Wait for modal to appear and find button with text "close"
      await delay(800); // Wait for modal to fully load
      
      const closeButtonClicked = await page.evaluate(() => {
        // First, find the visible modal
        const modals = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="Dialog"]'));
        let visibleModal = null;
        
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          const isVisible = modal.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden';
          if (isVisible) {
            visibleModal = modal;
            break;
          }
        }
        
        if (!visibleModal) {
          // Fallback: look for buttons anywhere
          const allButtons = Array.from(document.querySelectorAll("button"));
          for (const btn of allButtons) {
            const text = btn.textContent?.trim().toLowerCase();
            const isVisible = btn.offsetParent !== null;
            
            if (isVisible && text && text.includes("close")) {
              console.log(`Found close button (no modal): "${btn.textContent?.trim()}"`);
              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              btn.click();
              return { success: true, text: btn.textContent?.trim() };
            }
          }
          return { success: false, error: "No visible modal found" };
        }
        
        // Look for buttons with text containing "close" in the modal
        const buttons = Array.from(visibleModal.querySelectorAll("button"));
        console.log(`Found ${buttons.length} buttons in modal`);
        
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase();
          const isVisible = btn.offsetParent !== null;
          
          if (isVisible && text && text.includes("close")) {
            console.log(`Found close button: "${btn.textContent?.trim()}"`);
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            btn.click();
            return { success: true, text: btn.textContent?.trim() };
          }
        }
        
        // Log all buttons for debugging
        console.log("All buttons in modal:");
        buttons.forEach((btn, idx) => {
          if (btn.offsetParent !== null) {
            console.log(`  [${idx}] "${btn.textContent?.trim()}"`);
          }
        });
        
        return { success: false, error: "Close button not found in modal" };
      });
      
      if (closeButtonClicked.success) {
        console.log(`✓ Clicked "${closeButtonClicked.text}" button`);
        
        // Wait 10 seconds and check if position closed
        console.log(`✓ Limit close modal submitted. Waiting 10 seconds to check if position closed...`);
        
        const limitWaitTime = 10000; // 10 seconds
        const checkInterval = 700; // Check every 2 seconds
        const totalChecks = limitWaitTime / checkInterval; // 5 checks
        let positionClosed = false;
        
        for (let i = 0; i < totalChecks; i++) {
          await delay(checkInterval);
          
          // Check if position is closed
          positionClosed = await page.evaluate(() => {
            const text = document.body.innerText;
            const hasPositionIndicators = (
              text.includes("Current Position") ||
              text.includes("Unrealized P&L") ||
              text.includes("Position Size") ||
              text.includes("Entry Price")
            );
            
            const hasNoPositionsMessage = (
              text.includes("No positions") ||
              text.includes("No open positions") ||
              text.includes("You have no open positions")
            );
            
            return !hasPositionIndicators || hasNoPositionsMessage;
          });
          
          if (positionClosed) {
            console.log(`✓ Position closed successfully with Limit order!`);
            return { success: true, message: `Position closed with Limit order` };
          }
          
          console.log(`  Check ${i + 1}/${totalChecks}: Position still open, waiting...`);
        }
        
        // If not closed after 10 seconds, check one more time before falling back
        if (!positionClosed) {
          // Final check to make sure position is really not closed
          const finalCheck = await checkIfPositionsClosed(page);
          if (finalCheck) {
            console.log(`✓ Position closed successfully with Limit order (final check)!`);
            return { success: true, message: `Position closed with Limit order` };
          }
          console.log(`⚠ Position not closed after 10 seconds with Limit order. placing new order`);
     
          return { success: false, message: `Position not closed after 10 seconds with Limit order` };
          // Continue to the existing Close All flow below
        }
      } else {
        console.log(`⚠ Could not click close button: ${closeButtonClicked.error}`);
        // Check if position was closed anyway (maybe the click worked but we didn't detect it)
        const positionCheck = await checkIfPositionsClosed(page);
        if (positionCheck) {
          console.log(`✓ Position closed successfully with Limit order (position check after error)!`);
          return { success: true, message: `Position closed with Limit order` };
        }
        console.log(`⚠ Continuing with Close All flow...`);
        // Continue to the existing Close All flow below
      }
    } else {
      console.log(`⚠ Could not find Limit button: ${limitButtonClicked.error}`);
      console.log(`⚠ Continuing with Close All flow...`);
      // Continue to the existing Close All flow below
    }
  
    // Before proceeding to Close All flow, do a final check to see if position is already closed
    // This prevents showing the market close modal if position was already closed using Limit
    const finalPositionCheck = await checkIfPositionsClosed(page);
    if (finalPositionCheck) {
      console.log(`✓ Position already closed - skipping Close All flow to avoid showing market close modal`);
      return { success: true, message: `Position already closed (no need for market close)` };
    }
  
    // Step 2: ONLY if Limit button was not found or didn't work - Look for Close All button
    // This is the fallback method - only proceed if Limit button approach failed
    console.log(`Step 2: Looking for Close All button (fallback method - only if Limit button failed)...`);
    // Look for Close buttons with multiple strategies
    const closeButtonsDebug = await page.evaluate(() => {
      const allButtons = Array.from(
        document.querySelectorAll(
          'button, div[role="button"], a[role="button"], [class*="button"]'
        )
      );
  
      const candidates = [];
  
      for (const btn of allButtons) {
        const text = btn.textContent?.trim().toLowerCase();
        const isVisible = btn.offsetParent !== null;
  
        // Strategy 1: Text contains "close"
        if (text && (text.includes("close") || text === "x")) {
          candidates.push({
            text: btn.textContent?.trim(),
            visible: isVisible,
            className: btn.className,
            strategy: "text-match",
          });
        }
  
        // Strategy 2: Button near position-related text
        if (isVisible) {
          const parentText = btn.parentElement?.textContent?.toLowerCase() || "";
          if (
            parentText.includes("position") &&
            (text?.includes("close") ||
              text?.includes("exit") ||
              text?.includes("sell") ||
              text?.includes("buy"))
          ) {
            candidates.push({
              text: btn.textContent?.trim(),
              visible: isVisible,
              className: btn.className,
              strategy: "context-match",
            });
          }
        }
  
        // Strategy 3: Look for buttons with aria-label containing "close"
        const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";
        if (ariaLabel.includes("close") || ariaLabel.includes("exit")) {
          candidates.push({
            text: btn.textContent?.trim() || ariaLabel,
            visible: isVisible,
            className: btn.className,
            strategy: "aria-label",
          });
        }
      }
  
      return candidates;
    });
  
    console.log(
      `Found ${closeButtonsDebug.length} close-related buttons:`,
      JSON.stringify(closeButtonsDebug, null, 2)
    );
  
    // Try multiple strategies to find and click close button
    let closeBtn = null;
    let closeBtnClicked = false;
  
    // Strategy 1: Find by text "Close" or "Close All" using existing function
    closeBtn = await findByText(page, "Close", ["button", "div", "a"]);
    if (!closeBtn) {
      closeBtn = await findByText(page, "Close All", ["button", "div", "a"]);
    }
  
    // Strategy 2: If not found, try to find by evaluating the page and click directly
    if (!closeBtn && !closeBtnClicked) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll(
            'button, div[role="button"], a[role="button"]'
          )
        );
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase();
          const isVisible = btn.offsetParent !== null;
          if (isVisible && text && (text.includes("close") || text === "x")) {
            btn.click();
            return true;
          }
        }
        return false;
      });
  
      if (clicked) {
        closeBtnClicked = true;
        console.log("Clicked Close button (via evaluate)");
      }
    }
  
    // Strategy 3: Try finding by aria-label and click directly
    if (!closeBtn && !closeBtnClicked) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll(
            'button, div[role="button"], a[role="button"]'
          )
        );
        for (const btn of buttons) {
          const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";
          const isVisible = btn.offsetParent !== null;
          if (
            isVisible &&
            (ariaLabel.includes("close") || ariaLabel.includes("exit"))
          ) {
            btn.click();
            return true;
          }
        }
        return false;
      });
  
      if (clicked) {
        closeBtnClicked = true;
        console.log("Clicked Close button (via aria-label)");
      }
    }
  
    // Strategy 4: Use buttons found in debug step (fallback) - try to click "Close All" button
    if (!closeBtn && !closeBtnClicked && closeButtonsDebug.length > 0) {
      console.log(`Found ${closeButtonsDebug.length} close button(s) in debug, attempting to click...`);
      // Wait a bit for UI to stabilize
      await delay(500);
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll(
            'button, div[role="button"], a[role="button"], [class*="button"]'
          )
        );
        // First, try to find "Close All" button (exact text match, case insensitive)
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          const isVisible = btn.offsetParent !== null;
          if (isVisible && text && text.toLowerCase() === "close all") {
            try {
              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              btn.click();
              return { success: true, method: 'exact-match' };
            } catch (e) {
              console.log(`Error clicking exact match: ${e.message}`);
            }
          }
        }
        // Fallback: try any button with "close" in text
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase();
          const isVisible = btn.offsetParent !== null;
          if (isVisible && text && text.includes("close") && !text.includes("position")) {
            // Make sure it's not a position close button (we want "Close All")
            if (text.includes("all") || text === "close") {
              try {
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                btn.click();
                return { success: true, method: 'partial-match' };
              } catch (e) {
                console.log(`Error clicking partial match: ${e.message}`);
              }
            }
          }
        }
        return { success: false };
      });
  
      if (clicked && clicked.success) {
        closeBtnClicked = true;
        console.log(`✓ Clicked Close button (via debug fallback - ${clicked.method})`);
      } else {
        console.log("⚠ Debug fallback strategy failed to click button");
      }
    }
  
    if (!closeBtn && !closeBtnClicked && closeButtonsDebug.length === 0) {
      console.log("No close buttons found after multiple strategies");
      return { success: false, error: "No close buttons found in positions" };
    }
  
    if (closeBtn && !closeBtnClicked) {
      await closeBtn.click();
      console.log("Clicked Close button");
    }
  
    // Wait for modal to appear (whether clicked via element or evaluate)
    if (closeBtn || closeBtnClicked) {
      await delay(1000); // Reduced from 2000ms - wait for modal to fully load
  
      // Select the percentage by clicking the percentage button in the modal
      console.log(`Setting close percentage to ${percent}%`);
  
      // Find and click the percentage button in the modal
      // These buttons are INSIDE the modal, below "Position Value (Closing)"
      const percentButtonClicked = await page.evaluate((targetPercent) => {
        const buttons = Array.from(document.querySelectorAll("button"));
  
        // Find buttons that are just the percentage (like "50%", "25%", etc)
        // AND are inside a modal (check for modal-related parent)
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
  
          // Check if this is a percentage button
          if (text === `${targetPercent}%`) {
            // Check if it's in the modal by looking for modal-related parent elements
            let parent = btn.parentElement;
            let isInModal = false;
  
            // Check up to 10 levels up for modal indicators
            for (let i = 0; i < 10 && parent; i++) {
              const parentText = parent.textContent || "";
              if (
                parentText.includes("Close All Positions") ||
                parentText.includes("Position Value (Closing)")
              ) {
                isInModal = true;
                break;
              }
              parent = parent.parentElement;
            }
  
            if (isInModal) {
              console.log(`Found ${targetPercent}% button in modal, clicking it`);
              btn.click();
              return { success: true, clicked: text };
            }
          }
        }
  
        return {
          success: false,
          error: `${targetPercent}% button not found in modal`,
        };
      }, percent);
  
      if (!percentButtonClicked.success) {
        console.log(`Error: ${percentButtonClicked.error}`);
        return { success: false, error: percentButtonClicked.error };
      }
  
      console.log(`Clicked ${percentButtonClicked.clicked} button in modal`);
      await delay(500); // Reduced from 800ms
  
      // Now look for the close confirmation button
      // The button text should have changed to match the percentage
      console.log(`Looking for close confirmation button...`);
  
      const closeConfirmBtn = await page.evaluate((targetPercent) => {
        const buttons = Array.from(document.querySelectorAll("button"));
  
        // Log all buttons for debugging
        console.log("All buttons in modal:");
        buttons.forEach((btn) => {
          const text = btn.textContent?.trim();
          if (text) console.log(`  - "${text}"`);
        });
  
        // Look for button with text like "Close 50% of All Positions"
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if (
            text &&
            text.toLowerCase().includes("close") &&
            text.includes("%") &&
            text.toLowerCase().includes("position")
          ) {
            // Found the button, click it
            console.log(`Found and clicking: "${text}"`);
            btn.click();
            return { success: true, text: text };
          }
        }
  
        return { success: false };
      }, percent);
  
      if (closeConfirmBtn.success) {
        console.log(`Clicked button: "${closeConfirmBtn.text}"`);
        await delay(800); // Reduced from 1000ms
  
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
          console.log("Close error:", errorMsg);
          return { success: false, error: errorMsg };
        }
  
        console.log(`Position closed successfully (${percent}%)!`);
        return { success: true, message: `Position closed at ${percent}%` };
      } else {
        console.log("Close confirmation button not found");
        return { success: false, error: "Close confirmation button not found" };
      }
    } else {
      console.log("Close button not found");
      return { success: false, error: "Close button not found" };
    }
  }

  // Helper function to check if positions are actually closed
async function checkIfPositionsClosed(page) {
    // Navigate to Positions tab to check
    const positionsTab = await findByExactText(page, "Positions", [
      "button",
      "div",
      "span",
    ]);
    if (positionsTab) {
      await positionsTab.click();
      await delay(1000);
    }
  
    const checkResult = await page.evaluate(() => {
      const text = document.body.innerText;
      const hasPositionIndicators = (
        text.includes("Current Position") ||
        text.includes("Unrealized P&L") ||
        text.includes("Position Size") ||
        text.includes("Entry Price")
      );
      
      // Also check for "No positions" or "No open positions" messages
      const hasNoPositionsMessage = (
        text.includes("No positions") ||
        text.includes("No open positions") ||
        text.includes("You have no open positions")
      );
      
      return {
        hasPositions: hasPositionIndicators,
        hasNoPositionsMessage: hasNoPositionsMessage,
        isClosed: !hasPositionIndicators || hasNoPositionsMessage
      };
    });
  
    if (checkResult.isClosed) {
      console.log(`  ✓ Position check: Closed (${checkResult.hasNoPositionsMessage ? 'no positions message found' : 'no position indicators found'})`);
    } else {
      console.log(`  ⚠ Position check: Still open (position indicators found)`);
    }
  
    return checkResult.isClosed; // Returns true if positions are closed
  }

  async function getCurrentUnrealizedPnL(page) {
    // This function reads the current profit/loss from the Paradex page
    // Improved to detect losses even when displayed without minus sign (e.g., red color, parentheses)
    try {
      // First, click on "Positions" tab to see the P&L information
      const positionsTab = await findByExactText(page, "Positions", [
        "button",
        "div",
        "span",
      ]);
      if (positionsTab) {
        await positionsTab.click();
        await delay(1500); // Wait for page to update
      }
  
      // Now extract the P&L number from the page with improved loss detection
      const pnl = await page.evaluate(() => {
        const text = document.body.innerText;
  
        // Helper function to check if color indicates a loss (red colors)
        const isRedColor = (color) => {
          if (!color) return false;
          const lowerColor = color.toLowerCase();
          return (
            lowerColor.includes("rgb(255") ||
            lowerColor.includes("rgb(220") ||
            lowerColor.includes("rgb(239") ||
            lowerColor.includes("#ff") ||
            lowerColor.includes("#f00") ||
            lowerColor.includes("#ef") ||
            lowerColor.includes("red")
          );
        };
  
        // Strategy 1: Look for text containing "Unrealized P&L" and find the dollar amount nearby
        const allElements = Array.from(document.querySelectorAll("*"));
        for (const el of allElements) {
          // Skip style, script, and other non-content elements
          if (
            el.tagName === "STYLE" ||
            el.tagName === "SCRIPT" ||
            el.tagName === "NOSCRIPT"
          ) {
            continue;
          }
  
          // Skip elements that are not visible
          const computedStyle = window.getComputedStyle(el);
          if (
            computedStyle.display === "none" ||
            computedStyle.visibility === "hidden"
          ) {
            continue;
          }
  
          const elText = el.textContent || "";
  
          // Skip if text looks like CSS or code (contains CSS selectors, brackets, etc.)
          if (
            elText.includes(":where(") ||
            elText.includes("{color:") ||
            elText.includes("background-color:") ||
            elText.match(/^[a-z-]+:\s*[^;]+;/)
          ) {
            continue;
          }
  
          if (elText.includes("Unrealized P&L") || elText.includes("P&L")) {
            // Check if this element or nearby elements indicate a loss
            const color = computedStyle.color;
            const isRed = isRedColor(color);
  
            // Look for dollar amounts with or without minus
            const match = elText.match(
              /[\$]?([-]?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/
            );
  
            // Also check for parentheses format (2) = loss
            const parenMatch = elText.match(
              /\(([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\)/
            );
  
            if (match) {
              let value = parseFloat(match[1].replace(/,/g, ""));
              const originalValue = value;
              let conversionReason = null;
              const matchIndex = elText.indexOf(match[0]);
  
              // If value is in parentheses, it's a loss (make it negative)
              if (
                parenMatch &&
                Math.abs(value - parseFloat(parenMatch[1].replace(/,/g, ""))) <
                  0.01
              ) {
                value = -Math.abs(value);
                conversionReason = "parentheses format";
              }
              // If displayed in red color, it's likely a loss
              else if (isRed && value > 0) {
                value = -Math.abs(value);
                conversionReason = "red color detected";
              }
              // If the text contains "loss" or "negative" nearby (but not in CSS), make it negative
              else if (value > 0) {
                const lowerText = elText.toLowerCase();
                const lossIndex = lowerText.indexOf("loss");
                const negativeIndex = lowerText.indexOf("negative");
  
                // Only convert if "loss" or "negative" appears near the number (within 50 chars)
                if (
                  (lossIndex !== -1 && Math.abs(lossIndex - matchIndex) < 50) ||
                  (negativeIndex !== -1 &&
                    Math.abs(negativeIndex - matchIndex) < 50)
                ) {
                  value = -Math.abs(value);
                  conversionReason = "loss/negative text found near P&L value";
                }
              }
              // Check parent elements for red color or loss indicators
              if (value > 0) {
                let parent = el.parentElement;
                for (let i = 0; i < 5 && parent; i++) {
                  const parentStyle = window.getComputedStyle(parent);
                  const parentColor = parentStyle.color;
                  if (isRedColor(parentColor)) {
                    value = -Math.abs(value);
                    conversionReason = `parent element ${i + 1} has red color`;
                    break;
                  }
                  parent = parent.parentElement;
                }
              }
  
              // Make sure it's a reasonable P&L value (between -$100,000 and $100,000)
              if (value >= -100000 && value <= 100000) {
                // Return debug info along with value
                return {
                  value: value,
                  debug: {
                    originalValue: originalValue,
                    finalValue: value,
                    color: color,
                    isRed: isRed,
                    conversionReason: conversionReason,
                    elementText: elText.substring(0, 200), // Show more context
                    elementTag: el.tagName, // Add tag name for debugging
                  },
                };
              }
            }
          }
        }
  
        // Strategy 2: Look for negative dollar amounts (losses) near "P&L" text
        const negativeMatches = text.match(
          /[\$]?([-][0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/g
        );
        if (negativeMatches) {
          for (const match of negativeMatches) {
            const value = parseFloat(match.replace(/[$,]/g, ""));
            if (value < 0 && value >= -100000) {
              // Check if this number is near "P&L" text
              const matchIndex = text.indexOf(match);
              const nearbyText = text.substring(
                Math.max(0, matchIndex - 50),
                matchIndex + 50
              );
              if (
                nearbyText.includes("P&L") ||
                nearbyText.includes("Unrealized")
              ) {
                return {
                  value: value,
                  debug: {
                    originalValue: value,
                    finalValue: value,
                    color: "N/A (negative match)",
                    isRed: false,
                    conversionReason: "negative sign in text",
                    elementText: nearbyText,
                  },
                };
              }
            }
          }
        }
  
        // Strategy 3: Look for parentheses format (losses) near P&L text
        const parenMatches = text.match(
          /\(([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\)/g
        );
        if (parenMatches) {
          for (const match of parenMatches) {
            const matchIndex = text.indexOf(match);
            const nearbyText = text.substring(
              Math.max(0, matchIndex - 50),
              matchIndex + 50
            );
            if (
              nearbyText.includes("P&L") ||
              nearbyText.includes("Unrealized") ||
              nearbyText.toLowerCase().includes("loss")
            ) {
              const originalValue = parseFloat(match.replace(/[(),]/g, ""));
              const value = -Math.abs(originalValue);
              if (value >= -100000) {
                return {
                  value: value,
                  debug: {
                    originalValue: originalValue,
                    finalValue: value,
                    color: "N/A (parentheses match)",
                    isRed: false,
                    conversionReason: "parentheses format",
                    elementText: nearbyText,
                  },
                };
              }
            }
          }
        }
  
        // Strategy 4: Look in the positions section for any dollar amount
        const positionsSection = text.match(
          /Position[^]*?P&L[^]*?([\$]?[-]?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/i
        );
        if (positionsSection) {
          let value = parseFloat(positionsSection[1].replace(/[$,]/g, ""));
          const originalValue = value;
          let conversionReason = null;
  
          // Check if nearby text suggests it's a loss
          const sectionIndex = text.indexOf(positionsSection[0]);
          const contextText = text.substring(
            Math.max(0, sectionIndex - 100),
            sectionIndex + 100
          );
          if (
            (contextText.toLowerCase().includes("loss") ||
              contextText.includes("(")) &&
            value > 0
          ) {
            value = -Math.abs(value);
            conversionReason = "loss text or parentheses in context";
          }
  
          if (value >= -100000 && value <= 100000) {
            return {
              value: value,
              debug: {
                originalValue: originalValue,
                finalValue: value,
                color: "N/A (positions section)",
                isRed: false,
                conversionReason: conversionReason,
                elementText: contextText.substring(0, 100),
              },
            };
          }
        }
  
        return null; // Couldn't find P&L
      });
  
      if (pnl !== null) {
        // Handle both old format (number) and new format (object with debug)
        let pnlValue, debugInfo;
        if (typeof pnl === "object" && pnl.value !== undefined) {
          pnlValue = pnl.value;
          debugInfo = pnl.debug;
        } else {
          pnlValue = pnl;
          debugInfo = null;
        }
  
        console.log(`Current Unrealized P&L: $${pnlValue.toLocaleString()}`);
  
        // Log debug information if available
        if (debugInfo) {
          console.log(
            `  [P&L Debug] Original Value: $${debugInfo.originalValue}`
          );
          console.log(`  [P&L Debug] Final Value: $${debugInfo.finalValue}`);
          console.log(`  [P&L Debug] Color: ${debugInfo.color}`);
          console.log(`  [P&L Debug] Is Red: ${debugInfo.isRed}`);
          if (debugInfo.elementTag) {
            console.log(`  [P&L Debug] Element Tag: ${debugInfo.elementTag}`);
          }
          if (debugInfo.conversionReason) {
            console.log(
              `  [P&L Debug] Converted to negative because: ${debugInfo.conversionReason}`
            );
          } else {
            console.log(`  [P&L Debug] No conversion applied (value kept as-is)`);
          }
          console.log(`  [P&L Debug] Element Text: ${debugInfo.elementText}`);
        }
  
        return pnlValue; // Return the P&L value (negative = loss, positive = profit)
      } else {
        console.log("Could not find Unrealized P&L on page");
        return null;
      }
    } catch (error) {
      console.error("Error fetching P&L:", error.message);
      return null;
    }
  }

  // Helper function to handle closing positions and setting leverage
async function handleClosePositionsAndSetLeverage(page, email) {
    console.log(`[${email}] Attempting to close all positions...`);
    
    // Check if there are still open positions
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
      // Find and click CLOSE ALL POSITIONS button
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
        console.log(`[${email}] ✅ Clicked CLOSE ALL POSITIONS button`);
        await delay(2000);
        
        // Click Close Positions in modal
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
          console.log(`[${email}] ✅ Clicked Close Positions in modal`);
          await delay(2000);
        }
      }
    }
    
    // Set leverage after closing positions
    await handleSetLeverage(page, email);
  }


/**
 * Check if there are any open positions on GRVT
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<Object>} - { hasPositions: boolean, count: number, longCount: number, shortCount: number, positions: Array, success: boolean, message: string }
 */
async function checkGrvtOpenPositions(page) {
  console.log(`[GRVT] Checking for open positions...`);
  
  try {
    // Step 1: Navigate to Positions tab
    console.log(`[GRVT] Step 1: Navigating to Positions tab...`);
    let positionsTabClicked = false;
    
    // Strategy 1: Find by data-text attribute containing "Positions"
    const positionsClickedByDataText = await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
      for (const el of allElements) {
        const dataText = el.getAttribute('data-text');
        if (dataText && dataText.toLowerCase().includes('positions') && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      return false;
    });
    
    if (positionsClickedByDataText) {
      positionsTabClicked = true;
      console.log(`[GRVT] ✓ Clicked Positions tab (via data-text attribute)`);
      await delay(500);
    }
    
    // Strategy 2: Find by text starting with "Positions" (handles "Positions (1)" format)
    if (!positionsTabClicked) {
      const positionsClickedByText = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          // Match "Positions" or "Positions (1)" or "Positions (2)" etc.
          if (isVisible && text.toLowerCase().startsWith('positions')) {
            el.click();
            return true;
          }
        }
        return false;
      });
      
      if (positionsClickedByText) {
        positionsTabClicked = true;
        console.log(`[GRVT] ✓ Clicked Positions tab (via text content)`);
        await delay(500);
      }
    }
    
    // Strategy 3: Find by exact text "Positions" using helper functions
    if (!positionsTabClicked) {
      const positionsTab = await findByExactText(page, "Positions", ["button", "div", "span", "a"]);
      if (positionsTab) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, positionsTab);
        if (isVisible) {
          await positionsTab.click();
          console.log(`[GRVT] ✓ Clicked Positions tab (exact text helper)`);
          positionsTabClicked = true;
          await delay(500);
        }
      }
    }
    
    // Strategy 4: Find by text containing "positions" (case insensitive) using helper functions
    if (!positionsTabClicked) {
      const positionsTab2 = await findByText(page, "positions", ["button", "div", "span", "a"]);
      if (positionsTab2) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, positionsTab2);
        if (isVisible) {
          await positionsTab2.click();
          console.log(`[GRVT] ✓ Clicked Positions tab (text search helper)`);
          positionsTabClicked = true;
          await delay(500);
        }
      }
    }
    
    if (!positionsTabClicked) {
      console.log(`[GRVT] ⚠️  Could not find Positions tab, continuing anyway...`);
      await delay(500); // Wait a bit for page to stabilize
    }
    
    // Step 2: Wait for positions tab to load
    await delay(300);
    
    // Step 3: Count all Close buttons in Actions column and detect long/short
    console.log(`[GRVT] Step 2: Counting Close buttons in Actions column and detecting long/short...`);
    const positionResult = await page.evaluate(() => {
      // GRVT uses div-based table structure, not standard <table>
      // Look for Close buttons in the Actions column
      const allButtons = Array.from(document.querySelectorAll('button'));
      const validPositions = [];
      
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'close' && btn.offsetParent !== null) {
          // Verify it's in a positions table (check for nearby "Actions" text or table structure)
          let parent = btn.parentElement;
          let inActionsColumn = false;
          let positionRow = null;
          
          // Find the row containing this Close button
          for (let i = 0; i < 15 && parent; i++) {
            const parentText = parent.textContent || '';
            const parentClass = (parent.className || '').toLowerCase();
            
            // Check if it's in Actions column (has "Actions" text nearby or is in last column)
            if (parentText.includes('Actions') || 
                parentClass.includes('cell-ping-right') || // Last column class
                parentClass.includes('tablerow') ||
                parent.getAttribute('data-sentry-component') === 'TablePositions' ||
                parent.querySelector('[data-sentry-component="TablePositions"]') ||
                parent.querySelector('span')?.textContent?.trim() === 'Actions') {
              inActionsColumn = true;
              
              // Try to find the row element (usually has tablerow class or is a table row)
              if (parentClass.includes('tablerow') || parentClass.includes('row') || 
                  parent.getAttribute('data-sentry-component') === 'TablePositions') {
                positionRow = parent;
              } else {
                // Look for parent with row-like structure
                let rowParent = parent.parentElement;
                for (let j = 0; j < 5 && rowParent; j++) {
                  const rowClass = (rowParent.className || '').toLowerCase();
                  if (rowClass.includes('tablerow') || rowClass.includes('row') ||
                      rowParent.getAttribute('data-sentry-component') === 'TablePositions') {
                    positionRow = rowParent;
                    break;
                  }
                  rowParent = rowParent.parentElement;
                }
              }
              break;
            }
            parent = parent.parentElement;
          }
          
          if (inActionsColumn) {
            // Get the row text to check for long/short
            let rowText = '';
            if (positionRow) {
              rowText = (positionRow.textContent || '').toLowerCase();
            } else {
              // Fallback: check parent elements for position text
              let checkParent = btn.parentElement;
              for (let i = 0; i < 10 && checkParent; i++) {
                const checkText = (checkParent.textContent || '').toLowerCase();
                if (checkText.includes('long') || checkText.includes('short') || 
                    checkText.includes('btc') || checkText.includes('perp')) {
                  rowText = checkText;
                  break;
                }
                checkParent = checkParent.parentElement;
              }
            }
            
            const isLong = rowText.includes('long');
            const isShort = rowText.includes('short');
            
            validPositions.push({
              text: btn.textContent?.trim() || 'Close',
              visible: btn.offsetParent !== null,
              side: isLong ? 'long' : (isShort ? 'short' : 'unknown'),
              isLong: isLong,
              isShort: isShort
            });
          }
        }
      }
      
      // Count long and short positions
      const longCount = validPositions.filter(pos => pos.isLong).length;
      const shortCount = validPositions.filter(pos => pos.isShort).length;
      
      return {
        hasPositions: validPositions.length > 0,
        count: validPositions.length,
        longCount: longCount,
        shortCount: shortCount,
        positions: validPositions
      };
    });
    
    if (positionResult.hasPositions) {
      console.log(`[GRVT] ✅ Found ${positionResult.count} open position(s) - Long: ${positionResult.longCount}, Short: ${positionResult.shortCount}`);
      return {
        success: true,
        hasPositions: true,
        count: positionResult.count,
        longCount: positionResult.longCount,
        shortCount: positionResult.shortCount,
        positions: positionResult.positions,
        message: `Found ${positionResult.count} open position(s) - Long: ${positionResult.longCount}, Short: ${positionResult.shortCount}`
      };
    } else {
      console.log(`[GRVT] ✅ No open positions found`);
      return {
        success: true,
        hasPositions: false,
        count: 0,
        longCount: 0,
        shortCount: 0,
        positions: [],
        message: "No open positions found"
      };
    }
  } catch (error) {
    console.log(`[GRVT] ❌ Error checking for open positions: ${error.message}`);
    return {
      success: false,
      hasPositions: false,
      count: 0,
      longCount: 0,
      shortCount: 0,
      positions: [],
      message: `Error: ${error.message}`
    };
  }
}

export { closeAllPositions, checkIfPositionsClosed, getCurrentUnrealizedPnL, handleClosePositionsAndSetLeverage, checkGrvtOpenPositions };