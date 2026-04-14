import { useMemo, useState, useEffect } from 'react';
import refreshIcon from '../assets/refresh-icon.svg';
import { computeRequiredBalance } from '../lib/requiredBalance';

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
/**
 * Parse bot logs for dashboard metrics.
 * Optimized: scan last ~100 logs for live data (prices, state),
 * full scan only for cumulative counters (trades, cycle).
 */
function parseLogsForMetrics(logs) {
  const len = logs.length;
  let cycle = 0, krakenTrades = 0, grvtTrades = 0, currentCycle = 0;
  const counted = new Set();
  let krakenPrice = null, grvtPrice = null, priceDiff = null;
  let botState = null, botMessage = null, latency = null;
  // Kraken-solo mode live position tracking (used to show "Open Side" + "Entry"
  // in the dashboard for Kraken Future / Margin). We walk the logs in order
  // and maintain the most recent open position state.
  let openSide = null;       // 'BUY' | 'SELL' | null
  let entryPrice = null;     // number | null
  let pendingSide = null;    // side we've seen in a "Step 4: Opening X position" line but not yet confirmed
  let pendingPrice = null;   // price captured from the cycle header right before pendingSide

  // --- Pass 1: Full scan for cumulative data (trades + max cycle) ---
  for (let i = 0; i < len; i++) {
    const msg = (logs[i].message || '');
    const cm = msg.match(/CYCLE\s+(\d+)/);
    if (cm) { const n = parseInt(cm[1], 10); if (n > cycle) cycle = n; if (n > currentCycle) currentCycle = n; }
    if (/Kraken/i.test(msg) && /Order confirmed/i.test(msg)) {
      const k = `k${currentCycle}`; if (!counted.has(k)) { counted.add(k); krakenTrades++; }
    }
    if (/GRVT/i.test(msg) && /Order confirmed/i.test(msg)) {
      const k = `g${currentCycle}`; if (!counted.has(k)) { counted.add(k); grvtTrades++; }
    }

    // === Track Kraken-solo open position ===
    // Cycle header: "[CYCLE 5] BUY → hold 120s → SELL"
    const cycleHeader = msg.match(/\[CYCLE\s+\d+\]\s+(BUY|SELL)\s*→\s*hold/i);
    if (cycleHeader) {
      pendingSide = cycleHeader[1].toUpperCase();
      pendingPrice = null;
    }
    // Price line right after cycle header: "[CYCLE 5]   Price: $108,234.56"
    const cyclePrice = msg.match(/\[CYCLE\s+\d+\]\s+Price:\s*\$([\d,]+\.?\d*)/);
    if (cyclePrice && pendingSide) {
      pendingPrice = parseFloat(cyclePrice[1].replace(/,/g, ''));
    }
    // Open confirmed: "[CYCLE 5] ✅ [Kraken] BUY Order confirmed" (NOT "position closed")
    const openConfirmed = msg.match(/\[CYCLE\s+\d+\].*\[Kraken\]\s+(BUY|SELL)\s+Order confirmed/i);
    if (openConfirmed && !/position closed/i.test(msg)) {
      openSide = openConfirmed[1].toUpperCase();
      // Prefer pendingPrice (from cycle header), fall back to most recent krakenPrice
      if (pendingPrice != null) entryPrice = pendingPrice;
      else if (krakenPrice != null) entryPrice = krakenPrice;
    }
    // Close confirmed: "[CYCLE 5] ✅ [Kraken] SELL Order confirmed — position closed"
    if (/Order confirmed.*position closed/i.test(msg)) {
      openSide = null;
      entryPrice = null;
      pendingSide = null;
      pendingPrice = null;
    }
  }

  // --- Pass 2: Last 100 logs only for live data (prices, state, latency) ---
  const start = Math.max(0, len - 100);
  for (let i = start; i < len; i++) {
    const log = logs[i];
    const msg = (log.message || '');

    // Prices
    const hm = msg.match(/Highest:\s+(\w+)\s+at\s+\$([\d,.]+)/);
    if (hm) { const p = parseFloat(hm[2].replace(/,/g, '')); if (hm[1].toLowerCase() === 'kraken') krakenPrice = p; else if (hm[1].toLowerCase() === 'grvt') grvtPrice = p; }
    const lm = msg.match(/Lowest:\s+(\w+)\s+at\s+\$([\d,.]+)/);
    if (lm) { const p = parseFloat(lm[2].replace(/,/g, '')); if (lm[1].toLowerCase() === 'kraken') krakenPrice = p; else if (lm[1].toLowerCase() === 'grvt') grvtPrice = p; }
    const pm = msg.match(/(?:HIGHEST|LOWEST)\s+(\w+):\s+\$([\d,.]+)/);
    if (pm) { const p = parseFloat(pm[2].replace(/,/g, '')); if (pm[1].toLowerCase() === 'kraken') krakenPrice = p; else if (pm[1].toLowerCase() === 'grvt') grvtPrice = p; }

    // Spread
    const dm = msg.match(/[Dd]ifference:\s+\$([\d,.]+)/);
    if (dm) priceDiff = parseFloat(dm[1].replace(/,/g, ''));

    // Latency
    const fm = msg.match(/Total fetch time:\s*(\d+)ms/i);
    if (fm) latency = (parseInt(fm[1]) / 1000).toFixed(1);

    // Bot state (only from recent logs)
    if (/Launching browser|Starting Multi-Exchange|opening.*browsers/i.test(msg)) { botState = 'setting_up'; botMessage = 'Launching browser sessions...'; }
    else if (/Please log in|waiting.*login/i.test(msg)) { botState = 'setting_up'; botMessage = 'Waiting for exchange login...'; }
    else if (/CYCLE.*Price check attempt/i.test(msg)) { botState = 'running'; botMessage = 'Scanning prices across exchanges...'; }
    else if (/Price difference.*>=.*threshold.*Proceeding/i.test(msg)) { botState = 'running'; botMessage = 'Price threshold met — opening positions...'; }
    else if (/Executing trades|Step 6.*Executing/i.test(msg)) { botState = 'running'; botMessage = 'Executing trade on both exchanges...'; }
    else if (/waiting.*positions to open|waiting.*minutes.*positions/i.test(msg)) { botState = 'running'; botMessage = 'Waiting for positions to fill...'; }
    else if (/Both positions opened successfully/i.test(msg)) { botState = 'running'; botMessage = 'Both positions opened — monitoring for close...'; }
    else if (/Closing threshold check|Closing spread threshold/i.test(msg)) { botState = 'running'; botMessage = 'Waiting for closing conditions...'; }
    else if (/Proceeding to close positions/i.test(msg)) { botState = 'running'; botMessage = 'Closing positions...'; }
    else if (/Force closing positions/i.test(msg)) { botState = 'running'; botMessage = 'Force closing positions (timeout)...'; }
    else if (/cleanup/i.test(msg) && /CYCLE/.test(msg)) { botState = 'running'; botMessage = 'Cleaning up for next cycle...'; }
    else if (/checking again/i.test(msg)) { botState = 'running'; botMessage = 'Spread below threshold — waiting...'; }

    // Critical errors (last 50 only)
    if (i >= len - 50) {
      if (/No accounts logged in/i.test(msg)) { botState = 'error'; botMessage = 'No accounts logged in — restart required'; }
      else if (/Browser session crashed/i.test(msg)) { botState = 'error'; botMessage = 'Browser crashed — restart the bot'; }
      else if (/insufficient.*balance|not enough.*balance/i.test(msg)) { botState = 'error'; botMessage = 'Insufficient balance — deposit more funds'; }
      else if (log.type === 'error' && /Fatal|MODULE_NOT_FOUND/i.test(msg)) { botState = 'error'; botMessage = 'Fatal error — restart required'; }
      else if (/ECONNREFUSED|cannot connect/i.test(msg)) { botState = 'error'; botMessage = 'Connection lost — check your internet'; }
    }
  }

  return { cycle, krakenTrades, grvtTrades, krakenPrice, grvtPrice, priceDiff, botState, botMessage, latency, openSide, entryPrice };
}

