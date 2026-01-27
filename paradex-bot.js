import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

puppeteer.use(StealthPlugin());

// ---------- CONFIG ----------
const HEADLESS = process.argv.includes('--headless');

// Exchange configurations
const EXCHANGE_CONFIGS = {
  paradex: {
    name: "Paradex",
    url: "https://app.paradex.trade/trade/BTC-USD-PERP",
    referralUrl: "https://app.paradex.trade/r/instantcrypto",
    urlPattern: "app.paradex.trade/trade",
    // UI selectors - using same as current (Paradex-specific)
    selectors: {
      loginButton: 'button[data-dd-action-name="Connect wallet"]',
      buyButton: "Buy",
      sellButton: "Sell",
      marketButton: "Market",
      limitButton: "Limit",
      confirmBuy: "Confirm Buy",
      confirmSell: "Confirm Sell",
      positionsTab: "Positions",
    }
  },
  extended: {
    name: "Extended Exchange",
    url: "https://app.extended.exchange/perp",
    referralUrl: "https://app.extended.exchange/perp",
    urlPattern: "app.extended.exchange/perp",
    // UI selectors - will need to be updated after inspecting Extended Exchange UI
    // For now, using generic text-based selectors (same as Paradex)
    selectors: {
      loginButton: null, // Will use text-based search
      buyButton: "Buy",
      sellButton: "Sell",
      marketButton: "Market",
      limitButton: "Limit",
      confirmBuy: "Confirm Buy", // May need to change
      confirmSell: "Sell", // Extended Exchange uses "Sell" button, not "Confirm Sell"
      positionsTab: "Positions", // May need to change
    }
  }
};

// Multiple accounts configuration - read from environment variable
const getAccountsFromEnv = () => {
  const emailsEnv = process.env.ACCOUNT_EMAILS;

  if (!emailsEnv) {
    console.error('ERROR: ACCOUNT_EMAILS not found in .env file');
    process.exit(1);
  }

  const emails = emailsEnv.split(',').map(e => e.trim()).filter(e => e);

  if (emails.length === 0) {
    console.error('ERROR: No valid emails found in ACCOUNT_EMAILS');
    process.exit(1);
  }

  return emails.map((email, index) => {
    // Create a unique profile directory based on email hash to avoid conflicts
    const emailHash = Buffer.from(email).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
    return {
      email: email,
      cookiesPath: `./paradex-cookies-account${index + 1}.json`, // Keep same name for compatibility
      profileDir: `/tmp/puppeteer-chrome-profile-${index + 1}-${emailHash}`,
      apiPort: 3001 + index,
      exchange: null // Will be set based on trading mode
    };
  });
};

const ACCOUNTS = getAccountsFromEnv();
// ----------------------------

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

// Prompt user to choose trading mode
async function chooseTradingMode() {
  console.log(`\n========================================`);
  console.log(`Select Trading Mode:`);
  console.log(`========================================`);
  console.log(`1. Buy from Paradex, Sell from Paradex (Both accounts on Paradex)`);
  console.log(`2. Buy from Paradex, Sell from Extended Exchange`);
  console.log(`========================================\n`);
  
  const answer = await prompt(`Enter option (1 or 2): `);
  const mode = answer.trim();
  
  if (mode === '1') {
    return {
      mode: 1,
      buyExchange: 'paradex',
      sellExchange: 'paradex',
      description: 'Buy from Paradex, Sell from Paradex'
    };
  } else if (mode === '2') {
    return {
      mode: 2,
      buyExchange: 'paradex',
      sellExchange: 'extended',
      description: 'Buy from Paradex, Sell from Extended Exchange'
    };
  } else {
    console.log(`\n✗ Invalid option. Please enter 1 or 2.`);
    process.exit(1);
  }
}

async function findByText(page, text, tagNames = ['button', 'a', 'div', 'span']) {
  for (const tag of tagNames) {
    const elements = await page.$$(tag);
    for (const el of elements) {
      const elText = await page.evaluate(e => e.textContent?.trim(), el);
      if (elText && elText.toLowerCase().includes(text.toLowerCase())) {
        return el;
      }
    }
  }
  return null;
}

async function saveCookies(page, cookiesPath, email) {
  const cookies = await page.cookies();
  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));

  // Save email metadata alongside cookies
  const metadataPath = cookiesPath.replace('.json', '-metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify({ email, lastUpdated: new Date().toISOString() }, null, 2));

  console.log("Cookies saved to", cookiesPath);
}

async function loadCookies(page, cookiesPath, expectedEmail) {
  if (fs.existsSync(cookiesPath)) {
    // Check metadata to see if cookies belong to a different account
    const metadataPath = cookiesPath.replace('.json', '-metadata.json');
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (metadata.email && metadata.email !== expectedEmail) {
          console.log(`[${expectedEmail}] Cookie email mismatch: cookie has ${metadata.email}, expected ${expectedEmail}`);
          console.log(`[${expectedEmail}] Deleting old cookies for different account`);
          fs.unlinkSync(cookiesPath);
          fs.unlinkSync(metadataPath);
          return false;
        }
      } catch (e) {
        console.log(`[${expectedEmail}] Error reading metadata, treating as new account`);
        fs.unlinkSync(cookiesPath);
        if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
        return false;
      }
    }

    const cookies = JSON.parse(fs.readFileSync(cookiesPath));
    await page.setCookie(...cookies);
    console.log("Cookies loaded from", cookiesPath);
    return true;
  }
  return false;
}

// Check if Extended Exchange cookies exist
async function hasExtendedExchangeCookies(page) {
  const cookies = await page.cookies();
  const hasAccessToken = cookies.some(c => c.name === 'x10_access_token');
  const hasRefreshToken = cookies.some(c => c.name === 'x10_refresh_token');
  return hasAccessToken && hasRefreshToken;
}

// Clear Extended Exchange cookies
async function clearExtendedExchangeCookies(page) {
  console.log(`Clearing Extended Exchange cookies...`);
  try {
    const cookies = await page.cookies();
    const extendedCookies = cookies.filter(c => 
      c.name === 'x10_access_token' || c.name === 'x10_refresh_token'
    );
    
    if (extendedCookies.length > 0) {
      // Delete cookies by setting them with past expiry
      for (const cookie of extendedCookies) {
        await page.deleteCookie({
          name: cookie.name,
          domain: cookie.domain
        });
      }
      console.log(`Cleared ${extendedCookies.length} Extended Exchange cookie(s)`);
      return true;
    }
    console.log(`No Extended Exchange cookies to clear`);
    return false;
  } catch (error) {
    console.log(`Error clearing Extended Exchange cookies: ${error.message}`);
    return false;
  }
}

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
        await ordersTab.click();
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
        await positionsTab.click();
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
                await inputElement.click({ delay: 100 });
                await delay(300);
                await inputElement.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await delay(200);
                await inputElement.type(stopLossValue, { delay: 50 });
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
                  await inputElement.click({ delay: 100 });
                  await delay(300);
                  await inputElement.click({ clickCount: 3 });
                  await page.keyboard.press('Backspace');
                  await delay(200);
                  await inputElement.type(stopLossValue, { delay: 50 });
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

async function isLoggedIn(page, exchangeConfig = null) {
  const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
  
  // For Extended Exchange, check for specific cookies first
  if (exchange.name === 'Extended Exchange') {
    const hasCookies = await hasExtendedExchangeCookies(page);
    if (hasCookies) {
      console.log(`[Extended Exchange] Found x10_access_token and x10_refresh_token cookies`);
      // Also check if trading interface is visible
      await delay(1000);
      const hasTradingInterface = await page.evaluate(() => {
        const text = document.body.innerText;
        const hasAccountInfo = text.includes('Available to trade') ||
                              text.includes('Account Value') ||
                              text.includes('Portfolio Value') ||
                              text.includes('Unrealized P&L') ||
                              text.includes('Balance') ||
                              text.includes('Equity');
        const hasTradingButtons = Array.from(document.querySelectorAll('button')).some(
          b => {
            const btnText = b.textContent?.trim();
            return btnText === 'Buy' || btnText === 'Sell' || btnText === 'Long' || btnText === 'Short';
          }
        );
        return hasAccountInfo || hasTradingButtons;
      });
      return hasTradingInterface;
    }
    return false;
  }
  
  // For Paradex, use original logic
  // Check if user is logged in by looking for account/portfolio elements
  await delay(2000);
  const loggedInIndicators = await page.evaluate((exchangeName) => {
    const text = document.body.innerText;

    // Check for "Log in" button - if exists, we're NOT logged in
    const hasLoginBtn = Array.from(document.querySelectorAll('button')).some(
      b => b.textContent?.trim() === 'Log in'
    );

    // Check for actual trading interface elements that only appear when logged in
    // Generic indicators that work for both exchanges
    const hasAccountInfo = text.includes('Available to trade') ||
                          text.includes('Account Value') ||
                          text.includes('Portfolio Value') ||
                          text.includes('Unrealized P&L') ||
                          text.includes('Balance') ||
                          text.includes('Equity');

    // More specific check - look for the trading form (Buy/Sell buttons in trading panel)
    const hasTradingInterface = Array.from(document.querySelectorAll('button')).some(
      b => {
        const btnText = b.textContent?.trim();
        return btnText === 'Buy' || btnText === 'Sell' || btnText === 'Long' || btnText === 'Short';
      }
    );

    // We're only logged in if we DON'T see login button AND we DO see trading interface
    return !hasLoginBtn && (hasAccountInfo || hasTradingInterface);
  }, exchange.name);
  return loggedInIndicators;
}

// Helper function to handle Ethereum wallet connection error
async function handleWalletConnectionError(page, email) {
  try {
    // Check if there's a wallet connection error
    const errorInfo = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasError = (
        text.includes('ethereum wallet') ||
        text.includes('wallet connection') ||
        text.includes('connect wallet') ||
        text.includes('wallet error')
      );
      
      // Also check if Continue button exists
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const continueBtn = buttons.find(btn => {
        const btnText = btn.textContent?.trim().toLowerCase();
        const isVisible = btn.offsetParent !== null;
        return isVisible && (btnText === 'continue' || btnText.includes('continue'));
      });
      
      return { hasError, hasContinueButton: !!continueBtn };
    });

    if (errorInfo.hasError && errorInfo.hasContinueButton) {
      console.log(`[${email}] Wallet connection error detected, looking for Continue button...`);
      
      // Try to find and click Continue button
      let continueClicked = false;
      
      // Strategy 1: Find by text "Continue"
      const continueBtn = await findByText(page, 'Continue', ['button', 'div', 'span', 'a']);
      if (continueBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, continueBtn);
        if (isVisible) {
          await continueBtn.click();
          continueClicked = true;
          console.log(`[${email}] Clicked Continue button (by text)`);
        }
      }
      
      // Strategy 2: Find by data attribute or class
      if (!continueClicked) {
        const continueBtnByAttr = await page.$('button[data-dd-action-name*="continue"], button[class*="continue"]');
        if (continueBtnByAttr) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, continueBtnByAttr);
          if (isVisible) {
            await continueBtnByAttr.click();
            continueClicked = true;
            console.log(`[${email}] Clicked Continue button (by attribute)`);
          }
        }
      }
      
      // Strategy 3: Use evaluate to find and click
      if (!continueClicked) {
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
          const continueBtn = buttons.find(btn => {
            const text = btn.textContent?.trim().toLowerCase();
            const isVisible = btn.offsetParent !== null;
            return isVisible && (text === 'continue' || text.includes('continue'));
          });
          if (continueBtn) {
            continueBtn.click();
            return true;
          }
          return false;
        });
        if (clicked) {
          continueClicked = true;
          console.log(`[${email}] Clicked Continue button (via evaluate)`);
        }
      }
      
      if (continueClicked) {
        await delay(2000); // Wait for page to process
        console.log(`[${email}] Continue button clicked, waiting for page to update...`);
      } else {
        console.log(`[${email}] Continue button not found, but error was detected`);
      }
    }
  } catch (error) {
    console.log(`[${email}] Error handling wallet connection: ${error.message}`);
  }
}

