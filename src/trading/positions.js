import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay } from '../utils/helpers.js';
import { findByExactText } from '../utils/helpers.js';
import { handleSetLeverage } from './leverage.js';

async function closeAllPositions(page, percent = 100, exchangeConfig = null) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
    console.log(`\n=== Closing Position (${percent}%) on ${exchange.name} ===`);
  
    // Wait a moment for any previous actions to complete
    await delay(700);
  
    // Click on Positions tab to see open positions
    // IMPORTANT: For Paradex, we need to stay on Positions tab throughout the entire flow
    // Do NOT navigate to Orders tab - we need Positions tab for TP/SL and Limit button
    console.log(`[${exchange.name}] Navigating to Positions tab (will stay here for TP/SL and Limit button)...`);
    const positionsTab = await findByExactText(page, exchange.selectors.positionsTab, [
      "button",
      "div",
      "span",
    ]);
    if (positionsTab) {
      await positionsTab.click();
      console.log(`[${exchange.name}] ✓ Clicked Positions tab - will stay here for TP/SL and Limit button`);
      await delay(400); // Reduced from 2000ms - wait for positions to load
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find Positions tab`);
    }
  
    // Check if there are any open positions
    console.log("Checking for open positions...");
    let hasPositions = false;
    for (let i = 0; i < 3; i++) {
      hasPositions = await page.evaluate(() => {
        const text = document.body.innerText;
        return (
          text.includes("Current Position") ||
          text.includes("Unrealized P&L") ||
          text.includes("Position Size") ||
          text.includes("Entry Price")
        );
      });
  
      if (hasPositions) {
        console.log("Found open positions!");
        break;
      }
  
      if (i < 2) {
        console.log(`Attempt ${i + 1}/3: No positions found yet, waiting...`);
        await delay(400); // Reduced from 1500ms
      }
    }
  
    if (!hasPositions) {
      console.log("✓ No open positions found - nothing to close");
      return { success: true, message: "No positions to close" };
    }
  
    // If we reach here, positions exist - FIRST add TP/SL, then close using Limit, then fallback to Close All
    console.log("✓ Positions found - proceeding to add TP/SL first, then close them...");
    
    // Wait a bit more for UI to fully render
    await delay(300);
  
    // Step 0: For Paradex - Add TP/SL before closing positions
    // if (exchange.name === 'Paradex') {
    //   console.log(`\n[Paradex] Step 0: Adding TP/SL before closing positions...`);
      
    //   // Use the new function to handle the complete TP/SL flow
    //   const tpSlResult = await clickTpSlColumnInPositions(page, exchange);
      
    //   if (tpSlResult.success) {
    //     console.log(`[Paradex] ✅ TP/SL flow completed: ${tpSlResult.message}`);
    //     tpSlCompleted = true;
    //   } else {
    //     console.log(`[Paradex] ⚠️  TP/SL flow failed: ${tpSlResult.message}`);
    //     // Continue anyway - might still be able to close positions
    //   }
    // }
  
    // CRITICAL: After TP/SL is set, ensure we're still on Positions tab before looking for Limit button
    // Do NOT navigate to Orders tab - we need to stay on Positions tab to find Limit button
    console.log(`[Paradex] TP/SL setup complete. Ensuring we're on Positions tab before looking for Limit button...`);
    
    // IMPORTANT: Only look for Limit button if there are still open positions
    // Check if positions exist by checking for data rows in table (not just header row)
    console.log(`[Paradex] Checking if positions still exist before looking for Limit button...`);
    const hasPositionsForLimit = await page.evaluate(() => {
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
            // If row has some text content (not just whitespace), it's a data row = position exists
            if (rowText && rowText.length > 0) {
              return true; // Found at least one data row = positions exist
            }
          }
        }
      }
      
      return false; // No data rows found = no positions
    });
  
    if (!hasPositionsForLimit) {
      console.log(`[Paradex] ✅ No open positions found (only header row in table) - skipping Limit button search`);
      return { success: true, message: "No positions to close - TP/SL was set but positions already closed" };
    }
  
    console.log(`[Paradex] ✅ Positions still exist (data rows found in table) - proceeding to find Limit button...`);
    
    // Step 1: Look for Limit button in Positions table Close column BEFORE any Close All button logic
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


  export { closeAllPositions, checkIfPositionsClosed, getCurrentUnrealizedPnL, handleClosePositionsAndSetLeverage };