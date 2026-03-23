import puppeteer from 'puppeteer-extra';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay, closeNotifyBarWrapperNotifications } from '../utils/helpers.js';
import { loadCookies, saveCookies, hasExtendedExchangeCookies } from '../utils/cookies.js';
import { isLoggedIn, login } from '../auth/login.js';
import { clickOrdersTab } from '../ui/tabs.js';
import { startApiServer } from '../api/server.js';
import { HEADLESS } from '../config/headless.js';

/**
 * Find a usable Chrome/Chromium executable.
 * Priority: Puppeteer cache → System Chrome → null (let Puppeteer decide)
 */
function findChromePath() {
  const isPackaged = process.env.ELECTRON_MODE === '1';
  if (!isPackaged) return undefined; // Dev mode — Puppeteer handles it

  // 1. Check Puppeteer cache (~/.cache/puppeteer/chrome/...)
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const cacheDir = path.join(homeDir, '.cache', 'puppeteer', 'chrome');
    try {
      if (fs.existsSync(cacheDir)) {
        const versions = fs.readdirSync(cacheDir).sort().reverse(); // newest first
        for (const ver of versions) {
          // macOS
          const macPath = path.join(cacheDir, ver, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
          if (fs.existsSync(macPath)) {
            console.log(`[Chrome] Using Puppeteer cached Chrome: ${macPath}`);
            return macPath;
          }
          // Windows
          const winPath = path.join(cacheDir, ver, 'chrome-win64', 'chrome.exe');
          if (fs.existsSync(winPath)) {
            console.log(`[Chrome] Using Puppeteer cached Chrome: ${winPath}`);
            return winPath;
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 2. System Chrome
  const systemPaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',                    // macOS
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',                       // Windows
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',                // Windows x86
    '/usr/bin/google-chrome',                                                           // Linux
    '/usr/bin/google-chrome-stable',                                                    // Linux
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) {
      console.log(`[Chrome] Using system Chrome: ${p}`);
      return p;
    }
  }

  // No Chrome found anywhere
  const err = new Error('CHROME_NOT_FOUND');
  err.code = 'CHROME_NOT_FOUND';
  throw err;
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
  
      // Remove stale lock file from previous crashed sessions
      const lockFile = path.join(profileDir, 'SingletonLock');
      if (fs.existsSync(lockFile)) {
        console.log(`[${email}] Removing stale browser lock: ${lockFile}`);
        try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
      }

      const chromePath = findChromePath();
      const browser = await puppeteer.launch({
        headless: HEADLESS,
        ...(chromePath ? { executablePath: chromePath } : {}),
        userDataDir: profileDir,
        args: [
          "--start-maximized",
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--window-size=1920,1080",
          "--disable-backgrounding-occluded-windows",  // Prevent throttling when window is behind others
          "--disable-renderer-backgrounding",           // Prevent throttling background tab rendering
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
            `[${email}] Loaded with referral link: ${exchange.referralUrl}`
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
  
      // For GRVT: Close any NotifyBarWrapper notifications immediately after page load
      await delay(2000); // Wait for notifications to appear
      await closeNotifyBarWrapperNotifications(page, exchange, 'on initial page load');
  
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
            
            // For GRVT: Close any NotifyBarWrapper notifications after navigation
            await delay(2000);
            await closeNotifyBarWrapperNotifications(page, exchange, 'after navigation');
          } catch (error) {
            console.log(`[${email}] Navigation error, continuing...`);
          }
        }

        // For GRVT: Close any NotifyBarWrapper notifications on page load
        await delay(2000); // Wait for notifications to appear
        await closeNotifyBarWrapperNotifications(page, exchange, 'on page load');

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

      // For Kraken: navigation can destroy context due to redirects — retry with fresh page
      if (error.message.includes('Execution context was destroyed') || error.message.includes('navigation')) {
        try {
          console.log(`[${email}] Retrying with fresh page after navigation error...`);
          const pages = await browser.pages();
          const activePage = pages[pages.length - 1] || await browser.newPage();
          await activePage.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          );
          await delay(3000);

          // Navigate to the exchange URL
          try {
            await activePage.goto(exchange.url, { waitUntil: "domcontentloaded", timeout: 60000 });
          } catch (navErr) {
            console.log(`[${email}] Page load timeout on retry, continuing...`);
          }
          await delay(5000);

          // Check if already logged in (Kraken may have session)
          const loggedIn = await isLoggedIn(activePage, exchange);
          if (loggedIn) {
            console.log(`[${email}] *** Successfully logged in to ${exchange.name} on retry! ***`);
            startApiServer(activePage, apiPort, email);
            return { browser, page: activePage, email, success: true, exchange: exchange.name };
          }

          // Not logged in — attempt login with wait
          console.log(`[${email}] Not logged in, starting login process...`);
          await login(activePage, browser, email, cookiesPath, true, exchange);
          await delay(3000);
          const loggedInAfterLogin = await isLoggedIn(activePage, exchange);
          if (loggedInAfterLogin) {
            console.log(`[${email}] *** Successfully logged in to ${exchange.name} after login flow! ***`);
            await saveCookies(activePage, cookiesPath, email);
            startApiServer(activePage, apiPort, email);
            return { browser, page: activePage, email, success: true, exchange: exchange.name };
          }

          console.log(`[${email}] Login failed on retry. Keeping browser open for manual login.`);
          return { browser, page: activePage, email, success: false, exchange: exchange.name, keepBrowserOpen: true };
        } catch (retryError) {
          console.error(`[${email}] Retry also failed:`, retryError.message);
        }
      }

      return { email, success: false, error: error.message };
    }
  }

  export { launchAccount };