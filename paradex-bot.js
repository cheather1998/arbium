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
const PARADEX_URL = "https://app.paradex.trade/trade/BTC-USD-PERP";
const PARADEX_REFERRAL_URL = "https://app.paradex.trade/r/instantcrypto";
const HEADLESS = process.argv.includes('--headless');

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
      cookiesPath: `./paradex-cookies-account${index + 1}.json`,
      profileDir: `/tmp/puppeteer-chrome-profile-${index + 1}-${emailHash}`,
      apiPort: 3001 + index
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

async function isLoggedIn(page) {
  // Check if user is logged in by looking for account/portfolio elements
  await delay(2000);
  const loggedInIndicators = await page.evaluate(() => {
    const text = document.body.innerText;

    // Check for "Log in" button - if exists, we're NOT logged in
    const hasLoginBtn = Array.from(document.querySelectorAll('button')).some(
      b => b.textContent?.trim() === 'Log in'
    );

    // Check for actual trading interface elements that only appear when logged in
    const hasAccountInfo = text.includes('Available to trade') ||
                          text.includes('Account Value') ||
                          text.includes('Portfolio Value') ||
                          text.includes('Unrealized P&L');

    // More specific check - look for the trading form (Buy/Sell buttons in trading panel)
    const hasTradingInterface = Array.from(document.querySelectorAll('button')).some(
      b => {
        const btnText = b.textContent?.trim();
        return btnText === 'Buy' || btnText === 'Sell';
      }
    );

    // We're only logged in if we DON'T see login button AND we DO see trading interface
    return !hasLoginBtn && (hasAccountInfo || hasTradingInterface);
  });
  return loggedInIndicators;
}

async function login(page, browser, email, cookiesPath, isNewAccount = false) {
  console.log(`[${email}] Starting login process...`);

  try {
    // For new accounts, navigate to referral URL first
    if (isNewAccount) {
      console.log(`[${email}] New account detected - using referral link`);
      try {
        await page.goto(PARADEX_REFERRAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(3000);
        console.log(`[${email}] Referral link applied: ${PARADEX_REFERRAL_URL}`);
      } catch (error) {
        console.log(`[${email}] Error loading referral link, continuing...`);
      }
    }

    // Click Log in button (first time - on referral/landing page)
    const loginBtn = await findByText(page, 'Log in', ['button']);
    if (loginBtn) {
      await loginBtn.click();
      console.log(`[${email}] Clicked Log in button (first click)`);
      await delay(3000); // Wait for page to navigate
    } else {
      console.log(`[${email}] No Log in button found - might already be logged in`);
      return true;
    }

    // For referral links, we need to click Log in AGAIN on the dashboard
    if (isNewAccount) {
      console.log(`[${email}] Looking for Log in button on dashboard...`);
      const loginBtn2 = await findByText(page, 'Log in', ['button']);
      if (loginBtn2) {
        await loginBtn2.click();
        console.log(`[${email}] Clicked Log in button (second click - on dashboard)`);
        await delay(3000); // Wait for modal to appear
      } else {
        console.log(`[${email}] Second Log in button not found, continuing...`);
      }
    }

    await delay(2000); // Additional wait for modal to fully load

    // Click Email or Social
    const socialBtn = await findByText(page, 'Email or Social', ['button', 'div']);
    if (socialBtn) {
      await socialBtn.click();
      console.log(`[${email}] Clicked Email or Social`);
    } else {
      console.log(`[${email}] Email or Social button not found, trying to continue...`);
    }

    await delay(2000); // Wait for email input to appear

    // Enter email
    const emailInput = await page.$('input[type="email"], input[placeholder*="email"], input[placeholder*="Email"]');
    if (emailInput) {
      await emailInput.click();
      await delay(200);
      await emailInput.type(email, { delay: 30 });
      console.log(`[${email}] Entered email: ${email}`);
    } else {
      console.log(`[${email}] Email input not found`);
    }

    await delay(500);

    // Click Submit - try multiple approaches
    console.log(`[${email}] Looking for Submit button...`);

    // Try clicking any element with "Submit" text using page.evaluate
    const submitClicked = await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('*'));
      const submitElement = allElements.find(el => {
        const text = el.textContent?.trim();
        return text === 'Submit' && el.offsetParent !== null; // visible element
      });

      if (submitElement) {
        submitElement.click();
        return true;
      }
      return false;
    });

    if (submitClicked) {
      console.log(`[${email}] Clicked Submit`);
    } else {
      console.log(`[${email}] Submit not found, pressing Enter...`);
      await page.keyboard.press('Enter');
      console.log(`[${email}] Pressed Enter`);
    }

    await delay(3000); // Wait for OTP screen
  } catch (error) {
    console.error(`[${email}] Error during login flow:`, error.message);
    // Don't throw - login might have succeeded despite DOM changes
    console.log(`[${email}] Continuing despite error - will check login status...`);
  }

  // Wait for OTP code entry
  console.log("\n===========================================");
  console.log(`[${email}] Check your email for the verification code!`);
  console.log("===========================================\n");

  if (HEADLESS) {
    // In headless mode, prompt for OTP in terminal
    const otp = await prompt(`[${email}] Enter the 6-digit OTP code: `);

    // Find OTP input fields and enter code
    const otpInputs = await page.$$('input');
    let otpIndex = 0;
    for (const input of otpInputs) {
      const maxLength = await page.evaluate(el => el.maxLength, input);
      if (maxLength === 1 && otpIndex < 6) {
        await input.type(otp[otpIndex], { delay: 100 });
        otpIndex++;
      }
    }
    console.log(`[${email}] OTP entered`);
  } else {
    // In non-headless mode, wait for manual entry
    console.log(`[${email}] Please enter the OTP code in the browser...`);

    // Wait until we're logged in (check periodically)
    let attempts = 0;
    while (attempts < 40) { // Wait up to 2 minutes (40 × 3s)
      await delay(3000); // Check every 3 seconds
      try {
        const loggedIn = await isLoggedIn(page);
        if (loggedIn) {
          console.log(`[${email}] Login detected!`);
          break;
        }
      } catch (error) {
        // Ignore errors during login check - might be DOM changes
        console.log(`[${email}] Waiting for login... (attempt ${attempts + 1}/40)`);
      }
      attempts++;
    }
  }

  await delay(3000);
  await saveCookies(page, cookiesPath, email);
  return true;
}

