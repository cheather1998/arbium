import { app, BrowserWindow, ipcMain, shell, session } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { fork } from 'child_process';
import { checkForUpdates } from './updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

let mainWindow = null;
let botProcess = null;
let verifyWindows = {}; // { kraken: BrowserWindow, grvt: BrowserWindow }
let verifyTimers = {};  // { kraken: interval, grvt: interval }

const isDev = !app.isPackaged;

// In packaged mode, .env and cookies must be in a writable directory
// (app.asar is read-only). Use app.getPath('userData') as the data dir.
const DATA_DIR = isDev ? ROOT_DIR : app.getPath('userData');

// On first run of packaged app, copy .env from asar to userData if not exists
function ensureDataFiles() {
  if (isDev) return;
  const userEnv = path.join(DATA_DIR, '.env');
  if (!fs.existsSync(userEnv)) {
    // Copy default .env from the asar bundle
    const bundledEnv = path.join(ROOT_DIR, '.env');
    try {
      const content = fs.readFileSync(bundledEnv, 'utf-8');
      fs.writeFileSync(userEnv, content);
      console.log('[Data] Copied default .env to', userEnv);
    } catch (err) {
      console.error('[Data] Failed to copy .env:', err.message);
    }
  }
}

const EXCHANGE_URLS = {
  kraken: {
    name: 'Kraken',
    loginUrl: 'https://pro.kraken.com/app/trade/futures-btc-usd-perp',
  },
  grvt: {
    name: 'GRVT',
    loginUrl: 'https://grvt.io/exchange/perpetual/BTC-USDT',
  },
};

function createWindow() {
  ensureDataFiles();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Arbium',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(ROOT_DIR, 'ui', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopBot();
    closeAllVerifyWindows();
  });
}

// --- Bot Process Management ---

function startBot(mode, config) {
  if (botProcess) {
    sendToUI('bot:log', { type: 'warn', message: 'Bot is already running.' });
    return;
  }

  const botScript = path.join(ROOT_DIR, 'src', 'bot-process.js');

  botProcess = fork(botScript, [], {
    cwd: DATA_DIR,
    env: { ...process.env, ELECTRON_MODE: '1', DOTENV_CONFIG_PATH: path.join(DATA_DIR, '.env') },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  botProcess.stdout.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach((line) => {
      sendToUI('bot:log', { type: 'info', message: line });
    });
  });

  botProcess.stderr.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach((line) => {
      sendToUI('bot:log', { type: 'error', message: line });
    });
  });

  botProcess.on('message', (msg) => {
    if (msg.type === 'status') sendToUI('bot:status', msg.data);
    else if (msg.type === 'log') sendToUI('bot:log', { type: msg.level || 'info', message: msg.message });
    else if (msg.type === 'stopped') { sendToUI('bot:stopped', {}); botProcess = null; }
  });

  botProcess.on('exit', (code) => {
    sendToUI('bot:log', { type: 'info', message: `Bot process exited with code ${code}` });
    sendToUI('bot:stopped', {});
    botProcess = null;
  });

  botProcess.on('error', (err) => {
    sendToUI('bot:log', { type: 'error', message: `Bot process error: ${err.message}` });
    sendToUI('bot:stopped', {});
    botProcess = null;
  });

  botProcess.send({ type: 'start', mode, config });
  sendToUI('bot:started', { mode });
}

function stopBot() {
  if (botProcess) {
    botProcess.send({ type: 'stop' });
    setTimeout(() => {
      if (botProcess) { botProcess.kill('SIGKILL'); botProcess = null; }
    }, 10000);
  }
}

