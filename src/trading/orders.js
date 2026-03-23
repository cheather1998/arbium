import { delay, findByExactText, findByText } from '../utils/helpers.js';

async function cancelAllOrders(page) {
    console.log(`\n=== Canceling All Open Orders (GENERIC FUNCTION) ===`);
    console.log(`⚠️  NOTE: This is the generic cancelAllOrders function. If this is Kraken, it should use cancelKrakenOrders instead!`);
  
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
      // Wait before proceeding to leverage setting
      console.log("Waiting 2 seconds before proceeding to leverage setting...");
      await delay(2000);
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
      // Wait before proceeding to leverage setting
      console.log("Waiting 2 seconds before proceeding to leverage setting...");
      await delay(2000);
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
      // Wait before proceeding to leverage setting
      console.log("Waiting 2 seconds before proceeding to leverage setting...");
      await delay(2000);
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
    // Use shorter check interval for Extended Exchange (500ms) to verify faster
    const checkInterval = exchange.name?.toLowerCase().includes('extended') ? 500 : 1000;
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
      
      // For Extended Exchange, check modal closure earlier (after 1 check = 0.5s)
      // For other exchanges, wait at least 2 seconds before checking modal
      const minChecksForModal = exchange.name?.toLowerCase().includes('extended') ? 1 : 2;
      if (modalClosed && i >= minChecksForModal) {
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

/**
 * Cancel orders for Kraken using modal flow
 * 1. Go to Open Orders tab
 * 2. Check if there are any orders
 * 3. Click on an order (opens modal)
 * 4. Click "Cancel order" button
 * 5. Click "Yes, cancel order" in confirmation modal
 */
async function cancelKrakenOrders(page, closeAtMarket = false) {
  console.log(`\n=== Canceling Kraken Orders via Modal Flow (KRAKEN-SPECIFIC FUNCTION) ${closeAtMarket ? '(Market Close)' : '(Limit Close)'} ===`);
  
  // Smart wait for Kraken page to be ready (check for Open Orders tab instead of fixed delay)
  console.log(`[Kraken] Waiting for page to be ready...`);
  let pageReady = false;
  const maxWaitTime = 15000; // Max 15 seconds (reduced from 20s fixed)
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitTime) {
    // Check if Open Orders tab is available
    const tabFound = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.toLowerCase().includes('open orders') || 
             text.toLowerCase().includes('order history') ||
             document.querySelector('div[data-layout-path*="/c1/ts1/tb"]') !== null;
    });
    
    if (tabFound) {
      // Additional check: try to find the tab element
      let tabElement = null;
      try {
        tabElement = await findByExactText(page, "Open orders", ["button", "div", "span", "a"]);
      } catch (e) {
        try {
          tabElement = await findByExactText(page, "Open Orders", ["button", "div", "span", "a"]);
        } catch (e2) {
          try {
            tabElement = await findByText(page, "Open orders", ["button", "div", "span", "a"]);
          } catch (e3) {
            // Continue checking
          }
        }
      }
      
      if (tabElement) {
        try {
          const isVisible = await page.evaluate((el) => {
            return el && el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, tabElement);
          
          if (isVisible) {
            pageReady = true;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Kraken] ✅ Page ready (took ${elapsed}s)`);
            break;
          }
        } catch (e) {
          // Element might have been removed, continue checking
        }
      }
    }
    
    await delay(500); // Check every 500ms
  }
  
  if (!pageReady) {
    console.log(`[Kraken] ⚠️  Page readiness check timeout, proceeding anyway...`);
    await delay(2000); // Fallback: wait 2 seconds
  }
  
  // Step 1: Go to Open orders tab
  console.log(`[Kraken] Step 1: Going to Open orders tab...`);
  console.log(`[Kraken] Finding Open orders tab using data-layout-path="/c1/ts1/tb2"...`);
  
  let openOrdersTab = await page.evaluateHandle(() => {
    // Find Open orders tab using the provided HTML structure
    const tabs = Array.from(document.querySelectorAll('div[data-layout-path="/c1/ts1/tb2"]'));
    for (const tab of tabs) {
      const tabContent = tab.querySelector('.flexlayout__tab_button_content');
      if (tabContent) {
        const text = tabContent.textContent || '';
        if (text.toLowerCase().includes('open orders')) {
          return tab;
        }
      }
    }
    return null;
  });
  
  if (openOrdersTab && openOrdersTab.asElement()) {
    const openOrdersTabElement = openOrdersTab.asElement();
    const isVisible = await page.evaluate((el) => {
      return el && el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
    }, openOrdersTabElement);
    
    if (isVisible) {
      console.log(`[Kraken] ✅ Found Open orders tab, clicking...`);
      await openOrdersTabElement.click();
      console.log(`[Kraken] ✅ Clicked Open orders tab`);
      
      // Smart wait for orders table to load (check for table elements instead of fixed delay)
      let tableReady = false;
      for (let i = 0; i < 10; i++) {
        tableReady = await page.evaluate(() => {
          const hasTable = document.querySelector('[role="table"]') !== null ||
                          document.getElementById('open-orders') !== null ||
                          document.querySelector('[role="rowgroup"]') !== null;
          const hasOrderText = document.body.innerText.toLowerCase().includes('limit') ||
                              document.body.innerText.toLowerCase().includes('market');
          return hasTable || hasOrderText;
        });
        if (tableReady) {
          console.log(`[Kraken] ✅ Orders table loaded`);
          break;
        }
        await delay(300);
      }
      if (!tableReady) {
        console.log(`[Kraken] ⚠️  Orders table may not be fully loaded, proceeding...`);
        await delay(500); // Fallback delay
      }
    } else {
      console.log(`[Kraken] ⚠️  Open orders tab found but not visible`);
      return { success: false, message: "Open orders tab not visible" };
    }
  } else {
    console.log(`[Kraken] ⚠️  Could not find Open orders tab using data-layout-path="/c1/ts1/tb2"`);
    return { success: false, message: "Open orders tab not found" };
  }
  
  // Step 2: Check if there are any orders
  console.log(`[Kraken] Step 2: Checking for open orders...`);
  
  // Small delay to ensure DOM is stable
  await delay(300);
  const hasOrders = await page.evaluate(() => {
    // Strategy 1: Look for container with id="open-orders" (Kraken-specific)
    let container = document.getElementById('open-orders');
    
    // Strategy 2: Look for table with role="table" that contains order data
    if (!container) {
      const tables = Array.from(document.querySelectorAll('[role="table"]'));
      for (const table of tables) {
        const tableText = (table.textContent || '').toLowerCase();
        // Check if this table contains order-related headers or data
        if ((tableText.includes('limit') || tableText.includes('market')) && 
            (tableText.includes('buy') || tableText.includes('sell')) &&
            (tableText.includes('quantity') || tableText.includes('price') || tableText.includes('usd'))) {
          container = table;
          break;
        }
      }
    }
    
    // Strategy 3: Look for rowgroup that contains order rows
    if (!container) {
      const rowgroups = Array.from(document.querySelectorAll('[role="rowgroup"]'));
      for (const rg of rowgroups) {
        const rgText = (rg.textContent || '').toLowerCase();
        if ((rgText.includes('limit') || rgText.includes('market')) && 
            (rgText.includes('buy') || rgText.includes('sell'))) {
          container = rg;
          break;
        }
      }
    }
    
    if (!container) {
      console.log('[Kraken] No order table/container found');
      return { hasOrders: false, count: 0, debug: 'no container' };
    }
    
    // Look for rows with role="button" (Kraken order rows are clickable buttons)
    const buttonRows = Array.from(container.querySelectorAll('[role="button"]'));
    
    // Also look for regular table rows
    const tableRows = Array.from(container.querySelectorAll('tbody tr, tr'));
    
    // Also look in rowgroups within the container
    const rowgroups = Array.from(container.querySelectorAll('[role="rowgroup"]'));
    const rowgroupRows = [];
    for (const rg of rowgroups) {
      rowgroupRows.push(...Array.from(rg.querySelectorAll('[role="button"], tr')));
    }
    
    // Combine all potential rows
    const allRows = [...new Set([...buttonRows, ...tableRows, ...rowgroupRows])];
    
    const orderRows = allRows.filter(row => {
      // Check visibility - be more lenient with offsetParent check
      const style = window.getComputedStyle(row);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      
      // Check if element has dimensions (even if offsetParent is null due to positioning)
      if (row.offsetWidth === 0 && row.offsetHeight === 0) {
        return false;
      }
      
      const rowText = (row.textContent || '').toLowerCase();
      
      // Skip header rows - check for multiple header indicators
      if ((rowText.includes('market') || rowText.includes('side') || rowText.includes('type')) &&
          (rowText.includes('quantity') || rowText.includes('price')) &&
          (rowText.includes('date') || rowText.includes('time'))) {
        // This looks like a header row
        return false;
      }
      
      // Check if row contains order data indicators
      const hasOrderType = rowText.includes('limit') || rowText.includes('market');
      const hasSide = (rowText.includes('buy') || rowText.includes('sell')) && 
                      !rowText.includes('side'); // "side" is a header, not order data
      const hasPrice = /\d{1,3}([,.]\d{3})*[,.]?\d*\s*(usd|btc)/i.test(rowText) || 
                      /\d{4,}\s*(usd|btc)/i.test(rowText); // Match prices like "82,669 USD" or "83056 USD"
      const hasQuantity = /0\.\d+\s*(btc|usd)/i.test(rowText) || 
                          /\d+\.\d+\s*(btc|usd)/i.test(rowText); // Match quantities like "0.0001 BTC"
      
      // Must have order type AND side, and at least one of price/quantity
      const isOrderRow = hasOrderType && hasSide && (hasPrice || hasQuantity);
      
      // Exclude canceled/filled orders
      const isActive = !rowText.includes('canceled') && 
                       !rowText.includes('filled') && 
                       !rowText.includes('executed') &&
                       !rowText.includes('no orders');
      
      return isOrderRow && isActive;
    });
    
    if (orderRows.length > 0) {
      return { hasOrders: true, count: orderRows.length };
    }
    
    return { hasOrders: false, count: 0, debug: `checked ${allRows.length} rows, none matched` };
  });
  
  // Initialize canceledCount before the if/else block
  let canceledCount = 0;
  
  if (!hasOrders.hasOrders) {
    console.log(`[Kraken] ✅ No open orders found`);
    // Continue to position closing flow instead of returning early
  } else {
  console.log(`[Kraken] Found ${hasOrders.count} open order(s), canceling all...`);
  
  // Store the initial count - we'll use this to ensure we try to cancel at least this many
  const initialOrderCount = hasOrders.count;
  
  // Helper function to find all order rows (reusable)
  const findOrderRows = async () => {
    try {
      const result = await page.evaluate(() => {
        try {
          console.log('[Kraken] findOrderRows: Starting search...');
          // Strategy 1: Look for container with id="open-orders" (Kraken-specific)
          let container = document.getElementById('open-orders');
          console.log('[Kraken] findOrderRows: Container by ID:', container ? 'found' : 'not found');
      
      // Strategy 2: Look for table with role="table" that contains order data
      if (!container) {
        const tables = Array.from(document.querySelectorAll('[role="table"]'));
        for (const table of tables) {
          const tableText = (table.textContent || '').toLowerCase();
          if ((tableText.includes('limit') || tableText.includes('market')) && 
              (tableText.includes('buy') || tableText.includes('sell')) &&
              (tableText.includes('quantity') || tableText.includes('price') || tableText.includes('usd'))) {
            container = table;
            break;
          }
        }
      }
      
      // Strategy 3: Look for rowgroup that contains order rows
      if (!container) {
        const rowgroups = Array.from(document.querySelectorAll('[role="rowgroup"]'));
        for (const rg of rowgroups) {
          const rgText = (rg.textContent || '').toLowerCase();
          if ((rgText.includes('limit') || rgText.includes('market')) && 
              (rgText.includes('buy') || rgText.includes('sell'))) {
            container = rg;
            break;
          }
        }
      }
      
      if (!container) {
        return [];
      }
      
      // Look for rows with role="button" (Kraken order rows are clickable buttons)
      const buttonRows = Array.from(container.querySelectorAll('[role="button"]'));
      const tableRows = Array.from(container.querySelectorAll('tbody tr, tr'));
      
      // Also look in rowgroups within the container
      const rowgroups = Array.from(container.querySelectorAll('[role="rowgroup"]'));
      const rowgroupRows = [];
      for (const rg of rowgroups) {
        rowgroupRows.push(...Array.from(rg.querySelectorAll('[role="button"], tr')));
      }
      
      // Combine all potential rows
      const allRows = [...new Set([...buttonRows, ...tableRows, ...rowgroupRows])];
      
      const orderRows = allRows.filter(row => {
        // Check visibility - be more lenient with offsetParent check
        const style = window.getComputedStyle(row);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
        
        // Check if element has dimensions (even if offsetParent is null due to positioning)
        if (row.offsetWidth === 0 && row.offsetHeight === 0) {
          return false;
        }
        
        const rowText = (row.textContent || '').toLowerCase();
        
        // Skip header rows - check for multiple header indicators
        if ((rowText.includes('market') || rowText.includes('side') || rowText.includes('type')) &&
            (rowText.includes('quantity') || rowText.includes('price')) &&
            (rowText.includes('date') || rowText.includes('time'))) {
          return false;
        }
        
        // Check if row contains order data indicators
        const hasOrderType = rowText.includes('limit') || rowText.includes('market');
        const hasSide = (rowText.includes('buy') || rowText.includes('sell')) && 
                        !rowText.includes('side'); // "side" is a header, not order data
        const hasPrice = /\d{1,3}([,.]\d{3})*[,.]?\d*\s*(usd|btc)/i.test(rowText) || 
                        /\d{4,}\s*(usd|btc)/i.test(rowText); // Match prices like "82,669 USD" or "83056 USD"
        const hasQuantity = /0\.\d+\s*(btc|usd)/i.test(rowText) || 
                            /\d+\.\d+\s*(btc|usd)/i.test(rowText); // Match quantities like "0.0001 BTC"
        
        // Must have order type AND side, and at least one of price/quantity
        const isOrderRow = hasOrderType && hasSide && (hasPrice || hasQuantity);
        
        // Exclude canceled/filled orders
        const isActive = !rowText.includes('canceled') && 
                         !rowText.includes('filled') && 
                         !rowText.includes('executed') &&
                         !rowText.includes('no orders');
        
        return isOrderRow && isActive;
      });
      
      console.log('[Kraken] findOrderRows: Filtered to', orderRows.length, 'order rows');
      
      // Return array of order row info - we can't pass DOM elements, so we'll use selectors
      return orderRows.map((row, index) => {
        // Get a unique identifier for the row - use its position and text content
        const rowText = row.textContent || '';
        const rowId = `${index}_${rowText.substring(0, 50).replace(/\s+/g, '_')}`;
        return {
          index,
          text: rowText.substring(0, 100) || '',
          rowId: rowId,
          // Store selector info that we can use to find it again
          hasBuy: rowText.toLowerCase().includes('buy'),
          hasSell: rowText.toLowerCase().includes('sell'),
          hasLimit: rowText.toLowerCase().includes('limit'),
          hasMarket: rowText.toLowerCase().includes('market')
        };
      });
        } catch (e) {
          // Return error info that can be logged in Node.js context
          return { error: true, message: e.message || String(e) };
        }
      });
      
      // Check if result is an error object
      if (result && typeof result === 'object' && result.error) {
        console.log(`[Kraken] ⚠️  Error in page.evaluate: ${result.message}`);
        return [];
      }
      // Ensure we always return an array
      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.log(`[Kraken] ⚠️  Error in findOrderRows: ${error.message}`);
      return [];
    }
  };
  
  // Cancel all orders one by one
  const maxAttempts = initialOrderCount * 3; // Allow up to 3 attempts per order
  let attempts = 0;
  let lastOrderCount = initialOrderCount; // Track last known order count
  
  while (attempts < maxAttempts) {
    attempts++;
    
    console.log(`[Kraken] Loop iteration ${attempts}/${maxAttempts}, canceled so far: ${canceledCount}, initial count: ${initialOrderCount}`);
    
    // Get current list of order rows
    const orderRows = await findOrderRows();
    
    // Safety check: ensure orderRows is an array
    if (!Array.isArray(orderRows)) {
      console.log(`[Kraken] ⚠️  findOrderRows returned non-array: ${typeof orderRows}, defaulting to empty array`);
      break;
    }
    
    console.log(`[Kraken] findOrderRows returned ${orderRows.length} order row(s)`);
    
    // If we haven't canceled any orders yet but findOrderRows returns empty,
    // and we know there should be orders, try to click anyway using the initial count
    if (orderRows.length === 0 && canceledCount === 0 && initialOrderCount > 0) {
      console.log(`[Kraken] ⚠️  findOrderRows returned empty but initial check found ${initialOrderCount} order(s).`);
      console.log(`[Kraken] Will attempt to click order row directly using index 0...`);
      // Continue to the clicking logic - we'll use index 0 in the page.evaluate
    } else if (orderRows.length === 0) {
      // Only exit if we've canceled at least one order AND no orders remain
      if (canceledCount > 0) {
        console.log(`[Kraken] ✅ All orders canceled (${canceledCount} total)`);
        break;
      } else {
        console.log(`[Kraken] ✅ No orders found - nothing to cancel`);
        break;
      }
    }
    
    const currentOrderCount = orderRows.length > 0 ? orderRows.length : (canceledCount === 0 ? initialOrderCount : 0);
    console.log(`[Kraken] Canceling order ${canceledCount + 1}/${initialOrderCount} (${currentOrderCount} remaining)...`);
    
    // Step 3: Click on the first available order to open modal
    console.log(`[Kraken] Step 3: Clicking on order row to open modal...`);
    if (orderRows.length > 0 && orderRows[0]) {
      const orderInfo = orderRows[0];
      console.log(`[Kraken] Order info: ${orderInfo.text ? orderInfo.text.substring(0, 80) : 'N/A'}...`);
    } else {
      console.log(`[Kraken] No order info available, will try to click first order row by index 0...`);
    }
    
    const orderClicked = await page.evaluate((targetIndex) => {
      // Strategy 1: Look for container with id="open-orders" (Kraken-specific)
      let container = document.getElementById('open-orders');
      
      // Strategy 2: Look for table with role="table" that contains order data
      if (!container) {
        const tables = Array.from(document.querySelectorAll('[role="table"]'));
        for (const table of tables) {
          const tableText = (table.textContent || '').toLowerCase();
          if ((tableText.includes('limit') || tableText.includes('market')) && 
              (tableText.includes('buy') || tableText.includes('sell')) &&
              (tableText.includes('quantity') || tableText.includes('price') || tableText.includes('usd'))) {
            container = table;
            break;
          }
        }
      }
      
      // Strategy 3: Look for rowgroup that contains order rows
      if (!container) {
        const rowgroups = Array.from(document.querySelectorAll('[role="rowgroup"]'));
        for (const rg of rowgroups) {
          const rgText = (rg.textContent || '').toLowerCase();
          if ((rgText.includes('limit') || rgText.includes('market')) && 
              (rgText.includes('buy') || rgText.includes('sell'))) {
            container = rg;
            break;
          }
        }
      }
      
      if (!container) {
        return false;
      }
      
      // Look for rows with role="button" (Kraken order rows are clickable buttons)
      const buttonRows = Array.from(container.querySelectorAll('[role="button"]'));
      const tableRows = Array.from(container.querySelectorAll('tbody tr, tr'));
      
      // Also look in rowgroups within the container
      const rowgroups = Array.from(container.querySelectorAll('[role="rowgroup"]'));
      const rowgroupRows = [];
      for (const rg of rowgroups) {
        rowgroupRows.push(...Array.from(rg.querySelectorAll('[role="button"], tr')));
      }
      
      // Combine all potential rows
      const allRows = [...new Set([...buttonRows, ...tableRows, ...rowgroupRows])];
      
      const orderRows = allRows.filter(row => {
        const style = window.getComputedStyle(row);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
        
        if (row.offsetWidth === 0 && row.offsetHeight === 0) {
          return false;
        }
        
        const rowText = (row.textContent || '').toLowerCase();
        
        // Skip header rows
        if ((rowText.includes('market') || rowText.includes('side') || rowText.includes('type')) &&
            (rowText.includes('quantity') || rowText.includes('price')) &&
            (rowText.includes('date') || rowText.includes('time'))) {
          return false;
        }
        
        const hasOrderType = rowText.includes('limit') || rowText.includes('market');
        const hasSide = (rowText.includes('buy') || rowText.includes('sell')) && 
                        !rowText.includes('side');
        const hasPrice = /\d{1,3}([,.]\d{3})*[,.]?\d*\s*(usd|btc)/i.test(rowText) || 
                        /\d{4,}\s*(usd|btc)/i.test(rowText);
        const hasQuantity = /0\.\d+\s*(btc|usd)/i.test(rowText) || 
                            /\d+\.\d+\s*(btc|usd)/i.test(rowText);
        
        const isOrderRow = hasOrderType && hasSide && (hasPrice || hasQuantity);
        const isActive = !rowText.includes('canceled') && 
                         !rowText.includes('filled') && 
                         !rowText.includes('executed') &&
                         !rowText.includes('no orders');
        
        return isOrderRow && isActive;
      });
      
      if (orderRows.length > 0 && targetIndex < orderRows.length) {
        // Click on the order row at the specified index
        orderRows[targetIndex].click();
        return true;
      }
      
      return false;
    }, 0); // Always click the first available order (index 0)
    
    if (!orderClicked) {
      console.log(`[Kraken] ⚠️  Could not click on order row`);
      break;
    }
    
    // Step 3a: Wait for FIRST modal to open (order details modal)
    console.log(`[Kraken] Step 3a: Waiting for first modal (order details) to open...`);
    let firstModalOpen = false;
      for (let i = 0; i < 12; i++) { // Increased attempts slightly but shorter delay
      firstModalOpen = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"]'));
        return modals.some(modal => {
          const style = window.getComputedStyle(modal);
          return style.display !== 'none' && style.visibility !== 'hidden' && 
                 (modal.offsetWidth > 0 && modal.offsetHeight > 0);
        });
      });
      if (firstModalOpen) {
        console.log(`[Kraken] ✅ First modal opened`);
        break;
      }
        await delay(150); // Reduced from 200ms
    }
    
    if (!firstModalOpen) {
      console.log(`[Kraken] ⚠️  First modal did not open, skipping this order`);
      await page.keyboard.press('Escape');
        await delay(200);
      continue;
    }
    
      // Smart wait: check if modal content is ready (has buttons/text)
      let modalReady = false;
      for (let i = 0; i < 5; i++) {
        modalReady = await page.evaluate(() => {
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
          return modals.some(modal => {
            const style = window.getComputedStyle(modal);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const hasButtons = modal.querySelectorAll('button').length > 0;
            const hasText = (modal.textContent || '').trim().length > 10;
            return hasButtons && hasText;
          });
        });
        if (modalReady) break;
        await delay(100);
      }
      if (!modalReady) {
        await delay(200); // Fallback
      }
    
    // Step 4: Find and click "Cancel order" button in FIRST modal
    console.log(`[Kraken] Step 4: Looking for "Cancel order" button in first modal...`);
    let cancelOrderBtn = await findByExactText(page, "Cancel order", ["button", "div", "span"]);
    
    if (!cancelOrderBtn) {
      cancelOrderBtn = await findByText(page, "Cancel order", ["button", "div", "span"]);
    }
    
    if (!cancelOrderBtn) {
      cancelOrderBtn = await findByExactText(page, "Cancel", ["button", "div", "span"]);
    }
    
    if (cancelOrderBtn) {
      // Verify it's in a modal
      const isInModal = await page.evaluate((el) => {
        let parent = el.parentElement;
        for (let i = 0; i < 10 && parent; i++) {
          const className = (typeof parent.className === 'string' ? parent.className : (parent.className?.baseVal || String(parent.className) || '')).toLowerCase();
          if (parent.tagName === 'DIV' && (parent.getAttribute('role') === 'dialog' || 
              className.includes('modal') || className.includes('dialog') || 
              className.includes('overlay'))) {
            return true;
          }
          parent = parent.parentElement;
        }
        return false;
      }, cancelOrderBtn);
      
      if (isInModal) {
        console.log(`[Kraken] ✅ Found "Cancel order" button in first modal, clicking...`);
        await cancelOrderBtn.click();
        console.log(`[Kraken] Waiting for first modal to close and second modal (confirmation) to open...`);
        
        // Step 4a: Wait for FIRST modal to close and SECOND modal to open
        let secondModalOpen = false;
        let firstModalClosed = false;
        for (let i = 0; i < 12; i++) { // Reduced from 15
          const modalState = await page.evaluate(() => {
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"]'));
            const visibleModals = modals.filter(modal => {
              const style = window.getComputedStyle(modal);
              return style.display !== 'none' && style.visibility !== 'hidden' && 
                     (modal.offsetWidth > 0 && modal.offsetHeight > 0);
            });
            return { count: visibleModals.length, hasCancelText: document.body.innerText.toLowerCase().includes('yes, cancel order') || document.body.innerText.toLowerCase().includes('cancel order') };
          });
          
          // Check if we have a confirmation modal (should have "Yes, cancel order" text)
          if (modalState.hasCancelText && modalState.count > 0) {
            secondModalOpen = true;
            firstModalClosed = true; // Assume first closed if second opened
            break;
          }
          
          // If no modals visible, first modal closed but second hasn't opened yet
          if (modalState.count === 0 && i > 2) {
            firstModalClosed = true;
          }
          
          await delay(150); // Reduced from 200ms
        }
        
        if (!secondModalOpen) {
          console.log(`[Kraken] ⚠️  Second modal (confirmation) did not open after clicking "Cancel order"`);
          // Try to close any open modals and continue
          await page.keyboard.press('Escape');
          await delay(300);
          continue;
        }
        
        console.log(`[Kraken] ✅ Second modal (confirmation) opened`);
        // Smart wait: check if confirmation button is ready
        let confirmReady = false;
        for (let i = 0; i < 5; i++) {
          confirmReady = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return text.includes('yes, cancel order') || text.includes('cancel order');
          });
          if (confirmReady) break;
          await delay(100);
        }
        if (!confirmReady) {
          await delay(200); // Fallback
        }
      } else {
        console.log(`[Kraken] ⚠️  Found "Cancel order" button but it's not in a modal`);
        // Try to close any open modals and continue
        await page.keyboard.press('Escape');
        await delay(300);
        continue;
      }
    } else {
      console.log(`[Kraken] ⚠️  Could not find "Cancel order" button in first modal`);
      // Try to close any open modals and continue
      await page.keyboard.press('Escape');
      await delay(300);
      continue;
    }
    
    // Step 5: Find and click "Yes, cancel order" button in SECOND modal (confirmation modal)
    console.log(`[Kraken] Step 5: Looking for "Yes, cancel order" button in second modal (confirmation)...`);
    let confirmCancelBtn = await findByExactText(page, "Yes, cancel order", ["button", "div", "span"]);
    
    if (!confirmCancelBtn) {
      confirmCancelBtn = await findByText(page, "Yes, cancel order", ["button", "div", "span"]);
    }
    
    if (!confirmCancelBtn) {
      // Try variations
      confirmCancelBtn = await findByExactText(page, "Yes", ["button", "div", "span"]);
    }
    
    if (confirmCancelBtn) {
      // Verify it's in a modal
      const isInModal = await page.evaluate((el) => {
        let parent = el.parentElement;
        for (let i = 0; i < 10 && parent; i++) {
          const className = (typeof parent.className === 'string' ? parent.className : (parent.className?.baseVal || String(parent.className) || '')).toLowerCase();
          if (parent.tagName === 'DIV' && (parent.getAttribute('role') === 'dialog' || 
              className.includes('modal') || className.includes('dialog') || 
              className.includes('overlay'))) {
            return true;
          }
          parent = parent.parentElement;
        }
        return false;
      }, confirmCancelBtn);
      
      if (isInModal) {
        console.log(`[Kraken] ✅ Found "Yes, cancel order" button in second modal, clicking...`);
        await confirmCancelBtn.click();
        console.log(`[Kraken] Waiting for both modals to close...`);
        
        // Step 5a: Wait for both modals to close
        let modalsClosed = false;
        for (let i = 0; i < 15; i++) { // Reduced from 20
          const modalCount = await page.evaluate(() => {
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"]'));
            return modals.filter(modal => {
              const style = window.getComputedStyle(modal);
              return style.display !== 'none' && style.visibility !== 'hidden' && 
                     (modal.offsetWidth > 0 && modal.offsetHeight > 0);
            }).length;
          });
          
          if (modalCount === 0) {
            modalsClosed = true;
            break;
          }
          await delay(150); // Reduced from 200ms
        }
        
        if (modalsClosed) {
          canceledCount++;
          console.log(`[Kraken] ✅ Order ${canceledCount} canceled successfully (both modals closed)`);
        } else {
          console.log(`[Kraken] ⚠️  Modals may still be open, but order cancellation was attempted`);
          // Try to close any remaining modals
          await page.keyboard.press('Escape');
          await delay(300);
          canceledCount++; // Count it anyway since we clicked confirm
        }
      } else {
        console.log(`[Kraken] ⚠️  Found "Yes, cancel order" button but it's not in a modal`);
        // Try to close any open modals and continue
        await page.keyboard.press('Escape');
        await delay(300);
      }
    } else {
      console.log(`[Kraken] ⚠️  Could not find "Yes, cancel order" button in second modal`);
      // Try to close any open modals and continue
      await page.keyboard.press('Escape');
      await delay(300);
    }
    
      // Wait a bit before checking for next order (reduced)
      await delay(300);
    }
  }
  
  // Wait for orders table to stabilize after canceling orders
  console.log(`[Kraken] Waiting for orders table to stabilize after cancel order flow...`);
  let tableStable = false;
  for (let i = 0; i < 5; i++) {
    tableStable = await page.evaluate(() => {
      // Check if no more order rows are visible
      const tables = Array.from(document.querySelectorAll('[role="table"]'));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('[role="button"], tr'));
        const orderRows = rows.filter(row => {
          const text = (row.textContent || '').toLowerCase();
          return (text.includes('limit') || text.includes('market')) &&
                 (text.includes('buy') || text.includes('sell')) &&
                 !text.includes('canceled') && !text.includes('filled');
        });
        return orderRows.length === 0;
      }
      return true;
    });
    if (tableStable) {
      console.log(`[Kraken] ✅ Orders table stabilized`);
      break;
    }
    await delay(300);
  }
  if (!tableStable) {
    await delay(500); // Fallback
  }
  
  // Step 6: Navigate to Positions tab and close all positions
  console.log(`[Kraken] Step 6: Navigating to Positions tab...`);
  let positionsTab = await page.evaluateHandle(() => {
    // Find Positions tab using the provided HTML structure
    const tabs = Array.from(document.querySelectorAll('div[data-layout-path*="/c1/ts1/tb"]'));
    for (const tab of tabs) {
      const tabContent = tab.querySelector('.flexlayout__tab_button_content');
      if (tabContent) {
        const text = tabContent.textContent || '';
        if (text.toLowerCase().includes('positions')) {
          return tab;
        }
      }
    }
    return null;
  });
  
  if (positionsTab && positionsTab.asElement()) {
    const positionsTabElement = positionsTab.asElement();
    const isVisible = await page.evaluate((el) => {
      return el && el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
    }, positionsTabElement);
    
    if (isVisible) {
      console.log(`[Kraken] ✅ Found Positions tab, clicking...`);
      await positionsTabElement.click();
      
      // Smart wait for positions tab to load
      let positionsReady = false;
      for (let i = 0; i < 8; i++) {
        positionsReady = await page.evaluate(() => {
          const hasPositionText = document.body.innerText.toLowerCase().includes('positions') ||
                                 document.body.innerText.toLowerCase().includes('long') ||
                                 document.body.innerText.toLowerCase().includes('short');
          const hasPositionRows = document.querySelectorAll('div[role="button"]').length > 0;
          return hasPositionText && hasPositionRows;
        });
        if (positionsReady) {
          console.log(`[Kraken] ✅ Positions tab loaded`);
          break;
        }
        await delay(300);
      }
      if (!positionsReady) {
        await delay(500); // Fallback
      }
      console.log(`[Kraken] ✅ Clicked Positions tab`);
    } else {
      console.log(`[Kraken] ⚠️  Positions tab found but not visible`);
    }
  } else {
    // Fallback: Try text-based search
    positionsTab = await findByText(page, "Positions", ["button", "div", "span", "a"]);
    if (positionsTab) {
      const isVisible = await page.evaluate((el) => {
        return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      }, positionsTab);
      if (isVisible) {
        console.log(`[Kraken] ✅ Found Positions tab via text search, clicking...`);
        await positionsTab.click();
        
        // Smart wait for positions tab to load
        let positionsReady = false;
        for (let i = 0; i < 8; i++) {
          positionsReady = await page.evaluate(() => {
            const hasPositionText = document.body.innerText.toLowerCase().includes('positions') ||
                                   document.body.innerText.toLowerCase().includes('long') ||
                                   document.body.innerText.toLowerCase().includes('short');
            const hasPositionRows = document.querySelectorAll('div[role="button"]').length > 0;
            return hasPositionText && hasPositionRows;
          });
          if (positionsReady) {
            console.log(`[Kraken] ✅ Positions tab loaded`);
            break;
          }
          await delay(300);
        }
        if (!positionsReady) {
          await delay(500); // Fallback
        }
        console.log(`[Kraken] ✅ Clicked Positions tab`);
      }
    } else {
      console.log(`[Kraken] ⚠️  Could not find Positions tab`);
    }
  }
  
  // Step 7: Find all position rows and close them
  console.log(`[Kraken] Step 7: Finding all position rows in Positions tab...`);
  // Small delay to ensure DOM is stable
  await delay(300);
  
  // Get count of position rows (divs with role="button" and cursor-pointer class)
  const positionCount = await page.evaluate(() => {
    // Find all position rows - they have role="button" and cursor-pointer class
    const positionRows = Array.from(document.querySelectorAll('div[role="button"]'));
    const validRows = [];
    
    for (const row of positionRows) {
      // Skip if not visible
      if (row.offsetParent === null) continue;
      const style = window.getComputedStyle(row);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      
      // Check if element has dimensions
      const rect = row.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      
      // Check if it has cursor-pointer class (position rows are clickable)
      const className = row.className || '';
      const hasCursorPointer = className.includes('cursor-pointer');
      
      // Check if it contains position data (BTC, Long, Short, etc.)
      const text = (row.textContent || '').toLowerCase();
      const hasPositionData = text.includes('btc') || 
                              text.includes('long') || 
                              text.includes('short') ||
                              (text.includes('perp') && /\d/.test(text));
      
      // Exclude headers - look for header patterns
      const isHeader = (text.includes('side') && text.includes('size') && text.includes('price')) ||
                      (text.includes('pair') && text.includes('side') && text.includes('size')) ||
                      row.querySelector('th') !== null ||
                      (row.parentElement && row.parentElement.tagName === 'THEAD');
      
      // Include if it's a clickable row with position data and not a header
      if (hasCursorPointer && hasPositionData && !isHeader) {
        validRows.push({
          text: text.substring(0, 80),
          hasLong: text.includes('long'),
          hasShort: text.includes('short')
        });
      }
    }
    
    return validRows.length;
  });
  
  console.log(`[Kraken] Found ${positionCount} position row(s)`);
  
  if (positionCount === 0) {
    console.log(`[Kraken] ✅ No positions found to close`);
  } else {
    // Close each position by clicking on clickable elements one by one
    for (let i = 1; i < positionCount; i++) {
      console.log(`[Kraken] Closing position ${i + 1}/${positionCount}...`);
      
      // Step 7a: Click on the position row to open modal
      const positionClicked = await page.evaluate((index) => {
        // Find all position rows again (in case DOM changed)
        const positionRows = Array.from(document.querySelectorAll('div[role="button"]'));
        const validRows = [];
        
        for (const row of positionRows) {
          if (row.offsetParent === null) continue;
          const style = window.getComputedStyle(row);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          
          const rect = row.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          
          const className = row.className || '';
          const hasCursorPointer = className.includes('cursor-pointer');
          
          const text = (row.textContent || '').toLowerCase();
          const hasPositionData = text.includes('btc') || 
                                  text.includes('long') || 
                                  text.includes('short') ||
                                  (text.includes('perp') && /\d/.test(text));
          
          const isHeader = (text.includes('side') && text.includes('size') && text.includes('price')) ||
                          (text.includes('pair') && text.includes('side') && text.includes('size')) ||
                          row.querySelector('th') !== null ||
                          (row.parentElement && row.parentElement.tagName === 'THEAD');
          
          if (hasCursorPointer && hasPositionData && !isHeader) {
            validRows.push(row);
          }
        }
        
        if (validRows.length > index) {
          const row = validRows[index];
          // Try to click the row
          try {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.click();
            return { success: true, text: row.textContent?.substring(0, 80) || '' };
          } catch (e) {
            // Try JavaScript click
            try {
              row.scrollIntoView({ behavior: 'smooth', block: 'center' });
              row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return { success: true, text: row.textContent?.substring(0, 80) || '' };
            } catch (e2) {
              return { success: false, error: e2.message };
            }
          }
        }
        return { success: false, error: 'Row not found' };
      }, i);
      
      if (!positionClicked || !positionClicked.success) {
        console.log(`[Kraken] ⚠️  Could not click on position ${i + 1}: ${positionClicked?.error || 'Unknown error'}`);
        await delay(300);
        continue;
      }
      
      console.log(`[Kraken] ✅ Clicked on position row: ${positionClicked.text}`);
      await delay(300); // Reduced from 500ms
      
      // Step 7b: Wait for first modal to render
      console.log(`[Kraken] Waiting for position modal to open...`);
      let firstModalOpen = false;
      for (let j = 0; j < 5; j++) { // Reduced from 20
        firstModalOpen = await page.evaluate(() => {
          // Check for modals/dialogs
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="dialog"]'));
          const visibleModals = modals.filter(modal => {
            const style = window.getComputedStyle(modal);
            const isVisible = style.display !== 'none' && 
                             style.visibility !== 'hidden' && 
                             style.opacity !== '0' &&
                             modal.offsetWidth > 0 && 
                             modal.offsetHeight > 0;
            
            // Also check if modal is actually on screen
            if (isVisible) {
              const rect = modal.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }
            return false;
          });
          
          return visibleModals.length > 0;
        });
        if (firstModalOpen) {
          console.log(`[Kraken] ✅ Position modal opened`);
          break;
        }
        await delay(200); // Reduced from 300ms
      }
      
      if (!firstModalOpen) {
        console.log(`[Kraken] ⚠️  Position modal did not open after clicking, trying next element...`);
        // Don't press Escape here - might interfere with next click
        await delay(200);
        continue;
      }
      
      // Smart wait: check if modal content is ready
      let modalReady = false;
      for (let i = 0; i < 5; i++) {
        modalReady = await page.evaluate(() => {
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
          return modals.some(modal => {
            const style = window.getComputedStyle(modal);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const hasButtons = modal.querySelectorAll('button').length > 0;
            const hasText = (modal.textContent || '').trim().length > 10;
            return hasButtons && hasText;
          });
        });
        if (modalReady) break;
        await delay(100);
      }
      if (!modalReady) {
        await delay(200); // Fallback
      }
      
      // Step 7c: Find and click "Close position" button in first modal
      console.log(`[Kraken] Looking for "Close position" button in modal...`);
      let closePositionBtn = await findByExactText(page, "Close position", ["button", "div", "span"]);
      
      if (!closePositionBtn) {
        closePositionBtn = await findByText(page, "Close position", ["button", "div", "span"]);
      }
      
      if (!closePositionBtn) {
        // Try variations
        closePositionBtn = await findByExactText(page, "Close", ["button", "div", "span"]);
      }
      
      if (closePositionBtn) {
        const isInModal = await page.evaluate((el) => {
          let parent = el.parentElement;
          for (let j = 0; j < 10 && parent; j++) {
            const className = (typeof parent.className === 'string' ? parent.className : (parent.className?.baseVal || String(parent.className) || '')).toLowerCase();
            if (parent.tagName === 'DIV' && (parent.getAttribute('role') === 'dialog' || 
                className.includes('modal') || className.includes('dialog') || 
                className.includes('overlay'))) {
              return true;
            }
            parent = parent.parentElement;
          }
          return false;
        }, closePositionBtn);
        
        if (isInModal) {
          console.log(`[Kraken] ✅ Found "Close position" button, clicking...`);
          await closePositionBtn.click();
          await delay(300); // Reduced from 500ms
          
          // Step 7d: Wait for second modal to render
          console.log(`[Kraken] Waiting for close position modal to open...`);
          let secondModalOpen = false;
          for (let j = 0; j < 12; j++) { // Reduced from 15
            secondModalOpen = await page.evaluate(() => {
              const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"]'));
              return modals.some(modal => {
                const style = window.getComputedStyle(modal);
                return style.display !== 'none' && style.visibility !== 'hidden' && 
                       (modal.offsetWidth > 0 && modal.offsetHeight > 0);
              });
            });
            if (secondModalOpen) {
              console.log(`[Kraken] ✅ Close position modal opened`);
              break;
            }
            await delay(150); // Reduced from 200ms
          }
          
          if (!secondModalOpen) {
            console.log(`[Kraken] ⚠️  Close position modal did not open`);
            await page.keyboard.press('Escape');
            await delay(200);
            continue;
          }
          
          // Smart wait: check if modal content is ready
          let secondModalReady = false;
          for (let i = 0; i < 5; i++) {
            secondModalReady = await page.evaluate(() => {
              const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
              return modals.some(modal => {
                const style = window.getComputedStyle(modal);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const hasButtons = modal.querySelectorAll('button').length > 0;
                const hasText = (modal.textContent || '').trim().length > 10;
                return hasButtons && hasText;
              });
            });
            if (secondModalReady) break;
            await delay(100);
          }
          if (!secondModalReady) {
            await delay(200); // Fallback
          }
          
          // Step 7e: Find and click "Limit" option (skip if closeAtMarket is true - Market is selected by default)
          if (!closeAtMarket) {
            console.log(`[Kraken] Looking for "Limit" option in modal...`);
            const limitOption = await page.evaluateHandle(() => {
              // Find button with role="tab" and text "Limit"
              const buttons = Array.from(document.querySelectorAll('button[role="tab"]'));
              for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (text.toLowerCase() === 'limit') {
                  return btn;
                }
              }
              return null;
            });
            
            if (limitOption && limitOption.asElement()) {
              const limitElement = limitOption.asElement();
              const isVisible = await page.evaluate((el) => {
                return el && el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
              }, limitElement);
              
              if (isVisible) {
                console.log(`[Kraken] ✅ Found "Limit" option, clicking...`);
                await limitElement.click();
                await delay(300); // Reduced from 500ms
              } else {
                console.log(`[Kraken] ⚠️  Limit option found but not visible`);
              }
            } else {
              // Fallback: Try text search
              const limitBtn = await findByText(page, "Limit", ["button"]);
              if (limitBtn) {
                console.log(`[Kraken] ✅ Found "Limit" option via text search, clicking...`);
                await limitBtn.click();
                await delay(300); // Reduced from 500ms
              } else {
                console.log(`[Kraken] ⚠️  Could not find "Limit" option`);
              }
            }
          } else {
            // Market close: Skip Limit selection (Market is selected by default)
            console.log(`[Kraken] Skipping Limit selection - closing at Market (default selection)`);
            await delay(200); // Small delay for modal to be ready
          }
          
          // Step 7f: Find and click "Close BTC Perp" button
          console.log(`[Kraken] Looking for "Close BTC Perp" button in modal...`);
          let closeBtcBtn = await findByExactText(page, "Close BTC", ["button", "div", "span"]);
          
          if (!closeBtcBtn) {
            closeBtcBtn = await findByText(page, "Close BTC", ["button", "div", "span"]);
          }
          
          if (!closeBtcBtn) {
            // Try variations
            closeBtcBtn = await findByText(page, "Close", ["button", "div", "span"]);
          }
          
          if (closeBtcBtn) {
            const isInModal2 = await page.evaluate((el) => {
              let parent = el.parentElement;
              for (let j = 0; j < 10 && parent; j++) {
                const className = (typeof parent.className === 'string' ? parent.className : (parent.className?.baseVal || String(parent.className) || '')).toLowerCase();
                if (parent.tagName === 'DIV' && (parent.getAttribute('role') === 'dialog' || 
                    className.includes('modal') || className.includes('dialog') || 
                    className.includes('overlay'))) {
                  return true;
                }
                parent = parent.parentElement;
              }
              return false;
            }, closeBtcBtn);
            
            if (isInModal2) {
              console.log(`[Kraken] ✅ Found "Close BTC Perp" button, clicking...`);
              await closeBtcBtn.click();
              await delay(500); // Reduced from 1000ms
              
              // Wait for modal to close
              let modalClosed = false;
              for (let j = 0; j < 12; j++) { // Reduced from 15
                const modalCount = await page.evaluate(() => {
                  const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"]'));
                  return modals.filter(modal => {
                    const style = window.getComputedStyle(modal);
                    return style.display !== 'none' && style.visibility !== 'hidden' && 
                           (modal.offsetWidth > 0 && modal.offsetHeight > 0);
                  }).length;
                });
                
                if (modalCount === 0) {
                  modalClosed = true;
                  break;
                }
                await delay(150); // Reduced from 200ms
              }
              
              if (modalClosed) {
                console.log(`[Kraken] ✅ Position ${i + 1} closed successfully`);
              } else {
                console.log(`[Kraken] ⚠️  Modal may still be open, but position close was attempted`);
                await page.keyboard.press('Escape');
                await delay(200);
              }
            } else {
              console.log(`[Kraken] ⚠️  Found "Close BTC Perp" button but it's not in a modal`);
            }
          } else {
            console.log(`[Kraken] ⚠️  Could not find "Close BTC Perp" button`);
            await page.keyboard.press('Escape');
            await delay(200);
          }
        } else {
          console.log(`[Kraken] ⚠️  Found "Close position" button but it's not in a modal`);
          await page.keyboard.press('Escape');
          await delay(200);
        }
      } else {
        console.log(`[Kraken] ⚠️  Could not find "Close position" button`);
        await page.keyboard.press('Escape');
        await delay(200);
      }
      
      // Wait before processing next position (reduced)
      await delay(300);
    }
  }
  
  console.log(`[Kraken] ✅ Position closing flow completed`);
  await delay(500); // Reduced from 1000ms
  
  if (canceledCount > 0) {
    return { success: true, message: `Canceled ${canceledCount} order(s)`, canceled: canceledCount };
  } else {
    return { success: true, message: "No orders to cancel", canceled: 0 };
  }
}

