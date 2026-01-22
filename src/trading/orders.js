import { delay } from '../utils/helpers.js';
import { findByExactText } from '../utils/helpers.js';

async function cancelAllOrders(page) {
    console.log(`\n=== Canceling All Open Orders ===`);
  
    // Wait a moment for any previous actions to complete
    await delay(500); // Reduced from 1000ms
  
    // First try to find "Open Orders" tab
    let ordersTab = await findByExactText(page, "Open Orders", [
      "button",
      "div",
      "span",
    ]);
    
    // If "Open Orders" not found, try "Order History" as fallback
    if (!ordersTab) {
      ordersTab = await findByExactText(page, "Order History", [
        "button",
        "div",
        "span",
      ]);
      if (ordersTab) {
        console.log("Found Order History tab (using as fallback)");
      }
    }
    
    // If still not found, try just "Orders" as last resort
    if (!ordersTab) {
      ordersTab = await findByExactText(page, "Orders", [
        "button",
        "div",
        "span",
      ]);
      if (ordersTab) {
        console.log("Found Orders tab (using as last resort)");
      }
    }
    
    if (ordersTab) {
      await ordersTab.click();
      console.log("Clicked Orders/Open Orders/Order History tab");
      await delay(1000); // Reduced from 2000ms - wait for orders to load
    } else {
      console.log("⚠ Could not find Open Orders, Order History, or Orders tab");
    }
  
    // Check if there are any open orders
    console.log("Checking for open orders...");
    let hasOrders = false;
    for (let i = 0; i < 3; i++) {
      hasOrders = await page.evaluate(() => {
        const text = document.body.innerText;
        return (
          text.includes("Open Orders") ||
          text.includes("Pending") ||
          text.includes("Limit Order") ||
          text.includes("Market Order") ||
          text.includes("Cancel")
        );
      });
  
      if (hasOrders) {
        console.log("Found open orders!");
        break;
      }
  
      if (i < 2) {
        console.log(`Attempt ${i + 1}/3: No orders found yet, waiting...`);
        await delay(800); // Reduced from 1500ms
      }
    }
  
    if (!hasOrders) {
      console.log("✅ No open orders found - skipping cancellation");
      return { success: true, message: "No orders to cancel", canceled: 0 };
    }
  
    // Wait a bit more for UI to fully render
    await delay(500); // Reduced from 1000ms
  
    // Find and click all Cancel buttons
    let canceledCount = 0;
    let maxAttempts = 10; // Prevent infinite loop
    let attempts = 0;
    
    // Get initial order count for accurate reporting
    const initialOrderCount = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
        const orderRows = dataRows.filter(row => {
          const isVisible = row.offsetParent !== null;
          if (!isVisible) return false;
          const rowText = row.textContent?.toLowerCase() || '';
          return (rowText.includes('limit') || rowText.includes('market') || rowText.includes('pending')) &&
                 !rowText.includes('canceled') && !rowText.includes('filled');
        });
        if (orderRows.length > 0) return orderRows.length;
      }
      return 0;
    });
    
    console.log(`📊 Initial open orders detected: ${initialOrderCount}`);
    
    // Early exit if no orders found
    if (initialOrderCount === 0) {
      console.log("✅ No open orders found - skipping cancellation");
      return { success: true, message: "No orders to cancel", canceled: 0 };
    }
  
    let previousOrderCount = initialOrderCount;
    let consecutiveNoProgressAttempts = 0;
    
    while (attempts < maxAttempts) {
      attempts++;
      console.log(`Looking for cancel buttons (attempt ${attempts}/${maxAttempts})...`);
  
      const cancelResult = await page.evaluate(() => {
        // Find all buttons that might be cancel buttons
        const allButtons = Array.from(
          document.querySelectorAll(
            'button, div[role="button"], a[role="button"], [class*="button"]'
          )
        );
  
        const cancelButtons = [];
        for (const btn of allButtons) {
          const text = btn.textContent?.trim().toLowerCase();
          const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";
          const isVisible = btn.offsetParent !== null;
          const isDisabled = btn.disabled || btn.getAttribute("disabled") !== null || btn.classList.contains("disabled");
          
          // Skip buttons that have been marked as clicked (using data attribute)
          const alreadyClicked = btn.getAttribute("data-bot-clicked") === "true";
  
          // Skip disabled buttons or already clicked buttons
          if (isDisabled || alreadyClicked) continue;
  
          if (
            isVisible &&
            (text.includes("cancel") ||
              text === "x" ||
              ariaLabel.includes("cancel") ||
              ariaLabel.includes("remove"))
          ) {
            // Make sure it's related to orders, not positions
            const parentText = btn.parentElement?.textContent?.toLowerCase() || "";
            if (
              parentText.includes("order") ||
              parentText.includes("pending") ||
              parentText.includes("limit") ||
              parentText.includes("market") ||
              !parentText.includes("position")
            ) {
              cancelButtons.push({
                element: btn,
                text: btn.textContent?.trim() || ariaLabel,
              });
            }
          }
        }
  
        // Click all cancel buttons found (only active ones) and mark them as clicked
        let clicked = 0;
        for (const btnInfo of cancelButtons) {
          try {
            // Double-check it's not disabled before clicking
            if (!btnInfo.element.disabled && btnInfo.element.offsetParent !== null) {
              // Mark button as clicked to avoid clicking again
              btnInfo.element.setAttribute("data-bot-clicked", "true");
              btnInfo.element.click();
              clicked++;
            }
          } catch (e) {
            console.log(`Error clicking cancel button: ${e.message}`);
          }
        }
  
        return { found: cancelButtons.length, clicked };
      });
  
      if (cancelResult.clicked > 0) {
        canceledCount += cancelResult.clicked;
        console.log(
          `✓ Clicked ${cancelResult.clicked} cancel button(s) (total: ${canceledCount})`
        );
        
        // Wait longer for cancellation to process
        await delay(2000); // Increased from 1000ms - wait for orders to actually be canceled
  
        // Actually verify orders are gone by checking table rows, not just text
        const actualOrderCount = await page.evaluate(() => {
          // Find all tables
          const tables = Array.from(document.querySelectorAll('table'));
          
          for (const table of tables) {
            // Find data rows (skip header)
            const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
            
            // Filter to only visible rows that contain order-related content
            const orderRows = dataRows.filter(row => {
              const isVisible = row.offsetParent !== null && row.offsetWidth > 0 && row.offsetHeight > 0;
              if (!isVisible) return false;
              
              const rowText = row.textContent?.toLowerCase() || '';
              // Check if row contains order indicators but NOT "canceled" or "filled"
              const hasOrderIndicators = (
                rowText.includes('limit') || 
                rowText.includes('market') || 
                rowText.includes('pending') ||
                rowText.includes('order')
              );
              const isAlreadyCanceled = (
                rowText.includes('canceled') || 
                rowText.includes('filled') ||
                rowText.includes('executed')
              );
              
              return hasOrderIndicators && !isAlreadyCanceled;
            });
            
            if (orderRows.length > 0) {
              return orderRows.length;
            }
          }
          
          // Fallback: check for cancel buttons (if buttons exist, orders likely exist)
          const cancelButtons = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
          const activeCancelButtons = cancelButtons.filter(btn => {
            const text = btn.textContent?.trim().toLowerCase();
            const isVisible = btn.offsetParent !== null;
            const isDisabled = btn.disabled || btn.getAttribute("disabled") !== null;
            return isVisible && !isDisabled && (text.includes("cancel") || text === "x");
          });
          
          return activeCancelButtons.length;
        });
  
        console.log(`📊 Remaining open orders: ${actualOrderCount}`);
        
        if (actualOrderCount === 0) {
          console.log("✅ All orders successfully canceled!");
          break;
        }
        
        // Check if order count actually decreased (progress made)
        if (actualOrderCount < previousOrderCount) {
          // Progress made - reset consecutive no-progress counter
          consecutiveNoProgressAttempts = 0;
          previousOrderCount = actualOrderCount;
          console.log(`✅ Progress: Order count decreased from ${previousOrderCount + (previousOrderCount - actualOrderCount)} to ${actualOrderCount}`);
        } else if (actualOrderCount === previousOrderCount && cancelResult.clicked > 0) {
          // No progress despite clicking buttons
          consecutiveNoProgressAttempts++;
          console.log(`⚠️  No progress: Order count unchanged (${actualOrderCount}) after clicking ${cancelResult.clicked} button(s)`);
          
          // If we've tried multiple times with no progress, stop trying
          if (consecutiveNoProgressAttempts >= 3) {
            console.log(`⚠️  Stopping: No progress after ${consecutiveNoProgressAttempts} attempts. Orders may require manual cancellation.`);
            break;
          }
        }
        
        // If we clicked buttons but order count didn't decrease, wait a bit more
        if (actualOrderCount > 0 && attempts < maxAttempts && consecutiveNoProgressAttempts < 3) {
          console.log(`⏳ Waiting for cancellations to process... (${actualOrderCount} orders remaining)`);
          await delay(1500); // Additional wait for async cancellation
        }
      } else {
        // No more cancel buttons found - verify there are actually no orders
        const finalOrderCount = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table'));
          for (const table of tables) {
            const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
            const orderRows = dataRows.filter(row => {
              const isVisible = row.offsetParent !== null;
              if (!isVisible) return false;
              const rowText = row.textContent?.toLowerCase() || '';
              return (rowText.includes('limit') || rowText.includes('market') || rowText.includes('pending')) &&
                     !rowText.includes('canceled') && !rowText.includes('filled');
            });
            if (orderRows.length > 0) return orderRows.length;
          }
          return 0;
        });
        
        if (finalOrderCount === 0) {
          console.log("✅ No more orders found - all canceled!");
        } else {
          console.log(`⚠️  No cancel buttons found, but ${finalOrderCount} order(s) may still be open`);
        }
        break;
      }
    }
  
    // Final verification: check actual remaining orders
    const finalOrderCount = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
        const orderRows = dataRows.filter(row => {
          const isVisible = row.offsetParent !== null;
          if (!isVisible) return false;
          const rowText = row.textContent?.toLowerCase() || '';
          return (rowText.includes('limit') || rowText.includes('market') || rowText.includes('pending')) &&
                 !rowText.includes('canceled') && !rowText.includes('filled');
        });
        if (orderRows.length > 0) return orderRows.length;
      }
      return 0;
    });
    
    const actuallyCanceled = initialOrderCount - finalOrderCount;
    
    if (finalOrderCount === 0 && initialOrderCount > 0) {
      console.log(`✅ Successfully canceled all ${initialOrderCount} order(s)`);
      return {
        success: true,
        message: `Canceled ${initialOrderCount} order(s)`,
        canceled: initialOrderCount,
      };
    } else if (finalOrderCount > 0) {
      console.log(`⚠️  Warning: ${finalOrderCount} order(s) still remain (attempted to cancel ${canceledCount} button clicks)`);
      return {
        success: false,
        message: `${finalOrderCount} order(s) still remain`,
        canceled: actuallyCanceled,
        remaining: finalOrderCount,
      };
    } else {
      console.log("No orders were canceled (none found or already canceled)");
      return {
        success: true,
        message: "No orders to cancel",
        canceled: 0,
      };
    }
  }

  /**
 * Verifies that an order was placed and is pending/active
 * Checks for order in orders table or success confirmation
 */