function sendToUI(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// --- Account Verification via Electron BrowserWindow ---

function closeAllVerifyWindows() {
  for (const exchange of Object.keys(verifyWindows)) {
    cancelVerification(exchange);
  }
}

/**
 * Login detection scripts — mirrors the logic in src/auth/login.js isLoggedIn()
 * For Kraken & GRVT: checks for trading interface elements (buy/sell/market/limit/order/position)
 * and trading buttons. This is the same approach the bot uses at runtime.
 */
const LOGIN_DETECT_SCRIPTS = {
  // Mirrors isLoggedIn() for Kraken (lines 39-73 of login.js)
  kraken: `(function() {
    try {
      var text = document.body ? document.body.innerText.toLowerCase() : '';
      var hasTradingElements =
        text.includes('buy') ||
        text.includes('sell') ||
        text.includes('market') ||
        text.includes('limit') ||
        text.includes('order') ||
        text.includes('position');
      var hasPriceElements = document.querySelectorAll('[class*="price"], [class*="ticker"]').length > 0;
      var hasTradingButtons = Array.from(document.querySelectorAll('button')).some(function(btn) {
        var btnText = (btn.textContent || '').trim().toLowerCase();
        return btnText === 'buy' || btnText === 'sell' || btnText === 'long' || btnText === 'short';
      });
      // Kraken-specific: check if the user has an active session
      // When NOT logged in on Kraken Futures, there's a "Sign In" or "Create Account" prompt
      var hasSignInPrompt = Array.from(document.querySelectorAll('button, a')).some(function(el) {
        var t = (el.textContent || '').trim();
        return t === 'Sign In' || t === 'Create Account' || t === 'Log In';
      });
      // Must have trading interface AND no sign-in prompt
      return (hasTradingElements || hasPriceElements || hasTradingButtons) && !hasSignInPrompt;
    } catch(e) { return false; }
  })()`,

  // Mirrors isLoggedIn() for GRVT (lines 39-73 of login.js)
  grvt: `(function() {
    try {
      var text = document.body ? document.body.innerText.toLowerCase() : '';
      var hasTradingElements =
        text.includes('buy') ||
        text.includes('sell') ||
        text.includes('market') ||
        text.includes('limit') ||
        text.includes('order') ||
        text.includes('position');
      var hasTradingButtons = Array.from(document.querySelectorAll('button')).some(function(btn) {
        var btnText = (btn.textContent || '').trim().toLowerCase();
        return btnText === 'buy' || btnText === 'sell' || btnText === 'long' || btnText === 'short' ||
               btnText === 'buy / long' || btnText === 'sell / short';
      });
      // GRVT-specific: when not logged in, there's typically a "Connect" or "Sign In" button
      var hasConnectPrompt = Array.from(document.querySelectorAll('button, a')).some(function(el) {
        var t = (el.textContent || '').trim();
        return t === 'Connect' || t === 'Sign In' || t === 'Log In' || t === 'Get Started' || t === 'Connect Wallet';
      });
      return (hasTradingElements || hasTradingButtons) && !hasConnectPrompt;
    } catch(e) { return false; }
  })()`,
};

function startVerification(exchange, email) {
  cancelVerification(exchange);

  const exchangeInfo = EXCHANGE_URLS[exchange];
  if (!exchangeInfo) {
    sendToUI('verify:result', { exchange, success: false, error: `Unknown exchange: ${exchange}` });
    return;
  }

  sendToUI('verify:status', { exchange, step: 'launching', message: `Opening ${exchangeInfo.name} login page...` });

  const partition = `persist:verify-${exchange}`;

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: `Log in to ${exchangeInfo.name} — ${email}`,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  verifyWindows[exchange] = win;
  win.loadURL(exchangeInfo.loginUrl);

  sendToUI('verify:status', { exchange, step: 'waiting_login', message: `Please log in to ${exchangeInfo.name} in the browser window...` });

  const detectScript = LOGIN_DETECT_SCRIPTS[exchange] || LOGIN_DETECT_SCRIPTS.kraken;
  let pollCount = 0;
  const pollInterval = 1500;  // Check every 1.5 seconds (fast)
  const maxPolls = 200;       // 5 minutes (200 * 1.5s)
  let checking = false;       // Prevent overlapping checks

  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    pollCount++;

    try {
      // Check if window was closed
      if (!verifyWindows[exchange] || win.isDestroyed()) {
        clearInterval(timer);
        delete verifyTimers[exchange];
        delete verifyWindows[exchange];
        sendToUI('verify:result', { exchange, success: false, error: 'Login window was closed.' });
        return;
      }

      // Run exchange-specific detection
      const isLoggedIn = await win.webContents.executeJavaScript(detectScript);

      if (isLoggedIn) {
        clearInterval(timer);
        delete verifyTimers[exchange];

        sendToUI('verify:status', { exchange, step: 'saving', message: 'Login detected! Saving session...' });

        // Extract and save cookies
        const ses = session.fromPartition(partition);
        const cookies = await ses.cookies.get({});

        const puppeteerCookies = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: c.expirationDate || -1,
          httpOnly: c.httpOnly || false,
          secure: c.secure || false,
          sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'lax' ? 'Lax' : 'Strict'),
        }));

        const accountIndex = exchange === 'kraken' ? 1 : 2;
        const cookiesPath = path.join(DATA_DIR, `paradex-cookies-account${accountIndex}.json`);
        const metadataPath = cookiesPath.replace('.json', '-metadata.json');

        fs.writeFileSync(cookiesPath, JSON.stringify(puppeteerCookies, null, 2));
        fs.writeFileSync(metadataPath, JSON.stringify({ email, lastUpdated: new Date().toISOString() }, null, 2));

        sendToUI('verify:result', { exchange, success: true, email });

        setTimeout(() => {
          if (!win.isDestroyed()) win.close();
          delete verifyWindows[exchange];
        }, 1500);
        return;
      }

      // Periodic status update every ~10s
      if (pollCount % 7 === 0) {
        const elapsed = Math.round(pollCount * pollInterval / 1000);
        sendToUI('verify:status', {
          exchange,
          step: 'waiting_login',
          message: `Waiting for ${exchangeInfo.name} login... (${elapsed}s)`,
        });
      }

      // Timeout
      if (pollCount >= maxPolls) {
        clearInterval(timer);
        delete verifyTimers[exchange];
        if (!win.isDestroyed()) win.close();
        delete verifyWindows[exchange];
        sendToUI('verify:result', { exchange, success: false, error: 'Verification timed out. Please try again.' });
      }
    } catch {
      // Page navigating, ignore
    } finally {
      checking = false;
    }
  }, pollInterval);

  verifyTimers[exchange] = timer;

  // Also detect via URL changes (fast signal)
  win.webContents.on('did-navigate-in-page', () => {
    // Trigger an immediate check on SPA navigation
    pollCount = Math.max(0, pollCount - 1);
  });

  win.on('closed', () => {
    if (verifyTimers[exchange]) {
      clearInterval(verifyTimers[exchange]);
      delete verifyTimers[exchange];
    }
    if (verifyWindows[exchange]) {
      delete verifyWindows[exchange];
      sendToUI('verify:result', { exchange, success: false, error: 'Login window was closed.' });
    }
  });
}