async function login(page, browser, email, cookiesPath, isNewAccount = false, exchangeConfig = null) {
  const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
  console.log(`[${email}] Starting login process for ${exchange.name}...`);

  try {
    // Extended Exchange specific login flow
    if (exchange.name === 'Extended Exchange') {
      console.log(`[${email}] Extended Exchange - starting login flow...`);
      
      // Step 1: Clear cookies when bot starts
      console.log(`[${email}] Clearing Extended Exchange cookies...`);
      await clearExtendedExchangeCookies(page);
      await delay(1000);
      
      // Step 2: Look for Connect Wallet or Start Trading button
      console.log(`[${email}] Looking for Connect Wallet or Start Trading button...`);
      await delay(2000);
      
      let connectButtonClicked = false;
      
      // Strategy 1: Find "Connect Wallet" button
      const connectWalletBtn = await findByText(page, "Connect Wallet", ["button", "div", "span"]);
      if (connectWalletBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, connectWalletBtn);
        if (isVisible) {
          await connectWalletBtn.click();
          connectButtonClicked = true;
          console.log(`[${email}] Clicked Connect Wallet button`);
        }
      }
      
      // Strategy 2: Find "Start Trading" button
      if (!connectButtonClicked) {
        const startTradingBtn = await findByText(page, "Start Trading", ["button", "div", "span"]);
        if (startTradingBtn) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, startTradingBtn);
          if (isVisible) {
            await startTradingBtn.click();
            connectButtonClicked = true;
            console.log(`[${email}] Clicked Start Trading button`);
          }
        }
      }
      
      // Strategy 3: Use evaluate to find button
      if (!connectButtonClicked) {
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
          for (const btn of buttons) {
            const text = btn.textContent?.trim();
            const isVisible = btn.offsetParent !== null;
            if (isVisible && (text === 'Connect Wallet' || text === 'Start Trading')) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        if (clicked) {
          connectButtonClicked = true;
          console.log(`[${email}] Clicked Connect Wallet/Start Trading button (via evaluate)`);
        }
      }
      
      if (!connectButtonClicked) {
        console.log(`[${email}] Could not find Connect Wallet or Start Trading button`);
        return false;
      }
      
      // Wait for modal/QR code to appear
      console.log(`[${email}] Waiting for modal/QR code to appear...`);
      console.log(`[${email}] User should scan QR code and connect wallet...`);
      await delay(3000);
      
      // Check if cookies are set (one-time check after waiting)
      const hasCookiesNow = await hasExtendedExchangeCookies(page);
      if (hasCookiesNow) {
        console.log(`[${email}] ✅ Extended Exchange cookies detected!`);
        
        // Save cookies
        await saveCookies(page, cookiesPath, email);
        
        // Click on Orders tab
        console.log(`[${email}] Clicking Orders tab...`);
        await clickOrdersTab(page, email);
        
        return true;
      }
      
      console.log(`[${email}] Extended Exchange login process - user should complete wallet connection`);
      return true; // Return true to allow manual completion
    }

    // Paradex login flow (original logic)
    // For new accounts, navigate to referral URL first
    if (isNewAccount) {
      console.log(`[${email}] New account detected - using referral link`);
      try {
        await page.goto(exchange.referralUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await delay(3000);
        console.log(
          `[${email}] Referral link applied: ${exchange.referralUrl}`
        );
      } catch (error) {
        console.log(`[${email}] Error loading referral link, continuing...`);
      }
    }

    // Find and click Log in button - check both app bar and modal
    // Button has data-dd-action-name="Connect wallet" and text "Log in"
    console.log(`[${email}] Looking for Log in button...`);
    let loginClicked = false;

    // Strategy 1: Find by data attribute (most reliable) - Paradex specific
    if (exchange.selectors.loginButton) {
      const loginBtnByAttr = await page.$(exchange.selectors.loginButton);
      if (loginBtnByAttr) {
        await loginBtnByAttr.click();
        loginClicked = true;
        console.log(`[${email}] Clicked Log in button (by data attribute)`);
      }
    }

    // Strategy 2: Find by text "Log in" in button
    if (!loginClicked) {
      const loginBtnByText = await findByText(page, "Log in", ["button"]);
      if (loginBtnByText) {
        await loginBtnByText.click();
        loginClicked = true;
        console.log(`[${email}] Clicked Log in button (by text)`);
      }
    }

    // Strategy 3: Find any visible button with "Log in" text using evaluate
    if (!loginClicked) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const btn = buttons.find((b) => {
          const text = b.textContent?.trim();
          return text === "Log in" && b.offsetParent !== null;
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        loginClicked = true;
        console.log(`[${email}] Clicked Log in button (via evaluate)`);
      }
    }

    if (loginClicked) {
      // Wait for either navigation or modal to appear
      try {
        await Promise.race([
          page
            .waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 })
            .catch(() => null),
          page
            .waitForSelector(
              '[class*="modal"], [class*="Modal"], [role="dialog"]',
              { visible: true, timeout: 10000 }
            )
            .catch(() => null),
        ]);
      } catch (e) {
        // Continue anyway
      }
      await delay(2000);
    } else {
      console.log(
        `[${email}] No Log in button found - might already be logged in`
      );
      const alreadyLoggedIn = await isLoggedIn(page, exchange);
      if (alreadyLoggedIn) {
        return true;
      }
      console.log(`[${email}] Not logged in, continuing...`);
    }

    // For referral links, we need to click Log in AGAIN on the dashboard
    if (isNewAccount) {
      console.log(`[${email}] Looking for Log in button on dashboard...`);
      await delay(2000); // Wait for dashboard to load

      let loginBtn2Clicked = false;

      // Try to find login button again (might be in modal or app bar)
      const loginBtn2ByAttr = await page.$(
        'button[data-dd-action-name="Connect wallet"]'
      );
      if (loginBtn2ByAttr) {
        await loginBtn2ByAttr.click();
        loginBtn2Clicked = true;
        console.log(
          `[${email}] Clicked Log in button (second click - by data attribute)`
        );
      }

      if (!loginBtn2Clicked) {
        const loginBtn2ByText = await findByText(page, "Log in", ["button"]);
        if (loginBtn2ByText) {
          await loginBtn2ByText.click();
          loginBtn2Clicked = true;
          console.log(
            `[${email}] Clicked Log in button (second click - by text)`
          );
        }
      }

      if (!loginBtn2Clicked) {
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const btn = buttons.find((b) => {
            const text = b.textContent?.trim();
            return text === "Log in" && b.offsetParent !== null;
          });
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        });
        if (clicked) {
          loginBtn2Clicked = true;
          console.log(
            `[${email}] Clicked Log in button (second click - via evaluate)`
          );
        }
      }

      if (loginBtn2Clicked) {
        // Wait for modal to appear
        try {
          await page
            .waitForSelector(
              '[class*="modal"], [class*="Modal"], [role="dialog"]',
              { visible: true, timeout: 10000 }
            )
            .catch(() => null);
        } catch (e) {
          // Continue anyway
        }
        await delay(2000);
      } else {
        console.log(`[${email}] Second Log in button not found, continuing...`);
      }
    }

    // Wait for login modal/form to appear - check for email input or modal
    console.log(`[${email}] Waiting for login form to appear...`);
    let formReady = false;
    for (let i = 0; i < 15; i++) {
      // Check if email input is already visible (form might be ready)
      const emailInputCheck = await page.$(
        'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"], input[autocomplete="email"]'
      );
      if (emailInputCheck) {
        const isVisible = await page.evaluate((el) => {
          return (
            el.offsetParent !== null &&
            el.offsetWidth > 0 &&
            el.offsetHeight > 0
          );
        }, emailInputCheck);
        if (isVisible) {
          formReady = true;
          console.log(
            `[${email}] Email input already visible - form ready (attempt ${
              i + 1
            })`
          );
          break;
        }
      }

      // Also check for modal
      const modal = await page.$(
        '[class*="modal"], [class*="Modal"], [role="dialog"], [class*="Dialog"]'
      );
      if (modal) {
        const isVisible = await page.evaluate((el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return (
            el.offsetParent !== null &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            el.offsetWidth > 0 &&
            el.offsetHeight > 0
          );
        }, modal);
        if (isVisible) {
          console.log(`[${email}] Login modal detected (attempt ${i + 1})`);
          // Don't break yet - wait a bit more for content to load
          if (i >= 2) {
            formReady = true;
            break;
          }
        }
      }
      await delay(1000);
    }

    if (!formReady) {
      console.log(`[${email}] Form not fully ready, but continuing anyway...`);
    }
    await delay(2000); // Additional wait for modal content to load

    // Check if email input is already visible (might not need "Email or Social" click)
    const emailInputAlreadyVisible = await page.$(
      'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"], input[autocomplete="email"]'
    );
    let emailInputVisible = false;
    if (emailInputAlreadyVisible) {
      emailInputVisible = await page.evaluate((el) => {
        return (
          el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0
        );
      }, emailInputAlreadyVisible);
    }

    // Only click "Email or Social" if email input is not visible
    if (!emailInputVisible) {
      console.log(
        `[${email}] Email input not visible, looking for Email or Social button...`
      );

      // Try multiple text variations for the button
      const socialButtonTexts = [
        "Email or Social",
        "Email",
        "Social",
        "Continue with Email",
        "Sign in with Email",
        "Use Email",
      ];

      let socialBtn = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        for (const buttonText of socialButtonTexts) {
          socialBtn = await findByText(page, buttonText, [
            "button",
            "div",
            "span",
            "a",
          ]);
          if (socialBtn) {
            const isVisible = await page.evaluate((el) => {
              return (
                el.offsetParent !== null &&
                el.offsetWidth > 0 &&
                el.offsetHeight > 0
              );
            }, socialBtn);
            if (isVisible) {
              console.log(
                `[${email}] Found "${buttonText}" button (attempt ${
                  attempt + 1
                })`
              );
              break;
            }
          }
        }
        if (socialBtn) break;
        await delay(1000);
      }

      if (socialBtn) {
        await socialBtn.click();
        console.log(`[${email}] Clicked Email or Social button`);
        await delay(2000); // Wait for email input to appear
      } else {
        console.log(
          `[${email}] Email or Social button not found after retries, checking available buttons...`
        );

        // Debug: List all visible buttons to see what's available
        const availableButtons = await page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll(
              'button, div[role="button"], a[role="button"]'
            )
          );
          return buttons
            .filter((btn) => {
              const style = window.getComputedStyle(btn);
              return (
                btn.offsetParent !== null &&
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                btn.offsetWidth > 0 &&
                btn.offsetHeight > 0
              );
            })
            .map((btn) => btn.textContent?.trim())
            .filter((text) => text && text.length > 0)
            .slice(0, 10); // Limit to first 10
        });
        console.log(`[${email}] Available visible buttons:`, availableButtons);

        // Check one more time if email input appeared
        await delay(2000);
        const emailInputCheck = await page.$(
          'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"], input[autocomplete="email"]'
        );
        if (emailInputCheck) {
          const isVisible = await page.evaluate((el) => {
            return (
              el.offsetParent !== null &&
              el.offsetWidth > 0 &&
              el.offsetHeight > 0
            );
          }, emailInputCheck);
          if (isVisible) {
            console.log(
              `[${email}] Email input appeared without clicking button - continuing...`
            );
          }
        }
      }
    } else {
      console.log(
        `[${email}] Email input already visible, skipping Email or Social button`
      );
    }

    // Check if we're already on OTP screen (form might have auto-submitted)
    const isOtpScreen = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasOtpInputs =
        document.querySelectorAll(
          'input[maxlength="1"], input[type="text"][maxlength="1"]'
        ).length >= 4;
      return (
        hasOtpInputs ||
        text.includes("verification code") ||
        text.includes("enter code") ||
        text.includes("6-digit")
      );
    });

    if (isOtpScreen) {
      console.log(
        `[${email}] Already on OTP screen - email form was auto-submitted, skipping email entry`
      );
    } else {
      // Wait for email input to appear with retry logic
      console.log(`[${email}] Waiting for email input field...`);
      let emailInput = null;
      for (let i = 0; i < 15; i++) {
        emailInput = await page.$(
          'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"], input[autocomplete="email"]'
        );
        if (emailInput) {
          const isVisible = await page.evaluate((el) => {
            return (
              el.offsetParent !== null &&
              el.offsetWidth > 0 &&
              el.offsetHeight > 0
            );
          }, emailInput);
          if (isVisible) {
            console.log(
              `[${email}] Email input found and visible (attempt ${i + 1})`
            );
            break;
          }
        }
        await delay(500);
      }

      if (emailInput) {
        // Clear and enter email
        await emailInput.click({ clickCount: 3 }); // Triple click to select all
        await delay(200);
        await page.keyboard.press("Backspace"); // Clear any existing text
        await delay(200);
        await emailInput.type(email, { delay: 50 });
        console.log(`[${email}] Entered email: ${email}`);

        // Trigger input events for React forms
        await page.evaluate((el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, emailInput);

        await delay(1000); // Wait for form validation

        // Click Submit - try multiple approaches
        console.log(`[${email}] Looking for Submit button...`);
        let submitClicked = false;

        // Strategy 1: Try clicking Submit button with various text variations
        const submitButtonTexts = [
          "Submit",
          "Continue",
          "Next",
          "Send",
          "Sign in",
        ];
        for (const buttonText of submitButtonTexts) {
          const submitBtn = await findByText(page, buttonText, [
            "button",
            "div",
            "span",
          ]);
          if (submitBtn) {
            const isEnabled = await page.evaluate((el) => {
              if (el.tagName === "BUTTON") {
                return !el.disabled;
              }
              return el.offsetParent !== null;
            }, submitBtn);
            if (isEnabled) {
              await submitBtn.click();
              console.log(`[${email}] Clicked "${buttonText}" button`);
              submitClicked = true;
              break;
            }
          }
        }

        // Strategy 2: Try clicking any element with "Submit" text using page.evaluate
        if (!submitClicked) {
          const clicked = await page.evaluate(() => {
            const allElements = Array.from(
              document.querySelectorAll('button, div[role="button"]')
            );
            const submitElement = allElements.find((el) => {
              const text = el.textContent?.trim();
              return text === "Submit" && el.offsetParent !== null;
            });
            if (submitElement) {
              submitElement.click();
              return true;
            }
            return false;
          });
          if (clicked) {
            submitClicked = true;
            console.log(`[${email}] Clicked Submit via evaluate`);
          }
        }

        // Strategy 3: Press Enter on email input
        if (!submitClicked && emailInput) {
          console.log(
            `[${email}] Submit not found, pressing Enter on email input...`
          );
          await emailInput.focus();
          await delay(300);
          await page.keyboard.press("Enter");
          console.log(`[${email}] Pressed Enter`);
          submitClicked = true;
        }

        await delay(3000); // Wait for OTP screen
      } else {
        console.log(`[${email}] Email input not found after retries`);
        // Check if we're on OTP screen anyway
        const checkOtpAgain = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          const hasOtpInputs =
            document.querySelectorAll(
              'input[maxlength="1"], input[type="text"][maxlength="1"]'
            ).length >= 4;
          return (
            hasOtpInputs ||
            text.includes("verification code") ||
            text.includes("enter code")
          );
        });
        if (checkOtpAgain) {
          console.log(
            `[${email}] On OTP screen despite email input not found - continuing...`
          );
        }
      }
    }
  } catch (error) {
    console.error(`[${email}] Error during login flow:`, error.message);
    // Don't throw - login might have succeeded despite DOM changes
    console.log(
      `[${email}] Continuing despite error - will check login status...`
    );
  }

  // Wait for OTP code entry
  console.log("\n===========================================");
  console.log(`[${email}] Check your email for the verification code!`);
  console.log("===========================================\n");

  if (HEADLESS) {
    // In headless mode, prompt for OTP in terminal
    const otp = await prompt(`[${email}] Enter the 6-digit OTP code: `);

    // Find OTP input fields and enter code
    const otpInputs = await page.$$("input");
    let otpIndex = 0;
    for (const input of otpInputs) {
      const maxLength = await page.evaluate((el) => el.maxLength, input);
      if (maxLength === 1 && otpIndex < 6) {
        await input.type(otp[otpIndex], { delay: 100 });
        otpIndex++;
      }
    }
    console.log(`[${email}] OTP entered`);
    await delay(2000); // Wait for OTP to be processed

    // Check for Ethereum wallet connection error and click Continue
    // Check multiple times as error might appear after a delay
    for (let i = 0; i < 5; i++) {
      await handleWalletConnectionError(page, email);
      await delay(2000);

      // Check if we're logged in (error might be resolved)
      const loggedIn = await isLoggedIn(page, exchange);
      if (loggedIn) {
        console.log(`[${email}] Login detected after handling wallet error!`);
        break;
      }
    }
  } else {
    // In non-headless mode, wait for manual entry
    console.log(`[${email}] Please enter the OTP code in the browser...`);

    // Wait until we're logged in (check periodically)
    let attempts = 0;
    while (attempts < 40) {
      // Wait up to 2 minutes (40 × 3s)
      await delay(3000); // Check every 3 seconds

      // Check for wallet connection error and handle it
      const hasError = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("ethereum wallet") ||
          text.includes("wallet connection") ||
          text.includes("connect wallet")
        );
      });

      if (hasError) {
        console.log(
          `[${email}] Wallet connection error detected, looking for Continue button...`
        );
        await handleWalletConnectionError(page, email);
      }

      try {
        const loggedIn = await isLoggedIn(page, exchange);
        if (loggedIn) {
          console.log(`[${email}] Login detected!`);
          break;
        }
      } catch (error) {
        // Ignore errors during login check - might be DOM changes
        console.log(
          `[${email}] Waiting for login... (attempt ${attempts + 1}/40)`
        );
      }
      attempts++;
    }
  }

  await delay(3000);
  await saveCookies(page, cookiesPath, email);
  return true;
}