async function verifyOrderPlaced(page, exchange, side, qty, maxWaitTime = 10000) {
    const startTime = Date.now();
    const checkInterval = 1000; // Check every 1 second
    const maxChecks = Math.ceil(maxWaitTime / checkInterval);
    
    for (let i = 0; i < maxChecks; i++) {
      // Check if we've exceeded max wait time
      if (Date.now() - startTime > maxWaitTime) {
        break;
      }
      
      // Method 1: Check for success message/notification
      const successMessage = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const successIndicators = [
          'order placed',
          'order submitted',
          'order created',
          'order pending',
          'success',
          'submitted successfully'
        ];
        
        for (const indicator of successIndicators) {
          if (bodyText.toLowerCase().includes(indicator)) {
            return indicator;
          }
        }
        return null;
      });
      
      if (successMessage) {
        return { success: true, status: 'pending', method: 'success_message' };
      }
      
      // Method 2: Check orders table for pending order
      const orderInTable = await page.evaluate((side, qty) => {
        // Find all tables
        const tables = Array.from(document.querySelectorAll('table'));
        
        for (const table of tables) {
          // Find data rows (skip header)
          const dataRows = Array.from(table.querySelectorAll('tbody tr, tr:not(:first-child)'));
          
          // Filter to only visible rows
          const visibleRows = dataRows.filter(row => {
            return row.offsetParent !== null && row.offsetWidth > 0 && row.offsetHeight > 0;
          });
          
          // Check each row for order indicators
          for (const row of visibleRows) {
            const rowText = row.textContent?.toLowerCase() || '';
            
            // Check if row contains order indicators
            const hasOrderIndicators = (
              rowText.includes('limit') || 
              rowText.includes('market') || 
              rowText.includes('pending') ||
              rowText.includes('open') ||
              rowText.includes('order')
            );
            
            // Check if row matches the side (buy/sell)
            const matchesSide = side === 'buy' 
              ? (rowText.includes('buy') || rowText.includes('long'))
              : (rowText.includes('sell') || rowText.includes('short'));
            
            // Check if NOT already canceled/filled
            const isActive = !(
              rowText.includes('canceled') || 
              rowText.includes('filled') ||
              rowText.includes('executed') ||
              rowText.includes('closed')
            );
            
            if (hasOrderIndicators && matchesSide && isActive) {
              return true;
            }
          }
        }
        
        return false;
      }, side, qty);
      
      if (orderInTable) {
        return { success: true, status: 'pending', method: 'orders_table' };
      }
      
      // Method 3: Check for modal/confirmation dialog closing (indicates success)
      const modalClosed = await page.evaluate(() => {
        // Check if any confirmation/trade modal has closed
        const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
        // If no modals or modals are hidden, trade likely succeeded
        return modals.length === 0 || Array.from(modals).every(m => {
          const style = window.getComputedStyle(m);
          return style.display === 'none' || style.visibility === 'hidden';
        });
      });
      
      if (modalClosed && i > 2) { // Wait at least 2 seconds before checking modal
        // Modal closed and no errors found - order likely placed
        return { success: true, status: 'pending', method: 'modal_closed' };
      }
      
      // Wait before next check
      await delay(checkInterval);
    }
    
    // If we get here, couldn't verify order placement
    return { 
      success: false, 
      reason: `Could not verify order placement within ${maxWaitTime}ms. Order may still be processing.` 
    };
  }

  export { cancelAllOrders, verifyOrderPlaced };