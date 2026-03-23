/**
 * bot-process.js — Bridge between Electron (main.js) and the trading bot.
 *
 * Electron forks this file as a child process and communicates via IPC:
 *   parent → child:  { type: 'start', mode, config }
 *   parent → child:  { type: 'stop' }
 *   child  → parent: { type: 'log',     level, message }
 *   child  → parent: { type: 'status',  data }
 *   child  → parent: { type: 'stopped' }
 */

import dotenv from 'dotenv';
import { delay } from './utils/helpers.js';
import {
  closeAllPositionsOnShutdown,
  automatedTradingLoop,
  automatedTradingLoop3Exchanges,
  automatedTradingLoop2Exchanges,
} from './core/loop.js';
import { launchAccount } from './core/launch.js';
import EXCHANGE_CONFIGS from './config/exchanges.js';
import { ACCOUNTS } from './config/accounts.js';

// Load env from path provided by Electron (DATA_DIR/.env)
const envPath = process.env.DOTENV_CONFIG_PATH;
if (envPath) dotenv.config({ path: envPath });
else dotenv.config();

let isShuttingDown = false;
let activeBrowsers = [];

/* ---- helpers ---- */

function log(level, message) {
  if (level === 'error') process.stderr.write(message + '\n');
  else process.stdout.write(message + '\n');
  if (process.send) process.send({ type: 'log', level, message });
}

function status(data) {
  if (process.send) process.send({ type: 'status', data });
}

function stopped() {
  if (process.send) process.send({ type: 'stopped' });
}

/* ---- trading mode mapping ---- */

function resolveMode(uiMode) {
  const MODES = {
    '3': {
      mode: 3,
      description: 'All 3 Exchanges (Kraken, GRVT, Extended)',
      exchanges: ['kraken', 'grvt', 'extended'],
    },
    '3d': {
      mode: '3d',
      description: 'Kraken + GRVT',
      exchanges: ['kraken', 'grvt'],
    },
    '3e': {
      mode: '3e',
      description: 'Kraken + Extended',
      exchanges: ['kraken', 'extended'],
    },
    '3f': {
      mode: '3f',
      description: 'GRVT + Extended',
      exchanges: ['grvt', 'extended'],
    },
    '1': {
      mode: 1,
      description: 'Buy Paradex, Sell Paradex',
      buyExchange: 'paradex',
      sellExchange: 'paradex',
    },
    '2': {
      mode: 2,
      description: 'Buy Paradex, Sell Extended',
      buyExchange: 'paradex',
      sellExchange: 'extended',
    },
  };
  return MODES[String(uiMode)] || MODES['3'];
}

/* ---- main bot logic ---- */