export default function Dashboard({ status, botRunning, logs, onStart, onStop, onStopGraceful, onStopForceClose, config, tradingMode, onTradingModeChange, liveBtcPrice }) {
  const isKrakenSolo = tradingMode === 'kraken-future' || tradingMode === 'kraken-margin';
  const api = window.electronAPI;
  const [refreshKey, setRefreshKey] = useState(0);

  // Parse logs for metrics
  const logMetrics = useMemo(() => parseLogsForMetrics(logs), [logs, refreshKey]);


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
  const openSide = logMetrics.openSide;
  const entryPrice = logMetrics.entryPrice;

  const [showConfirm, setShowConfirm] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Graceful-stop popup state: true while waiting for cycle to complete
  const [stoppingGraceful, setStoppingGraceful] = useState(false);
  // Auto-close the stopping popup when bot actually stops
  useEffect(() => { if (!botRunning) setStoppingGraceful(false); }, [botRunning]);
  // User must explicitly confirm they have enough balance before starting.
  // Reset every time the modal opens so the user actively re-checks each run.
  const [balanceConfirmed, setBalanceConfirmed] = useState(false);
  useEffect(() => {
    if (showConfirm) setBalanceConfirmed(false);
  }, [showConfirm]);

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
      if (!isKrakenSolo) api.openExternal('https://grvt.io/exchange/perpetual/BTC-USDT');
    } else {
      window.open('https://pro.kraken.com/app/trade/futures-btc-usd-perp', '_blank');
      if (!isKrakenSolo) window.open('https://grvt.io/exchange/perpetual/BTC-USDT', '_blank');
    }
  };

  const leverage = config?.LEVERAGE || '1';
  const buyQty = config?.BUY_QTY || '—';
  const sellQty = config?.SELL_QTY || '—';

  // Compute minimum account balance for Kraken Future / Margin modes
  const isKrakenFuture = tradingMode === 'kraken-future';
  const isKrakenMargin = tradingMode === 'kraken-margin';
  // Use the SAME price source as ConfigPanel: prefer live bot prices, fall
  // back to the app-level liveBtcPrice fetched in App.jsx. Only use the
  // hard-coded 100000 as a last resort before the first fetch completes.
  const refBtcPrice = krakenPrice || grvtPrice || liveBtcPrice || 100000;
  const maxQty = Math.max(parseFloat(buyQty) || 0, parseFloat(sellQty) || 0);
  // Shared helper — must match ConfigPanel exactly so sidebar = confirm modal.
  const { minBalanceUsd: minBalance } = computeRequiredBalance({
    qtyBtc: maxQty,
    btcPrice: refBtcPrice,
    leverage: Number(leverage) || 1,
    isMargin: isKrakenMargin,
  });

  const formatPrice = (price) => {
    if (!price) return '—';
    return `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  // Stop button handler — behaviour depends on trading mode
  const handleStopClick = () => {
    if (isKrakenSolo) {
      // Kraken solo: graceful stop (wait for cycle) + show popup
      setStoppingGraceful(true);
      onStopGraceful();
    } else {
      // Kraken+GRVT: close positions immediately (old Ctrl+C logic)
      onStopForceClose();
    }
  };

  // Force-close from popup (Kraken solo only)
  const handleForceCloseClick = () => {
    setStoppingGraceful(false);
    onStopForceClose();
  };

  return (
    <div className="dashboard">
      {/* Trading Mode Selector / Title — Top Level */}
      {!botRunning ? (
        (() => {
          const modeList = ['kraken-grvt', 'kraken-future', 'kraken-margin'];
          const activeIndex = Math.max(0, modeList.indexOf(tradingMode));
          return (
            <div className="dash-mode-selector">
              <div
                className="dash-mode-indicator"
                style={{
                  left: `calc(3px + (100% - 6px) / 3 * ${activeIndex})`,
                }}
              />
              <button
                className={`dash-mode-btn ${tradingMode === 'kraken-grvt' ? 'active' : ''}`}
                onClick={() => onTradingModeChange('kraken-grvt')}
              >
                Kraken & GRVT Arbitrage
              </button>
              <button
                className={`dash-mode-btn ${tradingMode === 'kraken-future' ? 'active' : ''}`}
                onClick={() => onTradingModeChange('kraken-future')}
              >
                Kraken Future
              </button>
              <button
                className={`dash-mode-btn ${tradingMode === 'kraken-margin' ? 'active' : ''}`}
                onClick={() => onTradingModeChange('kraken-margin')}
              >
                Kraken Margin
              </button>
            </div>
          );
        })()
      ) : (
        <div className="dash-mode-title">
          {tradingMode === 'kraken-future' ? 'Kraken Future Trade' : tradingMode === 'kraken-margin' ? 'Kraken Margin Trade' : 'Kraken & GRVT Arbitrage Strategy'}
        </div>
      )}

      {/* Confirm Modal */}
      {showConfirm && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowConfirm(false); }}>
          <div className="confirm-modal">
            <button
              type="button"
              className="confirm-modal-close"
              onClick={() => setShowConfirm(false)}
              aria-label="Close"
            >
              ×
            </button>
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
                <span className="confirm-modal-value">{isKrakenMargin ? '10x' : `${leverage}x`}</span>
              </div>
              {(isKrakenFuture || isKrakenMargin) && minBalance > 0 && (
                <div className="confirm-modal-row confirm-modal-balance-row">
                  <span className="confirm-modal-label">
                    Required {isKrakenFuture ? 'Futures' : 'Spot'} Balance
                  </span>
                  <span className="confirm-modal-value confirm-modal-balance-value">
                    {minBalance.toLocaleString()} USD
                  </span>
                </div>
              )}
            </div>
            <label className="confirm-modal-check">
              <input
                type="checkbox"
                checked={balanceConfirmed}
                onChange={(e) => setBalanceConfirmed(e.target.checked)}
              />
              <span>
                I have enough balance in my <strong>{isKrakenMargin ? 'spot' : 'future'} account</strong>.
              </span>
            </label>
            <div className="confirm-modal-actions">
              <button className="btn confirm-btn-edit" onClick={() => setShowConfirm(false)} style={{ flex: 1 }}>
                Edit
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { setShowConfirm(false); onStart(); }}
                disabled={!balanceConfirmed}
                style={{ flex: 1, opacity: balanceConfirmed ? 1 : 0.5, cursor: balanceConfirmed ? 'pointer' : 'not-allowed' }}
              >
                Confirm & Start
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
                if (err.fix.action.restart && !window._restarting) { window._restarting = true; onStop(); setTimeout(() => { onStart(); window._restarting = false; }, 2000); }
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
        {botRunning && !isError && (
          <div className="dash-sleep-reminder">
            Please <strong>do not let your computer enter sleep mode</strong> while the bot is running.
          </div>
        )}
      </div>

      {/* Action Button */}
      <div className="dash-actions">
        {botRunning ? (
          <div className="dash-actions-row">
            <button className="btn btn-danger dash-action-btn" onClick={handleStopClick}>
              Stop Bot
            </button>
            {isError && recentErrors.length > 0 && (
              <button className="btn dash-restart-btn" onClick={() => { if (!window._restarting) { window._restarting = true; onStop(); setTimeout(() => { onStart(); window._restarting = false; }, 2000); } }}>
                Restart Bot
              </button>
            )}
          </div>
        ) : (
          <button className="btn btn-primary dash-action-btn" onClick={() => setShowConfirm(true)}>
            {isKrakenFuture
              ? 'Log In & Trade Kraken Future'
              : isKrakenMargin
                ? 'Log In & Trade Kraken Margin'
                : 'Log In & Start Trading'}
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
          {!isKrakenSolo && (
            <>
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
            </>
          )}
        </div>
      </div>

      {/* Stats + Check P&L */}
      <div className="dash-section">
        <div className="dash-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Performance
          <button className={`dash-refresh-btn ${isRefreshing ? 'spinning' : ''}`} onClick={() => { setRefreshKey(k => k + 1); setIsRefreshing(true); setTimeout(() => setIsRefreshing(false), 600); }} title="Refresh dashboard">
            <img src={refreshIcon} alt="" className="dash-refresh-icon" />
            <span className="dash-refresh-label">Refresh</span>
          </button>
        </div>
        <div className="dash-stats">
          <div className="dash-stat">
            <span className="dash-stat-value">{cycle || '—'}</span>
            <span className="dash-stat-label">Cycles</span>
          </div>
          <div className="dash-stat-divider" />
          {isKrakenSolo ? (
            <>
              {/* Kraken Future / Margin: show live position instead of cumulative trade count */}
              <div className="dash-stat">
                <span
                  className="dash-stat-value"
                  style={openSide ? { color: openSide === 'BUY' ? 'var(--green)' : 'var(--red)' } : undefined}
                >
                  {openSide || '—'}
                </span>
                <span className="dash-stat-label">Open Side</span>
              </div>
              <div className="dash-stat-divider" />
              <div className="dash-stat">
                <span className="dash-stat-value">
                  {entryPrice != null ? `$${Number(entryPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
                </span>
                <span className="dash-stat-label">Entry</span>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
        <div className="dash-pnl-row">
          <button className="btn dash-pnl-btn" onClick={handleOpenExchanges}>
            {isKrakenSolo ? 'Check P&L on Kraken' : 'Check P&L on Kraken & GRVT'}
          </button>
          <p className="dash-pnl-note">
            Do not click any elements in the bot's browser windows while running. Open separate browser windows to check P&L.
          </p>
        </div>
      </div>

      {/* Graceful-stop popup — shown while waiting for the current cycle to finish */}
      {stoppingGraceful && (
        <div className="modal-overlay">
          <div className="confirm-modal stopping-modal">
            <div className="stopping-dots">
              <span /><span /><span />
            </div>
            <h2 className="stopping-title">Bot will stop after this cycle</h2>
            <p className="stopping-subtitle">It usually takes 30–300s to complete.</p>
            <button
              className="btn btn-force-close-subtle"
              onClick={handleForceCloseClick}
            >
              Immediately close all positions
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
