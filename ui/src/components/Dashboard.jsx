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

const EXCHANGE_LINKS = [
  { name: 'Kraken', url: 'https://pro.kraken.com/app/trade/futures-btc-usd-perp' },
  { name: 'GRVT', url: 'https://grvt.io/exchange/perpetual/BTC-USDT' },
];

export default function Dashboard({ status, botRunning, logs, onStart, onStop }) {
  const api = window.electronAPI;
  const prices = status.prices || {};
  const cycle = status.cycle || 0;
  const priceDiff = status.priceDiff ?? null;
  const cycleTime = status.cycleTime ?? null;
  const tradesExecuted = status.tradesExecuted || 0;
  const positions = status.positions || {};
  const pnl = status.pnl ?? null;

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

  const speedLabel = cycleTime
    ? cycleTime < 1000 ? `${cycleTime}ms` : `${(cycleTime / 1000).toFixed(1)}s`
    : '--';

  const cyclesPerMin = cycleTime && cycleTime > 0 ? Math.round(60000 / cycleTime) : null;

  return (
    <div className="dashboard">
      {/* Status Banner */}
      <div className={`status-banner ${botRunning ? 'running' : 'stopped'}`}>
        <div className="status-banner-left">
          <span className={`status-pulse ${botRunning ? 'active' : ''}`} />
          <div>
            <span className="status-banner-title">
              {botRunning ? 'Bot Running' : 'Bot Stopped'}
            </span>
            {botRunning && (
              <span className="status-banner-uptime">Uptime: {formatUptime(uptime)}</span>
            )}
          </div>
        </div>
        <span className="status-banner-mode">Kraken + GRVT Arbitrage</span>
      </div>

      {/* Core Action Button */}
      <div style={{ padding: '0 0 12px' }}>
        {botRunning ? (
          <button className="btn btn-danger" onClick={onStop}
            style={{ width: '100%', padding: '14px', fontSize: 15, fontWeight: 600 }}>
            Stop Bot
          </button>
        ) : (
          <button className="btn btn-primary" onClick={onStart}
            style={{ width: '100%', padding: '14px', fontSize: 15, fontWeight: 600 }}>
            Log In & Start Trading
          </button>
        )}
        {!botRunning && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6 }}>
            Opens Kraken & GRVT in Chrome — log in, then trading starts automatically
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="quick-links">
        {EXCHANGE_LINKS.map((ex) => (
          <button
            key={ex.name}
            className="btn btn-sm btn-ghost"
            onClick={() => api ? api.openExternal(ex.url) : window.open(ex.url, '_blank')}
          >
            <span>{'\u2197'}</span> {ex.name}
          </button>
        ))}
      </div>

      {/* Price Cards - Prominent */}
      <div className="price-row">
        <div className="price-card">
          <div className="price-exchange">Kraken</div>
          <div className="price-value">
            {prices.kraken ? `$${Number(prices.kraken).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'}
          </div>
        </div>
        <div className="price-spread-indicator">
          <div className="spread-label">Spread</div>
          <div className={`spread-value ${priceDiff !== null ? (Math.abs(priceDiff) >= 5 ? 'high' : 'low') : ''}`}>
            {priceDiff !== null ? `$${Math.abs(priceDiff).toFixed(2)}` : '--'}
          </div>
        </div>
        <div className="price-card">
          <div className="price-exchange">GRVT</div>
          <div className="price-value">
            {prices.grvt ? `$${Number(prices.grvt).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'}
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="card-title">Performance</div>
      <div className="dashboard-grid">
        <div className="stat-card">
          <div className="stat-label">Cycle Speed</div>
          <div className="stat-value">{speedLabel}</div>
          {cyclesPerMin && <div className="stat-sub">{cyclesPerMin} cycles/min</div>}
        </div>
        <div className="stat-card">
          <div className="stat-label">Cycles</div>
          <div className="stat-value">{cycle || '--'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Trades</div>
          <div className="stat-value">{tradesExecuted || '--'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">P&L</div>
          <div className={`stat-value ${pnl !== null ? (pnl >= 0 ? 'positive' : 'negative') : ''}`}>
            {pnl !== null ? `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '--'}
          </div>
        </div>
      </div>

      {/* Errors */}
      {recentErrors.length > 0 && (
        <div className="error-section">
          <div className="card-title" style={{ color: 'var(--red)' }}>
            Errors ({recentErrors.length})
          </div>
          <div className="error-list">
            {recentErrors.map((err, i) => (
              <div key={i} className="error-item">
                <div className="error-time">{err.time}</div>
                <div className="error-message">{err.message}</div>
                {err.fix && (
                  <div className="error-fix">
                    <span className="error-fix-icon">{'\u2139'}</span>
                    {err.fix}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!botRunning && recentErrors.length === 0 && (
        <div className="dashboard-empty">
          <div className="dashboard-empty-icon">{'\u26A1'}</div>
          <p>Configure your settings and click <strong>Log In & Start Trading</strong> above to begin.</p>
        </div>
      )}
    </div>
  );
}
