/**
 * Account verification subprocess.
 * Launched by Electron main process to verify exchange accounts.
 * Opens a real browser, navigates to the exchange, and waits for the user to log in.
 * Reports verification status back via IPC messages.
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

const EXCHANGE_URLS = {
  kraken: {
    name: 'Kraken',
    url: 'https://pro.kraken.com/app/trade/futures-btc-usd-perp',
    urlPattern: 'pro.kraken.com/app/trade',
  },
  grvt: {
    name: 'GRVT',
    url: 'https://grvt.io/exchange/perpetual/BTC-USDT',
    urlPattern: 'grvt.io/exchange',
  },
};

function send(type, data) {
  if (process.send) {
    process.send({ type, ...data });
  }
}

function getCookiesPath(exchange, email) {
  const index = exchange === 'kraken' ? 1 : 2;
  return path.join(ROOT_DIR, `paradex-cookies-account${index}.json`);
}

function getMetadataPath(cookiesPath) {
  return cookiesPath.replace('.json', '-metadata.json');
}

function getProfileDir(exchange, email) {
  const index = exchange === 'kraken' ? 1 : 2;
  const emailHash = Buffer.from(email).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
  return `/tmp/puppeteer-chrome-profile-${index}-${emailHash}`;
}

async function checkLoginStatus(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasTradingElements =
        text.includes('buy') ||
        text.includes('sell') ||
        text.includes('market') ||
        text.includes('limit') ||
        text.includes('order') ||
        text.includes('position');

      const hasTradingButtons = Array.from(document.querySelectorAll('button')).some(
        (btn) => {
          const btnText = btn.textContent?.trim().toLowerCase();
          return btnText === 'buy' || btnText === 'sell' || btnText === 'long' || btnText === 'short' ||
                 btnText === 'buy / long' || btnText === 'sell / short';
        }
      );

      // Check for login/signup buttons that indicate NOT logged in
      const hasLoginBtn = Array.from(document.querySelectorAll('button, a')).some(
        (btn) => {
          const btnText = btn.textContent?.trim().toLowerCase();
          return btnText === 'sign in' || btnText === 'log in' || btnText === 'create account' || btnText === 'sign up';
        }
      );

      return (hasTradingElements || hasTradingButtons) && !hasLoginBtn;
    });
  } catch {
    return false;
  }
}

async function verifyAccount(exchangeKey, email) {
  const exchangeInfo = EXCHANGE_URLS[exchangeKey];
  if (!exchangeInfo) {
    send('error', { message: `Unknown exchange: ${exchangeKey}` });
    return;
  }

  const cookiesPath = getCookiesPath(exchangeKey, email);
  const metadataPath = getMetadataPath(cookiesPath);
  const profileDir = getProfileDir(exchangeKey, email);

  send('status', { step: 'launching', message: `Launching browser for ${exchangeInfo.name}...` });

  let browser;
  try {
    // Clean up old profile if email changed
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (metadata.email && metadata.email !== email) {
          send('status', { step: 'cleanup', message: 'Email changed, clearing old session...' });
          if (fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);
          fs.unlinkSync(metadataPath);
          if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore metadata errors
      }
    }

    browser = await puppeteer.launch({
      headless: false,
      userDataDir: profileDir,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1280,900',
      ],
      defaultViewport: null,
      protocolTimeout: 180000,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Load existing cookies
    let hasExistingCookies = false;
    if (fs.existsSync(cookiesPath)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        await page.setCookie(...cookies);
        hasExistingCookies = true;
        send('status', { step: 'cookies', message: 'Loaded saved session, checking...' });
      } catch {
        send('status', { step: 'cookies', message: 'No saved session found' });
      }
    }

    // Navigate to exchange
    send('status', { step: 'navigating', message: `Opening ${exchangeInfo.name}...` });

    try {
      await page.goto(exchangeInfo.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch {
      send('status', { step: 'navigating', message: 'Page load slow, continuing...' });
    }

    // Wait for page to settle
    await new Promise((r) => setTimeout(r, 5000));

    // Check if already logged in with cookies
    let loggedIn = false;
    if (hasExistingCookies) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 5000));

      for (let i = 0; i < 5; i++) {
        loggedIn = await checkLoginStatus(page);
        if (loggedIn) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (loggedIn) {
      // Already logged in from cookies
      send('status', { step: 'verified', message: `${exchangeInfo.name} account verified!` });

      // Save fresh cookies
      const cookies = await page.cookies();
      fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
      fs.writeFileSync(metadataPath, JSON.stringify({ email, lastUpdated: new Date().toISOString() }, null, 2));

      send('verified', { exchange: exchangeKey, email, success: true });

      // Close browser after short delay
      await new Promise((r) => setTimeout(r, 2000));
      await browser.close();
      return;
    }

    // Not logged in - prompt user to log in manually
    send('status', {
      step: 'waiting_login',
      message: `Please log in to ${exchangeInfo.name} in the browser window...`,
    });

    // Poll for login (up to 5 minutes)
    const maxWaitMs = 5 * 60 * 1000;
    const pollIntervalMs = 3000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      // Check if browser is still open
      try {
        const pages = await browser.pages();
        if (pages.length === 0) {
          send('error', { message: 'Browser window was closed' });
          return;
        }
      } catch {
        send('error', { message: 'Browser was closed' });
        return;
      }

      loggedIn = await checkLoginStatus(page);

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (loggedIn) {
        send('status', { step: 'verified', message: `Login detected! Saving session...` });

        // Save cookies
        const cookies = await page.cookies();
        fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
        fs.writeFileSync(metadataPath, JSON.stringify({ email, lastUpdated: new Date().toISOString() }, null, 2));

        send('verified', { exchange: exchangeKey, email, success: true });

        // Close browser after short delay
        await new Promise((r) => setTimeout(r, 2000));
        await browser.close();
        return;
      }

      // Send periodic progress
      if (elapsed % 15 === 0 && elapsed > 0) {
        send('status', {
          step: 'waiting_login',
          message: `Waiting for ${exchangeInfo.name} login... (${elapsed}s)`,
        });
      }
    }

    // Timed out
    send('error', { message: `Verification timed out after 5 minutes. Please try again.` });
    await browser.close();
  } catch (err) {
    send('error', { message: err.message });
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

// Listen for commands from parent process
process.on('message', (msg) => {
  if (msg.type === 'verify') {
    verifyAccount(msg.exchange, msg.email);
  } else if (msg.type === 'cancel') {
    process.exit(0);
  }
});

// Check for cookies without launching browser
process.on('message', (msg) => {
  if (msg.type === 'checkCookies') {
    const cookiesPath = getCookiesPath(msg.exchange, msg.email);
    const metadataPath = getMetadataPath(cookiesPath);
    let valid = false;
    let savedEmail = null;

    if (fs.existsSync(cookiesPath) && fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        savedEmail = metadata.email;
        valid = metadata.email === msg.email;
      } catch { /* ignore */ }
    }

    send('cookieStatus', {
      exchange: msg.exchange,
      hasCookies: valid,
      savedEmail,
    });
  }
});
