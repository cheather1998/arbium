import { useMemo, useState, useEffect } from 'react';

// Only critical system errors — trading events (timeouts, fills) are normal and filtered out
const ERROR_FIXES = [
  {
    pattern: /not enough balance|insufficient balance|insufficient fund/i,
    fix: 'Insufficient balance',
    action: { label: 'Deposit', urls: ['https://www.kraken.com/u/funding', 'https://grvt.io/exchange/deposit'] },
  },
  {
    pattern: /cookie|session.*expired|logged out|unauthorized/i,
    fix: 'Session expired',
    action: { label: 'Restart', restart: true },
  },
  {
    pattern: /No accounts logged in|login.*failed/i,
    fix: 'Login failed',
    action: { label: 'Log in', urls: ['https://www.kraken.com/sign-in', 'https://grvt.io/exchange/login'] },
  },
  {
    pattern: /browser.*crash|page.*closed|target.*closed/i,
    fix: 'Browser crashed',
    action: { label: 'Restart', restart: true },
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|cannot connect|disconnected/i,
    fix: 'Network disconnected',
    action: null,
  },
  {
    pattern: /wallet|connect.*wallet|metamask/i,
    fix: 'Wallet not connected',
    action: { label: 'Get MetaMask', urls: ['https://metamask.io/download/'] },
  },
  {
    pattern: /Chrome.*not found|chrome.*not installed|CHROME_NOT_FOUND/i,
    fix: 'Chrome not installed',
    action: { label: 'Download', urls: ['https://www.google.com/chrome/'] },
  },
  {
    pattern: /Fatal|uncaught|MODULE_NOT_FOUND/i,
    fix: 'Fatal error — reinstall Arbium',
    action: { label: 'Download', urls: ['https://github.com/cheather1998/arbium/releases/latest'] },
  },
];

function getErrorFix(message) {
  for (const entry of ERROR_FIXES) {
    if (entry.pattern.test(message)) {
      return { text: entry.fix, action: entry.action };
    }
  }
  return { text: 'Unexpected error. Restart the bot.', action: null };
}

const BOT_STATE_MAP = {
  setting_up: { label: 'Setting Up', color: 'var(--yellow)', desc: 'Bot is initializing browsers and logging in...' },
  running: { label: 'Running Correctly', color: 'var(--green)', desc: 'Monitoring price spreads and executing trades' },
  error: { label: 'Error Detected', color: 'var(--red)', desc: 'An issue occurred — see details below' },
  paused: { label: 'Paused', color: 'var(--yellow)', desc: 'Bot is temporarily paused' },
};

/**
 * Parse bot logs to extract dashboard metrics.
 * The bot outputs structured text logs — we regex-match key data points.
 */
