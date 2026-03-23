import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay, findByExactText, findByText, closeNotifyBarWrapperNotifications } from '../utils/helpers.js';
import { handleSetLeverage } from './leverage.js';
import { safeClick } from '../utils/safeActions.js';
import { getCurrentMarketPrice } from './executeBase.js';

async function closeAllPositions(page, percent = 100, exchangeConfig = null, closeAtMarket = false) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex

    console.log(`\n=== Closing Position (${percent}%) on ${exchange.name} ${closeAtMarket ? '(Market)' : '(Limit)'} ===`);
  
    // Wait a moment for any previous actions to complete
    await delay(700);
  
    // Close any NotifyBarWrapper notifications before closing positions
    await closeNotifyBarWrapperNotifications(page, exchange, 'before closing positions');
  
    // ============================================================================
    // GRVT-SPECIFIC CLOSE POSITION FLOW
    // This block ONLY runs for GRVT exchange - all other exchanges are unaffected
    // ============================================================================
    if (exchange.name === 'GRVT') {
      console.log(`[${exchange.name}] 🔵 GRVT-SPECIFIC CLOSE POSITION FLOW STARTING...`);

      // Helper: dismiss any open modal (Cancel button, X button, or Escape key)
      // Called before error returns to prevent modal from staying stuck open
      const dismissGrvtModal = async () => {
        try {
          const dismissed = await page.evaluate(() => {
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'));
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
              // Try Cancel button first
              const buttons = Array.from(modal.querySelectorAll('button'));
              const cancelBtn = buttons.find(btn => (btn.textContent || '').trim() === 'Cancel' && btn.offsetParent !== null);
              if (cancelBtn) { cancelBtn.click(); return 'Cancel'; }
              // Try X / close button
              const closeBtn = buttons.find(btn => {
                const text = (btn.textContent || '').trim().toLowerCase();
                const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                return text === '×' || text === 'x' || ariaLabel.includes('close') || (btn.querySelector('svg') && text === '');
              });
              if (closeBtn) { closeBtn.click(); return 'X'; }
            }
            return null;
          });
          if (dismissed) {
            console.log(`[${exchange.name}] ✅ Dismissed stuck modal via ${dismissed} button`);
            await delay(500);
          } else {
            // Fallback: press Escape
            await page.keyboard.press('Escape');
            console.log(`[${exchange.name}] ✅ Dismissed stuck modal via Escape key`);
            await delay(500);
          }
        } catch (e) {
          console.log(`[${exchange.name}] ⚠️  Error dismissing modal: ${e.message}`);
        }
      };
      
      // Step 0: SKIPPED — Order cancellation is already done by loop.js before calling closeAllPositions.
      // Also, closing the position automatically cancels associated TP/SL trigger orders on GRVT.
      // Previously this step took 6+ seconds navigating to Open orders tab, clicking Cancel all, waiting for confirm modal.
      console.log(`[${exchange.name}] Step 0: Skipped (orders already canceled by loop.js, TP/SL auto-cancels on position close)`);
      if (false) { // DISABLED — kept for reference only
      
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
            const isVisible = el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0);
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
            return el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0);
          }, openOrdersTab);
          if (isVisible) {
            await safeClick(page, openOrdersTab);
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
            return el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0);
          }, openOrdersTab2);
          if (isVisible) {
            await safeClick(page, openOrdersTab2);
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
      let cancelAllOrdersBtnElement = null;
      
      // Strategy 1: Find by exact text
      const cancelAllOrdersBtn = await findByExactText(page, "Cancel all orders", ["button", "div", "span"]);
      
      if (cancelAllOrdersBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0);
        }, cancelAllOrdersBtn);
        if (isVisible) {
          cancelAllOrdersBtnElement = cancelAllOrdersBtn;
        }
      }
      
      // Strategy 2: Find by partial text if exact didn't work
      if (!cancelAllOrdersBtnElement) {
        const cancelAllOrdersBtn2 = await findByText(page, "Cancel all orders", ["button", "div", "span"]);
        if (cancelAllOrdersBtn2) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0);
          }, cancelAllOrdersBtn2);
          if (isVisible) {
            cancelAllOrdersBtnElement = cancelAllOrdersBtn2;
          }
        }
      }
      
      // Strategy 3: Find by JavaScript evaluation (more robust for GRVT)
      if (!cancelAllOrdersBtnElement) {
        const btnHandle = await page.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('button, div, span, a'));
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text.toLowerCase().includes('cancel all orders') && el.offsetParent !== null) {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              const isVisible = (rect.width > 0 && rect.height > 0) || el.offsetParent !== null;
              const isDisabled = el.disabled || el.getAttribute('disabled') !== null ||
                                style.pointerEvents === 'none' || style.cursor === 'not-allowed';

              if (style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  isVisible &&
                  !isDisabled) {
                return el;
              }
            }
          }
          return null;
        });

        const btnElement = btnHandle.asElement();
        if (btnElement) {
          const btnInfo = await page.evaluate((el) => {
            const isDisabled = el.disabled || el.getAttribute('disabled') !== null ||
                              window.getComputedStyle(el).pointerEvents === 'none' ||
                              window.getComputedStyle(el).cursor === 'not-allowed';
            return {
              tagName: el.tagName,
              text: (el.textContent || '').trim().substring(0, 50),
              disabled: isDisabled
            };
          }, btnElement);

          if (btnInfo.disabled) {
            console.log(`[${exchange.name}] ⚠️  "Cancel all orders" button found but is DISABLED - no orders to cancel`);
          } else {
            console.log(`[${exchange.name}] ✅ Found "Cancel all orders" button via JavaScript (${btnInfo.tagName}, text: "${btnInfo.text}")`);
            // Click using DOM-level click (minimize-safe)
            await safeClick(page, btnElement);
            cancelAllOrdersBtnClicked = true;
            await delay(500);
          }
        }
      }
      
      // Check if there are actually orders to cancel before proceeding
      if (cancelAllOrdersBtnClicked) {
        const hasOrders = await page.evaluate(() => {
          // Check for order rows in tables
          const tables = Array.from(document.querySelectorAll('table'));
          for (const table of tables) {
            const rows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
            const orderRows = rows.filter(row => {
              if (row.offsetParent === null) return false;
              const text = (row.textContent || '').toLowerCase();
              return (text.includes('limit') || text.includes('market') || text.includes('pending')) &&
                     !text.includes('canceled') && !text.includes('filled');
            });
            if (orderRows.length > 0) return true;
          }
          return false;
        });
        
        if (!hasOrders) {
          console.log(`[${exchange.name}] ⚠️  No orders found in table - button may have been clicked but no orders to cancel`);
          cancelAllOrdersBtnClicked = false; // Reset since there's nothing to cancel
        } else {
          console.log(`[${exchange.name}] ✅ Orders found in table - proceeding with cancellation`);
        }
      }
      
      // Click the button if found via helper functions
      if (cancelAllOrdersBtnElement && !cancelAllOrdersBtnClicked) {
        console.log(`[${exchange.name}] ✅ Found "Cancel all orders" button, clicking...`);
        
        // Try multiple click methods for GRVT
        let clickWorked = false;
        
        // Method 1: JavaScript click with events
        try {
          const jsClickResult = await page.evaluate((btn) => {
            if (!btn) return { success: false };
            try {
              btn.scrollIntoView({ behavior: 'instant', block: 'center' });
              btn.focus();
              
              // Dispatch mouse events
              const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
              const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
              const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              
              btn.dispatchEvent(mouseDown);
              btn.dispatchEvent(mouseUp);
              btn.dispatchEvent(clickEvent);
              btn.click();
              
              return { success: true };
            } catch (e) {
              return { success: false, error: e.message };
            }
          }, cancelAllOrdersBtnElement);
          
          if (jsClickResult && jsClickResult.success) {
            clickWorked = true;
            console.log(`[${exchange.name}] ✅ Clicked "Cancel all orders" button using JavaScript`);
          }
        } catch (error) {
          console.log(`[${exchange.name}] ⚠️  JavaScript click failed: ${error.message}`);
        }
        
        // Method 2: DOM-level click (minimize-safe)
        if (!clickWorked) {
          try {
            await cancelAllOrdersBtnElement.evaluate((btn) => btn.scrollIntoView({ behavior: 'instant', block: 'center' }));
            await delay(200);
            await safeClick(page, cancelAllOrdersBtnElement);
            clickWorked = true;
            console.log(`[${exchange.name}] ✅ Clicked "Cancel all orders" button using DOM click`);
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  DOM click failed: ${error.message}`);
          }
        }
        
        if (clickWorked) {
          cancelAllOrdersBtnClicked = true;
          await delay(500); // Wait for modal to start opening
          
          // Verify that modal actually opened after clicking
          const modalOpened = await page.evaluate(() => {
            // Check for modals
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              if (style.display !== 'none' && 
                  style.visibility !== 'hidden' && 
                  style.opacity !== '0' &&
                  (modal.offsetWidth > 0 && modal.offsetHeight > 0 || modal.offsetParent !== null)) {
                const modalText = (modal.textContent || '').toLowerCase();
                if (modalText.includes('cancel') || modalText.includes('confirm') || modalText.includes('order')) {
                  return true;
                }
              }
            }
            
            // Also check for Confirm button
            const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text === 'confirm' && btn.offsetParent !== null) {
                const style = window.getComputedStyle(btn);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  return true;
                }
              }
            }
            
            return false;
          });
          
          if (!modalOpened) {
            console.log(`[${exchange.name}] ⚠️  Modal did not open after clicking "Cancel all orders" button. Retrying click...`);
            // Retry with more aggressive click
            await delay(500);
            try {
              await page.evaluate(() => {
                const allElements = Array.from(document.querySelectorAll('button, div, span, a'));
                for (const el of allElements) {
                  const text = (el.textContent || '').trim();
                  if (text.toLowerCase().includes('cancel all orders') && el.offsetParent !== null) {
                    el.scrollIntoView({ behavior: 'instant', block: 'center' });
                    el.focus();
                    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
                    const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
                    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                    el.dispatchEvent(mouseDown);
                    el.dispatchEvent(mouseUp);
                    el.dispatchEvent(clickEvent);
                    el.click();
                    return;
                  }
                }
              });
              await delay(1000); // Wait longer after retry
              console.log(`[${exchange.name}] ✅ Retried clicking "Cancel all orders" button`);
            } catch (retryError) {
              console.log(`[${exchange.name}] ⚠️  Retry click failed: ${retryError.message}`);
            }
          } else {
            console.log(`[${exchange.name}] ✅ Modal opened after clicking "Cancel all orders" button`);
          }
        }
      }
      
      if (!cancelAllOrdersBtnClicked) {
        console.log(`[${exchange.name}] ⚠️  Could not find or click "Cancel all orders" button, no orders to cancel - proceeding to close positions...`);
      }
      
      // Wait for confirmation modal to open (only if button was clicked)
      if (cancelAllOrdersBtnClicked) {
        console.log(`[${exchange.name}] Step 0.3: Waiting for confirmation modal/button to appear...`);
        
        // First, wait a bit for modal to start opening
        await delay(1000); // Wait 1 second for GRVT modal to start opening
        
        // Wait for Confirm button to appear after clicking Cancel all orders
        let confirmBtn = null;
        let confirmBtnVisible = false;
        let modalDetected = false;
        
        // Wait up to 10 seconds for Confirm button to appear (increased for GRVT)
        for (let i = 0; i < 40; i++) {
          await delay(250);
          
          // Check if modal is open first
          if (!modalDetected) {
            modalDetected = await page.evaluate(() => {
              // Check for modals
              const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"]'));
              for (const modal of modals) {
                const style = window.getComputedStyle(modal);
                if (style.display !== 'none' && 
                    style.visibility !== 'hidden' && 
                    style.opacity !== '0' &&
                    modal.offsetWidth > 0 && 
                    modal.offsetHeight > 0) {
                  const modalText = (modal.textContent || '').toLowerCase();
                  if (modalText.includes('cancel') || modalText.includes('confirm') || modalText.includes('order')) {
                    return true;
                  }
                }
              }
              return false;
            });
            
            if (modalDetected) {
              console.log(`[${exchange.name}] ✅ Modal detected (attempt ${i + 1})`);
            }
          }
          
          // Try to find Confirm button with multiple strategies
          if (!confirmBtn) {
            // Strategy 1: Find by exact text
            confirmBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);
            
            // Strategy 2: Find by partial text
            if (!confirmBtn) {
              confirmBtn = await findByText(page, "Confirm", ["button", "div", "span"]);
            }
            
            // Strategy 3: Find by class selector (for GRVT destructive button)
            if (!confirmBtn) {
              const confirmByClass = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                for (const btn of buttons) {
                  const text = (btn.textContent || '').trim();
                  const className = (btn.className || '').toLowerCase();
                  if (text === 'Confirm' && 
                      (className.includes('destructive') || 
                       className.includes('style_destructive') ||
                       className.includes('style_btn'))) {
                    const style = window.getComputedStyle(btn);
                    const rect = btn.getBoundingClientRect();
                    const isVisible = (rect.width > 0 && rect.height > 0) || btn.offsetParent !== null;
                    if (isVisible &&
                        style.display !== 'none' &&
                        style.visibility !== 'hidden') {
                      return btn;
                    }
                  }
                }
                return null;
              });
              confirmBtn = confirmByClass.asElement();
              if (confirmBtn) {
                console.log(`[${exchange.name}] ✅ Found Confirm button using class selector`);
              }
            }
          }
          
          // Check if Confirm button is visible and clickable
          if (confirmBtn) {
            confirmBtnVisible = await page.evaluate((btn) => {
              if (!btn) return false;
              const style = window.getComputedStyle(btn);
              const rect = btn.getBoundingClientRect();
              const isVisible = (rect.width > 0 && rect.height > 0) || btn.offsetParent !== null;
              return isVisible &&
                     style.display !== 'none' &&
                     style.visibility !== 'hidden' &&
                     style.opacity !== '0' &&
                     !btn.disabled;
            }, confirmBtn);
            
            if (confirmBtnVisible) {
              console.log(`[${exchange.name}] ✅ Confirm button found and visible (attempt ${i + 1})`);
              break;
            }
          }
          
          // Also check if page text indicates modal is open
          const hasConfirmText = await page.evaluate(() => {
            const text = document.body.innerText || '';
            return text.toLowerCase().includes('confirm') && 
                   (text.toLowerCase().includes('cancel') || text.toLowerCase().includes('order'));
          });
          
          if (hasConfirmText && i > 5) {
            // Give it a bit more time if we see confirm text
            console.log(`[${exchange.name}] Confirm text detected on page, waiting a bit more...`);
          }
        }
        
        if (confirmBtn && confirmBtnVisible) {
          // Find and click Confirm button with verification
          console.log(`[${exchange.name}] Step 0.4: Clicking Confirm button in cancellation modal...`);
          await delay(300); // Small delay before clicking
          
          try {
            // Get button state before clicking for verification
            const buttonStateBefore = await page.evaluate((btn) => {
              if (!btn) return null;
              return {
                text: (btn.textContent || '').trim(),
                disabled: btn.disabled,
                className: btn.className || '',
                visible: btn.offsetParent !== null
              };
            }, confirmBtn);
            
            // Try multiple click strategies for GRVT with verification
            let clickSuccess = false;
            let clickMethod = '';
            
            // Strategy 1: Scroll into view + JavaScript click with mouse events (most reliable for GRVT)
            try {
              const jsClickResult = await page.evaluate((btn) => {
                if (!btn) return { success: false, error: 'Button not found' };
                try {
                  // Scroll into view
                  btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                  
                  // Focus the button
                  btn.focus();
                  
                  // Trigger mouse events
                  const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
                  const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
                  const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                  
                  btn.dispatchEvent(mouseDown);
                  btn.dispatchEvent(mouseUp);
                  btn.dispatchEvent(clickEvent);
                  
                  // Also call click() method
                  btn.click();
                  
                  return { success: true };
                } catch (e) {
                  return { success: false, error: e.message };
                }
              }, confirmBtn);
              
              if (jsClickResult && jsClickResult.success) {
                clickSuccess = true;
                clickMethod = 'JavaScript with mouse events';
                console.log(`[${exchange.name}] ✅ Clicked Confirm button (${clickMethod})`);
              }
            } catch (error) {
              console.log(`[${exchange.name}] ⚠️  JavaScript click with mouse events failed: ${error.message}`);
            }
            
            // Strategy 2: DOM-level click (minimize-safe)
            if (!clickSuccess) {
              try {
                await confirmBtn.evaluate((btn) => btn.scrollIntoView({ behavior: 'instant', block: 'center' }));
                await delay(100);
                await safeClick(page, confirmBtn);
                clickSuccess = true;
                clickMethod = 'DOM click';
                console.log(`[${exchange.name}] ✅ Clicked Confirm button (${clickMethod})`);
              } catch (error) {
                console.log(`[${exchange.name}] ⚠️  DOM click failed: ${error.message}`);
              }
            }
            
            // Strategy 3: Direct DOM el.click() as fallback
            if (!clickSuccess) {
              try {
                await page.evaluate((btn) => {
                  if (!btn) return;
                  btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                  btn.focus();
                  btn.click();
                }, confirmBtn);
                clickSuccess = true;
                clickMethod = 'Direct DOM el.click()';
                console.log(`[${exchange.name}] ✅ Clicked Confirm button (${clickMethod})`);
              } catch (error) {
                console.log(`[${exchange.name}] ⚠️  Direct DOM click failed: ${error.message}`);
              }
            }
            
            // Verify the click actually worked by checking if modal/button state changed
            if (clickSuccess) {
              await delay(500); // Wait for click to register
              
              const clickVerified = await page.evaluate(() => {
                // Check if Confirm button is gone or modal is closed
                const buttons = Array.from(document.querySelectorAll('button'));
                const hasConfirmBtn = buttons.some(btn => {
                  const text = (btn.textContent || '').trim();
                  return text === 'Confirm' && btn.offsetParent !== null;
                });
                
                // Check for modals
                const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
                let hasOpenModal = false;
                for (const modal of modals) {
                  const style = window.getComputedStyle(modal);
                  if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    hasOpenModal = true;
                    break;
                  }
                }
                
                return !hasConfirmBtn || !hasOpenModal;
              });
              
              if (clickVerified) {
                console.log(`[${exchange.name}] ✅ Click verified - modal closed or Confirm button disappeared`);
              } else {
                console.log(`[${exchange.name}] ⚠️  Click may not have worked - modal/button still present, retrying...`);
                // Retry with different method
                try {
                  await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    for (const btn of buttons) {
                      const text = (btn.textContent || '').trim();
                      const className = (btn.className || '').toLowerCase();
                      if (text === 'Confirm' && 
                          (className.includes('destructive') || className.includes('style_destructive'))) {
                        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                        btn.focus();
                        const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
                        const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
                        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
                        btn.dispatchEvent(mouseDown);
                        btn.dispatchEvent(mouseUp);
                        btn.dispatchEvent(clickEvent);
                        btn.click();
                        break;
                      }
                    }
                  });
                  await delay(500);
                  console.log(`[${exchange.name}] ✅ Retried click with JavaScript`);
                } catch (retryError) {
                  console.log(`[${exchange.name}] ⚠️  Retry also failed: ${retryError.message}`);
                }
              }
            } else {
              console.log(`[${exchange.name}] ⚠️  All click methods failed`);
            }
            
            // Wait for modal/confirmation to process
            await delay(1000);
            
            // Wait for any modals to close
            console.log(`[${exchange.name}] Step 0.5: Waiting for cancellation to complete...`);
            let modalClosed = false;
            for (let i = 0; i < 10; i++) {
              await delay(300);
              modalClosed = await page.evaluate(() => {
                // Check if Confirm button is gone (indicates modal closed)
                const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                const hasConfirmBtn = buttons.some(btn => {
                  const text = (btn.textContent || '').trim().toLowerCase();
                  return text === 'confirm' && btn.offsetParent !== null;
                });
                
                // Also check for modals
                const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
                for (const modal of modals) {
                  const style = window.getComputedStyle(modal);
                  if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    return false;
                  }
                }
                
                return !hasConfirmBtn;
              });
              if (modalClosed) {
                console.log(`[${exchange.name}] ✅ Cancellation completed`);
                break;
              }
            }
            
            // Wait a bit more after cancellation
            await delay(500);
            
            // Verify orders were actually canceled by checking the orders table
            const ordersStillExist = await page.evaluate(() => {
              const text = document.body.innerText || '';
              // Check for active orders (not canceled/filled)
              const hasActiveOrderText = (text.toLowerCase().includes('limit') || 
                                         text.toLowerCase().includes('market') ||
                                         text.toLowerCase().includes('pending')) &&
                                        !text.toLowerCase().includes('canceled') &&
                                        !text.toLowerCase().includes('filled') &&
                                        !text.toLowerCase().includes('no orders');
              return hasActiveOrderText;
            });
            
            if (!ordersStillExist) {
              console.log(`[${exchange.name}] ✅ All orders canceled successfully, proceeding to close positions...`);
            } else {
              console.log(`[${exchange.name}] ⚠️  Some orders may still exist after cancellation, but proceeding to close positions...`);
            }
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error clicking Confirm button: ${error.message}`);
            // Try to close any open modals
            await page.keyboard.press('Escape');
            await delay(500);
          }
        } else if (confirmBtn && !confirmBtnVisible) {
          console.log(`[${exchange.name}] ⚠️  Found Confirm button but it's not visible/clickable, trying to click anyway...`);
          try {
            await safeClick(page, confirmBtn);
            await delay(1000);
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error clicking Confirm button: ${error.message}`);
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Confirm button did not appear after clicking Cancel all orders`);
          console.log(`[${exchange.name}]    This might mean: 1) No orders to cancel, 2) Orders canceled instantly, or 3) Button detection failed`);
          console.log(`[${exchange.name}]    Proceeding to close positions...`);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Cancel all orders button not clicked, proceeding to close positions...`);
      }
      
      } // End of disabled Step 0 block

      // Proceed directly to close positions flow (Step 0 skipped)
      console.log(`[${exchange.name}] 🔵 Proceeding to close positions flow...`);
      
      // Now proceed with close positions flow
      // Navigate to Positions tab (GRVT uses similar structure to Open orders tab)
      console.log(`[${exchange.name}] Step 1: Navigating to Positions tab...`);
      let positionsTabClicked = false;
      
      // Strategy 0: Find by tab item structure (GRVT specific: div with class containing "tabItem" containing span with "Positions")
      // MUST use Puppeteer native click (elementHandle.click()) — produces isTrusted: true.
      // GRVT's React tab component ignores isTrusted: false clicks from DOM el.click().

      // Strategy 0: Find by tab item structure (tabItem class + Positions span)
      const posTabH0 = await page.evaluateHandle(() => {
        const allDivs = Array.from(document.querySelectorAll('div'));
        for (const div of allDivs) {
          const divClass = (div.className || '').toLowerCase();
          if ((divClass.includes('tabitem') || divClass.includes('tab-item')) && div.offsetParent !== null) {
            const spans = Array.from(div.querySelectorAll('span'));
            for (const span of spans) {
              const spanText = (span.textContent || '').trim();
              if (spanText.toLowerCase().startsWith('positions')) return div;
            }
          }
        }
        return null;
      });
      const posTabEl0 = posTabH0.asElement();
      if (posTabEl0) {
        await posTabEl0.click();
        positionsTabClicked = true;
        console.log(`[${exchange.name}] ✓ Clicked Positions tab (via tab item structure)`);
        await delay(500);
      }

      // Strategy 1: Find by data-text attribute containing "Positions"
      if (!positionsTabClicked) {
        const posTabH1 = await page.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
          for (const el of allElements) {
            const dataText = el.getAttribute('data-text');
            if (dataText && dataText.toLowerCase().includes('positions') && el.offsetParent !== null) return el;
          }
          return null;
        });
        const posTabEl1 = posTabH1.asElement();
        if (posTabEl1) {
          await posTabEl1.click();
          positionsTabClicked = true;
          console.log(`[${exchange.name}] ✓ Clicked Positions tab (via data-text attribute)`);
          await delay(500);
        }
      }

      // Strategy 2: Find span/button with SHORT text starting with "Positions" (max 30 chars)
      // Prevents matching large container divs whose textContent starts with "Positions..."
      if (!positionsTabClicked) {
        const posTabH2 = await page.evaluateHandle(() => {
          const candidates = [];
          const allElements = Array.from(document.querySelectorAll('span, button, a, div'));
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            const isVisible = el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0);
            if (isVisible && text.toLowerCase().startsWith('positions') && text.length < 30) {
              const parentClass = (el.parentElement?.className || '').toLowerCase();
              const isInTabBar = parentClass.includes('tab') || parentClass.includes('bar') ||
                                 el.getAttribute('role') === 'tab';
              candidates.push({ el, priority: isInTabBar ? 0 : 1, len: text.length });
            }
          }
          candidates.sort((a, b) => a.priority - b.priority || a.len - b.len);
          return candidates.length > 0 ? candidates[0].el : null;
        });
        const posTabEl2 = posTabH2.asElement();
        if (posTabEl2) {
          await posTabEl2.click();
          positionsTabClicked = true;
          console.log(`[${exchange.name}] ✓ Clicked Positions tab (via short text match)`);
          await delay(500);
        }
      }

      if (!positionsTabClicked) {
        console.log(`[${exchange.name}] ⚠️  Could not find Positions tab, continuing anyway...`);
        await delay(500);
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
      
      // Scroll page to ensure positions table is in viewport
      console.log(`[${exchange.name}] Scrolling page to ensure positions table is in viewport...`);
      await page.evaluate(() => {
        // Scroll to bottom first to ensure positions table is loaded
        window.scrollTo(0, document.body.scrollHeight);
      });
      await delay(500);
      
      // Scroll positions table/container into view
      await page.evaluate(() => {
        const positionsTable = document.querySelector('[data-sentry-component="TablePositions"]') ||
                               document.querySelector('[class*="table"]') ||
                               document.querySelector('[class*="Table"]');
        if (positionsTable) {
          positionsTable.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      });
      await delay(500);
      
      // Step 3: Find Close button in Actions column (last column of table)
      console.log(`[${exchange.name}] Step 3: Looking for Close button in Actions column (last column)...`);
      
      const closeButtonInActions = await page.evaluate(() => {
        // GRVT uses div-based table structure, not standard <table>
        // Look for Close buttons directly
        const allButtons = Array.from(document.querySelectorAll('button'));
        
        for (const btn of allButtons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'close' && btn.offsetParent !== null) {
            // First check: Is this Close button inside TablePositions component?
            const isInTablePositions = btn.closest('[data-sentry-component="TablePositions"]') !== null;
            
            // Second check: Is it in the Actions column (cell-ping-right)?
            let parent = btn.parentElement;
            let isInActionsColumn = false;
            for (let i = 0; i < 10 && parent; i++) {
              const parentClass = (parent.className || '').toLowerCase();
              if (parentClass.includes('cell-ping-right') || 
                  (parent.textContent || '').includes('Actions')) {
                isInActionsColumn = true;
                break;
              }
              parent = parent.parentElement;
            }
            
            // Third check: Look for position data (Long, Short, BTC, etc.) in the row
            parent = btn.parentElement;
            let hasPositionData = false;
            for (let i = 0; i < 20 && parent; i++) {
              const parentText = (parent.textContent || '').toLowerCase();
              const parentClass = (parent.className || '').toLowerCase();
              
              const hasLongShort = parentText.includes('long') || parentText.includes('short');
              const hasSymbol = parentText.includes('btc') || parentText.includes('perp') || 
                               parentText.includes('eth') || parentText.includes('usd');
              const hasPositionFields = parentText.includes('quantity') || parentText.includes('size') || 
                                       parentText.includes('pnl') || parentText.includes('p&l') ||
                                       parentText.includes('entry') || parentText.includes('mark') ||
                                       parentText.includes('liq') || parentText.includes('margin');
              const isRowLike = parentClass.includes('tablerow') || 
                               parentClass.includes('table-row') ||
                               parentClass.includes('row');
              
              if ((hasLongShort || hasSymbol || hasPositionFields) && (isRowLike || isInTablePositions)) {
                hasPositionData = true;
                break;
              }
              
              parent = parent.parentElement;
            }
            
            // If it's in TablePositions, Actions column, or has position data, it's valid
            if (isInTablePositions || isInActionsColumn || hasPositionData) {
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
              // First check: Is this Close button inside TablePositions component?
              const isInTablePositions = btn.closest('[data-sentry-component="TablePositions"]') !== null;
              
              // Second check: Is it in the Actions column (cell-ping-right)?
              let parent = btn.parentElement;
              let isInActionsColumn = false;
              for (let i = 0; i < 10 && parent; i++) {
                const parentClass = (parent.className || '').toLowerCase();
                if (parentClass.includes('cell-ping-right') || 
                    (parent.textContent || '').includes('Actions')) {
                  isInActionsColumn = true;
                  break;
                }
                parent = parent.parentElement;
              }
              
              // Third check: Look for position data (Long, Short, BTC, etc.) in the row
              parent = btn.parentElement;
              let hasPositionData = false;
              for (let i = 0; i < 20 && parent; i++) {
                const parentText = (parent.textContent || '').toLowerCase();
                const parentClass = (parent.className || '').toLowerCase();
                
                const hasLongShort = parentText.includes('long') || parentText.includes('short');
                const hasSymbol = parentText.includes('btc') || parentText.includes('perp') || 
                                 parentText.includes('eth') || parentText.includes('usd');
                const hasPositionFields = parentText.includes('quantity') || parentText.includes('size') || 
                                         parentText.includes('pnl') || parentText.includes('p&l') ||
                                         parentText.includes('entry') || parentText.includes('mark') ||
                                         parentText.includes('liq') || parentText.includes('margin');
                const isRowLike = parentClass.includes('tablerow') || 
                                 parentClass.includes('table-row') ||
                                 parentClass.includes('row');
                
                if ((hasLongShort || hasSymbol || hasPositionFields) && (isRowLike || isInTablePositions)) {
                  hasPositionData = true;
                  break;
                }
                
                parent = parent.parentElement;
              }
              
              // If it's in TablePositions, Actions column, or has position data, it's valid
              if (isInTablePositions || isInActionsColumn || hasPositionData) {
                return btn;
              }
            }
          }
          return null;
        });
        
        if (closeBtnElement && closeBtnElement.asElement()) {
          // Ensure Close button is in viewport before proceeding
          try {
            await closeBtnElement.asElement().evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await delay(300);

            // Verify element is still connected and visible
            const isVisible = await closeBtnElement.asElement().evaluate((btn) => {
              const rect = btn.getBoundingClientRect();
              const style = window.getComputedStyle(btn);
              const isVisibleByRect = (rect.width > 0 && rect.height > 0) || btn.offsetParent !== null;
              return btn.isConnected &&
                     style.display !== 'none' &&
                     style.visibility !== 'hidden' &&
                     style.opacity !== '0' &&
                     isVisibleByRect;
            });
            
            if (!isVisible) {
              throw new Error('Close button is not visible after scrolling');
            }
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error scrolling Close button into view: ${error.message}`);
            // Continue anyway, will try to re-find if click fails
          }
          
          // Step 1.5: Close any NON-close-position modals that might be open
          // Skip modals that contain "Close Position" text to avoid closing the very modal we need
          console.log(`[${exchange.name}] Step 1.5: Checking for and closing any non-close-position modals...`);
          const closedOtherModals = await page.evaluate(() => {
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'));
            let closed = false;
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

              // Skip the Close Position modal itself — don't close what we're about to use
              const modalText = (modal.textContent || '').toLowerCase();
              if (modalText.includes('close position') || modalText.includes('confirm')) continue;

              // Close other modals (TP/SL, notifications, etc.)
              const closeButtons = Array.from(modal.querySelectorAll('button, [role="button"]'));
              const closeBtn = closeButtons.find(btn => {
                const text = (btn.textContent || '').trim().toLowerCase();
                const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                return text === '×' || text === 'x' || text === 'cancel' ||
                       ariaLabel.includes('close') ||
                       (btn.querySelector('svg') && text === '');
              });
              if (closeBtn) {
                closeBtn.click();
                closed = true;
              }
            }
            return closed;
          });
          
          if (closedOtherModals) {
            console.log(`[${exchange.name}] ✅ Closed other open modal(s), waiting a moment...`);
            await delay(500);
          }
          
          console.log(`[${exchange.name}] Clicking Close button to open modal...`);

          // Try to click the Close button with error handling for detached nodes
          try {
            // Ensure element is in viewport before clicking
            await closeBtnElement.asElement().evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await delay(300);
            await safeClick(page, closeBtnElement.asElement());
          } catch (error) {
            if (error.message && error.message.includes('detached')) {
              console.log(`[${exchange.name}] ⚠️  Close button became detached, re-finding and clicking...`);
              
              // Re-find the Close button
              const closeBtnElementRetry = await page.evaluateHandle(() => {
                const allButtons = Array.from(document.querySelectorAll('button'));
                
                for (const btn of allButtons) {
                  const text = (btn.textContent || '').trim().toLowerCase();
                  if (text === 'close' && btn.offsetParent !== null) {
                    // First check: Is this Close button inside TablePositions component?
                    const isInTablePositions = btn.closest('[data-sentry-component="TablePositions"]') !== null;
                    
                    // Second check: Is it in the Actions column (cell-ping-right)?
                    let parent = btn.parentElement;
                    let isInActionsColumn = false;
                    for (let i = 0; i < 10 && parent; i++) {
                      const parentClass = (parent.className || '').toLowerCase();
                      if (parentClass.includes('cell-ping-right') || 
                          (parent.textContent || '').includes('Actions')) {
                        isInActionsColumn = true;
                        break;
                      }
                      parent = parent.parentElement;
                    }
                    
                    // Third check: Look for position data (Long, Short, BTC, etc.) in the row
                    parent = btn.parentElement;
                    let hasPositionData = false;
                    for (let i = 0; i < 20 && parent; i++) {
                      const parentText = (parent.textContent || '').toLowerCase();
                      const parentClass = (parent.className || '').toLowerCase();
                      
                      const hasLongShort = parentText.includes('long') || parentText.includes('short');
                      const hasSymbol = parentText.includes('btc') || parentText.includes('perp') || 
                                       parentText.includes('eth') || parentText.includes('usd');
                      const hasPositionFields = parentText.includes('quantity') || parentText.includes('size') || 
                                               parentText.includes('pnl') || parentText.includes('p&l') ||
                                               parentText.includes('entry') || parentText.includes('mark') ||
                                               parentText.includes('liq') || parentText.includes('margin');
                      const isRowLike = parentClass.includes('tablerow') || 
                                       parentClass.includes('table-row') ||
                                       parentClass.includes('row');
                      
                      if ((hasLongShort || hasSymbol || hasPositionFields) && (isRowLike || isInTablePositions)) {
                        hasPositionData = true;
                        break;
                      }
                      
                      parent = parent.parentElement;
                    }
                    
                    // If it's in TablePositions, Actions column, or has position data, it's valid
                    if (isInTablePositions || isInActionsColumn || hasPositionData) {
                      return btn;
                    }
                  }
                }
                return null;
              });
              
              if (closeBtnElementRetry && closeBtnElementRetry.asElement()) {
                // Use JavaScript click as fallback
                await closeBtnElementRetry.asElement().evaluate((btn) => {
                  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  btn.click();
                });
                console.log(`[${exchange.name}] ✅ Successfully clicked Close button using JavaScript fallback`);
              } else {
                throw new Error('Could not re-find Close button after detachment');
              }
            } else {
              throw error;
            }
          }
          
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
          
          // Step 5: Select order type in close modal
          // When closeAtMarket=true: skip Limit selection, use Market (modal default)
          // When closeAtMarket=false: select Limit to minimize taker fees
          if (closeAtMarket) {
            console.log(`[${exchange.name}] Step 5: Market close requested — using Market (modal default), skipping Limit selection`);
          } else {
            // Find and click Limit option in modal
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
            await safeClick(page, limitButtonHandle.asElement());
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
              await safeClick(page, limitOption);
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
                await safeClick(page, limitButtonHandle.asElement());
              } else {
                const limitOption = await findByExactText(page, "Limit", ["button", "div", "span", "a"]);
                if (limitOption) {
                  await safeClick(page, limitOption);
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
                if (closeAtMarket) {
                  console.log(`[${exchange.name}] ⚠️  Limit not selected after clicking, falling back to Market close (closeAtMarket=true)`);
                } else {
                  console.log(`[${exchange.name}] ⚠️  CRITICAL: Limit still not selected after clicking! Cannot proceed to Confirm.`);
                  await dismissGrvtModal();
                  return { success: false, message: "Could not select Limit option in modal - still showing Market" };
                }
              } else {
                console.log(`[${exchange.name}] ✅ Limit verified as selected after second click (data-active="true")`);
              }
            } else {
              console.log(`[${exchange.name}] ✅ Limit option verified as selected (data-active="true" or style_active__vVGd1 class)`);
            }
          } else {
            if (closeAtMarket) {
              console.log(`[${exchange.name}] ⚠️  Limit option not found, falling back to Market close (closeAtMarket=true)`);
            } else {
              console.log(`[${exchange.name}] ⚠️  CRITICAL: Limit option not clicked! Cannot proceed to Confirm.`);
              await dismissGrvtModal();
              return { success: false, message: "Could not find or click Limit option in modal" };
            }
          }

          // Small delay after order type selection before clicking Confirm
          console.log(`[${exchange.name}] Waiting a moment after order type selection before Confirm...`);
          await delay(500);

          // Step 5.5: Fill price input for Limit close order
          // Without a price, the Limit order will fail to submit
          console.log(`[${exchange.name}] Step 5.5: Filling price for Limit close order...`);
          try {
            // Get current market price from the page
            const marketPrice = await getCurrentMarketPrice(page, exchange);
            if (marketPrice && marketPrice > 0) {
              // Keep 2 decimal places — GRVT may reject integer-only prices
              const priceStr = String(parseFloat(marketPrice.toFixed(2)));
              console.log(`[${exchange.name}] Market price: $${marketPrice.toLocaleString()}, using $${priceStr} for Limit close`);

              // Find price input inside the close modal
              const priceFilled = await page.evaluate((price) => {
                const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'));
                for (const modal of modals) {
                  const style = window.getComputedStyle(modal);
                  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

                  // Find input elements in the modal (price input for Limit orders)
                  const inputs = Array.from(modal.querySelectorAll('input'));
                  for (const input of inputs) {
                    const type = input.type || 'text';
                    if (type === 'checkbox' || type === 'radio' || type === 'hidden') continue;
                    // Check placeholder or label for price-related text
                    const placeholder = (input.placeholder || '').toLowerCase();
                    const inputId = (input.id || '').toLowerCase();
                    const inputName = (input.name || '').toLowerCase();
                    // Look for price-related context in parent
                    let parentText = '';
                    let p = input.parentElement;
                    for (let i = 0; i < 3 && p; i++) {
                      parentText += ' ' + (p.textContent || '').toLowerCase();
                      p = p.parentElement;
                    }

                    const isPriceInput = placeholder.includes('price') ||
                      inputId.includes('price') || inputName.includes('price') ||
                      parentText.includes('price') || parentText.includes('limit');

                    if (isPriceInput && input.offsetParent !== null) {
                      // Use React native value setter to fill the price
                      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                      nativeSetter.call(input, price);
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.dispatchEvent(new Event('change', { bubbles: true }));
                      return { filled: true, placeholder: input.placeholder || '', value: input.value };
                    }
                  }

                  // Fallback: try the first visible text/number input in the modal
                  for (const input of inputs) {
                    const type = input.type || 'text';
                    if (type === 'checkbox' || type === 'radio' || type === 'hidden') continue;
                    if (input.offsetParent !== null) {
                      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                      nativeSetter.call(input, price);
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.dispatchEvent(new Event('change', { bubbles: true }));
                      return { filled: true, placeholder: input.placeholder || '', value: input.value, fallback: true };
                    }
                  }
                }
                return { filled: false };
              }, priceStr);

              if (priceFilled.filled) {
                console.log(`[${exchange.name}] ✅ Price filled: $${priceStr}${priceFilled.fallback ? ' (fallback input)' : ''} (placeholder: "${priceFilled.placeholder}")`);
              } else {
                console.log(`[${exchange.name}] ⚠️  Could not find price input in modal — Limit order may fail`);
              }
            } else {
              console.log(`[${exchange.name}] ⚠️  Could not get market price — Limit close may fail`);
            }
          } catch (priceError) {
            console.log(`[${exchange.name}] ⚠️  Error filling price for Limit close: ${priceError.message}`);
          }

          await delay(300);
          } // end of if (!closeAtMarket) block

          // Step 6: Find and click Confirm button in modal
          console.log(`[${exchange.name}] Step 6: Looking for Confirm button in modal...`);
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
                await safeClick(page, confirmBtn);
                console.log(`[${exchange.name}] ✅ Clicked Confirm button`);
                
                // Step 7: Wait for modal to close automatically after Confirm click
                // When Limit is selected and Confirm is clicked, the modal closes automatically
                console.log(`[${exchange.name}] Step 7: Waiting for modal to close automatically after Confirm click...`);
                let modalClosed = false;
                const maxWaitIterations = 30; // Wait up to 9 seconds (30 * 300ms) for automatic close
                for (let i = 0; i < maxWaitIterations; i++) {
                  await delay(300);
                  const modalState = await page.evaluate(() => {
                    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
                    for (const modal of modals) {
                      const style = window.getComputedStyle(modal);
                      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                        // Check for error messages inside the modal
                        const errorEls = Array.from(modal.querySelectorAll('[class*="error"], [class*="Error"], [class*="warning"], [role="alert"]'));
                        const errors = errorEls
                          .filter(el => el.offsetParent !== null && (el.textContent || '').trim().length > 3)
                          .map(el => (el.textContent || '').trim().substring(0, 100));
                        return { closed: false, errors };
                      }
                    }
                    return { closed: true, errors: [] };
                  });

                  modalClosed = modalState.closed;

                  if (modalClosed) {
                    console.log(`[${exchange.name}] ✅ Modal closed automatically - position close order placed (waited ${(i + 1) * 300}ms)`);
                    break;
                  }

                  // Log errors if detected
                  if (modalState.errors.length > 0 && i === 5) {
                    console.log(`[${exchange.name}] ⚠️  Modal error detected: ${modalState.errors.join(' | ')}`);
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
                    await dismissGrvtModal();
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
                    await dismissGrvtModal();
                    return { success: false, message: "Modal did not close automatically after Confirm click - cannot proceed" };
                  }
                }

                await delay(500);
                console.log(`[${exchange.name}] ✅ Position close flow complete, modal closed automatically, ready for leverage setting`);
                return { success: true, message: "Confirm clicked via JavaScript, modal closed automatically" };
              }
            } else {
              console.log(`[${exchange.name}] ⚠️  Found Confirm button but it's not in modal`);
              await dismissGrvtModal();
            }
          } else {
            console.log(`[${exchange.name}] ⚠️  Could not find Confirm button in modal`);
            await dismissGrvtModal();
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not get Close button element handle`);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Could not find Close button in Actions column`);
      }

      // GRVT flow failed — dismiss any stuck modal and return failure
      // Do NOT fall through to generic Paradex flow (wrong selectors, wastes time)
      await dismissGrvtModal();
      console.log(`[${exchange.name}] ❌ GRVT-specific close flow failed — returning failure`);
      return { success: false, message: "GRVT close flow failed (Close button or Confirm not found)" };
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
        await safeClick(page, positionsTab);
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
                const isVisible = btn.offsetParent !== null || (btn.offsetWidth > 0 && btn.offsetHeight > 0);
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
      await safeClick(page, closeBtn);
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
      await safeClick(page, positionsTab);
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
        await safeClick(page, positionsTab);
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
          const isVisible = btn.offsetParent !== null || (btn.offsetWidth > 0 && btn.offsetHeight > 0);
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
            const isVisible = btn.offsetParent !== null || (btn.offsetWidth > 0 && btn.offsetHeight > 0);
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
    
    // MUST use Puppeteer native click (elementHandle.click()) — produces isTrusted: true.
    // IMPORTANT: textContent includes ALL child text, so container divs can match
    // "Positions..." even though they're not the tab. Must filter by text length.

    // Strategy 1: Find GRVT tab structure — div with tabItem class containing "Positions" span
    const posTabHandle1 = await page.evaluateHandle(() => {
      const allDivs = Array.from(document.querySelectorAll('div'));
      for (const div of allDivs) {
        const divClass = (div.className || '').toLowerCase();
        if ((divClass.includes('tabitem') || divClass.includes('tab-item') || divClass.includes('tab_item')) && div.offsetParent !== null) {
          const spans = Array.from(div.querySelectorAll('span'));
          for (const span of spans) {
            if ((span.textContent || '').trim().toLowerCase().startsWith('positions')) return div;
          }
        }
      }
      return null;
    });
    const posTab1 = posTabHandle1.asElement();
    if (posTab1) {
      await posTab1.click();
      positionsTabClicked = true;
      console.log(`[GRVT] ✓ Clicked Positions tab (via tabItem structure)`);
      await delay(500);
    }

    // Strategy 2: Find by data-text attribute containing "Positions"
    if (!positionsTabClicked) {
      const posTabHandle2 = await page.evaluateHandle(() => {
        const allElements = Array.from(document.querySelectorAll('div, button, span, a'));
        for (const el of allElements) {
          const dataText = el.getAttribute('data-text');
          if (dataText && dataText.toLowerCase().includes('positions') && el.offsetParent !== null) return el;
        }
        return null;
      });
      const posTab2 = posTabHandle2.asElement();
      if (posTab2) {
        await posTab2.click();
        positionsTabClicked = true;
        console.log(`[GRVT] ✓ Clicked Positions tab (via data-text attribute)`);
        await delay(500);
      }
    }

    // Strategy 3: Find span/button with SHORT text starting with "Positions" (max 30 chars)
    if (!positionsTabClicked) {
      const posTabHandle3 = await page.evaluateHandle(() => {
        const candidates = [];
        const allElements = Array.from(document.querySelectorAll('span, button, a, div'));
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          const isVisible = el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0);
          if (isVisible && text.toLowerCase().startsWith('positions') && text.length < 30) {
            const parentClass = (el.parentElement?.className || '').toLowerCase();
            const isInTabBar = parentClass.includes('tab') || parentClass.includes('bar') ||
                               el.getAttribute('role') === 'tab';
            candidates.push({ el, priority: isInTabBar ? 0 : 1, len: text.length });
          }
        }
        candidates.sort((a, b) => a.priority - b.priority || a.len - b.len);
        return candidates.length > 0 ? candidates[0].el : null;
      });
      const posTab3 = posTabHandle3.asElement();
      if (posTab3) {
        await posTab3.click();
        positionsTabClicked = true;
        console.log(`[GRVT] ✓ Clicked Positions tab (via short text match)`);
        await delay(500);
      }
    }

    if (!positionsTabClicked) {
      console.log(`[GRVT] ⚠️  Could not find Positions tab, continuing anyway...`);
      await delay(500);
    }
    
    // Step 2: Wait for positions tab to load and verify TablePositions component appears
    console.log(`[GRVT] Step 2: Waiting for Positions tab to load and TablePositions component to appear...`);
    
    // Wait for TablePositions component to appear (with retries)
    let tablePositionsFound = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(attempt === 0 ? 500 : 300); // First wait 500ms, then 300ms for retries
      
      const isOnPositionsPage = await page.evaluate(() => {
        return document.querySelector('[data-sentry-component="TablePositions"]') !== null;
      });
      
      if (isOnPositionsPage) {
        tablePositionsFound = true;
        console.log(`[GRVT] ✓ TablePositions component found (attempt ${attempt + 1}/5)`);
        break;
      } else if (attempt < 4) {
        console.log(`[GRVT] ⏳ TablePositions component not found yet, waiting... (attempt ${attempt + 1}/5)`);
      }
    }
    
    if (!tablePositionsFound) {
      console.log(`[GRVT] ⚠️  TablePositions component not found after all attempts - continuing anyway (may still work if positions exist)`);
    }
    
    // Step 3: Count all Close buttons and detect long/short
    console.log(`[GRVT] Step 2: Counting Close buttons and detecting long/short...`);
    const positionResult = await page.evaluate(() => {
      // GRVT uses div-based table structure, not standard <table>
      // Look for Close buttons - if we're on Positions tab, any Close button is likely a position Close
      const allButtons = Array.from(document.querySelectorAll('button'));
      const validPositions = [];
      const debugInfo = [];
      
      // First, check if we're on Positions page by looking for position-related text
      const pageText = (document.body.textContent || '').toLowerCase();
      const isPositionsPage = pageText.includes('positions') && 
                              (pageText.includes('long') || pageText.includes('short') || 
                               pageText.includes('size') || pageText.includes('pnl'));
      
      debugInfo.push(`Total buttons found: ${allButtons.length}`);
      debugInfo.push(`Is Positions page: ${isPositionsPage}`);
      
      // Check if TablePositions component exists
      const tablePositionsExists = document.querySelector('[data-sentry-component="TablePositions"]') !== null;
      debugInfo.push(`TablePositions component exists: ${tablePositionsExists}`);
      
      // Count Close buttons first
      let totalCloseButtons = 0;
      let visibleCloseButtons = 0;
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'close') {
          totalCloseButtons++;
          if (btn.offsetParent !== null) {
            visibleCloseButtons++;
          }
        }
      }
      debugInfo.push(`Total Close buttons: ${totalCloseButtons}, Visible: ${visibleCloseButtons}`);
      
      let closeButtonCount = 0;
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'close' && btn.offsetParent !== null) {
          closeButtonCount++;
          // First check: Is this Close button inside TablePositions component?
          const isInTablePositions = btn.closest('[data-sentry-component="TablePositions"]') !== null;
          
          // Second check: Is it in the Actions column (cell-ping-right)?
          let parent = btn.parentElement;
          let isInActionsColumn = false;
          for (let i = 0; i < 5 && parent; i++) {
            const parentClass = (parent.className || '').toLowerCase();
            if (parentClass.includes('cell-ping-right') || 
                (parent.textContent || '').includes('Actions')) {
              isInActionsColumn = true;
              break;
            }
            parent = parent.parentElement;
          }
          
          debugInfo.push(`Close button #${closeButtonCount}: InTablePositions=${isInTablePositions}, InActionsColumn=${isInActionsColumn}`);
          
          // Get surrounding context to verify it's a position Close button
          parent = btn.parentElement;
          let positionRow = null;
          let hasPositionData = false;
          let rowText = '';
          
          // Walk up the DOM to find the row and check for position data
          for (let i = 0; i < 20 && parent; i++) {
            const parentText = (parent.textContent || '').toLowerCase();
            const parentClass = (parent.className || '').toLowerCase();
            
            // Check if this parent contains position data (Long, Short, BTC, PERP, Size, PnL, etc.)
            const hasLongShort = parentText.includes('long') || parentText.includes('short');
            const hasSymbol = parentText.includes('btc') || parentText.includes('perp') || 
                             parentText.includes('eth') || parentText.includes('usd');
            const hasPositionFields = parentText.includes('quantity') || parentText.includes('size') || 
                                     parentText.includes('pnl') || parentText.includes('p&l') ||
                                     parentText.includes('entry') || parentText.includes('entry price') ||
                                     parentText.includes('mark') || parentText.includes('mark price') ||
                                     parentText.includes('liq') || parentText.includes('margin');
            
            // Check if it's a table row structure (more flexible matching)
            // GRVT uses divs with classes like "style_tableRow__gbjWO" - when lowercased becomes "style_tablerow__gbjwo"
            // So we check for "tablerow" (all lowercase) or "row" in the class name
            const isRowLike = parentClass.includes('tablerow') || 
                             parentClass.includes('table-row') ||
                             parentClass.includes('row') ||
                             parentClass.includes('tr') ||
                             parent.tagName === 'TR' ||
                             parent.getAttribute('data-sentry-component') === 'TablePositions' ||
                             parent.querySelector('[data-sentry-component="TablePositions"]') ||
                             // Check if parent has cell-ping-right (last column indicator) or is inside TablePositions
                             parentClass.includes('cell-ping-right') ||
                             parent.closest('[data-sentry-component="TablePositions"]');
            
            // If we find position data in a row-like structure, that's ideal
            if ((hasLongShort || hasSymbol || hasPositionFields) && isRowLike) {
              positionRow = parent;
              rowText = parentText;
              hasPositionData = true;
              break;
            }
            
            // Also check if parent has position data even if not row-like (might be in a cell or container)
            // This is important for cases where the row structure isn't obvious
            if (hasLongShort || (hasSymbol && (hasPositionFields || parentText.includes('cross') || parentText.includes('10x') || parentText.includes('20x')))) {
              rowText = parentText;
              hasPositionData = true;
              // Don't break here - continue to see if we can find a better row structure
              if (!positionRow && isRowLike) {
                positionRow = parent;
                break;
              }
            }
            
            parent = parent.parentElement;
          }
          
          // If we found position data nearby, or we're on Positions page, or it's in TablePositions, consider it valid
          // Also check if it's in Actions column (cell-ping-right) which is a strong indicator
          if (hasPositionData || isPositionsPage || isInTablePositions || isInActionsColumn) {
            // Get row text for long/short detection
            if (!rowText) {
              // Fallback: check parent elements for position text
              let checkParent = btn.parentElement;
              for (let i = 0; i < 15 && checkParent; i++) {
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
            
            // Extract position size from rowText (pattern: "10x0.002 btc" or "10x0.004 btc")
            let positionSize = null;
            const sizeMatch = rowText.match(/(\d+)x([\d.]+)\s*btc/i);
            if (sizeMatch) {
              positionSize = parseFloat(sizeMatch[2]);
            }

            validPositions.push({
              text: btn.textContent?.trim() || 'Close',
              visible: btn.offsetParent !== null,
              side: isLong ? 'long' : (isShort ? 'short' : 'unknown'),
              isLong: isLong,
              isShort: isShort,
              hasPositionData: hasPositionData,
              size: positionSize
            });

            debugInfo.push(`Close #${closeButtonCount} VALID - Long: ${isLong}, Short: ${isShort}, HasPositionData: ${hasPositionData}, Size: ${positionSize} BTC, RowText: ${rowText.substring(0, 60)}`);
          } else {
            debugInfo.push(`Close #${closeButtonCount} SKIPPED - HasPositionData: ${hasPositionData}, IsPositionsPage: ${isPositionsPage}, IsInTablePositions: ${isInTablePositions}, IsInActionsColumn: ${isInActionsColumn}`);
          }
        }
      }
      
      // Count long and short positions
      const longCount = validPositions.filter(pos => pos.isLong).length;
      const shortCount = validPositions.filter(pos => pos.isShort).length;

      // Sum total position size across all valid positions
      // QA fix: If any position has null size (regex parse failed), return null instead of 0
      // to distinguish "size 0" from "size unknown"
      const hasParseFailure = validPositions.some(pos => pos.size === null || pos.size === undefined);
      const totalSize = hasParseFailure ? null : validPositions.reduce((sum, pos) => sum + (pos.size || 0), 0);

      return {
        hasPositions: validPositions.length > 0,
        count: validPositions.length,
        longCount: longCount,
        shortCount: shortCount,
        totalSize: totalSize,
        positions: validPositions,
        debug: debugInfo
      };
    });
    
    // Log debug information
    if (positionResult.debug && positionResult.debug.length > 0) {
      console.log(`[GRVT] 🔍 Debug info: ${positionResult.debug.join(' | ')}`);
    }
    
    if (positionResult.hasPositions) {
      console.log(`[GRVT] ✅ Found ${positionResult.count} open position(s) - Long: ${positionResult.longCount}, Short: ${positionResult.shortCount}${positionResult.totalSize ? `, Size: ${positionResult.totalSize} BTC` : ''}`);
      return {
        success: true,
        hasPositions: true,
        count: positionResult.count,
        longCount: positionResult.longCount,
        shortCount: positionResult.shortCount,
        totalSize: positionResult.totalSize || null,
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
        totalSize: null,
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
      totalSize: null,
      positions: [],
      message: `Error: ${error.message}`
    };
  }
}

export { closeAllPositions, checkIfPositionsClosed, getCurrentUnrealizedPnL, handleClosePositionsAndSetLeverage, checkGrvtOpenPositions };