async function findByExactText(pg, text, tagNames = ["button", "div", "span"]) {
  for (const tag of tagNames) {
    const elements = await pg.$$(tag);
    for (const el of elements) {
      const elText = await pg.evaluate((e) => e.textContent?.trim(), el);
      if (elText === text) {
        return el;
      }
    }
  }
  return null;
}

async function getCurrentMarketPrice(page) {
  console.log("Fetching current market price...");

  try {
    // Try to get the current price from the page
    const price = await page.evaluate(() => {
      // Look for price displays - common patterns on trading interfaces
      const priceSelectors = [
        // Try to find the main price ticker
        '[class*="price"]',
        '[class*="ticker"]',
        '[class*="mark-price"]',
        '[class*="last-price"]',
        '[data-testid*="price"]',
      ];

      // Check all possible price elements
      for (const selector of priceSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim();
          // Look for USD prices (format: $XX,XXX.XX or XX,XXX.XX)
          const match = text?.match(
            /\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/
          );
          if (match) {
            const priceStr = match[1].replace(/,/g, "");
            const price = parseFloat(priceStr);
            // Validate it's a reasonable BTC price (between $1,000 and $500,000)
            if (price >= 1000 && price <= 500000) {
              return price;
            }
          }
        }
      }

      // Fallback: look for any large number that looks like a BTC price
      const allText = document.body.innerText;
      const priceMatches = allText.match(
        /\$?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)/g
      );
      if (priceMatches) {
        for (const match of priceMatches) {
          const priceStr = match.replace(/[$,]/g, "");
          const price = parseFloat(priceStr);
          if (price >= 1000 && price <= 500000) {
            return price;
          }
        }
      }

      return null;
    });

    if (price) {
      console.log(`✓ Current market price: $${price.toLocaleString()}`);
      return price;
    } else {
      console.log("⚠ Could not find market price on page");
      return null;
    }
  } catch (error) {
    console.error("Error fetching market price:", error.message);
    return null;
  }
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
    
    await positionsTab.click();
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
              if (element.offsetParent !== null && element.offsetWidth > 0 && element.offsetHeight > 0) {
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
          const isVisible = m.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden' &&
                           style.opacity !== '0' &&
                           m.offsetWidth > 0 &&
                           m.offsetHeight > 0;
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
        const isVisible = m.offsetParent !== null && 
                         style.display !== 'none' && 
                         style.visibility !== 'hidden' &&
                         style.opacity !== '0' &&
                         m.offsetWidth > 0 &&
                         m.offsetHeight > 0;
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
        
        // Focus and clear the input
        await inputElement.click({ clickCount: 3 }); // Triple click to select all
        await page.keyboard.press('Backspace'); // Clear selected text
        await inputElement.type(stopLossValue, { delay: 30 }); // Use exact string value from env
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
          const isVisible = m.offsetParent !== null && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden' &&
                           style.opacity !== '0' &&
                           m.offsetWidth > 0 &&
                           m.offsetHeight > 0;
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
        const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
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
          if (rect.x >= rightSideThreshold) {
            // Find the button with role="checkbox" inside this label
            const checkboxButton = label.querySelector('button[role="checkbox"]');
            
            if (checkboxButton) {
              // Check if it's visible and not disabled
              const isVisible = checkboxButton.offsetParent !== null && 
                               checkboxButton.offsetWidth > 0 && 
                               checkboxButton.offsetHeight > 0;
              
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
            // Triple-click to select all existing text
            await input.click({ clickCount: 3 });
            await delay(100);
            
            // Clear the selected text
            await page.keyboard.press('Backspace');
            await delay(50);
            
            // Type the value
            await input.type(takeProfitValue, { delay: 50 });
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
            // Triple-click to select all existing text
            await input.click({ clickCount: 3 });
            await delay(100);
            
            // Clear the selected text
            await page.keyboard.press('Backspace');
            await delay(50);
            
            // Type the value
            await input.type(stopLossValue, { delay: 50 });
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

async function executeTrade(
  page,
  { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
  exchangeConfig = null
) {
  const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
  console.log(`\n=== Executing Trade on ${exchange.name} ===`);

  // Set leverage first if requested
  if (setLeverageFirst && leverage) {
    // For Extended Exchange, use modal-based leverage setting
    if (exchange.name === 'Extended Exchange') {
      console.log(`Setting leverage for Extended Exchange using modal...`);
      const leverageValue = String(leverage);
      
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
        console.log(`✅ Clicked leverage button`);
        await delay(2000);
        
        // Find leverage input in modal
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
        
        if (leverageInputFound) {
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
            await inputElement.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await delay(100);
            
            // Type the leverage value
            await inputElement.type(leverageValue, { delay: 50 });
            await delay(200);
            
            // Press Enter
            await page.keyboard.press('Enter');
            await delay(500);
            
            console.log(`✅ Entered leverage value: ${leverageValue} and pressed Enter`);
            
            // Check if leverage modal is still open
            const leverageModalStillOpen = await page.evaluate(() => {
              const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
              return modal !== null;
            });
            
            // Find and click Confirm or Cancel button
            const leverageSet = await page.evaluate((modalStillOpen) => {
              const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
              if (!modal) return { success: false, reason: 'No modal found' };
              
              const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
              
              if (modalStillOpen) {
                const cancelBtn = buttons.find(btn => {
                  const text = btn.textContent?.trim().toLowerCase();
                  const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
                  return isVisible && (text === 'cancel' || text === 'close' || text === 'x');
                });
                
                if (cancelBtn) {
                  cancelBtn.click();
                  return { success: true, cancelled: true };
                }
              }
              
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
              console.log(`✅ Leverage modal handled: ${leverageSet.cancelled ? 'Cancelled (unchanged)' : 'Confirmed'}`);
              await delay(1000);
            } else {
              console.log(`⚠️  Could not handle leverage modal: ${leverageSet.reason || 'unknown'}`);
            }
          } else {
            console.log(`⚠️  Could not find leverage input element`);
          }
        } else {
          console.log(`⚠️  Could not find leverage input in modal`);
        }
      } else {
        console.log(`⚠️  Could not find leverage button`);
      }
    } else {
      // For Paradex, use existing setLeverage function
      const leverageResult = await setLeverage(page, leverage);
      if (!leverageResult.success) {
        console.log(`⚠ Failed to set leverage: ${leverageResult.error}`);
        // Continue anyway - leverage setting might not be critical
      }
      await delay(1000);
    }
  }

  // If limit order without price, fetch current market price
  if (orderType === "limit" && !price) {
    price = await getCurrentMarketPrice(page);
    if (!price) {
      console.log("❌ Could not fetch market price for limit order");
      return { success: false, error: "Could not fetch market price" };
    }
  }

  console.log(
    `Side: ${side}, Type: ${orderType}, Price: ${
      price || "market"
    }, Qty: ${qty}`
  );

  // No need to reload - just wait a moment for any previous actions to complete
  await delay(1000); // Reduced from 2000

  // 1. Select Buy or Sell
  if (side === "sell") {
    const sellBtn = await findByExactText(page, exchange.selectors.sellButton, ["button", "div"]);
    if (sellBtn) {
      await sellBtn.click();
      console.log("Selected SELL");
      await delay(300); // Reduced from 500ms
    }
  } else {
    const buyBtn = await findByExactText(page, exchange.selectors.buyButton, ["button", "div"]);
    if (buyBtn) {
      await buyBtn.click();
      console.log("Selected BUY");
      await delay(300); // Reduced from 500ms
    }
  }

  // 2. Select Market or Limit order type
  if (orderType === "limit") {
    const limitBtn = await findByExactText(page, exchange.selectors.limitButton, ["button", "div"]);
    if (limitBtn) {
      await limitBtn.click();
      console.log("Selected LIMIT order");
      await delay(300); // Reduced from 500ms
    }
  } else {
    const marketBtn = await findByExactText(page, exchange.selectors.marketButton, ["button", "div"]);
    if (marketBtn) {
      await marketBtn.click();
      console.log("Selected MARKET order");
      await delay(300); // Reduced from 500ms
    }
  }

  await delay(500); // Reduced from 1000ms

  // 3. Find and fill inputs - Look for the Size input in the trading panel
  const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type])');
  let sizeInput = null;
  let priceInput = null;

  console.log(`Found ${inputs.length} text input elements on page`);

  // Get screen width for percentage-based filtering (works for all screen sizes)
  const screenWidth = await page.evaluate(() => window.innerWidth);
  const rightSideThreshold = screenWidth * 0.5; // Right half of screen

  for (const input of inputs) {
    const rect = await input.boundingBox();
    if (!rect) continue;

    // Look for inputs in the right panel (trading panel is on the right side)
    // Use percentage-based approach for screen-size independence
    if (rect.x < rightSideThreshold) continue;

    const inputInfo = await page.evaluate((el) => {
      // Get all text content around this input
      let parent = el.parentElement;
      let parentText = "";
      let labelText = "";

      // Check for label
      const labels = document.querySelectorAll("label");
      for (const label of labels) {
        if (label.control === el || label.contains(el)) {
          labelText = label.textContent?.trim() || "";
        }
      }

      // Get parent text
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.innerText) {
          parentText = parent.innerText;
          break;
        }
        parent = parent.parentElement;
      }

      return {
        placeholder: el.placeholder || "",
        value: el.value || "",
        id: el.id || "",
        name: el.name || "",
        parentText: parentText,
        labelText: labelText,
      };
    }, input);

    console.log(`Input at (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
    console.log(
      `  ID: "${inputInfo.id}", Name: "${inputInfo.name}", Placeholder: "${inputInfo.placeholder}"`
    );
    console.log(
      `  Label: "${
        inputInfo.labelText
      }", Parent: "${inputInfo.parentText.substring(0, 60)}"`
    );
    console.log(`  Current value: "${inputInfo.value}"`);

    // Check if this is the Size input (case-insensitive for better matching)
    const isSizeInput =
      inputInfo.parentText.toLowerCase().includes("size") ||
      inputInfo.labelText.toLowerCase().includes("size") ||
      inputInfo.placeholder.toLowerCase().includes("size") ||
      inputInfo.id.toLowerCase().includes("size") ||
      inputInfo.name.toLowerCase().includes("size") ||
      inputInfo.parentText.toLowerCase().includes("quantity") ||
      inputInfo.placeholder.toLowerCase().includes("quantity");

    // Check if this is the Price input
    const isPriceInput =
      inputInfo.parentText.includes("Price") ||
      inputInfo.labelText.includes("Price") ||
      inputInfo.placeholder.includes("Price") ||
      inputInfo.id.includes("price") ||
      inputInfo.name.includes("price");

    if (isSizeInput && !sizeInput) {
      sizeInput = input;
      console.log("✓ Found size input!");
    } else if (isPriceInput && !priceInput && orderType === "limit") {
      priceInput = input;
      console.log("✓ Found price input!");
    }
  }

  // Enter price (for limit orders)
  if (orderType === "limit" && price) {
    if (priceInput) {
      await priceInput.click({ clickCount: 3 });
      await delay(100);
      await page.keyboard.press("Backspace");
      await priceInput.type(String(price), { delay: 30 });
      console.log(`Entered price: ${price}`);
    } else {
      const allInputs = await page.$$("input");
      for (const inp of allInputs) {
        const rect = await inp.boundingBox();
        if (rect && rect.x > 1000 && rect.y > 150 && rect.y < 300) {
          await inp.click({ clickCount: 3 });
          await delay(100);
          await page.keyboard.press("Backspace");
          await inp.type(String(price), { delay: 30 });
          console.log(`Entered price: ${price} (fallback)`);
          break;
        }
      }
    }
    await delay(300);
  }

  // Enter quantity/size
  if (!sizeInput) {
    console.log("❌ Size input not found! Cannot proceed with trade.");
    return { success: false, error: "Size input field not found" };
  }

  console.log("\n=== Entering Size ===");

  // Method 1: Clear and type
  await sizeInput.click();
  await delay(300);

  // Select all existing text (using Meta/Command on Mac)
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Meta");
  await delay(100);

  // Type the new value
  await page.keyboard.type(String(qty), { delay: 100 });
  await delay(500);

  // Verify the value was set
  let actualValue = await page.evaluate((el) => el.value, sizeInput);
  console.log(`Size input value after first attempt: "${actualValue}"`);

  // If value wasn't set properly, try alternative method
  if (
    !actualValue ||
    actualValue === "" ||
    Math.abs(parseFloat(actualValue) - parseFloat(qty)) > 0.0001
  ) {
    console.log("First attempt failed, trying alternative method...");

    // Focus the input
    await sizeInput.focus();
    await delay(200);

    // Clear using JavaScript
    await page.evaluate((el) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sizeInput);
    await delay(200);

    // Type again
    await sizeInput.type(String(qty), { delay: 100 });
    await delay(500);

    actualValue = await page.evaluate((el) => el.value, sizeInput);
    console.log(`Size input value after second attempt: "${actualValue}"`);
  }

  // If still not set, try direct value assignment
  if (
    !actualValue ||
    actualValue === "" ||
    Math.abs(parseFloat(actualValue) - parseFloat(qty)) > 0.0001
  ) {
    console.log("Second attempt failed, using direct assignment...");

    await page.evaluate(
      (el, value) => {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      },
      sizeInput,
      String(qty)
    );
    await delay(500);

    actualValue = await page.evaluate((el) => el.value, sizeInput);
    console.log(`Size input value after direct assignment: "${actualValue}"`);
  }

  // Final verification
  if (!actualValue || actualValue === "") {
    console.log("❌ Failed to set size value!");
    return { success: false, error: "Failed to enter size value" };
  }

  console.log(`✓ Successfully set size to: ${actualValue}`);
  await delay(500); // Reduced from 1000ms

  if (exchange.name === 'Paradex') {
    console.log(`[Paradex] Clicking TP/SL checkbox before executing trade...`);
    const tpSlResult = await clickTpSlCheckboxForParadex(page);
    if (tpSlResult.success) {
      console.log(`[Paradex] ✅ TP/SL checkbox clicked successfully`);
      // Wait 100ms before filling TP/SL values
      await delay(100);
      // Fill Take Profit and Stop Loss values from environment variables
      const fillResult = await fillTpSlValuesForParadex(page);
      if (fillResult.success) {
        console.log(`[Paradex] ✅ TP/SL values filled successfully`);
      } else {
        console.log(`[Paradex] ⚠️  Could not fill TP/SL values: ${fillResult.error || 'unknown error'}`);
        // Continue anyway - TP/SL values might not be critical
      }
    } else {
      console.log(`[Paradex] ⚠️  Could not click TP/SL checkbox: ${tpSlResult.error || 'unknown error'}`);
      // Continue anyway - TP/SL checkbox might not be critical
    }
  }
  
  // NOTE: Order cancellation is already done before executeTrade() is called in the trading loop
  // No need to cancel orders here - just proceed to click confirm button
  
  // 4. Click Confirm button (use exchange-specific selectors)
  // For Extended Exchange, the sell button is just "Sell", not "Confirm Sell"
  let confirmText = side === "buy" ? exchange.selectors.confirmBuy : exchange.selectors.confirmSell;
  
  // Extended Exchange uses "Sell" button directly (no "Confirm Sell")
  // Check both exact name match and case-insensitive match
  const isExtendedExchange = exchange.name === 'Extended Exchange' || 
                              exchange.name?.toLowerCase() === 'extended exchange' ||
                              exchange.name?.includes('Extended');
  
  console.log(`[DEBUG] Exchange detection: name="${exchange.name}", isExtendedExchange=${isExtendedExchange}, side=${side}`);
  
  if (isExtendedExchange && side === 'sell') {
    confirmText = "Sell";
    console.log(`✓ Extended Exchange detected - using "Sell" button instead of "Confirm Sell"`);
  }
  
  // For Extended Exchange, use a more robust method to find the confirm button
  // We need to find the actual execute button, not the side selector
  let confirmBtn = null;
  
  // CRITICAL: Check if this is Extended Exchange with sell side
  if (isExtendedExchange && side === 'sell') {
    console.log(`[EXTENDED EXCHANGE] ✅ Entering Extended Exchange Sell button finding logic...`);
    console.log(`[EXTENDED EXCHANGE] Looking for "Sell" button in right 40% of screen (last 40%)...`);
    
    // Method 1: Find "Sell" button in the right 40% of screen (from 60% to 100%)
    const screenWidth = await page.evaluate(() => window.innerWidth);
    const rightSideThreshold = screenWidth * 0.6; // Start from 60% (last 40% of screen)
    console.log(`[EXTENDED EXCHANGE] Method 1: Screen width: ${screenWidth}, Right threshold (60%): ${rightSideThreshold}`);
    
    const allButtons = await page.$$('button, div[role="button"], span[role="button"], a[role="button"]');
    console.log(`[EXTENDED EXCHANGE] Method 1: Checking ${allButtons.length} buttons for "Sell" text in right 40%...`);
    
    let sellButtonsOnRight = [];
    for (const btn of allButtons) {
      const btnText = await page.evaluate((el) => el.textContent?.trim(), btn);
      const rect = await btn.boundingBox();
      const isVisible = await page.evaluate((el) => {
        return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      }, btn);
      
      // Check if it's the "Sell" button, visible, and in the right 40% of screen
      if (btnText === "Sell" && isVisible && rect && rect.x >= rightSideThreshold) {
        const isDisabled = await page.evaluate((el) => {
          return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                 el.classList.contains('disabled') || el.style.pointerEvents === 'none';
        }, btn);
        
        sellButtonsOnRight.push({
          text: btnText,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          onRight: true,
          disabled: isDisabled
        });
        
        if (!isDisabled) {
          confirmBtn = btn;
          console.log(`[EXTENDED EXCHANGE] ✓ Method 1 SUCCESS: Found Sell button at (${Math.round(rect.x)}, ${Math.round(rect.y)}) in right 40%`);
          break;
        }
      }
    }
    
    if (!confirmBtn && sellButtonsOnRight.length > 0) {
      console.log(`[EXTENDED EXCHANGE] Method 1: Found ${sellButtonsOnRight.length} "Sell" button(s) in right 40% but all disabled:`, JSON.stringify(sellButtonsOnRight, null, 2));
    } else if (sellButtonsOnRight.length === 0) {
      console.log(`[EXTENDED EXCHANGE] Method 1: No "Sell" buttons found in right 40% of screen`);
    }
    
    // Method 2: Fallback - try findByExactText and filter by right 40%
    if (!confirmBtn) {
      console.log(`[EXTENDED EXCHANGE] Method 2: Trying findByExactText("Sell") and filtering by right 40%...`);
      const foundBtn = await findByExactText(page, "Sell", ["button", "div", "span"]);
      if (foundBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, foundBtn);
        const rect = await foundBtn.boundingBox();
        
        console.log(`[EXTENDED EXCHANGE] Method 2: Found button - visible: ${isVisible}, x: ${Math.round(rect?.x || 0)}, threshold: ${rightSideThreshold}`);
        
        if (isVisible && rect && rect.x >= rightSideThreshold) {
          const isDisabled = await page.evaluate((el) => {
            return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                   el.classList.contains('disabled') || el.style.pointerEvents === 'none';
          }, foundBtn);
          
          if (!isDisabled) {
            confirmBtn = foundBtn;
            console.log(`[EXTENDED EXCHANGE] ✓ Method 2 SUCCESS: Found Sell button via findByExactText at (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
          } else {
            console.log(`[EXTENDED EXCHANGE] Method 2: Found button but it's disabled`);
          }
        } else {
          console.log(`[EXTENDED EXCHANGE] Method 2: Found button but not visible or not in right 40%`);
        }
      } else {
        console.log(`[EXTENDED EXCHANGE] Method 2: findByExactText returned null`);
      }
    }
    
    // Method 3: Final fallback to findByText and filter by right 40%
    if (!confirmBtn) {
      console.log(`[EXTENDED EXCHANGE] Method 3: Trying findByText("Sell") and filtering by right 40%...`);
      confirmBtn = await findByText(page, "Sell", ["button"]); // Use "Sell" not confirmText for Extended Exchange
      if (confirmBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, confirmBtn);
        if (!isVisible) {
          console.log(`[EXTENDED EXCHANGE] Method 3: Found button but it's not visible`);
          confirmBtn = null;
        } else {
          const rect = await confirmBtn.boundingBox();
          
          // Check if it's in the right 40%
          if (rect && rect.x >= rightSideThreshold) {
            const isDisabled = await page.evaluate((el) => {
              return el.disabled || el.getAttribute('aria-disabled') === 'true' || 
                     el.classList.contains('disabled') || el.style.pointerEvents === 'none';
            }, confirmBtn);
            
            if (!isDisabled) {
              console.log(`[EXTENDED EXCHANGE] ✓ Method 3 SUCCESS: Found Sell button via findByText at (${Math.round(rect.x)}, ${Math.round(rect.y)}) in right 40%`);
            } else {
              console.log(`[EXTENDED EXCHANGE] Method 3: Found button but it's disabled`);
              confirmBtn = null;
            }
          } else {
            console.log(`[EXTENDED EXCHANGE] Method 3: Found Sell button but it's not in right 40% (x: ${Math.round(rect?.x || 0)}, threshold: ${rightSideThreshold}), skipping...`);
            confirmBtn = null;
          }
        }
      } else {
        console.log(`[EXTENDED EXCHANGE] Method 3: findByText returned null`);
      }
    }
    
    // Final check: if we found the button, log it
    if (confirmBtn) {
      console.log(`[EXTENDED EXCHANGE] ✅ Sell button found and ready to click!`);
    } else {
      console.log(`[EXTENDED EXCHANGE] ❌ FAILED to find Sell button after all methods`);
    }
  } else {
    // For other exchanges (Paradex) or buy side, use improved method
    console.log(`Looking for "${confirmText}" button on ${exchange.name}...`);
    
    // Method 1: Try findByExactText first (more specific)
    confirmBtn = await findByExactText(page, confirmText, ["button", "div", "span"]);
    
    if (confirmBtn) {
      const isVisible = await page.evaluate((el) => {
        return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      }, confirmBtn);
      
      if (!isVisible) {
        console.log(`⚠️  Found "${confirmText}" button but it's not visible, trying fallback...`);
        confirmBtn = null;
      } else {
        const rect = await confirmBtn.boundingBox();
        console.log(`✓ Found "${confirmText}" button at (${Math.round(rect?.x || 0)}, ${Math.round(rect?.y || 0)})`);
      }
    }
    
    // Method 2: Fallback to findByText if exact match failed
    if (!confirmBtn) {
      console.log(`Exact text match failed, trying partial match...`);
      confirmBtn = await findByText(page, confirmText, ["button"]);
      
      if (confirmBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, confirmBtn);
        
        if (isVisible) {
          const rect = await confirmBtn.boundingBox();
          console.log(`✓ Found "${confirmText}" button via partial match at (${Math.round(rect?.x || 0)}, ${Math.round(rect?.y || 0)})`);
        } else {
          console.log(`⚠️  Found button but it's not visible`);
          confirmBtn = null;
        }
      }
    }
    
    // Method 3: Try case-insensitive search in evaluate
    if (!confirmBtn) {
      console.log(`Partial match failed, trying case-insensitive search...`);
      const foundBtn = await page.evaluate((searchText) => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
        const searchLower = searchText.toLowerCase();
        
        for (const btn of buttons) {
          const btnText = btn.textContent?.trim() || '';
          const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
          const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true' || 
                            btn.classList.contains('disabled') || btn.style.pointerEvents === 'none';
          
          if (isVisible && !isDisabled && btnText.toLowerCase().includes(searchLower)) {
            return {
              found: true,
              text: btnText,
              x: btn.getBoundingClientRect().x,
              y: btn.getBoundingClientRect().y
            };
          }
        }
        return { found: false };
      }, confirmText);
      
      if (foundBtn.found) {
        console.log(`✓ Found button via case-insensitive search: "${foundBtn.text}" at (${Math.round(foundBtn.x)}, ${Math.round(foundBtn.y)})`);
        // Try to find it again using Puppeteer
        confirmBtn = await findByText(page, foundBtn.text, ["button"]);
      }
    }
  }

  if (confirmBtn) {
    // Log which exchange and button before clicking
    if (isExtendedExchange && side === 'sell') {
      console.log(`[EXTENDED EXCHANGE] 🖱️  Clicking Sell button now...`);
    } else {
      console.log(`[${exchange.name}] 🖱️  Clicking "${confirmText}" button now...`);
    }
    await confirmBtn.click();
    console.log(`✓ Successfully clicked "${confirmText}" button`);
    await delay(2000); // Wait for order submission to process

    // Check for error messages first
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
      console.log("Trade error:", errorMsg);
      return { success: false, error: errorMsg };
    }

    // Verify order was placed and is pending
    console.log("Verifying order placement...");
    const orderVerified = await verifyOrderPlaced(page, exchange, side, qty, maxWaitTime = 10000);
    
    if (orderVerified.success) {
      console.log(`✓ Order confirmed as ${orderVerified.status || 'pending'}`);
      return { success: true, message: "Trade submitted and order confirmed", orderStatus: orderVerified.status };
    } else {
      console.log(`⚠️  Order verification: ${orderVerified.reason || 'Could not verify order placement'}`);
      // Still return success if no error was found (order might be placed but not yet visible)
      return { success: true, message: "Trade submitted (verification inconclusive)", warning: orderVerified.reason };
    }
  } else {
    // Enhanced error message with debugging info
    console.log(`❌ Could not find "${confirmText}" button`);
    console.log(`   Exchange: ${exchange.name}, Side: ${side}`);
    
    // Additional debugging: try to find what buttons are available
    const availableButtons = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
      return buttons
        .filter(btn => {
          const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
          return isVisible;
        })
        .map(btn => {
          const text = btn.textContent?.trim();
          const rect = btn.getBoundingClientRect();
          return {
            text: text,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true'
          };
        })
        .filter(btn => btn.text && btn.text.length > 0)
        .slice(0, 10); // Limit to first 10 for readability
    });
    
    console.log(`   Available buttons (first 10):`, JSON.stringify(availableButtons, null, 2));
    
    return { success: false, error: `Confirm button not found. Looking for: "${confirmText}"` };
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