function parseLogsForMetrics(logs) {
  let cycle = 0;
  let krakenTrades = 0;
  let grvtTrades = 0;
  let currentCycle = 0;
  const counted = new Set();
  let krakenPrice = null;
  let grvtPrice = null;
  let priceDiff = null;
  let botState = null;
  let botMessage = null;
  let latency = null;

  for (const log of logs) {
    const msg = (log.message || '').trim();

    // Extract cycle number
    const cycleMatch = msg.match(/CYCLE\s+(\d+)/);
    if (cycleMatch) {
      const num = parseInt(cycleMatch[1], 10);
      if (num > cycle) cycle = num;
      if (num > currentCycle) currentCycle = num;
    }

    // Count trades: "[Kraken] ✓ Order confirmed as ..."
    if (/Kraken/i.test(msg) && /Order confirmed/i.test(msg)) {
      const key = `k${currentCycle}`;
      if (!counted.has(key)) { counted.add(key); krakenTrades++; }
    }
    if (/GRVT/i.test(msg) && /Order confirmed/i.test(msg)) {
      const key = `g${currentCycle}`;
      if (!counted.has(key)) { counted.add(key); grvtTrades++; }
    }

    // Extract prices from multiple log formats:
    // loop.js: "   Highest: Kraken at $87,432.5"
    // loop.js: "   Lowest: GRVT at $87,410"
    // priceComparison.js: "🔺 HIGHEST Kraken: $87,432.5"
    // priceComparison.js: "   Highest: Kraken at $87,432.5"
    // priceComparison.js: "[Kraken] ✓ Price: $87,432.5"

    const highMatch = msg.match(/Highest:\s+(\w+)\s+at\s+\$([\d,.]+)/);
    if (highMatch) {
      const exchange = highMatch[1].toLowerCase();
      const price = parseFloat(highMatch[2].replace(/,/g, ''));
      if (exchange === 'kraken') krakenPrice = price;
      else if (exchange === 'grvt') grvtPrice = price;
    }

    const lowMatch = msg.match(/Lowest:\s+(\w+)\s+at\s+\$([\d,.]+)/);
    if (lowMatch) {
      const exchange = lowMatch[1].toLowerCase();
      const price = parseFloat(lowMatch[2].replace(/,/g, ''));
      if (exchange === 'kraken') krakenPrice = price;
      else if (exchange === 'grvt') grvtPrice = price;
    }

    // Also extract from "[Kraken] ✓ Price: $87,432.5" format
    const priceLogMatch = msg.match(/\[(Kraken|GRVT)\].*Price:\s+\$([\d,.]+)/i);
    if (priceLogMatch) {
      const exchange = priceLogMatch[1].toLowerCase();
      const price = parseFloat(priceLogMatch[2].replace(/,/g, ''));
      if (exchange === 'kraken') krakenPrice = price;
      else if (exchange === 'grvt') grvtPrice = price;
    }

    // Also extract from "HIGHEST Kraken: $87,432.5" format
    const resultMatch = msg.match(/(?:HIGHEST|LOWEST)\s+(\w+):\s+\$([\d,.]+)/);
    if (resultMatch) {
      const exchange = resultMatch[1].toLowerCase();
      const price = parseFloat(resultMatch[2].replace(/,/g, ''));
      if (exchange === 'kraken') krakenPrice = price;
      else if (exchange === 'grvt') grvtPrice = price;
    }

    // Extract price difference from multiple formats:
    // "Price difference: $22.50" or "Difference: $22.50"
    const diffMatch = msg.match(/(?:Price )?[Dd]ifference:\s+\$([\d,.]+)/);
    if (diffMatch) {
      priceDiff = parseFloat(diffMatch[1].replace(/,/g, ''));
    }

    // Calculate latency from "Total fetch time: 3018ms"
    const fetchTimeMatch = msg.match(/Total fetch time:\s*(\d+)ms/i);
    if (fetchTimeMatch) {
      latency = (parseInt(fetchTimeMatch[1]) / 1000).toFixed(1);
    }


    // === PREPARING / SETTING UP ===
    if (/Launching browser|Starting Multi-Exchange|opening.*browsers/i.test(msg)) {
      botState = 'setting_up';
      botMessage = 'Launching browser sessions...';
    }
    if (/Loading cookies|Restoring session/i.test(msg)) {
      botState = 'setting_up';
      botMessage = 'Restoring previous session...';
    }
    if (/Please log in|waiting.*login|waiting.*account/i.test(msg)) {
      botState = 'setting_up';
      botMessage = 'Waiting for exchange login...';
    }
    if (/Cleaning up existing positions|Checking for open positions/i.test(msg) && !cycle) {
      botState = 'setting_up';
      botMessage = 'Cleaning up previous positions...';
    }
    if (/Setting leverage|Leverage set/i.test(msg) && !cycle) {
      botState = 'setting_up';
      botMessage = 'Configuring leverage...';
    }
    if (/clickOrdersTab|PRE-trade flow/i.test(msg)) {
      botState = 'setting_up';
      botMessage = 'Preparing exchange interface...';
    }

    // === RUNNING NORMALLY ===
    if (/CYCLE.*Price check attempt/i.test(msg)) {
      botState = 'running';
      botMessage = 'Scanning prices across exchanges...';
    }
    if (/Price difference.*>=.*threshold.*Proceeding/i.test(msg)) {
      botState = 'running';
      botMessage = 'Price threshold met — opening positions...';
    }
    if (/Executing trades|Step 6.*Executing/i.test(msg)) {
      botState = 'running';
      botMessage = 'Executing trade on both exchanges...';
    }
    if (/waiting.*positions to open|waiting.*minutes.*positions/i.test(msg)) {
      botState = 'running';
      botMessage = 'Waiting for positions to fill...';
    }
    if (/Both positions opened successfully/i.test(msg)) {
      botState = 'running';
      botMessage = 'Both positions opened — monitoring for close...';
    }
    if (/Closing threshold check|Closing spread threshold check/i.test(msg)) {
      botState = 'running';
      botMessage = 'Waiting for closing conditions...';
    }
    if (/Proceeding to close positions/i.test(msg)) {
      botState = 'running';
      botMessage = 'Closing positions...';
    }
    if (/Force closing positions/i.test(msg)) {
      botState = 'running';
      botMessage = 'Force closing positions (timeout)...';
    }
    if (/Canceling.*orders/i.test(msg) && /CYCLE/.test(msg)) {
      botState = 'running';
      botMessage = 'Canceling open orders...';
    }
    if (/cleanup/i.test(msg) && /CYCLE/.test(msg)) {
      botState = 'running';
      botMessage = 'Cleaning up for next cycle...';
    }

    // === WAITING / THRESHOLD NOT MET ===
    if (/Price difference.*<.*threshold.*Waiting|checking again/i.test(msg)) {
      botState = 'running';
      botMessage = 'Spread below threshold — waiting...';
    }
    if (/Price comparison failed|insufficient prices.*Retrying/i.test(msg)) {
      botState = 'running';
      botMessage = 'Price data unavailable — retrying...';
    }
    if (/Maximum attempts.*reached/i.test(msg)) {
      botState = 'running';
      botMessage = 'Threshold not met after max attempts — restarting cycle...';
    }

    // === CRITICAL SYSTEM ERRORS ONLY ===
    // These are real problems that need user attention
    // Note: "Only ONE position opened" is a trading event, not a system error — bot handles it automatically
    if (/No accounts logged in/i.test(msg)) {
      botState = 'error';
      botMessage = 'No accounts logged in — restart required';
    }
    if (/Browser session crashed/i.test(msg)) {
      botState = 'error';
      botMessage = 'Browser crashed — restart the bot';
    }
    if (/insufficient.*balance|Insufficient funds|not enough.*balance|not enough.*fund/i.test(msg)) {
      botState = 'error';
      botMessage = 'Insufficient balance — deposit more funds';
    }
    if (log.type === 'error' && /Fatal|uncaught|MODULE_NOT_FOUND/i.test(msg)) {
      botState = 'error';
      botMessage = 'Fatal error — restart required';
    }
    if (/ECONNREFUSED|cannot connect to|network.*unreachable/i.test(msg)) {
      botState = 'error';
      botMessage = 'Connection lost — check your internet';
    }
    // NOTE: These are NORMAL trading events, NOT errors:
    // - "order failed: Quick fill timeout" = order didn't fill in time, bot retries automatically
    // - "order rejected" = exchange rejected order, bot adjusts and retries
    // - "timeout" in trade context = waiting for price, normal behavior
    // - "positions still open after close" = bot is retrying close, normal behavior
  }

  return { cycle, krakenTrades, grvtTrades, krakenPrice, grvtPrice, priceDiff, botState, botMessage, latency };
}