/**
 * Check if there are any open positions on Kraken
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<Object>} - { hasPositions: boolean, count: number, longCount: number, shortCount: number, positions: Array, success: boolean, message: string }
 */
async function checkKrakenOpenPositions(page) {
  console.log(`[Kraken] Checking for open positions...`);
  
  try {
    // Step 1: Navigate to Positions tab
    console.log(`[Kraken] Step 1: Navigating to Positions tab...`);
    let positionsTab = await page.evaluateHandle(() => {
      // Find Positions tab using the provided HTML structure
      const tabs = Array.from(document.querySelectorAll('div[data-layout-path*="/c1/ts1/tb"]'));
      for (const tab of tabs) {
        const tabContent = tab.querySelector('.flexlayout__tab_button_content');
        if (tabContent) {
          const text = tabContent.textContent || '';
          if (text.toLowerCase().includes('positions')) {
            return tab;
          }
        }
      }
      return null;
    });
    
    if (positionsTab && positionsTab.asElement()) {
      const positionsTabElement = positionsTab.asElement();
      const isVisible = await page.evaluate((el) => {
        return el && el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      }, positionsTabElement);
      
      if (isVisible) {
        console.log(`[Kraken] ✅ Found Positions tab, clicking...`);
        await positionsTabElement.click();
        
        // Smart wait for positions tab to load
        let positionsReady = false;
        for (let i = 0; i < 8; i++) {
          positionsReady = await page.evaluate(() => {
            const hasPositionText = document.body.innerText.toLowerCase().includes('positions') ||
                                   document.body.innerText.toLowerCase().includes('long') ||
                                   document.body.innerText.toLowerCase().includes('short');
            const hasPositionRows = document.querySelectorAll('div[role="button"]').length > 0;
            return hasPositionText && hasPositionRows;
          });
          if (positionsReady) {
            console.log(`[Kraken] ✅ Positions tab loaded`);
            break;
          }
          await delay(300);
        }
        if (!positionsReady) {
          await delay(500); // Fallback
        }
      } else {
        console.log(`[Kraken] ⚠️  Positions tab found but not visible`);
      }
    } else {
      // Fallback: Try text-based search
      positionsTab = await findByText(page, "Positions", ["button", "div", "span", "a"]);
      if (positionsTab) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, positionsTab);
        if (isVisible) {
          console.log(`[Kraken] ✅ Found Positions tab via text search, clicking...`);
          await positionsTab.click();
          
          // Smart wait for positions tab to load
          let positionsReady = false;
          for (let i = 0; i < 8; i++) {
            positionsReady = await page.evaluate(() => {
              const hasPositionText = document.body.innerText.toLowerCase().includes('positions') ||
                                     document.body.innerText.toLowerCase().includes('long') ||
                                     document.body.innerText.toLowerCase().includes('short');
              const hasPositionRows = document.querySelectorAll('div[role="button"]').length > 0;
              return hasPositionText && hasPositionRows;
            });
            if (positionsReady) {
              console.log(`[Kraken] ✅ Positions tab loaded`);
              break;
            }
            await delay(300);
          }
          if (!positionsReady) {
            await delay(500); // Fallback
          }
        }
      } else {
        console.log(`[Kraken] ⚠️  Could not find Positions tab`);
        return { 
          success: false, 
          hasPositions: false, 
          count: 0,
          longCount: 0,
          shortCount: 0,
          positions: [],
          message: "Could not find Positions tab" 
        };
      }
    }
    
    // Step 2: Check for position rows
    console.log(`[Kraken] Step 2: Checking for position rows in Positions tab...`);
    await delay(300); // Small delay to ensure DOM is stable
    
    const positionResult = await page.evaluate(() => {
      // Find all position rows - they have role="button" and cursor-pointer class
      const positionRows = Array.from(document.querySelectorAll('div[role="button"]'));
      const validRows = [];
      
      for (const row of positionRows) {
        // Skip if not visible
        if (row.offsetParent === null) continue;
        const style = window.getComputedStyle(row);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        
        // Check if element has dimensions
        const rect = row.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        
        // Check if it has cursor-pointer class (position rows are clickable)
        const className = row.className || '';
        const hasCursorPointer = className.includes('cursor-pointer');
        
        // Check if it contains position data (BTC, Long, Short, etc.)
        const text = (row.textContent || '').toLowerCase();
        const hasPositionData = text.includes('btc') || 
                                text.includes('long') || 
                                text.includes('short') ||
                                (text.includes('perp') && /\d/.test(text));
        
        // Exclude headers - look for header patterns
        const isHeader = (text.includes('side') && text.includes('size') && text.includes('price')) ||
                        (text.includes('pair') && text.includes('side') && text.includes('size')) ||
                        row.querySelector('th') !== null ||
                        (row.parentElement && row.parentElement.tagName === 'THEAD');
        
        // Include if it's a clickable row with position data and not a header
        if (hasCursorPointer && hasPositionData && !isHeader) {
          const isLong = text.includes('long');
          const isShort = text.includes('short');
          
          validRows.push({
            text: text.substring(0, 80),
            side: isLong ? 'long' : (isShort ? 'short' : 'unknown'),
            isLong: isLong,
            isShort: isShort
          });
        }
      }
      
      // Count long and short positions
      const longCount = validRows.filter(row => row.isLong).length;
      const shortCount = validRows.filter(row => row.isShort).length;
      
      return {
        hasPositions: validRows.length -1 > 0,
        count: validRows.length -1 ,
        longCount: longCount,
        shortCount: shortCount,
        rows: validRows
      };
    });
    
    if (positionResult.hasPositions) {
      console.log(`[Kraken] ✅ Found ${positionResult.count} open position(s) - Long: ${positionResult.longCount}, Short: ${positionResult.shortCount}`);
      return {
        success: true,
        hasPositions: true,
        count: positionResult.count,
        longCount: positionResult.longCount,
        shortCount: positionResult.shortCount,
        positions: positionResult.rows,
        message: `Found ${positionResult.count} open position(s) - Long: ${positionResult.longCount}, Short: ${positionResult.shortCount}`
      };
    } else {
      console.log(`[Kraken] ✅ No open positions found`);
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
    console.log(`[Kraken] ❌ Error checking for open positions: ${error.message}`);
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

export { cancelAllOrders, verifyOrderPlaced, cancelKrakenOrders, checkKrakenOpenPositions };