async function findByExactText(pg, text, tagNames = ['button', 'div', 'span']) {
  for (const tag of tagNames) {
    const elements = await pg.$$(tag);
    for (const el of elements) {
      const elText = await pg.evaluate(e => e.textContent?.trim(), el);
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
          const match = text?.match(/\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/);
          if (match) {
            const priceStr = match[1].replace(/,/g, '');
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
      const priceMatches = allText.match(/\$?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)/g);
      if (priceMatches) {
        for (const match of priceMatches) {
          const priceStr = match.replace(/[$,]/g, '');
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

async function closeAllPositions(page, percent = 100) {
  console.log(`\n=== Closing Position (${percent}%) ===`);

  // Wait a moment for any previous actions to complete
  await delay(1000);

  // Click on Positions tab to see open positions
  const positionsTab = await findByExactText(page, 'Positions', ['button', 'div', 'span']);
  if (positionsTab) {
    await positionsTab.click();
    console.log("Clicked Positions tab");
    await delay(1500); // Reduced from 3000
  }

  // Check if there are any open positions (reduced retries)
  console.log("Checking for open positions...");
  let hasPositions = false;
  for (let i = 0; i < 2; i++) { // Reduced from 3 to 2
    hasPositions = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('Current Position') || text.includes('Unrealized P&L');
    });

    if (hasPositions) {
      console.log("Found open positions!");
      break;
    }

    if (i < 1) { // Only wait on first attempt
      console.log(`Attempt ${i + 1}/2: No positions found yet, waiting...`);
      await delay(1000); // Reduced from 2000
    }
  }

  if (!hasPositions) {
    console.log("No open positions found");
    return { success: true, message: "No positions to close" };
  }

  // Look for Close buttons and log what we find
  const closeButtonsDebug = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
    return buttons
      .filter(btn => {
        const text = btn.textContent?.trim().toLowerCase();
        return text && (text.includes('close') || text === 'x');
      })
      .map(btn => ({
        text: btn.textContent?.trim(),
        visible: btn.offsetParent !== null,
        className: btn.className
      }));
  });

  console.log(`Found ${closeButtonsDebug.length} close-related buttons:`, JSON.stringify(closeButtonsDebug, null, 2));

  if (closeButtonsDebug.length === 0) {
    console.log("No close buttons found");
    return { success: false, error: "No close buttons found in positions" };
  }

  // Click the first Close button
  const closeBtn = await findByText(page, 'Close', ['button', 'div']);
  if (closeBtn) {
    await closeBtn.click();
    console.log("Clicked Close button");
    await delay(1000); // Reduced from 2000

    // Select the percentage by clicking the percentage button in the modal
    console.log(`Setting close percentage to ${percent}%`);

    // Find and click the percentage button in the modal
    // These buttons are INSIDE the modal, below "Position Value (Closing)"
    const percentButtonClicked = await page.evaluate((targetPercent) => {
      const buttons = Array.from(document.querySelectorAll('button'));

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
            const parentText = parent.textContent || '';
            if (parentText.includes('Close All Positions') ||
                parentText.includes('Position Value (Closing)')) {
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

      return { success: false, error: `${targetPercent}% button not found in modal` };
    }, percent);

    if (!percentButtonClicked.success) {
      console.log(`Error: ${percentButtonClicked.error}`);
      return { success: false, error: percentButtonClicked.error };
    }

    console.log(`Clicked ${percentButtonClicked.clicked} button in modal`);
    await delay(800); // Reduced from 1500

    // Now look for the close confirmation button
    // The button text should have changed to match the percentage
    console.log(`Looking for close confirmation button...`);

    const closeConfirmBtn = await page.evaluate((targetPercent) => {
      const buttons = Array.from(document.querySelectorAll('button'));

      // Log all buttons for debugging
      console.log('All buttons in modal:');
      buttons.forEach(btn => {
        const text = btn.textContent?.trim();
        if (text) console.log(`  - "${text}"`);
      });

      // Look for button with text like "Close 50% of All Positions"
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (text &&
            text.toLowerCase().includes('close') &&
            text.includes('%') &&
            text.toLowerCase().includes('position')) {
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
      await delay(1000); // Reduced from 2000

      const errorMsg = await page.evaluate(() => {
        const errors = document.querySelectorAll('[class*="error"], [class*="Error"]');
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

async function setLeverage(page, leverage) {
  console.log(`\n=== Setting Leverage to ${leverage}x ===`);
  console.log(`Target leverage from config: ${leverage}`);

  try {
    await delay(1000);

    // Step 1: Find and click the leverage display (e.g., "50x") in the trading panel to open modal
    console.log("Looking for leverage button in trading panel...");
    const leverageOpened = await page.evaluate(() => {
      // Look for leverage display with various strategies
      const allElements = Array.from(document.querySelectorAll('button, div, span, a'));

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
              height: rect.height
            });
          }
        }
      }

      console.log(`Found ${candidates.length} leverage button candidates`);
      candidates.forEach((c, i) => {
        console.log(`  ${i + 1}. "${c.text}" at (${Math.round(c.x)}, ${Math.round(c.y)}) size: ${Math.round(c.width)}x${Math.round(c.height)}`);
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

    console.log(`✓ Clicked leverage button: ${leverageOpened.found}, waiting for modal...`);
    await delay(2500); // Wait for "Adjust Leverage" modal to open

    // Step 2: Find the input field in the modal and enter the leverage value
    console.log(`Setting leverage to ${leverage} in the modal...`);

    // Find the leverage input field
    const inputInfo = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');

      console.log(`Found ${inputs.length} input fields in modal`);

      // Strategy: Find input with numeric value in visible modal
      for (const input of inputs) {
        if (input.offsetParent === null) continue; // Skip hidden inputs

        const value = input.value || '';
        const placeholder = input.placeholder || '';

        console.log(`Input: value="${value}", placeholder="${placeholder}"`);

        // Check if this looks like a leverage input
        if (/^\d+$/.test(value) || placeholder.toLowerCase().includes('leverage')) {
          console.log(`Found leverage input with current value: "${value}"`);

          // Mark the input with a unique attribute so we can find it again
          input.setAttribute('data-leverage-input', 'true');
          input.setAttribute('data-old-value', value);

          return {
            success: true,
            oldValue: value
          };
        }
      }

      return { success: false, error: 'Leverage input not found in modal' };
    });

    if (!inputInfo.success) {
      console.log(`⚠ Could not find leverage input: ${inputInfo.error}`);
      return { success: false, error: inputInfo.error };
    }

    // Now use Puppeteer to actually type into the input (for proper React state management)
    const leverageInput = await page.$('input[data-leverage-input="true"]');

    if (!leverageInput) {
      console.log(`⚠ Could not locate leverage input element`);
      return { success: false, error: 'Could not locate leverage input element' };
    }

    // Triple-click to select all and position cursor
    await leverageInput.click({ clickCount: 3 });
    await delay(200);

    // Get current value
    let currentValue = await page.evaluate(() => {
      const input = document.querySelector('input[data-leverage-input="true"]');
      return input ? input.value : '';
    });

    console.log(`Current input value: "${currentValue}"`);

    // Move cursor to end of input
    await page.keyboard.press('End');
    await delay(100);

    // Delete all characters with backspace
    const deleteCount = currentValue.length;
    console.log(`Deleting ${deleteCount} characters with backspace...`);
    for (let i = 0; i < deleteCount; i++) {
      await page.keyboard.press('Backspace');
      await delay(30);
    }
    await delay(200);

    // Verify input is empty or has default "0"
    currentValue = await page.evaluate(() => {
      const input = document.querySelector('input[data-leverage-input="true"]');
      return input ? input.value : '';
    });
    console.log(`After deleting: "${currentValue}"`);

    // If there's still a "0", delete it too
    if (currentValue === '0') {
      await page.keyboard.press('Backspace');
      await delay(100);
    }

    // Now type the new leverage value
    const leverageStr = String(leverage);
    console.log(`Typing leverage value: "${leverageStr}"`);
    await page.keyboard.type(leverageStr, { delay: 100 });
    await delay(300);

    // Delete the trailing "0" if it appears
    console.log(`Pressing Delete to remove trailing "0"...`);
    await page.keyboard.press('Delete');
    await delay(200);

    // Verify the value was set
    const leverageSet = await page.evaluate(() => {
      const input = document.querySelector('input[data-leverage-input="true"]');
      if (input) {
        return {
          success: true,
          oldValue: input.getAttribute('data-old-value') || 'unknown',
          newValue: input.value
        };
      }
      return { success: false, error: 'Input disappeared' };
    });

    if (!leverageSet.success) {
      console.log(`⚠ Could not set leverage value: ${leverageSet.error}`);
      return { success: false, error: leverageSet.error };
    }

    console.log(`✓ Changed leverage from ${leverageSet.oldValue} to ${leverageSet.newValue}`);

    // Wait for the UI to register the input change before clicking Confirm
    console.log("Waiting for UI to register the leverage change...");
    await delay(3000);

    // Step 3: Click the "Confirm" button
    console.log("Clicking Confirm button...");
    const confirmed = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (text === 'Confirm' && btn.offsetParent !== null) {
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

    await delay(2000); // Wait for modal to close and settings to apply

    // Verify the leverage was actually applied by checking the display button
    console.log("Verifying leverage was applied...");
    const finalLeverage = await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('button, div, span, a'));
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
      console.log(`✓ Leverage successfully set to ${leverage}x (verified: ${finalLeverage})`);
    } else {
      console.log(`✓ Leverage set to ${leverage}x (verification skipped - display not found)`);
    }

    return { success: true, leverage: leverage };
  } catch (error) {
    console.error("Error setting leverage:", error.message);
    return { success: false, error: error.message };
  }
}

async function executeTrade(page, { side, orderType, price, qty, setLeverageFirst = false, leverage = null }) {
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
  if (orderType === 'limit' && !price) {
    price = await getCurrentMarketPrice(page);
    if (!price) {
      console.log("❌ Could not fetch market price for limit order");
      return { success: false, error: "Could not fetch market price" };
    }
  }

  console.log(`Side: ${side}, Type: ${orderType}, Price: ${price || 'market'}, Qty: ${qty}`);

  // No need to reload - just wait a moment for any previous actions to complete
  await delay(1000); // Reduced from 2000

  // 1. Select Buy or Sell
  if (side === 'sell') {
    const sellBtn = await findByExactText(page, 'Sell', ['button', 'div']);
    if (sellBtn) {
      await sellBtn.click();
      console.log("Selected SELL");
      await delay(500);
    }
  } else {
    const buyBtn = await findByExactText(page, 'Buy', ['button', 'div']);
    if (buyBtn) {
      await buyBtn.click();
      console.log("Selected BUY");
      await delay(500);
    }
  }

  // 2. Select Market or Limit order type
  if (orderType === 'limit') {
    const limitBtn = await findByExactText(page, 'Limit', ['button', 'div']);
    if (limitBtn) {
      await limitBtn.click();
      console.log("Selected LIMIT order");
      await delay(500);
    }
  } else {
    const marketBtn = await findByExactText(page, 'Market', ['button', 'div']);
    if (marketBtn) {
      await marketBtn.click();
      console.log("Selected MARKET order");
      await delay(500);
    }
  }

  await delay(1000);

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

    const inputInfo = await page.evaluate(el => {
      // Get all text content around this input
      let parent = el.parentElement;
      let parentText = '';
      let labelText = '';

      // Check for label
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        if (label.control === el || label.contains(el)) {
          labelText = label.textContent?.trim() || '';
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
        placeholder: el.placeholder || '',
        value: el.value || '',
        id: el.id || '',
        name: el.name || '',
        parentText: parentText,
        labelText: labelText
      };
    }, input);

    console.log(`Input at (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
    console.log(`  ID: "${inputInfo.id}", Name: "${inputInfo.name}", Placeholder: "${inputInfo.placeholder}"`);
    console.log(`  Label: "${inputInfo.labelText}", Parent: "${inputInfo.parentText.substring(0, 60)}"`);
    console.log(`  Current value: "${inputInfo.value}"`);

    // Check if this is the Size input
    const isSizeInput = inputInfo.parentText.includes('Size') ||
                        inputInfo.labelText.includes('Size') ||
                        inputInfo.placeholder.includes('Size') ||
                        inputInfo.id.includes('size') ||
                        inputInfo.name.includes('size');

    // Check if this is the Price input
    const isPriceInput = inputInfo.parentText.includes('Price') ||
                         inputInfo.labelText.includes('Price') ||
                         inputInfo.placeholder.includes('Price') ||
                         inputInfo.id.includes('price') ||
                         inputInfo.name.includes('price');

    if (isSizeInput && !sizeInput) {
      sizeInput = input;
      console.log("✓ Found size input!");
    } else if (isPriceInput && !priceInput && orderType === 'limit') {
      priceInput = input;
      console.log("✓ Found price input!");
    }
  }

  // Enter price (for limit orders)
  if (orderType === 'limit' && price) {
    if (priceInput) {
      await priceInput.click({ clickCount: 3 });
      await delay(100);
      await page.keyboard.press('Backspace');
      await priceInput.type(String(price), { delay: 30 });
      console.log(`Entered price: ${price}`);
    } else {
      const allInputs = await page.$$('input');
      for (const inp of allInputs) {
        const rect = await inp.boundingBox();
        if (rect && rect.x > 1000 && rect.y > 150 && rect.y < 300) {
          await inp.click({ clickCount: 3 });
          await delay(100);
          await page.keyboard.press('Backspace');
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
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Meta');
  await delay(100);

  // Type the new value
  await page.keyboard.type(String(qty), { delay: 100 });
  await delay(500);

  // Verify the value was set
  let actualValue = await page.evaluate(el => el.value, sizeInput);
  console.log(`Size input value after first attempt: "${actualValue}"`);

  // If value wasn't set properly, try alternative method
  if (!actualValue || actualValue === '' || Math.abs(parseFloat(actualValue) - parseFloat(qty)) > 0.0001) {
    console.log("First attempt failed, trying alternative method...");

    // Focus the input
    await sizeInput.focus();
    await delay(200);

    // Clear using JavaScript
    await page.evaluate(el => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, sizeInput);
    await delay(200);

    // Type again
    await sizeInput.type(String(qty), { delay: 100 });
    await delay(500);

    actualValue = await page.evaluate(el => el.value, sizeInput);
    console.log(`Size input value after second attempt: "${actualValue}"`);
  }

  // If still not set, try direct value assignment
  if (!actualValue || actualValue === '' || Math.abs(parseFloat(actualValue) - parseFloat(qty)) > 0.0001) {
    console.log("Second attempt failed, using direct assignment...");

    await page.evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, sizeInput, String(qty));
    await delay(500);

    actualValue = await page.evaluate(el => el.value, sizeInput);
    console.log(`Size input value after direct assignment: "${actualValue}"`);
  }

  // Final verification
  if (!actualValue || actualValue === '') {
    console.log("❌ Failed to set size value!");
    return { success: false, error: "Failed to enter size value" };
  }

  console.log(`✓ Successfully set size to: ${actualValue}`);
  await delay(1000);
  // 4. Click Confirm button
  const confirmText = side === 'buy' ? 'Confirm Buy' : 'Confirm Sell';
  const confirmBtn = await findByText(page, confirmText, ['button']);

  if (confirmBtn) {
    await confirmBtn.click();
    console.log(`Clicked "${confirmText}"`);
    await delay(2000);

    const errorMsg = await page.evaluate(() => {
      const errors = document.querySelectorAll('[class*="error"], [class*="Error"]');
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

function startApiServer(page, apiPort, email) {
  let isReady = true;
  const apiApp = express();
  apiApp.use(express.json());

  // Health check
  apiApp.get('/health', (req, res) => {
    res.json({ status: 'ok', ready: isReady, account: email });
  });

  // Place trade
  apiApp.post('/trade', async (req, res) => {
    const { side, orderType, price, qty, leverage, setLeverageFirst } = req.body;

    if (!side || !['buy', 'sell'].includes(side)) {
      return res.status(400).json({ error: "Invalid side. Use 'buy' or 'sell'" });
    }
    if (!orderType || !['market', 'limit'].includes(orderType)) {
      return res.status(400).json({ error: "Invalid orderType. Use 'market' or 'limit'" });
    }
    // Price is now optional for limit orders - will fetch current market price if not provided
    if (!qty || qty <= 0) {
      return res.status(400).json({ error: "Invalid qty. Must be positive number" });
    }

    try {
      const result = await executeTrade(page, {
        side,
        orderType,
        price,
        qty,
        leverage,
        setLeverageFirst: setLeverageFirst || false
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Close all positions
  apiApp.post('/close-all', async (req, res) => {
    const { percent = 100 } = req.body;

    // Validate percent
    if (percent < 0 || percent > 100) {
      return res.status(400).json({ error: "Percent must be between 0 and 100" });
    }

    try {
      const result = await closeAllPositions(page, percent);
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Screenshot endpoint
  apiApp.get('/screenshot', async (req, res) => {
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
    console.log(`  # Place a limit buy order at market price (price auto-fetched)`);
    console.log(`  curl -X POST http://localhost:${apiPort}/trade \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"side":"buy","orderType":"limit","qty":0.001}'\n`);
    console.log(`  # Place a limit order with 40x leverage`);
    console.log(`  curl -X POST http://localhost:${apiPort}/trade \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"side":"buy","orderType":"limit","qty":0.001,"leverage":40,"setLeverageFirst":true}'\n`);
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

async function launchAccount(accountConfig) {
  const { email, cookiesPath, profileDir, apiPort } = accountConfig;

  try {
    console.log(`\n[${email}] Launching browser instance...`);

    // Clean up old profile directories for this account slot if email changed
    // Look for old profile dirs with pattern /tmp/puppeteer-chrome-profile-{index}-*
    const accountIndex = cookiesPath.match(/account(\d+)/)?.[1];
    if (accountIndex) {
      const profilePattern = `/tmp/puppeteer-chrome-profile-${accountIndex}-`;
      try {
        const tmpFiles = fs.readdirSync('/tmp');
        tmpFiles.forEach(file => {
          if (file.startsWith(`puppeteer-chrome-profile-${accountIndex}-`) &&
              `/tmp/${file}` !== profileDir) {
            const oldProfilePath = path.join('/tmp', file);
            console.log(`[${email}] Cleaning up old profile directory: ${oldProfilePath}`);
            try {
              fs.rmSync(oldProfilePath, { recursive: true, force: true });
            } catch (e) {
              console.log(`[${email}] Could not delete old profile (may be in use): ${e.message}`);
            }
          }
        });
      } catch (e) {
        // Ignore errors reading /tmp
      }
    }

    const browser = await puppeteer.launch({
      headless: HEADLESS,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: profileDir,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1920,1080',
      ],
      defaultViewport: HEADLESS ? { width: 1920, height: 1080 } : null,
    });

    const page = await browser.newPage();

    // Set default navigation timeout to 60 seconds (increased from default 30s)
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Try to load saved cookies - check if this is a new account
    const hasExistingCookies = await loadCookies(page, cookiesPath, email);
    const isNewAccount = !hasExistingCookies;

    if (isNewAccount) {
      console.log(`[${email}] New account detected - no existing cookies`);
    }

    console.log(`[${email}] Opening Paradex...`);

    // If new account, use referral URL; otherwise use regular trading URL
    const targetUrl = isNewAccount ? PARADEX_REFERRAL_URL : PARADEX_URL;

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      if (isNewAccount) {
        console.log(`[${email}] Loaded with referral link: ${PARADEX_REFERRAL_URL}`);
      }
    } catch (error) {
      console.log(`[${email}] Page load timeout, attempting to continue...`);
    }
    await delay(5000);

    // Check if logged in
    let loggedIn = await isLoggedIn(page);
    console.log(`[${email}] Logged in:`, loggedIn);

    if (!loggedIn) {
      await login(page, browser, email, cookiesPath, isNewAccount);
      await delay(3000);
      loggedIn = await isLoggedIn(page);
    }

    // If logged in and we were on referral page, navigate to trading page
    if (loggedIn && isNewAccount) {
      const currentUrl = page.url();
      if (!currentUrl.includes('app.paradex.trade/trade')) {
        console.log(`[${email}] Navigating to trading page after login...`);
        try {
          await page.goto(PARADEX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(3000);
        } catch (error) {
          console.log(`[${email}] Navigation error, continuing...`);
        }
      }
    }

    if (loggedIn) {
      console.log(`\n[${email}] *** Successfully logged in! ***\n`);

      // Ensure we're on the trading page (not redirected to status page)
      const currentUrl = page.url();
      if (!currentUrl.includes('app.paradex.trade/trade')) {
        console.log(`[${email}] Redirected to ${currentUrl}, navigating back to trading page...`);
        try {
          await page.goto(PARADEX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(3000);
        } catch (error) {
          console.log(`[${email}] Navigation error, continuing...`);
        }
      }

      // Start the API server for this account
      startApiServer(page, apiPort, email);

      return { browser, page, email, success: true };
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
  buyQty: parseFloat(process.env.BUY_QTY) || 0.0005,  // BTC quantity for BUY
  sellQty: parseFloat(process.env.SELL_QTY) || 0.0005,  // BTC quantity for SELL
  waitTime: parseInt(process.env.TRADE_TIME) || 60000,  // Time to wait before closing (milliseconds)
  leverage: parseInt(process.env.LEVERAGE) || 20,  // Leverage multiplier
};

let isShuttingDown = false;

async function automatedTradingLoop(account1Result, account2Result) {
  const { page: page1, email: email1 } = account1Result;
  const { page: page2, email: email2 } = account2Result;

  let cycleCount = 0;

  console.log(`\n========================================`);
  console.log(`Starting Automated Trading Loop`);
  console.log(`Account 1 (${email1}): BUY ${TRADE_CONFIG.buyQty} BTC`);
  console.log(`Account 2 (${email2}): SELL ${TRADE_CONFIG.sellQty} BTC`);
  console.log(`Leverage: ${TRADE_CONFIG.leverage}x`);
  console.log(`Close after: Random time between 10s and 3min`);
  console.log(`========================================\n`);

  // Set leverage ONCE at the beginning for both accounts
  console.log(`\n🔧 Setting leverage for both accounts...`);
  const leveragePromises = [
    setLeverage(page1, TRADE_CONFIG.leverage),
    setLeverage(page2, TRADE_CONFIG.leverage)
  ];

  const leverageResults = await Promise.all(leveragePromises);

  if (leverageResults[0].success) {
    console.log(`✓ [${email1}] Leverage set to ${TRADE_CONFIG.leverage}x`);
  } else {
    console.log(`⚠ [${email1}] Failed to set leverage: ${leverageResults[0].error}`);
  }

  if (leverageResults[1].success) {
    console.log(`✓ [${email2}] Leverage set to ${TRADE_CONFIG.leverage}x`);
  } else {
    console.log(`⚠ [${email2}] Failed to set leverage: ${leverageResults[1].error}`);
  }

  console.log(`\n✓ Leverage configured. Starting trading cycles...\n`);
  await delay(2000);

  while (!isShuttingDown) {
    cycleCount++;
    console.log(`\n>>> CYCLE ${cycleCount} - ${new Date().toLocaleTimeString()}`);

    try {
      // Step 0: Close any existing positions FIRST
      console.log(`\n[CYCLE ${cycleCount}] Checking for existing positions...`);
      const initialClosePromises = [
        closeAllPositions(page1, 100),
        closeAllPositions(page2, 100)
      ];

      const initialCloseResults = await Promise.all(initialClosePromises);

      if (initialCloseResults[0].success) {
        console.log(`✓ [${email1}] Existing positions checked/closed`);
      }
      if (initialCloseResults[1].success) {
        console.log(`✓ [${email2}] Existing positions checked/closed`);
      }

      // Small delay to ensure positions are fully closed
      await delay(2000);

      // Step 1: Execute trades in parallel with limit orders at market price
      console.log(`\n[CYCLE ${cycleCount}] Opening new positions...`);
      const tradePromises = [
        executeTrade(page1, {
          side: 'buy',
          orderType: 'limit',
          qty: TRADE_CONFIG.buyQty
          // Leverage already set at the beginning, price will be fetched automatically
        }),
        executeTrade(page2, {
          side: 'sell',
          orderType: 'limit',
          qty: TRADE_CONFIG.sellQty
          // Leverage already set at the beginning, price will be fetched automatically
        })
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
        console.log(`\n✗ [CYCLE ${cycleCount}] One or both trades failed. Skipping wait and retrying in 5 seconds...`);
        await delay(5000);
        continue; // Skip to next cycle
      }

      console.log(`\n✓ [CYCLE ${cycleCount}] Both trades executed successfully!`);

      // Step 2: Wait for random time between 10 seconds and 3 minutes (only after both trades succeed)
      const minWaitTime = 10000; // 10 seconds
      const maxWaitTime = 180000; // 3 minutes
      const randomWaitTime = Math.floor(Math.random() * (maxWaitTime - minWaitTime + 1)) + minWaitTime;

      console.log(`\n[CYCLE ${cycleCount}] Waiting ${randomWaitTime / 1000} seconds before closing...`);

      // Break wait into smaller chunks to allow faster shutdown
      const checkInterval = 1000; // Check every second
      for (let i = 0; i < randomWaitTime / checkInterval; i++) {
        if (isShuttingDown) {
          console.log(`\n[CYCLE ${cycleCount}] Shutdown detected during wait period`);
          break;
        }
        await delay(checkInterval);

        // Show countdown every 10 seconds
        const remaining = randomWaitTime - (i + 1) * checkInterval;
        if (remaining > 0 && remaining % 10000 === 0) {
          console.log(`[CYCLE ${cycleCount}] ${remaining / 1000}s remaining...`);
        }
      }

      if (isShuttingDown) {
        console.log(`[CYCLE ${cycleCount}] Breaking loop due to shutdown`);
        break;
      }

      // Step 3: Close positions in parallel
      console.log(`\n[CYCLE ${cycleCount}] Closing positions...`);
      const closePromises = [
        closeAllPositions(page1, 100),
        closeAllPositions(page2, 100)
      ];

      const closeResults = await Promise.all(closePromises);

      const close1Success = closeResults[0].success;
      const close2Success = closeResults[1].success;

      if (close1Success) {
        console.log(`✓ [${email1}] Position closed successfully`);
      } else {
        console.log(`✗ [${email1}] Close failed: ${closeResults[0].error || closeResults[0].message}`);
      }

      if (close2Success) {
        console.log(`✓ [${email2}] Position closed successfully`);
      } else {
        console.log(`✗ [${email2}] Close failed: ${closeResults[1].error || closeResults[1].message}`);
      }

      // Check if both positions closed successfully
      if (close1Success && close2Success) {
        console.log(`\n✓ [CYCLE ${cycleCount}] Completed successfully at ${new Date().toLocaleTimeString()}`);
      } else {
        console.log(`\n⚠ [CYCLE ${cycleCount}] Completed with some errors at ${new Date().toLocaleTimeString()}`);
      }

      // Small delay before next cycle
      if (!isShuttingDown) {
        console.log(`\nStarting next cycle in 3 seconds...`);
        await delay(3000);
      }

    } catch (error) {
      console.error(`\n✗ [CYCLE ${cycleCount}] Error:`, error.message);
      console.log(`Waiting 5 seconds before retry...`);
      await delay(5000);
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
          console.log(`✗ [${result.email}] ${closeResult.error || closeResult.message}`);
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
  console.log(`Starting Paradex Multi-Account Bot`);
  console.log(`Headless mode: ${HEADLESS}`);
  console.log(`Number of accounts: ${ACCOUNTS.length}`);
  console.log(`Referral code: instantcrypto (auto-applied for new accounts)`);
  console.log(`========================================\n`);
  console.log(`💡 Tip: If you changed account emails, old cookies will be auto-deleted.`);
  console.log(`    You can also manually delete paradex-cookies-*.json files to reset.\n`);

  // Launch all accounts in parallel
  const accountPromises = ACCOUNTS.map(account => launchAccount(account));
  const results = await Promise.all(accountPromises);

  // Summary
  console.log(`\n========================================`);
  console.log(`Launch Summary:`);
  console.log(`========================================`);

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  successful.forEach(r => {
    const account = ACCOUNTS.find(a => a.email === r.email);
    console.log(`✓ ${r.email} - API on port ${account.apiPort}`);
  });

  failed.forEach(r => {
    console.log(`✗ ${r.email} - Failed to login`);
  });

  console.log(`\nTotal: ${successful.length} successful, ${failed.length} failed`);
  console.log(`========================================\n`);

  if (successful.length === 0) {
    console.log("No accounts logged in successfully. Exiting...");
    process.exit(1);
  }

  // Ensure we have exactly 2 accounts for the trading strategy
  if (successful.length !== 2) {
    console.log(`\n⚠️  Warning: Trading loop requires exactly 2 accounts.`);
    console.log(`Currently ${successful.length} accounts logged in.`);
    console.log(`Bot will run API servers but won't start automated trading.\n`);
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

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  // Start automated trading loop
  console.log(`\n🤖 Starting automated trading in 5 seconds...`);
  await delay(5000);

  // Start the trading loop with both accounts
  automatedTradingLoop(successful[0], successful[1]).catch(error => {
    console.error(`Trading loop error:`, error);
  });
}

main().catch(console.error);