export default function Dashboard({ status, botRunning, logs, onStart, onStop, config }) {
  const api = window.electronAPI;

  // Parse logs for metrics
  const logMetrics = useMemo(() => parseLogsForMetrics(logs), [logs]);


  // Use status data if available, fall back to log-parsed data
  const prices = status.prices || {};
  const cycle = status.cycle || logMetrics.cycle || 0;
  const priceDiff = status.priceDiff ?? logMetrics.priceDiff;
  const krakenPrice = prices.kraken || logMetrics.krakenPrice;
  const grvtPrice = prices.grvt || logMetrics.grvtPrice;
  const botState = status.botState || logMetrics.botState || (botRunning ? 'running' : null);
  const botMessage = status.botMessage || logMetrics.botMessage || (botRunning ? 'Running correctly' : null);
  const latency = logMetrics.latency;

  const krakenTrades = logMetrics.krakenTrades;
  const grvtTrades = logMetrics.grvtTrades;

  const [showConfirm, setShowConfirm] = useState(false);
  const [showSleepWarning, setShowSleepWarning] = useState(false);

  // Uptime counter
  const [uptime, setUptime] = useState(0);
  const [startTime, setStartTime] = useState(null);

  useEffect(() => {
    if (botRunning && !startTime) {
      setStartTime(Date.now());
    } else if (!botRunning) {
      setStartTime(null);
      setUptime(0);
    }
  }, [botRunning]);

  useEffect(() => {
    if (!startTime) return;
    const timer = setInterval(() => {
      setUptime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  const formatUptime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  // SYSTEM ERRORS ONLY — things the user must fix manually
  // Each pattern is specific to avoid false positives from trading logs
  const recentErrors = useMemo(() => {
    const seen = new Set();
    return logs
      .filter((l) => {
        const msg = l.message || '';
        const msgLower = msg.toLowerCase();

        // === WHITELIST: Only these specific system errors are shown ===
        let errorType = null;

        // 1. Insufficient balance — user needs to deposit funds
        if (/not enough balance|insufficient balance|insufficient fund/i.test(msg)) {
          errorType = 'balance';
        }
        // 2. No accounts logged in — all login attempts failed
        else if (/No accounts logged in\. Stopping/i.test(msg)) {
          errorType = 'login';
        }
        // 3. Browser crashed — not just "target closed" from navigation
        else if (/Browser session crashed/i.test(msg)) {
          errorType = 'crash';
        }
        // 4. Chrome not installed
        else if (/Chrome.*not found|Google Chrome is required/i.test(msg)) {
          errorType = 'chrome';
        }
        // 5. Fatal code error
        else if (/MODULE_NOT_FOUND|Fatal error|uncaught exception/i.test(msg) && l.type === 'error') {
          errorType = 'fatal';
        }
        // 6. Network completely down (not just temporary timeout)
        else if (/ECONNREFUSED|cannot connect to|network.*unreachable/i.test(msg)) {
          errorType = 'network';
        }

        // Deduplicate by error type
        if (errorType && !seen.has(errorType)) {
          seen.add(errorType);
          return true;
        }
        return false;
      })
      .slice(-5)
      .map((l) => ({ ...l, fix: getErrorFix(l.message) }));
  }, [logs]);

  const stateInfo = BOT_STATE_MAP[botState] || { label: 'Idle', color: 'var(--text-muted)', desc: 'Bot is not running' };
  const isError = botState === 'error';

  const handleOpenExchanges = () => {
    if (api?.openExternal) {
      api.openExternal('https://pro.kraken.com/app/trade/futures-btc-usd-perp');
      api.openExternal('https://grvt.io/exchange/perpetual/BTC-USDT');
    } else {
      window.open('https://pro.kraken.com/app/trade/futures-btc-usd-perp', '_blank');
      window.open('https://grvt.io/exchange/perpetual/BTC-USDT', '_blank');
    }
  };

  const leverage = config?.LEVERAGE || '1';
  const buyQty = config?.BUY_QTY || '—';
  const sellQty = config?.SELL_QTY || '—';

  const formatPrice = (price) => {
    if (!price) return '—';
    return `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="dashboard">
      {/* Confirm Modal */}
      {showConfirm && (
        <div className="modal-overlay">
          <div className="confirm-modal">
            <h2>Confirm Trading Settings</h2>
            <p className="confirm-modal-desc">Please review your settings before starting the bot.</p>
            <div className="confirm-modal-settings">
              <div className="confirm-modal-row">
                <span className="confirm-modal-label">Buy Quantity</span>
                <span className="confirm-modal-value">{buyQty} BTC</span>
              </div>
              <div className="confirm-modal-row">
                <span className="confirm-modal-label">Sell Quantity</span>
                <span className="confirm-modal-value">{sellQty} BTC</span>
              </div>
              <div className="confirm-modal-row">
                <span className="confirm-modal-label">Leverage</span>
                <span className="confirm-modal-value">{leverage}x</span>
              </div>
            </div>
            <div className="confirm-modal-actions">
              <button className="btn confirm-btn-edit" onClick={() => setShowConfirm(false)} style={{ flex: 1 }}>
                Edit
              </button>
              <button className="btn btn-secondary" onClick={() => { setShowConfirm(false); setShowSleepWarning(true); }} style={{ flex: 1 }}>
                Confirm & Start
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sleep Warning Modal */}
      {showSleepWarning && (
        <div className="modal-overlay">
          <div className="confirm-modal">
            <div style={{ fontSize: '2rem', marginBottom: '12px' }}>&#9888;</div>
            <h2>Important Reminder</h2>
            <p className="confirm-modal-desc" style={{ fontSize: '0.95rem', lineHeight: '1.6', color: 'var(--text-primary)' }}>
              Please <strong>do not let your computer enter sleep mode</strong> while the bot is running. The bot requires an active browser session to monitor prices and execute trades.
            </p>
            <p className="confirm-modal-desc" style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '8px' }}>
              Tip: Go to System Settings &rarr; Displays &rarr; set "Turn display off" to Never.
            </p>
            <div className="confirm-modal-actions">
              <button className="btn btn-secondary" onClick={() => { setShowSleepWarning(false); onStart(); }} style={{ width: '100%' }}>
                I Understand, Start Bot
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status Section */}
      <div className={`dash-status ${botRunning ? (isError ? 'is-error' : botState === 'paused' ? 'is-paused' : 'is-running') : 'is-idle'}`}>
        <div className="dash-status-header">
          <div className="dash-status-indicator">
            <span className="dash-status-dot" style={{ background: stateInfo.color, boxShadow: botRunning ? `0 0 10px ${stateInfo.color}` : 'none' }} />
          </div>
          <div className="dash-status-text">
            <span className="dash-status-label" style={{ color: botRunning ? stateInfo.color : 'var(--text-secondary)' }}>
              {botRunning ? stateInfo.label : 'Bot Stopped'}
            </span>
            <span className="dash-status-desc">
              {botRunning ? (botMessage || stateInfo.desc) : 'Configure settings and start trading'}
            </span>
          </div>
          {botRunning && (
            <div className="dash-status-uptime">
              {formatUptime(uptime)}
            </div>
          )}
        </div>
        {isError && recentErrors.length > 0 && (
          <div className="dash-errors-inline">
            {recentErrors.map((err, i) => (
              <div key={i} className="dash-error-inline-item" onClick={() => {
                if (!err.fix?.action) return;
                if (err.fix.action.restart) { onStop(); setTimeout(() => onStart(), 1500); }
                else if (err.fix.action.urls) { err.fix.action.urls.forEach(u => api?.openExternal?.(u)); }
              }}>
                <span className="dash-error-inline-text">{err.fix?.text || err.fix}</span>
                {err.fix?.action && (
                  <span className="dash-error-link-btn">{err.fix.action.label}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action Button */}
      <div className="dash-actions">
        {botRunning ? (
          <div className="dash-actions-row">
            <button className="btn btn-danger dash-action-btn" onClick={onStop}>
              Stop Bot
            </button>
            {isError && recentErrors.length > 0 && (
              <button className="btn dash-restart-btn" onClick={() => { onStop(); setTimeout(() => onStart(), 1500); }}>
                Restart Bot
              </button>
            )}
          </div>
        ) : (
          <button className="btn btn-primary dash-action-btn" onClick={() => setShowConfirm(true)}>
            Log In & Start Trading
          </button>
        )}
      </div>

      {/* Live Prices */}
      <div className="dash-section">
        <div className="dash-section-label">Live Prices</div>
        <div className="dash-prices">
          <div className="dash-price-item">
            <span className="dash-price-exchange">Kraken</span>
            <span className="dash-price-value">{formatPrice(krakenPrice)}</span>
          </div>
          <div className="dash-price-spread">
            <span className={`dash-spread-value ${priceDiff !== null ? (Math.abs(priceDiff) >= 5 ? 'high' : '') : ''}`}>
              {priceDiff !== null ? `$${Math.abs(priceDiff).toFixed(2)}` : '—'}
            </span>
            <span className="dash-spread-label">spread</span>
          </div>
          <div className="dash-price-item">
            <span className="dash-price-exchange">GRVT</span>
            <span className="dash-price-value">{formatPrice(grvtPrice)}</span>
          </div>
        </div>
      </div>

      {/* Stats + Check P&L */}
      <div className="dash-section">
        <div className="dash-section-label">Performance</div>
        <div className="dash-stats">
          <div className="dash-stat">
            <span className="dash-stat-value">{cycle || '—'}</span>
            <span className="dash-stat-label">Cycles</span>
          </div>
          <div className="dash-stat-divider" />
          <div className="dash-stat">
            <span className="dash-stat-value">{krakenTrades || '—'}</span>
            <span className="dash-stat-label">Kraken Trades</span>
          </div>
          <div className="dash-stat-divider" />
          <div className="dash-stat">
            <span className="dash-stat-value">{grvtTrades || '—'}</span>
            <span className="dash-stat-label">GRVT Trades</span>
          </div>
          <div className="dash-stat-divider" />
          <div className="dash-stat">
            <span className="dash-stat-value">{latency !== null ? `${latency}s` : '—'}</span>
            <span className="dash-stat-label">Latency</span>
          </div>
        </div>
        <div className="dash-pnl-row">
          <button className="btn dash-pnl-btn" onClick={handleOpenExchanges}>
            Check P&L on Kraken & GRVT
          </button>
          <p className="dash-pnl-note">
            Do not click any elements in the bot's browser windows while running. Open separate browser windows to check P&L.
          </p>
        </div>
      </div>

    </div>
  );
}