async function runBot(mode, config) {
  const tradingMode = resolveMode(mode);

  log('info', `\n========================================`);
  log('info', `Starting Multi-Exchange Trading Bot`);
  log('info', `Mode: ${tradingMode.description}`);
  log('info', `Number of accounts: ${ACCOUNTS.length}`);
  log('info', `========================================\n`);

  status({ state: 'starting', message: 'Bot setting up…' });

  // ---------- Multi-exchange modes (3, 3d, 3e, 3f) ----------
  if ([3, '3', '3d', '3e', '3f'].includes(tradingMode.mode)) {
    const exchanges = tradingMode.exchanges;
    const exchangeCount = exchanges.length;
    const is2ExchangeMode = exchangeCount === 2;

    if (ACCOUNTS.length < exchangeCount) {
      log('error', `Error: need ${exchangeCount} accounts, only ${ACCOUNTS.length} configured.`);
      status({ state: 'error', message: `Need ${exchangeCount} accounts in .env` });
      stopped();
      return;
    }

    const accountsWithExchanges = ACCOUNTS.slice(0, exchangeCount).map((account, i) => ({
      ...account,
      exchange: exchanges[i],
      exchangeConfig: EXCHANGE_CONFIGS[exchanges[i]],
    }));

    // Launch exchanges
    status({ state: 'launching', message: 'Launching exchanges…' });

    const results = await Promise.all(
      accountsWithExchanges.map((a) => launchAccount(a, a.exchangeConfig))
    );

    activeBrowsers = results.filter((r) => r.browser).map((r) => r.browser);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    successful.forEach((r) => log('info', `✓ ${r.email} on ${r.exchange} ready`));
    failed.forEach((r) => log('warn', `✗ ${r.email} failed to login`));

    if (successful.length === 0) {
      log('error', 'No accounts logged in. Stopping.');
      status({ state: 'error', message: 'All logins failed' });
      stopped();
      return;
    }

    if (successful.length !== exchangeCount) {
      log('warn', `Only ${successful.length}/${exchangeCount} logged in — trading loop will not start.`);
      status({ state: 'error', message: `Only ${successful.length}/${exchangeCount} exchanges connected` });
      stopped();
      return;
    }

    status({ state: 'running', message: 'Running correctly' });
    log('info', '🤖 Starting automated trading loop…');

    try {
      if (is2ExchangeMode) {
        const a1 = successful.find((r) => {
          const acc = accountsWithExchanges.find((a) => a.email === r.email);
          return acc && acc.exchange === exchanges[0];
        });
        const a2 = successful.find((r) => {
          const acc = accountsWithExchanges.find((a) => a.email === r.email);
          return acc && acc.exchange === exchanges[1];
        });
        if (a1 && a2) {
          await automatedTradingLoop2Exchanges(a1, a2);
        }
      } else {
        const kraken = successful.find((r) => accountsWithExchanges.find((a) => a.email === r.email)?.exchange === 'kraken');
        const grvt = successful.find((r) => accountsWithExchanges.find((a) => a.email === r.email)?.exchange === 'grvt');
        const ext = successful.find((r) => accountsWithExchanges.find((a) => a.email === r.email)?.exchange === 'extended');
        if (kraken && grvt && ext) {
          await automatedTradingLoop3Exchanges(kraken, grvt, ext);
        }
      }
    } catch (err) {
      log('error', `Trading loop error: ${err.message}`);
      status({ state: 'error', message: `Error: ${err.message}` });
    }

    return;
  }

  // ---------- 2-account modes (1, 2) ----------
  const accountsWithExchanges = ACCOUNTS.slice(0, 2).map((account, i) => ({
    ...account,
    exchange: i === 0 ? tradingMode.buyExchange : tradingMode.sellExchange,
    exchangeConfig: EXCHANGE_CONFIGS[i === 0 ? tradingMode.buyExchange : tradingMode.sellExchange],
  }));

  status({ state: 'launching', message: 'Launching exchanges…' });

  const results = await Promise.all(
    accountsWithExchanges.map((a) => launchAccount(a, a.exchangeConfig))
  );

  activeBrowsers = results.filter((r) => r.browser).map((r) => r.browser);

  const successful = results.filter((r) => r.success);
  if (successful.length !== 2) {
    log('error', `Need 2 accounts, only ${successful.length} logged in.`);
    status({ state: 'error', message: `Only ${successful.length}/2 accounts connected` });
    stopped();
    return;
  }

  const emails = (process.env.ACCOUNT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  const buyAccount = successful.find((r) => r.email === emails[0]);
  const sellAccount = successful.find((r) => r.email === emails[1]);

  if (!buyAccount || !sellAccount) {
    log('error', 'Could not match emails to accounts.');
    status({ state: 'error', message: 'Account email mismatch' });
    stopped();
    return;
  }

  status({ state: 'running', message: 'Running correctly' });
  log('info', '🤖 Starting automated trading loop…');

  try {
    await automatedTradingLoop(buyAccount, sellAccount);
  } catch (err) {
    log('error', `Trading loop error: ${err.message}`);
    status({ state: 'error', message: `Error: ${err.message}` });
  }
}

/* ---- shutdown ---- */

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('info', 'Shutting down bot…');
  status({ state: 'stopping', message: 'Shutting down…' });

  for (const browser of activeBrowsers) {
    try {
      const pages = await browser.pages();
      for (const p of pages) await p.close().catch(() => {});
      await browser.close().catch(() => {});
    } catch { /* ignore */ }
  }

  stopped();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ---- IPC listener ---- */

process.on('message', async (msg) => {
  if (msg.type === 'start') {
    try {
      await runBot(msg.mode, msg.config);
    } catch (err) {
      if (err.code === 'CHROME_NOT_FOUND' || err.message === 'CHROME_NOT_FOUND') {
        log('error', 'Google Chrome is not installed.');
        if (process.send) process.send({ type: 'chrome-not-found' });
        status({ state: 'error', message: 'Google Chrome not found' });
      } else {
        log('error', `Fatal error: ${err.message}`);
        status({ state: 'error', message: `Fatal: ${err.message}` });
      }
      stopped();
    }
  } else if (msg.type === 'stop') {
    await shutdown();
  }
});