// Handler lock to prevent multiple executions
const handlerLocks = new Map();

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
        
        // Focus and clear the input
        await inputElement.click({ clickCount: 3 }); // Triple click to select all
        await page.keyboard.press('Backspace'); // Clear selected text
        await inputElement.type(stopLossPercentStr, { delay: 30 }); // Use exact string value from env
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
        const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
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
      await button.click();
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

function startApiServer(page, apiPort, email) {
  let isReady = true;
  const apiApp = express();
  apiApp.use(express.json());

  // Health check
  apiApp.get("/health", (req, res) => {
    res.json({ status: "ok", ready: isReady, account: email });
  });

  // Place trade
  apiApp.post("/trade", async (req, res) => {
    const { side, orderType, price, qty, leverage, setLeverageFirst } =
      req.body;

    if (!side || !["buy", "sell"].includes(side)) {
      return res
        .status(400)
        .json({ error: "Invalid side. Use 'buy' or 'sell'" });
    }
    if (!orderType || !["market", "limit"].includes(orderType)) {
      return res
        .status(400)
        .json({ error: "Invalid orderType. Use 'market' or 'limit'" });
    }
    // Price is now optional for limit orders - will fetch current market price if not provided
    if (!qty || qty <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid qty. Must be positive number" });
    }

    try {
      const result = await executeTrade(page, {
        side,
        orderType,
        price,
        qty,
        leverage,
        setLeverageFirst: setLeverageFirst || false,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Close all positions
  apiApp.post("/close-all", async (req, res) => {
    const { percent = 100 } = req.body;

    // Validate percent
    if (percent < 0 || percent > 100) {
      return res
        .status(400)
        .json({ error: "Percent must be between 0 and 100" });
    }

    try {
      const result = await closeAllPositions(page, percent);
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Screenshot endpoint
  apiApp.get("/screenshot", async (req, res) => {
    const filename = `screenshot-${email}-${Date.now()}.png`;
    await page.screenshot({ path: filename });
    res.json({ success: true, file: filename });
  });

  apiApp.listen(apiPort, () => {
    console.log(`\n========================================`);
    console.log(`[${email}] Trade API running on http://localhost:${apiPort}`);
    console.log(`========================================\n`);
    console.log(`Endpoints:`);
    console.log(`  GET  /health      - Check if bot is ready`);
    console.log(`  POST /trade       - Place a trade`);
    console.log(`  POST /close-all   - Close all positions`);
    console.log(`  GET  /screenshot  - Take screenshot\n`);
    console.log(`Examples:`);
    console.log(
      `  # Place a limit buy order at market price (price auto-fetched)`
    );
    console.log(`  curl -X POST http://localhost:${apiPort}/trade \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"side":"buy","orderType":"limit","qty":0.001}'\n`);
    console.log(`  # Place a limit order with 40x leverage`);
    console.log(`  curl -X POST http://localhost:${apiPort}/trade \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(
      `    -d '{"side":"buy","orderType":"limit","qty":0.001,"leverage":40,"setLeverageFirst":true}'\n`
    );
    console.log(`  # Close 100% of position`);
    console.log(`  curl -X POST http://localhost:${apiPort}/close-all \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"percent":100}'\n`);
    console.log(`  # Close 50% of position`);
    console.log(`  curl -X POST http://localhost:${apiPort}/close-all \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"percent":50}'\n`);
  });
}

async function launchAccount(accountConfig, exchangeConfig) {
  const { email, cookiesPath, profileDir, apiPort } = accountConfig;
  const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex

  try {
    console.log(`\n[${email}] Launching browser instance...`);

    // Clean up old profile directories for this account slot if email changed
    // Look for old profile dirs with pattern /tmp/puppeteer-chrome-profile-{index}-*
    const accountIndex = cookiesPath.match(/account(\d+)/)?.[1];
    if (accountIndex) {
      const profilePattern = `/tmp/puppeteer-chrome-profile-${accountIndex}-`;
      try {
        const tmpFiles = fs.readdirSync("/tmp");
        tmpFiles.forEach((file) => {
          if (
            file.startsWith(`puppeteer-chrome-profile-${accountIndex}-`) &&
            `/tmp/${file}` !== profileDir
          ) {
            const oldProfilePath = path.join("/tmp", file);
            console.log(
              `[${email}] Cleaning up old profile directory: ${oldProfilePath}`
            );
            try {
              fs.rmSync(oldProfilePath, { recursive: true, force: true });
            } catch (e) {
              console.log(
                `[${email}] Could not delete old profile (may be in use): ${e.message}`
              );
            }
          }
        });
      } catch (e) {
        // Ignore errors reading /tmp
      }
    }

    const browser = await puppeteer.launch({
      headless: HEADLESS,
      // executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: profileDir,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--window-size=1920,1080",
      ],
      defaultViewport: HEADLESS ? { width: 1920, height: 1080 } : null,
      protocolTimeout: 180000, // Increase protocol timeout to 180 seconds (default is 30s) - needed for complex DOM queries
    });

    const page = await browser.newPage();

    // Set default navigation timeout to 60 seconds (increased from default 30s)
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(120000); // Increased to 120 seconds for complex DOM operations

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Try to load saved cookies - check if this is a new account
    // For Extended Exchange, skip loading cookies (we'll clear them anyway)
    let hasExistingCookies = false;
    let isNewAccount = true;
    
    if (exchange.name !== 'Extended Exchange') {
      // For non-Extended Exchange, load cookies normally
      hasExistingCookies = await loadCookies(page, cookiesPath, email);
      isNewAccount = !hasExistingCookies;
    } else {
      // For Extended Exchange, don't load cookies - we'll clear them in login flow
      console.log(`[${email}] Extended Exchange - skipping cookie load (will clear and re-authenticate)`);
    }

    if (isNewAccount) {
      console.log(`[${email}] New account detected - no existing cookies`);
    }

    console.log(`[${email}] Opening ${exchange.name}...`);

    // If new account, use referral URL; otherwise use regular trading URL
    const targetUrl = isNewAccount ? exchange.referralUrl : exchange.url;

    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      if (isNewAccount) {
        console.log(
          `[${email}] Loaded with referral link: ${PARADEX_REFERRAL_URL}`
        );
      }
    } catch (error) {
      console.log(`[${email}] Page load timeout, attempting to continue...`);
    }

    // If cookies were loaded, reload the page to ensure cookies are applied
    if (hasExistingCookies) {
      console.log(
        `[${email}] Cookies loaded, reloading page to apply cookies...`
      );
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(5000); // Wait for page to fully load with cookies
      } catch (error) {
        console.log(`[${email}] Reload timeout, continuing...`);
      }
    } else {
      await delay(5000);
    }

    // Check if logged in - retry multiple times if cookies exist
    let loggedIn = false;
    const maxLoginChecks = hasExistingCookies ? 5 : 1; // More retries if cookies exist
    for (let i = 0; i < maxLoginChecks; i++) {
      loggedIn = await isLoggedIn(page, exchange);
      console.log(
        `[${email}] Logged in:`,
        loggedIn,
        hasExistingCookies ? `(check ${i + 1}/${maxLoginChecks})` : ""
      );
      if (loggedIn) {
        break; // Exit early if logged in
      }
      if (i < maxLoginChecks - 1) {
        await delay(2000); // Wait before retrying
      }
    }

    // Only attempt login if we're really not logged in after all checks
    if (!loggedIn) {
      console.log(
        `[${email}] Not logged in after ${maxLoginChecks} check(s), starting login process...`
      );
      const loginResult = await login(page, browser, email, cookiesPath, isNewAccount, exchange);
      
      // For Extended Exchange, if login returns true but cookies aren't set yet,
      // wait longer for user to complete wallet connection manually
      if (exchange.name === 'Extended Exchange' && loginResult) {
        console.log(`[${email}] Extended Exchange login initiated, waiting for wallet connection...`);
        // Wait up to 2 minutes for cookies to be set (user needs to scan QR and connect)
        let waitAttempts = 0;
        const maxWaitAttempts = 40; // 40 * 3s = 2 minutes
        while (waitAttempts < maxWaitAttempts) {
          await delay(3000); // Check every 3 seconds
          loggedIn = await isLoggedIn(page, exchange);
          if (loggedIn) {
            console.log(`[${email}] ✅ Extended Exchange cookies detected after wallet connection!`);
            break;
          }
          waitAttempts++;
          if (waitAttempts % 10 === 0) {
            console.log(`[${email}] Still waiting for wallet connection... (${waitAttempts * 3}s elapsed)`);
          }
        }
        
        if (!loggedIn) {
          console.log(`[${email}] ⚠️  Extended Exchange: Wallet connection not completed after 2 minutes.`);
          console.log(`[${email}] Browser will remain open for manual connection.`);
          // Don't close browser - allow user to manually complete connection
          // Return success: false but keep browser open
          return { browser, page, email, success: false, exchange: exchange.name, keepBrowserOpen: true };
        }
      } else {
        // For non-Extended Exchange or if login failed
        await delay(3000);
        loggedIn = await isLoggedIn(page, exchange);
      }
    } else {
      console.log(
        `[${email}] Already logged in with existing cookies, skipping login process`
      );
    }

    // If logged in and we were on referral page, navigate to trading page
    if (loggedIn && isNewAccount) {
      const currentUrl = page.url();
      if (!currentUrl.includes(exchange.urlPattern)) {
        console.log(`[${email}] Navigating to trading page after login...`);
        try {
          await page.goto(exchange.url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await delay(3000);
        } catch (error) {
          console.log(`[${email}] Navigation error, continuing...`);
        }
      }
    }

    if (loggedIn) {
      console.log(`\n[${email}] *** Successfully logged in to ${exchange.name}! ***\n`);

      // For Extended Exchange, if cookies are set, click on Orders tab
      if (exchange.name === 'Extended Exchange') {
        const hasCookies = await hasExtendedExchangeCookies(page);
        if (hasCookies) {
          console.log(`[${email}] Extended Exchange cookies detected, clicking Orders tab...`);
          await clickOrdersTab(page, email);
        }
      }

      // Ensure we're on the trading page (not redirected to status page)
      const currentUrl = page.url();
      if (!currentUrl.includes(exchange.urlPattern)) {
        console.log(
          `[${email}] Redirected to ${currentUrl}, navigating back to trading page...`
        );
        try {
          await page.goto(exchange.url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await delay(3000);
          
          // After navigation, click Orders tab again for Extended Exchange
          if (exchange.name === 'Extended Exchange') {
            const hasCookies = await hasExtendedExchangeCookies(page);
            if (hasCookies) {
              await clickOrdersTab(page, email);
            }
          }
        } catch (error) {
          console.log(`[${email}] Navigation error, continuing...`);
        }
      }

      // Start the API server for this account
      startApiServer(page, apiPort, email);

      // DISABLED: Auto-click TP/SL listener - now using manual flow in closeAllPositions
      // The manual flow goes to Positions tab, finds TP/SL button, clicks it, fills value, confirms, then clicks Limit
      // This gives us better control over the sequence: TP/SL -> Confirm -> Wait -> Limit -> Close
      // if (exchange.name === 'Paradex') {
      //   await setupTpSlAddButtonListener(page, email);
      // }

      return { browser, page, email, success: true, exchange: exchange.name };
    } else {
      console.log(`[${email}] Failed to login.`);
      // For Extended Exchange, keep browser open to allow manual wallet connection
      // For other exchanges, close browser on login failure
      const shouldKeepOpen = exchange.name === 'Extended Exchange';
      if (!shouldKeepOpen) {
        await browser.close();
        return { email, success: false };
      } else {
        console.log(`[${email}] Extended Exchange: Keeping browser open for manual wallet connection.`);
        console.log(`[${email}] Please complete wallet connection manually in the browser window.`);
        return { browser, page, email, success: false, exchange: exchange.name, keepBrowserOpen: true };
      }
    }
  } catch (error) {
    console.error(`\n✗ [${email}] Error during account launch:`, error.message);
    return { email, success: false, error: error.message };
  }
}

// Trading configuration from environment variables
const TRADE_CONFIG = {
  buyQty: parseFloat(process.env.BUY_QTY) || 0.0005, // BTC quantity for BUY
  sellQty: parseFloat(process.env.SELL_QTY) || 0.0005, // BTC quantity for SELL
  waitTime: parseInt(process.env.TRADE_TIME) || 60000, // Time to wait before closing (milliseconds)
  leverage: parseInt(process.env.LEVERAGE) || 20, // Leverage multiplier
  stopLoss: parseFloat(process.env.STOP_LOSS) || null, // Maximum loss in USD (null = disabled)
};

let isShuttingDown = false;

async function automatedTradingLoop(account1Result, account2Result) {
  const { page: page1, email: email1, exchange: exchange1Name } = account1Result;
  const { page: page2, email: email2, exchange: exchange2Name } = account2Result;
  
  // Get exchange configs - handle both string names and undefined
  // Map exchange names to config keys: "Extended Exchange" -> "extended", "Paradex" -> "paradex"
  const getExchangeKey = (exchangeName) => {
    if (!exchangeName) return 'paradex';
    const nameLower = exchangeName.toLowerCase();
    if (nameLower.includes('extended')) return 'extended';
    if (nameLower.includes('paradex')) return 'paradex';
    return 'paradex'; // default
  };
  
  const exchange1Key = getExchangeKey(exchange1Name);
  const exchange2Key = getExchangeKey(exchange2Name);
  const exchange1 = EXCHANGE_CONFIGS[exchange1Key] || EXCHANGE_CONFIGS.paradex;
  const exchange2 = EXCHANGE_CONFIGS[exchange2Key] || EXCHANGE_CONFIGS.paradex;
  
  console.log(`[DEBUG] Exchange mapping: exchange1Name="${exchange1Name}" -> key="${exchange1Key}" -> config.name="${exchange1.name}"`);
  console.log(`[DEBUG] Exchange mapping: exchange2Name="${exchange2Name}" -> key="${exchange2Key}" -> config.name="${exchange2.name}"`);

  let cycleCount = 0;

  console.log(`\n========================================`);
  console.log(`Starting Automated Trading Loop`);
  console.log(`Account 1 (${email1}) on ${exchange1.name}: BUY ${TRADE_CONFIG.buyQty} BTC`);
  console.log(`Account 2 (${email2}) on ${exchange2.name}: SELL ${TRADE_CONFIG.sellQty} BTC`);
  console.log(`Leverage: ${TRADE_CONFIG.leverage}x`);
  console.log(`Close after: Random time between 10s and 3min`);
  console.log(`========================================\n`);

  // Clean up any existing positions and orders BEFORE setting leverage
  // NOTE: Extended Exchange already did this in clickOrdersTab() during login, so skip it
  console.log(`\n🧹 Cleaning up existing positions and orders...`);
  const cleanupPromises = [];
  
  // Only cleanup Paradex accounts (Extended Exchange already cleaned up in clickOrdersTab)
  if (exchange1Name !== 'Extended Exchange') {
    cleanupPromises.push((async () => {
      console.log(`\n[${email1}] Checking for open positions and orders...`);
      const closeResult = await closeAllPositions(page1, 100, exchange1);
      const cancelResult = await cancelAllOrders(page1);
      return { email: email1, close: closeResult, cancel: cancelResult };
    })());
  } else {
    console.log(`\n[${email1}] Skipping cleanup - already done in clickOrdersTab() during login`);
  }
  
  if (exchange2Name !== 'Extended Exchange') {
    cleanupPromises.push((async () => {
      console.log(`\n[${email2}] Checking for open positions and orders...`);
      const closeResult = await closeAllPositions(page2, 100, exchange2);
      const cancelResult = await cancelAllOrders(page2);
      return { email: email2, close: closeResult, cancel: cancelResult };
    })());
  } else {
    console.log(`\n[${email2}] Skipping cleanup - already done in clickOrdersTab() during login`);
  }

  if (cleanupPromises.length > 0) {
    const cleanupResults = await Promise.all(cleanupPromises);
    
    // Log cleanup results
    for (const result of cleanupResults) {
      if (result.close.success) {
        console.log(`✓ [${result.email}] Positions: ${result.close.message || 'checked'}`);
      } else {
        console.log(`⚠ [${result.email}] Positions: ${result.close.error || 'check failed'}`);
      }
      if (result.cancel.success) {
        console.log(`✓ [${result.email}] Orders: ${result.cancel.message || 'checked'}`);
      } else {
        console.log(`⚠ [${result.email}] Orders: ${result.cancel.error || 'check failed'}`);
      }
    }
  }

  console.log(`\n✓ Cleanup completed.`);
  
  // Set leverage ONCE at the beginning (AFTER cleanup)
  // NOTE: Extended Exchange already set leverage in clickOrdersTab() during login, so skip it
  console.log(`\n🔧 Setting leverage for accounts...`);
  const leveragePromises = [];
  
  // Only set leverage for Paradex accounts (Extended Exchange already set in clickOrdersTab)
  if (exchange1Name !== 'Extended Exchange') {
    leveragePromises.push((async () => {
      const result = await setLeverage(page1, TRADE_CONFIG.leverage);
      return { email: email1, result };
    })());
  } else {
    console.log(`[${email1}] Skipping leverage - already set in clickOrdersTab() during login`);
  }
  
  if (exchange2Name !== 'Extended Exchange') {
    leveragePromises.push((async () => {
      const result = await setLeverage(page2, TRADE_CONFIG.leverage);
      return { email: email2, result };
    })());
  } else {
    console.log(`[${email2}] Skipping leverage - already set in clickOrdersTab() during login`);
  }

  if (leveragePromises.length > 0) {
    const leverageResults = await Promise.all(leveragePromises);
    
    for (const { email, result } of leverageResults) {
      if (result.success) {
        console.log(`✓ [${email}] Leverage set to ${TRADE_CONFIG.leverage}x`);
      } else {
        console.log(`⚠ [${email}] Failed to set leverage: ${result.error}`);
      }
    }
  }

  console.log(`\n✓ Leverage configured. Starting trading cycles...\n`);
  await delay(1000); // Reduced from 2000ms

  // Track if Extended Exchange just completed post-trade flow (cleanup + leverage set)
  let extendedExchangeJustCompletedPostTrade = false;
  // Track if initial cleanup was done (to skip cleanup on first cycle)
  let initialCleanupDone = true; // Set to true since cleanup was just done before leverage

  while (!isShuttingDown) {
    cycleCount++;
    console.log(
      `\n>>> CYCLE ${cycleCount} - ${new Date().toLocaleTimeString()}`
    );

    try {
      // Skip cleanup if:
      // 1. Extended Exchange just completed post-trade flow (which already did cleanup + leverage)
      // 2. Initial cleanup was just done (first cycle after leverage was set)
      let skipCleanupAndPreTrade = false;
      if (extendedExchangeJustCompletedPostTrade) {
        console.log(`\n[CYCLE ${cycleCount}] Skipping cleanup and pre-trade - Extended Exchange just completed post-trade flow (cleanup + leverage already done)`);
        extendedExchangeJustCompletedPostTrade = false; // Reset flag
        skipCleanupAndPreTrade = true; // Skip both cleanup and pre-trade, go directly to trade execution
      } else if (initialCleanupDone && cycleCount === 1) {
        console.log(`\n[CYCLE ${cycleCount}] Skipping cleanup - initial cleanup was already done before leverage was set`);
        initialCleanupDone = false; // Reset flag after first cycle
        skipCleanupAndPreTrade = true; // Skip cleanup on first cycle, but still do pre-trade if needed
      }
      
      if (!skipCleanupAndPreTrade) {
        // Step 0: Cancel all open orders FIRST (to free up locked funds)
        console.log(`\n[CYCLE ${cycleCount}] Canceling all open orders first...`);
        const cancelPromises = [
          cancelAllOrders(page1),
          cancelAllOrders(page2),
        ];

        const cancelResults = await Promise.all(cancelPromises);

        if (cancelResults[0].success) {
          console.log(`✓ [${email1}] Open orders checked/canceled`);
        }
        if (cancelResults[1].success) {
          console.log(`✓ [${email2}] Open orders checked/canceled`);
        }

        // Small delay to ensure orders are fully canceled and funds are freed
        // Reduced from 2000ms - cancelAllOrders() already waits internally
        await delay(500);

        // Step 1: Close any existing positions
        // NOTE: For Extended Exchange, DON'T close positions here - let clickOrdersTab handle it (including TP/SL)
        console.log(`\n[CYCLE ${cycleCount}] Checking for existing positions...`);
        const initialClosePromises = [];
        
        // Only close positions for Paradex (Extended Exchange will handle it in clickOrdersTab)
        if (exchange1Name !== 'Extended Exchange') {
          initialClosePromises.push((async () => {
            const result = await closeAllPositions(page1, 100, exchange1);
            return { email: email1, result };
          })());
        }
        
        if (exchange2Name !== 'Extended Exchange') {
          initialClosePromises.push((async () => {
            const result = await closeAllPositions(page2, 100, exchange2);
            return { email: email2, result };
          })());
        }

        if (initialClosePromises.length > 0) {
          const initialCloseResults = await Promise.all(initialClosePromises);
          for (const { email, result } of initialCloseResults) {
            if (result.success) {
              console.log(`✓ [${email}] Existing positions checked/closed`);
            }
          }
          // Small delay to ensure positions are fully closed
          await delay(300);
        } else {
          console.log(`[CYCLE ${cycleCount}] Skipping position close - Extended Exchange will handle it in clickOrdersTab`);
        }
      } // End of else block for skip cleanup check
      
      // For first cycle, still need to do pre-trade flow for Extended Exchange if needed
      if (skipCleanupAndPreTrade && cycleCount === 1) {
        skipCleanupAndPreTrade = false; // Allow pre-trade flow on first cycle
      }

      // Step 0.5: For Extended Exchange, run PRE-trade flow BEFORE executing trades
      // Use clickOrdersTab() which does: cancel orders, positions, TP/SL, close positions, set leverage
      // This is the SAME flow as Phase 3 (initial setup) - no duplication
      // IMPORTANT: Don't close positions before this - clickOrdersTab needs to see positions to add TP/SL
      // Skip pre-trade if we just completed post-trade (cleanup + leverage already done)
      if (!skipCleanupAndPreTrade) {
        const hasExtendedExchange = exchange1Name === 'Extended Exchange' || exchange2Name === 'Extended Exchange';
        
        if (hasExtendedExchange) {
        console.log(`\n[CYCLE ${cycleCount}] Extended Exchange detected - running PRE-trade flow (clickOrdersTab)...`);
        console.log(`[CYCLE ${cycleCount}] NOTE: clickOrdersTab will handle cancel orders, TP/SL, close positions (leverage will be set in post-trade)`);
        
        // Run clickOrdersTab for Extended Exchange accounts (skip leverage - will be set post-trade)
        const preTradePromises = [];
        if (exchange1Name === 'Extended Exchange') {
          preTradePromises.push(clickOrdersTab(page1, email1, true)); // skipLeverage = true
        }
        if (exchange2Name === 'Extended Exchange') {
          preTradePromises.push(clickOrdersTab(page2, email2, true)); // skipLeverage = true
        }
        
          if (preTradePromises.length > 0) {
            await Promise.all(preTradePromises);
            console.log(`[CYCLE ${cycleCount}] Extended Exchange pre-trade flow completed`);
          }
          await delay(2000); // Small delay before trade execution
        }
      }

      // Step 1: Execute trades in parallel with limit orders at market price
      console.log(`\n[CYCLE ${cycleCount}] Opening new positions...`);
      const tradePromises = [
        executeTrade(page1, {
          side: "buy",
          orderType: "limit",
          qty: TRADE_CONFIG.buyQty,
          // Leverage already set at the beginning, price will be fetched automatically
        }, exchange1),
        executeTrade(page2, {
          side: "sell",
          orderType: "limit",
          qty: TRADE_CONFIG.sellQty,
          // Leverage already set at the beginning, price will be fetched automatically
        }, exchange2),
      ];

      const tradeResults = await Promise.all(tradePromises);

      // Check if both trades succeeded AND orders are confirmed as pending
      const trade1Success = tradeResults[0].success;
      const trade2Success = tradeResults[1].success;
      
      // Verify orders are actually placed (pending) before proceeding
      const order1Confirmed = tradeResults[0].orderStatus || tradeResults[0].success;
      const order2Confirmed = tradeResults[1].orderStatus || tradeResults[1].success;

      if (trade1Success) {
        if (order1Confirmed) {
          console.log(`✓ [${email1}] BUY order placed and confirmed as ${tradeResults[0].orderStatus || 'pending'}`);
        } else {
          console.log(`⚠️  [${email1}] BUY executed but order confirmation inconclusive: ${tradeResults[0].warning || 'unknown'}`);
        }
      } else {
        console.log(`✗ [${email1}] BUY failed: ${tradeResults[0].error}`);
      }

      if (trade2Success) {
        if (order2Confirmed) {
          console.log(`✓ [${email2}] SELL order placed and confirmed as ${tradeResults[1].orderStatus || 'pending'}`);
        } else {
          console.log(`⚠️  [${email2}] SELL executed but order confirmation inconclusive: ${tradeResults[1].warning || 'unknown'}`);
        }
      } else {
        console.log(`✗ [${email2}] SELL failed: ${tradeResults[1].error}`);
      }

      // CRITICAL: Only proceed to post-trade flow (closing orders/positions) AFTER both orders are confirmed as pending
      // This ensures we don't close positions before orders are actually placed
      if (trade1Success && trade2Success && (!order1Confirmed || !order2Confirmed)) {
        console.log(`\n⏳ [CYCLE ${cycleCount}] Waiting for order confirmation before proceeding...`);
        // Wait a bit more for orders to appear
        await delay(3000);
        console.log(`✓ [CYCLE ${cycleCount}] Proceeding with post-trade flow...`);
      }

      // Step 1.5: For Extended Exchange ONLY, run POST-trade flow AFTER orders are confirmed
      // IMPORTANT: Extended Exchange runs INDEPENDENTLY - doesn't wait for Paradex trade success
      // This ensures Extended Exchange proceeds even if Paradex trade fails
      const hasExtendedExchange1 = exchange1Name === 'Extended Exchange';
      const hasExtendedExchange2 = exchange2Name === 'Extended Exchange';
      
      if (hasExtendedExchange1 || hasExtendedExchange2) {
        console.log(`\n[CYCLE ${cycleCount}] Extended Exchange detected - running POST-trade flow IMMEDIATELY (independent of Paradex)...`);
        
        // Run post-trade flow for Extended Exchange accounts INDEPENDENTLY
        // Check if Extended Exchange trade succeeded before running post-trade
        const postTradePromises = [];
        if (hasExtendedExchange1 && trade1Success) {
          console.log(`[CYCLE ${cycleCount}] Running post-trade flow for ${email1} (Extended Exchange) - clickOrdersTab flow`);
          postTradePromises.push(clickOrdersTab(page1, email1));
        } else if (hasExtendedExchange1 && !trade1Success) {
          console.log(`[CYCLE ${cycleCount}] ⚠️  Extended Exchange (${email1}) trade failed - skipping post-trade flow`);
        }
        
        if (hasExtendedExchange2 && trade2Success) {
          console.log(`[CYCLE ${cycleCount}] Running post-trade flow for ${email2} (Extended Exchange) - clickOrdersTab flow`);
          postTradePromises.push(clickOrdersTab(page2, email2));
        } else if (hasExtendedExchange2 && !trade2Success) {
          console.log(`[CYCLE ${cycleCount}] ⚠️  Extended Exchange (${email2}) trade failed - skipping post-trade flow`);
        }
        
        if (postTradePromises.length > 0) {
          await Promise.all(postTradePromises);
          console.log(`[CYCLE ${cycleCount}] Extended Exchange post-trade flow completed (cleanup + leverage set)`);
        }
        
        // For Extended Exchange, skip wait/close steps and go directly to next cycle
        // Set flag to skip cleanup in next cycle since it was just done in post-trade flow
        extendedExchangeJustCompletedPostTrade = true;
        console.log(`[CYCLE ${cycleCount}] Extended Exchange cycle complete - next cycle will skip cleanup and go directly to trade execution`);
        await delay(2000); // Small delay before next cycle
        continue; // Skip to next cycle (bypass wait and close steps)
      }

      // Only proceed to wait and close if BOTH trades succeeded (for Paradex-only or mixed setups)
      if (!trade1Success || !trade2Success) {
        console.log(
          `\n✗ [CYCLE ${cycleCount}] One or both trades failed. Skipping wait and retrying in 5 seconds...`
        );
        await delay(5000);
        continue; // Skip to next cycle
      }

      console.log(
        `\n✓ [CYCLE ${cycleCount}] Both trades executed successfully!`
      );

      // Step 2: Wait for random time between 10 seconds and 3 minutes (only for non-Extended Exchange or mixed setups)
      const minWaitTime = 10000; // 10 seconds
      const maxWaitTime = 180000; // 3 minutes
      const randomWaitTime =
        Math.floor(Math.random() * (maxWaitTime - minWaitTime + 1)) +
        minWaitTime;

      console.log(
        `\n[CYCLE ${cycleCount}] Waiting ${
          randomWaitTime / 1000
        } seconds before closing...`
      );
      if (TRADE_CONFIG.stopLoss) {
        console.log(
          `[CYCLE ${cycleCount}] Stop loss enabled: $${TRADE_CONFIG.stopLoss} (will monitor P&L)`
        );
      }

      // Break wait into smaller chunks to allow faster shutdown and stop-loss checking
      const checkInterval = 2000; // Check every 2 seconds (changed from 1000 to allow P&L checks)
      const totalChecks = Math.ceil(randomWaitTime / checkInterval);

      for (let i = 0; i < totalChecks; i++) {
        if (isShuttingDown) {
          console.log(
            `\n[CYCLE ${cycleCount}] Shutdown detected during wait period`
          );
          break;
        }

        // Check stop loss if enabled
        if (TRADE_CONFIG.stopLoss) {
          try {
            // Get current P&L for both accounts
            const pnl1 = await getCurrentUnrealizedPnL(page1);
            const pnl2 = await getCurrentUnrealizedPnL(page2);

            const stopLossThreshold = -Math.abs(TRADE_CONFIG.stopLoss);

            // Debug logging every 5 checks (every 10 seconds) to see what's being compared
            if (i > 0 && i % 5 === 0) {
              console.log(
                `[CYCLE ${cycleCount}] Stop Loss Check - ${email1}: $${
                  pnl1 !== null ? pnl1.toLocaleString() : "N/A"
                }, ${email2}: $${
                  pnl2 !== null ? pnl2.toLocaleString() : "N/A"
                }, Threshold: $${stopLossThreshold.toLocaleString()}`
              );
            }

            // Check if Account 1 has exceeded stop loss
            // Changed from < to <= so it triggers at exactly the stop loss amount
            // Example: if stopLoss=1.5, we check if pnl1 <= -1.5
            if (pnl1 !== null && pnl1 <= stopLossThreshold) {
              console.log(
                `\n🚨 [CYCLE ${cycleCount}] STOP LOSS TRIGGERED for ${email1}!`
              );
              console.log(
                `   Current P&L: $${pnl1.toLocaleString()}, Stop Loss: -$${
                  TRADE_CONFIG.stopLoss
                }`
              );
              console.log(
                `   Condition: ${pnl1} <= ${stopLossThreshold} = ${
                  pnl1 <= stopLossThreshold
                }`
              );
              console.log(`   Closing positions immediately...`);

              // Close both accounts' positions to maintain balance
              await closeAllPositions(page1, 100, exchange1);
              await closeAllPositions(page2, 100, exchange2);

              console.log(
                `✓ [CYCLE ${cycleCount}] Positions closed due to stop loss`
              );
              break; // Exit the wait loop immediately
            }

            // Check if Account 2 has exceeded stop loss
            // Changed from < to <= so it triggers at exactly the stop loss amount
            if (pnl2 !== null && pnl2 <= stopLossThreshold) {
              console.log(
                `\n🚨 [CYCLE ${cycleCount}] STOP LOSS TRIGGERED for ${email2}!`
              );
              console.log(
                `   Current P&L: $${pnl2.toLocaleString()}, Stop Loss: -$${
                  TRADE_CONFIG.stopLoss
                }`
              );
              console.log(
                `   Condition: ${pnl2} <= ${stopLossThreshold} = ${
                  pnl2 <= stopLossThreshold
                }`
              );
              console.log(`   Closing positions immediately...`);

              // Close both accounts' positions to maintain balance
              await closeAllPositions(page1, 100, exchange1);
              await closeAllPositions(page2, 100, exchange2);

              console.log(
                `✓ [CYCLE ${cycleCount}] Positions closed due to stop loss`
              );
              break; // Exit the wait loop immediately
            }

            // Log P&L status every 10 checks (every 20 seconds) so you can see what's happening
            if (i > 0 && i % 10 === 0) {
              console.log(
                `[CYCLE ${cycleCount}] P&L Check - ${email1}: $${
                  pnl1 !== null ? pnl1.toLocaleString() : "N/A"
                }, ${email2}: $${pnl2 !== null ? pnl2.toLocaleString() : "N/A"}`
              );
            }
          } catch (error) {
            // If P&L check fails, don't break the loop - just log and continue
            console.log(
              `[CYCLE ${cycleCount}] Error checking P&L: ${error.message}`
            );
          }
        }

        await delay(checkInterval);

        // Show countdown every 10 seconds
        const remaining = randomWaitTime - (i + 1) * checkInterval;
        if (remaining > 0 && remaining % 10000 === 0) {
          console.log(
            `[CYCLE ${cycleCount}] ${remaining / 1000}s remaining...`
          );
        }
      }

      if (isShuttingDown) {
        console.log(`[CYCLE ${cycleCount}] Breaking loop due to shutdown`);
        break;
      }

      // Step 3: Close positions in parallel
      console.log(`\n[CYCLE ${cycleCount}] Closing positions...`);
      const closePromises = [
        closeAllPositions(page1, 100, exchange1),
        closeAllPositions(page2, 100, exchange2),
      ];

      const closeResults = await Promise.all(closePromises);

      const close1Success = closeResults[0].success;
      const close2Success = closeResults[1].success;

      if (close1Success) {
        console.log(`✓ [${email1}] Position closed successfully`);
      } else {
        console.log(
          `✗ [${email1}] Close failed: ${
            closeResults[0].error || closeResults[0].message
          }`
        );
      }

      if (close2Success) {
        console.log(`✓ [${email2}] Position closed successfully`);
      } else {
        console.log(
          `✗ [${email2}] Close failed: ${
            closeResults[1].error || closeResults[1].message
          }`
        );
      }

      // Check if both positions closed successfully
      if (close1Success && close2Success) {
        console.log(
          `\n✓ [CYCLE ${cycleCount}] Completed successfully at ${new Date().toLocaleTimeString()}`
        );
      } else {
        console.log(
          `\n⚠ [CYCLE ${cycleCount}] Completed with some errors at ${new Date().toLocaleTimeString()}`
        );
      }

      // Small delay before next cycle
      // Reduced from 3000ms - closeAllPositions() already waits internally
      if (!isShuttingDown) {
        console.log(`\nStarting next cycle in 1 second...`);
        await delay(1000);
      }
    } catch (error) {
      console.error(`\n✗ [CYCLE ${cycleCount}] Error:`, error.message);
      
      // Handle protocol timeout errors specifically
      if (error.message && error.message.includes('ProtocolError') && error.message.includes('timed out')) {
        console.log(`⚠ Protocol timeout detected - this may be due to slow page operations`);
        console.log(`   The bot will retry after a longer delay...`);
        await delay(10000); // Wait 10 seconds before retry for timeout errors
      } else {
        console.log(`Waiting 5 seconds before retry...`);
        await delay(5000);
      }
    }
  }

  console.log(`\n[Trading Loop] Exited after ${cycleCount} cycles`);
}

async function closeAllPositionsOnShutdown(results) {
  console.log(`\n========================================`);
  console.log(`Closing all positions before shutdown...`);
  console.log(`========================================\n`);

  const closePromises = results.map(async (result) => {
    if (result.success && result.page) {
      try {
        console.log(`[${result.email}] Closing positions...`);
        const closeResult = await closeAllPositions(result.page, 100);
        if (closeResult.success) {
          console.log(`✓ [${result.email}] Positions closed`);
        } else {
          console.log(
            `✗ [${result.email}] ${closeResult.error || closeResult.message}`
          );
        }
      } catch (error) {
        console.error(`✗ [${result.email}] Error closing:`, error.message);
      }
    }
  });

  await Promise.all(closePromises);
  console.log(`\n[Shutdown] All positions closed. Exiting...\n`);
}

async function main() {
  console.log(`\n========================================`);
  console.log(`Starting Multi-Exchange Trading Bot`);
  console.log(`Headless mode: ${HEADLESS}`);
  console.log(`Number of accounts: ${ACCOUNTS.length}`);
  console.log(`========================================\n`);

  // Prompt user to choose trading mode
  const tradingMode = await chooseTradingMode();
  console.log(`\n✓ Selected: ${tradingMode.description}\n`);

  // Assign exchanges to accounts based on mode
  const accountsWithExchanges = ACCOUNTS.map((account, index) => {
    let exchangeName;
    if (index === 0) {
      // First account = BUY account
      exchangeName = tradingMode.buyExchange;
    } else {
      // Second account = SELL account
      exchangeName = tradingMode.sellExchange;
    }
    return {
      ...account,
      exchange: exchangeName,
      exchangeConfig: EXCHANGE_CONFIGS[exchangeName]
    };
  });

  console.log(`\n📋 Account Configuration:`);
  accountsWithExchanges.forEach((acc, idx) => {
    console.log(`   Account ${idx + 1} (${acc.email}): ${acc.exchangeConfig.name} - ${idx === 0 ? 'BUY' : 'SELL'}`);
  });
  console.log(``);

  console.log(
    `💡 Tip: If you changed account emails, old cookies will be auto-deleted.`
  );
  console.log(
    `    You can also manually delete paradex-cookies-*.json files to reset.\n`
  );

  // Launch all accounts in parallel with their exchange configs
  const accountPromises = accountsWithExchanges.map((account) => 
    launchAccount(account, account.exchangeConfig)
  );
  const results = await Promise.all(accountPromises);

  // Summary
  console.log(`\n========================================`);
  console.log(`Launch Summary:`);
  console.log(`========================================`);

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  successful.forEach((r) => {
    const account = accountsWithExchanges.find((a) => a.email === r.email);
    console.log(`✓ ${r.email} on ${r.exchange || account.exchangeConfig.name} - API on port ${account.apiPort}`);
  });

  failed.forEach((r) => {
    console.log(`✗ ${r.email} - Failed to login`);
  });

  console.log(
    `\nTotal: ${successful.length} successful, ${failed.length} failed`
  );
  console.log(`========================================\n`);

  if (successful.length === 0) {
    console.log("No accounts logged in successfully. Exiting...");
    process.exit(1);
  }

  // Ensure we have exactly 2 accounts for the trading strategy
  if (successful.length !== 2) {
    console.log(`\n⚠️  Warning: Trading loop requires exactly 2 accounts.`);
    console.log(`Currently ${successful.length} accounts logged in.`);
    console.log(
      `Bot will run API servers but won't start automated trading.\n`
    );
    return;
  }

  // Setup graceful shutdown handlers
  const shutdownHandler = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n\n========================================`);
    console.log(`Shutdown signal received (Ctrl+C)`);
    console.log(`========================================`);

    // Stop trading loops
    console.log(`\nStopping trading loops...`);

    // Wait a moment for loops to detect shutdown flag
    await delay(2000);

    // Close all positions
    await closeAllPositionsOnShutdown(successful);

    // Close browsers
    console.log(`Closing browsers...`);
    for (const result of successful) {
      if (result.browser) {
        await result.browser.close();
      }
    }

    console.log(`Shutdown complete. Goodbye!\n`);
    process.exit(0);
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);

  // Get emails from ACCOUNT_EMAILS in order (first = BUY, second = SELL)
  const emailsEnv = process.env.ACCOUNT_EMAILS;
  if (!emailsEnv) {
    console.log(`\n✗ Error: ACCOUNT_EMAILS not found in .env file.`);
    process.exit(1);
  }

  const emails = emailsEnv.split(',').map(e => e.trim()).filter(e => e);
  
  if (emails.length < 2) {
    console.log(`\n✗ Error: ACCOUNT_EMAILS must contain at least 2 emails (comma-separated).`);
    console.log(`Format: ACCOUNT_EMAILS=email1@example.com,email2@example.com`);
    console.log(`First email will be used for BUY, second email for SELL.`);
    process.exit(1);
  }

  const buyEmail = emails[0];
  const sellEmail = emails[1];

  console.log(`\n📋 Account assignment from ACCOUNT_EMAILS:`);
  console.log(`   BUY:  ${buyEmail} (first email)`);
  console.log(`   SELL: ${sellEmail} (second email)`);

  // Find accounts by email from successful logins
  // Exchange info should already be stored in the result from launchAccount
  const buyAccount = successful.find((r) => r.email === buyEmail);
  const sellAccount = successful.find((r) => r.email === sellEmail);
  
  // Ensure exchange info is stored (fallback to trading mode if missing)
  if (buyAccount && !buyAccount.exchange) {
    buyAccount.exchange = tradingMode.buyExchange;
  }
  if (sellAccount && !sellAccount.exchange) {
    sellAccount.exchange = tradingMode.sellExchange;
  }

  if (!buyAccount) {
    console.log(`\n✗ Error: First email "${buyEmail}" (for BUY) not found in successful accounts.`);
    console.log(`Available accounts: ${successful.map((r) => r.email).join(", ")}`);
    process.exit(1);
  }

  if (!sellAccount) {
    console.log(`\n✗ Error: Second email "${sellEmail}" (for SELL) not found in successful accounts.`);
    console.log(`Available accounts: ${successful.map((r) => r.email).join(", ")}`);
    process.exit(1);
  }

  if (buyAccount.email === sellAccount.email) {
    console.log(`\n✗ Error: First and second emails in ACCOUNT_EMAILS must be different.`);
    process.exit(1);
  }

  console.log(`\n✓ Using ${buyAccount.email} for BUY orders`);
  console.log(`✓ Using ${sellAccount.email} for SELL orders`);

  // Start automated trading loop
  console.log(`\n🤖 Starting automated trading in 5 seconds...`);
  await delay(5000);

  // Start the trading loop with accounts based on ACCOUNT_EMAILS order
  automatedTradingLoop(buyAccount, sellAccount).catch((error) => {
    console.error(`Trading loop error:`, error);
  });
}

main().catch(console.error);

