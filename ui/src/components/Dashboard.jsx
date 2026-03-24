import { useMemo, useState, useEffect } from 'react';

const ERROR_FIXES = [
  { pattern: /cookie|session|login|logged out|unauthorized/i, fix: 'Delete cookie files (paradex-cookies-*.json) and restart the bot to re-login.' },
  { pattern: /timeout|timed out|ETIMEDOUT/i, fix: 'Network timeout. Check your internet connection or try again later.' },
  { pattern: /wallet|connect.*wallet|metamask/i, fix: 'Wallet connection issue. Make sure your wallet extension is unlocked.' },
  { pattern: /leverage|margin/i, fix: 'Check if the exchange supports the configured leverage level. Try reducing leverage.' },
  { pattern: /insufficient|balance|fund/i, fix: 'Insufficient balance. Deposit more funds to your exchange account.' },
  { pattern: /price.*not found|no price|NaN/i, fix: 'Price data unavailable. Restart the bot to reload the exchange page.' },
  { pattern: /ECONNREFUSED|ENOTFOUND|network/i, fix: 'Network connection failed. Check your internet and firewall settings.' },
  { pattern: /browser.*crash|page.*closed|target.*closed/i, fix: 'Browser session crashed. Restart the bot to launch a new session.' },
  { pattern: /rate.*limit|429|too many/i, fix: 'Exchange rate limit hit. The bot will auto-retry. Wait a moment.' },
  { pattern: /order.*rejected|order.*failed/i, fix: 'Order was rejected by the exchange. Check your balance and order size.' },
];

function getErrorFix(message) {
  for (const { pattern, fix } of ERROR_FIXES) {
    if (pattern.test(message)) return fix;
  }
  return 'Unexpected error. Try restarting the bot. If the issue persists, check the logs for details.';
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
  let tradesExecuted = 0;
  let krakenPrice = null;
  let grvtPrice = null;
  let priceDiff = null;
  let botState = null;
  let botMessage = null;
  let latency = null;
  let lastPriceCheckTime = null;

  for (const log of logs) {
    const msg = log.message || '';

    // Extract cycle number: [CYCLE 5]
    const cycleMatch = msg.match(/\[CYCLE\s+(\d+)\]/);
    if (cycleMatch) {
      const num = parseInt(cycleMatch[1], 10);
      if (num > cycle) cycle = num;
    }

    // Extract prices: "Highest: kraken at $87,432.50" / "Lowest: grvt at $87,410.00"
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

    // Extract price difference: "Price difference: $22.50"
    const diffMatch = msg.match(/Price difference:\s+\$([\d,.]+)/);
    if (diffMatch) {
      priceDiff = parseFloat(diffMatch[1].replace(/,/g, ''));
    }

    // Calculate latency from price check intervals
    if (/Price check attempt|Closing threshold check attempt|Closing spread threshold check attempt/i.test(msg) && log.time) {
      // Parse time "HH:MM:SS" to seconds
      const parts = log.time.split(':');
      if (parts.length === 3) {
        const timeInSec = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
        if (lastPriceCheckTime !== null) {
          const diff = timeInSec - lastPriceCheckTime;
          if (diff > 0 && diff < 300) { // reasonable range: 0-5 min
            latency = diff;
          }
        }
        lastPriceCheckTime = timeInSec;
      }
    }

    // Count trades: "Executing trades" or "Both positions opened successfully"
    if (/Executing trades|Step 6.*Executing trades/.test(msg)) {
      tradesExecuted++;
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
      botState = 'paused';
      botMessage = 'Price data unavailable — retrying...';
    }
    if (/Maximum attempts.*reached/i.test(msg)) {
      botState = 'paused';
      botMessage = 'Threshold not met after max attempts';
    }

    // === ERRORS ===
    if (/CRITICAL.*Only ONE position/i.test(msg)) {
      botState = 'error';
      botMessage = 'Only one side filled — emergency close';
    }
    if (/No accounts logged in/i.test(msg)) {
      botState = 'error';
      botMessage = 'No accounts logged in — restart required';
    }
    if (/Stopping/i.test(msg) && !/Bot stopped/i.test(msg)) {
      botState = 'error';
      botMessage = 'Bot stopped unexpectedly';
    }
    if (/Browser session crashed|target.*closed/i.test(msg)) {
      botState = 'error';
      botMessage = 'Browser crashed — restart the bot';
    }
    if (/timeout|ETIMEDOUT/i.test(msg) && log.type === 'error') {
      botState = 'error';
      botMessage = 'Network timeout — check connection';
    }
    if (/insufficient.*balance|Insufficient funds/i.test(msg)) {
      botState = 'error';
      botMessage = 'Insufficient balance on exchange';
    }
    if (log.type === 'error' && /Fatal|uncaught|MODULE_NOT_FOUND/i.test(msg)) {
      botState = 'error';
      botMessage = 'Fatal error — restart required';
    }
    if (/order.*rejected|order.*failed/i.test(msg)) {
      botState = 'error';
      botMessage = 'Order rejected by exchange';
    }
    if (/positions still open after close/i.test(msg)) {
      botState = 'paused';
      botMessage = 'Retrying to close remaining positions...';
    }
  }

  return { cycle, tradesExecuted, krakenPrice, grvtPrice, priceDiff, botState, botMessage, latency };
}

