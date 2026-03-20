import { useState, useEffect } from 'react';

const QTY_FIELDS = [
  { key: 'BUY_QTY', label: 'Buy Quantity (BTC)', step: '0.0001', placeholder: '0.001' },
  { key: 'SELL_QTY', label: 'Sell Quantity (BTC)', step: '0.0001', placeholder: '0.001' },
];

const LEVERAGE_STEPS = [1, 5, 10, 20, 30, 40, 50];

export default function ConfigPanel({ config, onSave, disabled, onSwitchAccount }) {
  const [localConfig, setLocalConfig] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    setLocalConfig({ ...config });
  }, [config]);

  const handleChange = (key, value) => {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
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
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span className="card-title" style={{ margin: 0 }}>Settings</span>
        <button
          className={`btn btn-sm ${saved ? 'btn-success' : 'btn-primary'}`}
          onClick={handleSave}
          disabled={saving || disabled}
        >
          {saving ? 'Saving...' : saved ? '\u2713 Saved' : 'Save'}
        </button>
      </div>

      {/* Trading Quantities */}
      <div className="config-section-title">Trade Size</div>

      {QTY_FIELDS.map((field) => (
        <div className="config-group" key={field.key}>
          <label className="config-label">{field.label}</label>
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
      ))}

      <div className="config-divider" />

      {/* Leverage */}
      <div className="config-section-title">Leverage</div>

      <div className="config-group">
        <label className="config-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Multiplier</span>
          <span style={{ color: leverageColor, fontWeight: 700, fontSize: 16, fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
            {leverage}x
          </span>
        </label>

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
      </div>

      <div className="config-divider" />

      {/* Advanced */}
      <button
        className="btn btn-sm btn-ghost"
        onClick={() => setShowAdvanced(!showAdvanced)}
        style={{ width: '100%', marginBottom: 8 }}
      >
        {showAdvanced ? 'Hide' : 'Show'} Advanced Settings
      </button>

      {showAdvanced && (
        <div className="advanced-settings">
          <div className="config-group">
            <label className="config-label">Stop Loss ($)</label>
            <input
              className="config-input mono"
              type="number"
              step="0.1"
              min="0"
              value={localConfig.STOP_LOSS || ''}
              onChange={(e) => handleChange('STOP_LOSS', e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="config-group">
            <label className="config-label">Take Profit ($)</label>
            <input
              className="config-input mono"
              type="number"
              step="0.1"
              min="0"
              value={localConfig.TAKE_PROFIT || ''}
              onChange={(e) => handleChange('TAKE_PROFIT', e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="config-group">
            <label className="config-label">Opening Threshold ($)</label>
            <input
              className="config-input mono"
              type="number"
              step="0.5"
              min="0"
              value={localConfig.OPENING_THRESHOLD || ''}
              onChange={(e) => handleChange('OPENING_THRESHOLD', e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="config-group">
            <label className="config-label">Closing Threshold ($)</label>
            <input
              className="config-input mono"
              type="number"
              step="0.5"
              min="0"
              value={localConfig.CLOSING_THRESHOLD || ''}
              onChange={(e) => handleChange('CLOSING_THRESHOLD', e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="config-group">
            <label className="config-label">Trade Hold Time (ms)</label>
            <input
              className="config-input mono"
              type="number"
              step="1000"
              min="1000"
              value={localConfig.TRADE_TIME || ''}
              onChange={(e) => handleChange('TRADE_TIME', e.target.value)}
              disabled={disabled}
            />
          </div>
        </div>
      )}

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