function cancelVerification(exchange) {
  if (verifyTimers[exchange]) {
    clearInterval(verifyTimers[exchange]);
    delete verifyTimers[exchange];
  }
  if (verifyWindows[exchange] && !verifyWindows[exchange].isDestroyed()) {
    verifyWindows[exchange].close();
  }
  delete verifyWindows[exchange];
}

function checkCookiesExist(exchange, email) {
  const index = exchange === 'kraken' ? 1 : 2;
  const cookiesPath = path.join(DATA_DIR, `paradex-cookies-account${index}.json`);
  const metadataPath = cookiesPath.replace('.json', '-metadata.json');

  if (fs.existsSync(cookiesPath) && fs.existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      if (metadata.email !== email) return { hasCookies: false, savedEmail: metadata.email };

      // Validate cookies are real session cookies (not empty or expired)
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
      if (!Array.isArray(cookies) || cookies.length === 0) {
        return { hasCookies: false, savedEmail: email };
      }

      // Check if cookies contain session/auth tokens (not just tracking cookies)
      const hasSessionCookie = cookies.some((c) => {
        const name = (c.name || '').toLowerCase();
        return name.includes('session') || name.includes('token') || name.includes('auth')
          || name.includes('sid') || name.includes('login') || name.includes('jwt');
      });
      if (!hasSessionCookie) {
        return { hasCookies: false, savedEmail: email };
      }

      // Check cookies are not older than 24 hours
      const lastUpdated = new Date(metadata.lastUpdated || 0);
      const ageMs = Date.now() - lastUpdated.getTime();
      const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
      if (ageMs > maxAgeMs) {
        return { hasCookies: false, savedEmail: email, expired: true };
      }

      return { hasCookies: true, savedEmail: email };
    } catch {
      return { hasCookies: false, savedEmail: null };
    }
  }
  return { hasCookies: false, savedEmail: null };
}

// --- IPC Handlers ---

ipcMain.handle('bot:start', (_event, { mode, config }) => {
  startBot(mode, config);
  return { success: true };
});

ipcMain.handle('bot:stop', () => {
  stopBot();
  return { success: true };
});

ipcMain.handle('bot:isRunning', () => {
  return { running: botProcess !== null };
});

// Account verification
ipcMain.handle('verify:start', (_event, { exchange, email }) => {
  startVerification(exchange, email);
  return { success: true };
});

ipcMain.handle('verify:cancel', (_event, { exchange }) => {
  cancelVerification(exchange);
  return { success: true };
});

ipcMain.handle('verify:checkCookies', (_event, { exchange, email }) => {
  return checkCookiesExist(exchange, email);
});

// Config: read .env
ipcMain.handle('config:read', () => {
  const envPath = path.join(DATA_DIR, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const config = {};
    content.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim();
          let value = trimmed.substring(eqIdx + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          config[key] = value;
        }
      }
    });
    return { success: true, config };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Config: save .env
ipcMain.handle('config:save', (_event, config) => {
  const envPath = path.join(DATA_DIR, '.env');
  try {
    const lines = Object.entries(config).map(([key, value]) => {
      if (typeof value === 'string' && (value.includes(' ') || value.includes(',') || value.includes(':'))) {
        return `${key}="${value}"`;
      }
      return `${key}=${value}`;
    });
    fs.writeFileSync(envPath, lines.join('\n') + '\n');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Update check
ipcMain.handle('update:check', async () => {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return await checkForUpdates(pkg.version);
});

// Open external URL
ipcMain.handle('shell:openExternal', (_event, url) => {
  shell.openExternal(url);
});

// Get app version
ipcMain.handle('app:version', () => {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
});

// --- App Lifecycle ---

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopBot();
  closeAllVerifyWindows();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
