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
      confirmSell: "Confirm Sell", // May need to change
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
async function clickOrdersTab(page, email) {
  console.log(`[${email}] Looking for Orders tab...`);
  
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
        await delay(1000);
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
          await delay(1000);
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
        await delay(1000);
      }
    }
    
    if (!ordersTabClicked) {
      console.log(`[${email}] Orders tab not found`);
      return false;
    }
    
    // After clicking Orders tab, check for buttons in Orders tab
    console.log(`[${email}] Checking for buttons in Orders tab (Login, Connect Wallet, or CANCEL ALL)...`);
    await delay(1500); // Wait for Orders tab content to load
    
    // Check for CANCEL ALL button first (use case in flow)
    let cancelAllClicked = false;
    
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
    
    if (cancelAllClicked) {
      console.log(`[${email}] Cancel All button clicked, waiting before clicking Positions tab...`);
      await delay(2000); // Wait for cancel operation to complete
      
      // Click on Positions tab after CANCEL ALL
      console.log(`[${email}] Looking for Positions tab after CANCEL ALL...`);
      let positionsTabClicked = false;
      
      // Strategy 1: Find by exact text "Positions"
      const positionsTab = await findByExactText(page, "Positions", ["button", "div", "span", "a"]);
      if (positionsTab) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, positionsTab);
        if (isVisible) {
          await positionsTab.click();
          positionsTabClicked = true;
          console.log(`[${email}] Clicked Positions tab after CANCEL ALL (exact text)`);
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
            console.log(`[${email}] Clicked Positions tab after CANCEL ALL (text search)`);
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
          console.log(`[${email}] Clicked Positions tab after CANCEL ALL (via evaluate)`);
        }
      }
      
      if (positionsTabClicked) {
        console.log(`[${email}] Positions tab clicked after CANCEL ALL`);
        await delay(2000); // Wait for Positions tab content to load
        
        // Look for TP/SL column in table and click any element/button in that column
        console.log(`[${email}] Looking for TP/SL column in Positions table...`);
        const tpSlClicked = await page.evaluate(() => {
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
        });
        
        if (tpSlClicked) {
          console.log(`[${email}] Clicked element in TP/SL column of Positions table`);
          await delay(1000);
        } else {
          console.log(`[${email}] Could not find TP/SL column or clickable element in Positions table`);
        }
      } else {
        console.log(`[${email}] Positions tab not found after CANCEL ALL`);
      }
    }
    
    // Check for Login button (just click once)
    let loginButtonFound = false;
    
    // Strategy 1: Find Login button by exact text
    const loginBtn = await findByExactText(page, "Log in", ["button", "div", "span", "a"]);
    if (loginBtn) {
      const isVisible = await page.evaluate((el) => {
        return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      }, loginBtn);
      if (isVisible) {
        await loginBtn.click();
        loginButtonFound = true;
        console.log(`[${email}] Clicked Log in button in Orders tab (exact text)`);
      }
    }
    
    if (!loginButtonFound) {
      const loginBtn2 = await findByExactText(page, "Login", ["button", "div", "span", "a"]);
      if (loginBtn2) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, loginBtn2);
        if (isVisible) {
          await loginBtn2.click();
          loginButtonFound = true;
          console.log(`[${email}] Clicked Login button in Orders tab (exact text)`);
        }
      }
    }
    
    // Strategy 2: Find Login button by text search
    if (!loginButtonFound) {
      const loginBtn3 = await findByText(page, "login", ["button", "div", "span", "a"]);
      if (loginBtn3) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, loginBtn3);
        if (isVisible) {
          await loginBtn3.click();
          loginButtonFound = true;
          console.log(`[${email}] Clicked Login button in Orders tab (text search)`);
        }
      }
    }
    
    // Strategy 3: Use evaluate to find Login button
    if (!loginButtonFound) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase();
          const isVisible = btn.offsetParent !== null;
          if (isVisible && text && (text === 'log in' || text === 'login')) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (clicked) {
        loginButtonFound = true;
        console.log(`[${email}] Clicked Login button in Orders tab (via evaluate)`);
      }
    }
    
    if (loginButtonFound) {
      console.log(`[${email}] Login button clicked, waiting for authentication...`);
      await delay(2000);
      return ordersTabClicked;
    }
    
    // If Login button not found, check for Connect Wallet button
    console.log(`[${email}] Login button not found, checking for Connect Wallet button...`);
    let connectWalletButtonClicked = false;
    
    // Strategy 1: Find Connect Wallet button by exact text
    const connectWalletBtn = await findByExactText(page, "Connect Wallet", ["button", "div", "span", "a"]);
    if (connectWalletBtn) {
      const isVisible = await page.evaluate((el) => {
        return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      }, connectWalletBtn);
      if (isVisible) {
        await connectWalletBtn.click();
        connectWalletButtonClicked = true;
        console.log(`[${email}] Clicked Connect Wallet button in Orders tab (exact text)`);
      }
    }
    
    // Strategy 2: Find Connect Wallet button by text search
    if (!connectWalletButtonClicked) {
      const connectWalletBtn2 = await findByText(page, "Connect Wallet", ["button", "div", "span", "a"]);
      if (connectWalletBtn2) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, connectWalletBtn2);
        if (isVisible) {
          await connectWalletBtn2.click();
          connectWalletButtonClicked = true;
          console.log(`[${email}] Clicked Connect Wallet button in Orders tab (text search)`);
        }
      }
    }
    
    // Strategy 3: Use evaluate to find Connect Wallet button
    if (!connectWalletButtonClicked) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase();
          const isVisible = btn.offsetParent !== null;
          if (isVisible && text && (text === 'connect wallet' || text.includes('connect wallet'))) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (clicked) {
        connectWalletButtonClicked = true;
        console.log(`[${email}] Clicked Connect Wallet button in Orders tab (via evaluate)`);
      }
    }
    
    if (connectWalletButtonClicked) {
      // Wait for modal to appear
      console.log(`[${email}] Connect Wallet button clicked, waiting for modal to appear...`);
      await delay(2000);
      
      // Look for WalletConnect button in modal
      console.log(`[${email}] Looking for WalletConnect button in modal...`);
      let walletConnectClicked = false;
      
      // Strategy 1: Find by exact text "WalletConnect"
      const walletConnectBtn = await findByExactText(page, "WalletConnect", ["button", "div", "span"]);
      if (walletConnectBtn) {
        const isVisible = await page.evaluate((el) => {
          return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, walletConnectBtn);
        if (isVisible) {
          await walletConnectBtn.click();
          walletConnectClicked = true;
          console.log(`[${email}] Clicked WalletConnect button in modal`);
        }
      }
      
      // Strategy 2: Find by text containing "WalletConnect" (case insensitive)
      if (!walletConnectClicked) {
        const walletConnectBtn2 = await findByText(page, "WalletConnect", ["button", "div", "span"]);
        if (walletConnectBtn2) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, walletConnectBtn2);
          if (isVisible) {
            await walletConnectBtn2.click();
            walletConnectClicked = true;
            console.log(`[${email}] Clicked WalletConnect button in modal (by text search)`);
          }
        }
      }
      
      // Strategy 3: Use evaluate to find WalletConnect in modal
      if (!walletConnectClicked) {
        const clicked = await page.evaluate(() => {
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
        if (clicked) {
          walletConnectClicked = true;
          console.log(`[${email}] Clicked WalletConnect button in modal (via evaluate)`);
        }
      }
      
      if (!walletConnectClicked) {
        console.log(`[${email}] Could not find WalletConnect button in modal`);
        console.log(`[${email}] User will need to manually connect wallet`);
      } else {
        console.log(`[${email}] WalletConnect button clicked, waiting for wallet connection...`);
        await delay(3000);
      }
    } else {
      console.log(`[${email}] No Login or Connect Wallet button found in Orders tab`);
    }
    
    return ordersTabClicked;
  } catch (error) {
    console.log(`[${email}] Error clicking Orders tab: ${error.message}`);
    return false;
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

async function closeAllPositions(page, percent = 100, exchangeConfig = null) {
  const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
  console.log(`\n=== Closing Position (${percent}%) on ${exchange.name} ===`);

  // Wait a moment for any previous actions to complete
  await delay(1000);

  // Click on Positions tab to see open positions
  const positionsTab = await findByExactText(page, exchange.selectors.positionsTab, [
    "button",
    "div",
    "span",
  ]);
  if (positionsTab) {
    await positionsTab.click();
    console.log("Clicked Positions tab");
    await delay(1000); // Reduced from 2000ms - wait for positions to load
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
      await delay(800); // Reduced from 1500ms
    }
  }

  if (!hasPositions) {
    console.log("✓ No open positions found - nothing to close");
    return { success: true, message: "No positions to close" };
  }

  // If we reach here, positions exist - first try Limit button, then fallback to Close All
  console.log("✓ Positions found - proceeding to close them...");
  
  // Wait a bit more for UI to fully render
  await delay(500);

  // Step 1: FIRST - Look for Limit button in Positions table Close column BEFORE any Close All button logic
  // The Close column has buttons with text "Market" and "Limit" in MarketCloseButton__Container
  // IMPORTANT: This must happen BEFORE looking for "Close All" button
  console.log(`Step 1: Looking for Limit button in Positions table Close column (before Close All button)...`);
  
  // Make sure we're on the Positions tab before looking for Limit button
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
    console.log(`Not on Positions tab, switching to Positions tab...`);
    const positionsTab = await findByExactText(page, exchange.selectors.positionsTab, [
      "button",
      "div",
      "span",
    ]);
    if (positionsTab) {
      await positionsTab.click();
      console.log("✓ Clicked Positions tab");
      await delay(1000); // Wait for positions to load
    } else {
      console.log("⚠ Could not find Positions tab");
    }
  } else {
    console.log("✓ Already on Positions tab");
  }
  
  // Wait a bit more for the table to fully render
  await delay(500);
  
  // Try multiple strategies to find and click Limit button (similar to Close All button detection)
  let limitBtn = null;
  let limitBtnClicked = false;
  
  // Strategy 1: Find by text "Limit" using existing function (same as Close All Strategy 1)
  limitBtn = await findByText(page, "Limit", ["button", "div", "a"]);
  
  if (limitBtn) {
    // Verify it's in the Close column (has Market button nearby)
    const isInCloseColumn = await page.evaluate((btn) => {
      let parent = btn.parentElement;
      for (let i = 0; i < 10 && parent; i++) {
        if (parent.tagName?.toLowerCase() === "td") {
          // Check if there's also a "Market" button in the same container or td
          const container = parent.querySelector('[class*="MarketCloseButton"]');
          if (container) {
            const marketBtn = Array.from(container.querySelectorAll('button')).find(
              b => b.textContent?.trim() === "Market"
            );
            if (marketBtn) return true;
          }
          // Also check if there's a Market button in the same td
          const marketBtn = Array.from(parent.querySelectorAll('button')).find(
            b => b.textContent?.trim() === "Market"
          );
          if (marketBtn) return true;
        }
        parent = parent.parentElement;
      }
      return false;
    }, limitBtn);
    
    if (isInCloseColumn) {
      console.log(`✓ Found Limit button by text in Close column`);
      await limitBtn.click();
      limitBtnClicked = true;
    } else {
      console.log(`⚠ Found Limit button but not in Close column, trying other strategies...`);
      limitBtn = null; // Reset to try other strategies
    }
  }
  
  // Strategy 2: If not found, try to find by evaluating the page and click directly (same as Close All Strategy 2)
  if (!limitBtn && !limitBtnClicked) {
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
    await delay(1500); // Wait for modal to fully load
    
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
      const checkInterval = 2000; // Check every 2 seconds
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
        console.log(`⚠ Position not closed after 10 seconds with Limit order. Will try Close All flow...`);
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
    console.log("No open orders found");
    return { success: true, message: "No orders to cancel", canceled: 0 };
  }

  // Wait a bit more for UI to fully render
  await delay(500); // Reduced from 1000ms

  // Find and click all Cancel buttons
  let canceledCount = 0;
  let maxAttempts = 10; // Prevent infinite loop
  let attempts = 0;

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

      // Click all cancel buttons found
      let clicked = 0;
      for (const btnInfo of cancelButtons) {
        try {
          btnInfo.element.click();
          clicked++;
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
      await delay(1000); // Reduced from 1500ms - wait for orders to be canceled

      // Check if there are still orders
      const stillHasOrders = await page.evaluate(() => {
        const text = document.body.innerText;
        return (
          text.includes("Open Orders") ||
          text.includes("Pending") ||
          (text.includes("Cancel") && text.includes("Order"))
        );
      });

      if (!stillHasOrders) {
        console.log("All orders canceled!");
        break;
      }
    } else {
      console.log("No more cancel buttons found");
      break;
    }
  }

  if (canceledCount > 0) {
    console.log(`✓ Successfully canceled ${canceledCount} order(s)`);
    return {
      success: true,
      message: `Canceled ${canceledCount} order(s)`,
      canceled: canceledCount,
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
  console.log(`\n=== Executing Trade ===`);

  // Set leverage first if requested (legacy support for API calls)
  if (setLeverageFirst && leverage) {
    const leverageResult = await setLeverage(page, leverage);
    if (!leverageResult.success) {
      console.log(`⚠ Failed to set leverage: ${leverageResult.error}`);
      // Continue anyway - leverage setting might not be critical
    }
    await delay(1000);
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
  const inputs = await page.$$('input[type="text"], input:not([type])');
  let sizeInput = null;
  let priceInput = null;

  console.log(`Found ${inputs.length} text input elements on page`);

  for (const input of inputs) {
    const rect = await input.boundingBox();
    if (!rect) continue;

    // Look for inputs in the right panel (trading panel is on the right side)
    if (rect.x < 1100) continue;

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

    // Check if this is the Size input
    const isSizeInput =
      inputInfo.parentText.includes("Size") ||
      inputInfo.labelText.includes("Size") ||
      inputInfo.placeholder.includes("Size") ||
      inputInfo.id.includes("size") ||
      inputInfo.name.includes("size");

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
  
  // 4. Cancel any open orders RIGHT BEFORE clicking confirm (to free up locked funds)
  console.log("Canceling any open orders before confirming trade...");
  const cancelResult = await cancelAllOrders(page);
  if (cancelResult.success) {
    console.log("✓ Open orders canceled before trade confirmation");
  }
  // Reduced from 500ms - cancelAllOrders() already waits internally
  await delay(300); // Wait for orders to be fully canceled and funds freed
  
  // 5. Click Confirm button
  const confirmText = side === "buy" ? "Confirm Buy" : "Confirm Sell";
  const confirmBtn = await findByText(page, confirmText, ["button"]);

  if (confirmBtn) {
    await confirmBtn.click();
    console.log(`Clicked "${confirmText}"`);
    await delay(1500); // Reduced from 2000ms

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

    console.log("Trade submitted successfully!");
    return { success: true, message: "Trade submitted" };
  } else {
    console.log(`Could not find "${confirmText}" button`);
    return { success: false, error: "Confirm button not found" };
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
    
    // Click Confirm button - make sure we're clicking in TP/SL modal, not leverage modal
    console.log(`[${email}] Clicking Confirm button...`);
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
      
      if (!tpslModal) return false;
      
      const buttons = Array.from(tpslModal.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        if (text === 'Confirm' || text.includes('Confirm')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
  
  if (confirmClicked) {
    console.log(`[${email}] ✓ Confirm button clicked`);
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
      protocolTimeout: 120000, // Increase protocol timeout to 120 seconds (default is 30s)
    });

    const page = await browser.newPage();

    // Set default navigation timeout to 60 seconds (increased from default 30s)
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

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
      await login(page, browser, email, cookiesPath, isNewAccount, exchange);
      await delay(3000);
      loggedIn = await isLoggedIn(page, exchange);
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

      // Set up TP/SL add button click listener (only for Paradex for now)
      if (exchange.name === 'Paradex') {
        await setupTpSlAddButtonListener(page, email);
      }

      return { browser, page, email, success: true, exchange: exchange.name };
    } else {
      console.log(`[${email}] Failed to login.`);
      await browser.close();
      return { email, success: false };
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
  const exchange1Key = exchange1Name?.toLowerCase() || 'paradex';
  const exchange2Key = exchange2Name?.toLowerCase() || 'paradex';
  const exchange1 = EXCHANGE_CONFIGS[exchange1Key] || EXCHANGE_CONFIGS.paradex;
  const exchange2 = EXCHANGE_CONFIGS[exchange2Key] || EXCHANGE_CONFIGS.paradex;

  let cycleCount = 0;

  console.log(`\n========================================`);
  console.log(`Starting Automated Trading Loop`);
  console.log(`Account 1 (${email1}) on ${exchange1.name}: BUY ${TRADE_CONFIG.buyQty} BTC`);
  console.log(`Account 2 (${email2}) on ${exchange2.name}: SELL ${TRADE_CONFIG.sellQty} BTC`);
  console.log(`Leverage: ${TRADE_CONFIG.leverage}x`);
  console.log(`Close after: Random time between 10s and 3min`);
  console.log(`========================================\n`);

  // Clean up any existing positions and orders BEFORE setting leverage
  console.log(`\n🧹 Cleaning up existing positions and orders...`);
  const cleanupPromises = [
    (async () => {
      console.log(`\n[${email1}] Checking for open positions and orders...`);
      const closeResult = await closeAllPositions(page1, 100, exchange1);
      const cancelResult = await cancelAllOrders(page1);
      return { email: email1, close: closeResult, cancel: cancelResult };
    })(),
    (async () => {
      console.log(`\n[${email2}] Checking for open positions and orders...`);
      const closeResult = await closeAllPositions(page2, 100, exchange2);
      const cancelResult = await cancelAllOrders(page2);
      return { email: email2, close: closeResult, cancel: cancelResult };
    })(),
  ];

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

  console.log(`\n✓ Cleanup completed.`);
  
  // Set leverage ONCE at the beginning for both accounts (AFTER cleanup)
  console.log(`\n🔧 Setting leverage for both accounts...`);
  const leveragePromises = [
    setLeverage(page1, TRADE_CONFIG.leverage),
    setLeverage(page2, TRADE_CONFIG.leverage),
  ];

  const leverageResults = await Promise.all(leveragePromises);

  if (leverageResults[0].success) {
    console.log(`✓ [${email1}] Leverage set to ${TRADE_CONFIG.leverage}x`);
  } else {
    console.log(
      `⚠ [${email1}] Failed to set leverage: ${leverageResults[0].error}`
    );
  }

  if (leverageResults[1].success) {
    console.log(`✓ [${email2}] Leverage set to ${TRADE_CONFIG.leverage}x`);
  } else {
    console.log(
      `⚠ [${email2}] Failed to set leverage: ${leverageResults[1].error}`
    );
  }

  console.log(`\n✓ Leverage configured. Starting trading cycles...\n`);
  await delay(1000); // Reduced from 2000ms

  while (!isShuttingDown) {
    cycleCount++;
    console.log(
      `\n>>> CYCLE ${cycleCount} - ${new Date().toLocaleTimeString()}`
    );

    try {
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
      console.log(`\n[CYCLE ${cycleCount}] Checking for existing positions...`);
      const initialClosePromises = [
        closeAllPositions(page1, 100, exchange1),
        closeAllPositions(page2, 100, exchange2),
      ];

      const initialCloseResults = await Promise.all(initialClosePromises);

      if (initialCloseResults[0].success) {
        console.log(`✓ [${email1}] Existing positions checked/closed`);
      }
      if (initialCloseResults[1].success) {
        console.log(`✓ [${email2}] Existing positions checked/closed`);
      }

      // Small delay to ensure positions are fully closed
      // Reduced from 500ms - closeAllPositions() already waits internally
      await delay(300); // Reduced from 500ms

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

      // Check if both trades succeeded
      const trade1Success = tradeResults[0].success;
      const trade2Success = tradeResults[1].success;

      if (trade1Success) {
        console.log(`✓ [${email1}] BUY executed successfully`);
      } else {
        console.log(`✗ [${email1}] BUY failed: ${tradeResults[0].error}`);
      }

      if (trade2Success) {
        console.log(`✓ [${email2}] SELL executed successfully`);
      } else {
        console.log(`✗ [${email2}] SELL failed: ${tradeResults[1].error}`);
      }

      // Only proceed to wait and close if BOTH trades succeeded
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

      // Step 2: Wait for random time between 10 seconds and 3 minutes (only after both trades succeed)
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