export default function Dashboard({ status, botRunning, logs, onStart, onStop, config }) {
  const api = window.electronAPI;

  // Parse logs for metrics
  const logMetrics = useMemo(() => parseLogsForMetrics(logs), [logs]);

  // Use status data if available, fall back to log-parsed data
  const prices = status.prices || {};
  const cycle = status.cycle || logMetrics.cycle || 0;
  const priceDiff = status.priceDiff ?? logMetrics.priceDiff;
  const tradesExecuted = status.tradesExecuted || logMetrics.tradesExecuted || 0;
  const krakenPrice = prices.kraken || logMetrics.krakenPrice;
  const grvtPrice = prices.grvt || logMetrics.grvtPrice;
  const botState = status.botState || logMetrics.botState || (botRunning ? 'running' : null);
  const botMessage = status.botMessage || logMetrics.botMessage || (botRunning ? 'Running correctly' : null);
  const latency = logMetrics.latency;

  const [showConfirm, setShowConfirm] = useState(false);
  const [showSleepWarning, setShowSleepWarning] = useState(false);

  // Stall detection — warn if no log activity for 60s while running
  const [stalled, setStalled] = useState(false);
  const lastLogCountRef = { current: 0 };

  useEffect(() => {
    if (!botRunning) { setStalled(false); return; }
    lastLogCountRef.current = logs.length;
    const stallTimer = setInterval(() => {
      if (logs.length === lastLogCountRef.current && botRunning) {
        setStalled(true);
      } else {
        setStalled(false);
        lastLogCountRef.current = logs.length;
      }
    }, 60000);
    return () => clearInterval(stallTimer);
  }, [botRunning, logs.length]);

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

  const recentErrors = useMemo(() => {
    return logs
      .filter((l) => l.type === 'error')
      .slice(-5)
      .map((l) => ({ ...l, fix: getErrorFix(l.message) }));
  }, [logs]);

  // Override state if stalled
  const effectiveBotState = stalled ? 'paused' : botState;
  const effectiveBotMessage = stalled ? 'No activity detected — bot may be stalled' : botMessage;

  const stateInfo = BOT_STATE_MAP[effectiveBotState] || { label: 'Idle', color: 'var(--text-muted)', desc: 'Bot is not running' };
  const isError = effectiveBotState === 'error';

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
      <div className={`dash-status ${botRunning ? (isError ? 'is-error' : effectiveBotState === 'paused' ? 'is-paused' : 'is-running') : 'is-idle'}`}>
        <div className="dash-status-indicator">
          <span className="dash-status-dot" style={{ background: stateInfo.color, boxShadow: botRunning ? `0 0 10px ${stateInfo.color}` : 'none' }} />
        </div>
        <div className="dash-status-text">
          <span className="dash-status-label" style={{ color: botRunning ? stateInfo.color : 'var(--text-secondary)' }}>
            {botRunning ? stateInfo.label : 'Bot Stopped'}
          </span>
          <span className="dash-status-desc">
            {botRunning ? (effectiveBotMessage || stateInfo.desc) : 'Configure settings and start trading'}
          </span>
        </div>
        {botRunning && (
          <div className="dash-status-uptime">
            {formatUptime(uptime)}
          </div>
        )}
      </div>

      {/* Action Button */}
      <div className="dash-actions">
        {botRunning ? (
          <button className="btn btn-danger dash-action-btn" onClick={onStop}>
            Stop Bot
          </button>
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
            <span className="dash-stat-value">{tradesExecuted || '—'}</span>
            <span className="dash-stat-label">Trades</span>
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

      {/* Errors */}
      {recentErrors.length > 0 && (
        <div className="dash-section">
          <div className="dash-section-label" style={{ color: 'var(--red)' }}>
            Errors ({recentErrors.length})
          </div>
          <div className="dash-errors">
            {recentErrors.map((err, i) => (
              <div key={i} className="dash-error-item">
                <div className="dash-error-top">
                  <span className="dash-error-time">{err.time}</span>
                  <span className="dash-error-msg">{err.message}</span>
                </div>
                {err.fix && (
                  <div className="dash-error-fix">
                    <span className="dash-error-fix-icon">{'\u2139'}</span>
                    {err.fix}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
