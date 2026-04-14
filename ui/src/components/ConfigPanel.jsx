import { useState, useEffect } from 'react';
import { computeRequiredBalance } from '../lib/requiredBalance';

const QTY_FIELDS = [
  { key: 'BUY_QTY', label: 'Buy Quantity (BTC)', step: '0.00001', placeholder: '0.00001' },
  { key: 'SELL_QTY', label: 'Sell Quantity (BTC)', step: '0.00001', placeholder: '0.00001' },
];

const LEVERAGE_STEPS_DEFAULT = [1, 5, 10, 20, 30, 40, 50];
const MARGIN_FIXED_LEVERAGE = 10;

// Per-mode quantity storage — each mode keeps independent BUY/SELL values
function loadModeQty(mode) {
  try {
    const raw = localStorage.getItem(`qty_${mode}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveModeQty(mode, buy, sell) {
  try {
    localStorage.setItem(`qty_${mode}`, JSON.stringify({ BUY_QTY: buy, SELL_QTY: sell }));
  } catch {}
}

export default function ConfigPanel({ config, onSave, disabled, onSwitchAccount, btcPrice, liveBtcPrice, tradingMode }) {
  const isMargin = tradingMode === 'kraken-margin';
  const LEVERAGE_STEPS = LEVERAGE_STEPS_DEFAULT;
  const [localConfig, setLocalConfig] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Shared reference price: prefer bot's live feed when running, otherwise
  // the app-level `liveBtcPrice` fetched in App.jsx (same source as Dashboard).
  const refPrice = btcPrice || liveBtcPrice;

  useEffect(() => {
    setLocalConfig({ ...config });
  }, [config]);

  // When trading mode changes: load mode-specific BUY/SELL quantities and enforce margin leverage
  useEffect(() => {
    if (!tradingMode) return;
    const saved = loadModeQty(tradingMode);
    const updates = {};
    if (saved) {
      updates.BUY_QTY = saved.BUY_QTY;
      updates.SELL_QTY = saved.SELL_QTY;
    } else {
      // First time in this mode — seed localStorage from current config values
      saveModeQty(tradingMode, localConfig.BUY_QTY || '', localConfig.SELL_QTY || '');
    }
    if (isMargin && Number(localConfig.LEVERAGE) !== MARGIN_FIXED_LEVERAGE) {
      updates.LEVERAGE = String(MARGIN_FIXED_LEVERAGE);
    }
    if (Object.keys(updates).length > 0) {
      const updated = { ...localConfig, ...updates };
      setLocalConfig(updated);
      onSave(updated);
    }
  }, [tradingMode]);

  const handleChange = (key, value) => {
    const updated = { ...localConfig, [key]: value };
    // Keep BUY_QTY and SELL_QTY in sync within the current mode only
    if (key === 'BUY_QTY') updated.SELL_QTY = value;
    if (key === 'SELL_QTY') updated.BUY_QTY = value;
    // Persist per-mode quantities
    if (key === 'BUY_QTY' || key === 'SELL_QTY') {
      saveModeQty(tradingMode, updated.BUY_QTY, updated.SELL_QTY);
    }
    setLocalConfig(updated);
    setSaved(false);
    // Auto-save on change
    onSave(updated);
  };

  const handleSave = async () => {
    setSaving(true);
    const result = await onSave(localConfig);
    setSaving(false);
    if (result.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const leverage = Number(localConfig.LEVERAGE) || 1;
  const stepIndex = LEVERAGE_STEPS.indexOf(leverage) !== -1
    ? LEVERAGE_STEPS.indexOf(leverage)
    : LEVERAGE_STEPS.reduce((best, val, i) => Math.abs(val - leverage) < Math.abs(LEVERAGE_STEPS[best] - leverage) ? i : best, 0);
  const fillPercent = (stepIndex / (LEVERAGE_STEPS.length - 1)) * 100;

  // Parse EXCHANGE_ACCOUNTS
  const exchangeAccounts = localConfig.EXCHANGE_ACCOUNTS || '';
  const parseAccounts = () => {
    const map = {};
    exchangeAccounts.split(',').forEach((entry) => {
      const [exchange, email] = entry.trim().split(':');
      if (exchange && email) map[exchange.trim()] = email.trim();
    });
    return map;
  };
  const accounts = parseAccounts();

  const handleAccountChange = (exchange, email) => {
    const updated = { ...accounts, [exchange]: email };
    const newVal = Object.entries(updated).map(([k, v]) => `${k}:${v}`).join(',');
    handleChange('EXCHANGE_ACCOUNTS', newVal);
    handleChange('ACCOUNT_EMAILS', Object.values(updated).join(','));
  };

  // Leverage warning color
  const leverageColor = leverage >= 30 ? 'var(--red)' : leverage >= 10 ? 'var(--yellow)' : 'var(--green)';

  return (
    <div className="config-panel">
      {/* Trading Quantities */}
      {QTY_FIELDS.map((field) => {
        const btcVal = parseFloat(localConfig[field.key]) || 0;
        const isKrakenSolo = tradingMode === 'kraken-future' || tradingMode === 'kraken-margin';

        // Uses the SHARED helper so this value matches the Dashboard confirm modal.
        const { minBalanceUsd: minBalance } = computeRequiredBalance({
          qtyBtc: btcVal,
          btcPrice: refPrice,
          leverage: Number(localConfig.LEVERAGE) || 1,
          isMargin,
        });
        const hintLabel = isMargin ? 'Required spot balance' : 'Required future balance';

        return (
          <div className="config-group" key={field.key}>
            <label className="config-label">{field.label}</label>
            <div className="config-input-wrap">
              <input
                className="config-input mono"
                type="number"
                step={field.step}
                min="0"
                placeholder={field.placeholder}
                value={localConfig[field.key] || ''}
                onChange={(e) => handleChange(field.key, e.target.value)}
                disabled={disabled}
              />
            </div>
            {isKrakenSolo && btcVal > 0 && (
              <div className="config-balance-hint">
                <span>{hintLabel}</span>
                <strong>
                  {minBalance > 0 ? `${minBalance.toLocaleString()} USD` : '…'}
                </strong>
              </div>
            )}
          </div>
        );
      })}

      <div className="config-divider" />

      {/* Leverage */}
      <div className="config-group">
        <label className="config-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Leverage</span>
          <span style={{ color: isMargin ? 'var(--yellow)' : leverageColor, fontWeight: 700, fontSize: 16, fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
            {isMargin ? `${MARGIN_FIXED_LEVERAGE}x` : `${leverage}x`}
          </span>
        </label>

        {isMargin ? (
          <div className="config-warning" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', borderColor: 'rgba(255,255,255,0.08)' }}>
            Kraken Margin Trade uses a fixed leverage of {MARGIN_FIXED_LEVERAGE}x.
          </div>
        ) : (
          <>
            <div className="leverage-slider-wrap">
              <input
                type="range"
                min={0}
                max={LEVERAGE_STEPS.length - 1}
                step="1"
                value={stepIndex}
                onChange={(e) => handleChange('LEVERAGE', String(LEVERAGE_STEPS[Number(e.target.value)]))}
                disabled={disabled}
                className="leverage-slider"
                style={{
                  background: `linear-gradient(to right, ${leverageColor} ${fillPercent}%, var(--border) ${fillPercent}%)`,
                  '--slider-color': leverageColor,
                }}
              />
              <div className="leverage-labels">
                {LEVERAGE_STEPS.map((v) => (
                  <span key={v} className={v === leverage ? 'active' : ''} style={v === leverage ? { color: leverageColor } : undefined}>
                    {v}x
                  </span>
                ))}
              </div>
            </div>

            {leverage >= 30 && (
              <div className="config-warning">
                High leverage increases liquidation risk significantly.
              </div>
            )}
          </>
        )}
      </div>


      {onSwitchAccount && (
        <>
          <div className="config-divider" />
          <button
            className="btn btn-sm btn-ghost"
            onClick={onSwitchAccount}
            disabled={disabled}
            style={{ width: '100%', fontSize: 12, color: 'var(--text-muted)' }}
          >
            Back to Setup
          </button>
        </>
      )}
    </div>
  );
}
