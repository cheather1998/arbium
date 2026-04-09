import puppeteer from 'puppeteer-extra';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay, closeNotifyBarWrapperNotifications } from '../utils/helpers.js';
import { loadCookies, hasExtendedExchangeCookies } from '../utils/cookies.js';
import { isLoggedIn, login } from '../auth/login.js';
import { clickOrdersTab } from '../ui/tabs.js';
import { startApiServer } from '../api/server.js';
import { HEADLESS } from '../config/headless.js';

/**
 * Find a usable Chrome/Chromium executable on the system.
 * Required when running inside packaged Electron (no bundled Puppeteer Chrome).
 */
function findSystemChrome() {
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try `which` on unix
  try {
    const result = execSync('which google-chrome || which chromium || which chrome 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch { /* ignore */ }
  return null;
}

// Determine if we need a system Chrome (packaged Electron mode)
function getChromePath() {
  // If ELECTRON_MODE is set, we're running inside Electron's packaged app
  // Puppeteer's bundled Chrome won't be accessible inside the asar
  if (process.env.ELECTRON_MODE === '1') {
    const systemChrome = findSystemChrome();
    if (systemChrome) {
      console.log(`[Chrome] Using system Chrome: ${systemChrome}`);
      return systemChrome;
    }
    console.warn('[Chrome] No system Chrome found! Puppeteer may fail to launch.');
    return undefined;
  }
  // In dev/CLI mode, let Puppeteer use its own bundled Chrome
  return undefined;
}

async function launchAccount(accountConfig, exchangeConfig, _isRetry = false) {
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
  
      // Kill any existing Chrome process using this profile directory
      try {
        const { execSync } = await import('child_process');
        // Find and kill Chrome processes using this specific profile
        const profileBase = path.basename(profileDir);
        try {
          execSync(`pkill -f "${profileBase}" 2>/dev/null`, { timeout: 3000 });
          console.log(`[${email}] Killed stale Chrome process for profile ${profileBase}`);
          await delay(1000);
        } catch {
          // No matching process found — that's fine
        }
        // Also remove the SingletonLock file that prevents reuse
        const lockFile = path.join(profileDir, 'SingletonLock');
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
          console.log(`[${email}] Removed stale SingletonLock`);
        }
      } catch {
        // Ignore cleanup errors
      }

      const chromePath = getChromePath();
      const launchOptions = {
        headless: HEADLESS,
        userDataDir: profileDir,
        args: [
          "--start-maximized",
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--window-size=1920,1080",
        ],
        defaultViewport: HEADLESS ? { width: 1920, height: 1080 } : null,
        protocolTimeout: 180000,
      };
      if (chromePath) {
        launchOptions.executablePath = chromePath;
      }
      const browser = await puppeteer.launch(launchOptions);
  
      let page = await browser.newPage();
  
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
      // For Kraken: always go to home page first — Futures URL redirects to sign-in
      // with repeated refreshes when not logged in. Navigate to Futures AFTER login.
      const targetUrl = isNewAccount ? exchange.referralUrl
        : (exchange.name === 'Kraken' ? 'https://pro.kraken.com/app/home' : exchange.url);
  
      // Retry navigation up to 3 times to handle "Execution context was destroyed" errors
      let navSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
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
          navSuccess = true;
          break;
        } catch (error) {
          const isContextDestroyed = error.message.includes('Execution context was destroyed') ||
            error.message.includes('most likely because of a navigation');
          if (isContextDestroyed && attempt < 3) {
            console.log(`[${email}] Navigation interrupted (attempt ${attempt}/3), retrying in 3s...`);
            await delay(3000);
            // Page might have navigated — try to get a fresh page reference
            const pages = await browser.pages();
            if (pages.length > 0) {
              // Use the last page (most recent)
              const freshPage = pages[pages.length - 1];
              if (freshPage !== page) {
                page = freshPage;
                page.setDefaultNavigationTimeout(60000);
                page.setDefaultTimeout(120000);
              }
            }
          } else {
            console.log(`[${email}] Page load failed after ${attempt} attempt(s), attempting to continue...`);
            break;
          }
        }
      }
  
      // If cookies were loaded, reload the page to ensure cookies are applied
      // SKIP reload for Kraken — expired cookies + reload causes infinite redirect loop
      if (hasExistingCookies && exchange.name !== 'Kraken') {
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
  
      // Verify the page URL matches the expected exchange URL
      // SKIP this check entirely for Kraken — Kraken redirects Futures URL to sign-in page
      // when not logged in (even with expired cookies), causing repeated refresh.
      // Futures navigation is handled AFTER login is confirmed (line ~337).
      if (exchange.url && exchange.name !== 'Kraken') {
        const currentUrl = page.url();
        const expectedUrl = exchange.url;
        if (!currentUrl.includes(new URL(expectedUrl).pathname)) {
          console.log(`[${email}] ⚠ Page redirected to wrong URL: ${currentUrl}`);
          console.log(`[${email}] Expected: ${expectedUrl}`);
          console.log(`[${email}] Forcing navigation to correct page...`);
          try {
            await page.goto(expectedUrl, {
              waitUntil: "domcontentloaded",
              timeout: 30000,
            });
            await delay(3000);
            console.log(`[${email}] ✅ Redirected to correct page: ${page.url()}`);
          } catch (error) {
            console.log(`[${email}] ⚠ Force navigation failed, continuing with current page...`);
          }
        } else {
          console.log(`[${email}] ✅ Page URL verified: ${currentUrl}`);
        }
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

        // For Kraken: ALWAYS navigate to the correct trading page after login
        // Kraken often redirects to Spot after login, and may redirect back even after navigation
        if (exchange.name === 'Kraken') {
          const tradingUrl = exchange.url; // Futures or Margin URL from exchange config
          const urlCheck = tradingUrl.includes('margin') ? 'margin' : 'futures';
          const pageLabel = tradingUrl.includes('margin') ? 'Margin' : 'Futures';

          // Try up to 5 times — Kraken may redirect back to Spot
          for (let attempt = 1; attempt <= 5; attempt++) {
            const currentUrl = page.url();
            if (currentUrl.includes(urlCheck)) {
              console.log(`[${email}] ✅ Kraken is on ${pageLabel} page: ${currentUrl}`);
              break;
            }
            console.log(`[${email}] Kraken not on ${pageLabel} (attempt ${attempt}/5): ${currentUrl}`);
            console.log(`[${email}] Navigating to ${pageLabel}...`);
            try {
              // Use domcontentloaded — networkidle2 times out on Kraken
              await page.goto(tradingUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            } catch (e) {
              console.log(`[${email}] Navigation timeout, checking URL anyway...`);
            }
            // Wait for page to settle and check URL
            await delay(3000);
            const afterUrl = page.url();
            if (afterUrl.includes(urlCheck)) {
              console.log(`[${email}] ✅ Kraken ${pageLabel} confirmed: ${afterUrl}`);
              break;
            } else {
              console.log(`[${email}] ⚠ Kraken redirected back to: ${afterUrl}`);
              // Try using JavaScript navigation as fallback
              if (attempt >= 2) {
                console.log(`[${email}] Trying JavaScript navigation...`);
                try {
                  await page.evaluate((url) => { window.location.href = url; }, tradingUrl);
                  await delay(5000);
                } catch (e) { /* ignore */ }
              }
            }
          }
        }

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

        // Final URL check for Kraken — ensure we're on Futures, not Spot
        if (exchange.name === 'Kraken') {
          const finalUrl = page.url();
          if (!finalUrl.includes('futures')) {
            console.log(`[${email}] ⚠ Kraken is on Spot page (${finalUrl}), forcing Futures via JS...`);
            try {
              await page.evaluate((url) => { window.location.href = url; }, exchange.url);
              await delay(5000);
              console.log(`[${email}] ✅ Navigated to Kraken Futures: ${page.url()}`);
            } catch (e) {
              console.log(`[${email}] ⚠ Futures navigation failed: ${e.message}`);
            }
          }
        }

        // Start the API server for this account
        startApiServer(page, apiPort, email);

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
      const msg = error.message || '';
      const isRecoverable = msg.includes('Execution context was destroyed') ||
        msg.includes('most likely because of a navigation') || msg.includes('Target closed');

      if (isRecoverable && !_isRetry) {
        console.log(`\n⚠ [${email}] Recoverable error during launch: ${msg}`);
        console.log(`[${email}] Retrying account launch in 5 seconds...`);
        await delay(5000);
        try {
          // Close old browser if still alive
          try { await browser?.close(); } catch {}
          // Retry once (pass _isRetry=true to prevent infinite recursion)
          return await launchAccount(accountConfig, exchangeConfig, true);
        } catch (retryError) {
          console.error(`\n✗ [${email}] Retry also failed:`, retryError.message);
          return { email, success: false, error: retryError.message };
        }
      }

      console.error(`\n✗ [${email}] Error during account launch:`, msg);
      return { email, success: false, error: msg };
    }
  }

  export { launchAccount };