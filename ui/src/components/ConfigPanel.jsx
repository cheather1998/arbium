import { useState, useEffect } from 'react';

const QTY_FIELDS = [
  { key: 'BUY_QTY', label: 'Buy Quantity (BTC)', step: '0.0001', placeholder: '0.001' },
  { key: 'SELL_QTY', label: 'Sell Quantity (BTC)', step: '0.0001', placeholder: '0.001' },
];

const LEVERAGE_STEPS = [1, 5, 10, 20, 30, 40, 50];

export default function ConfigPanel({ config, onSave, disabled, onSwitchAccount, btcPrice }) {
  const [localConfig, setLocalConfig] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [liveBtcPrice, setLiveBtcPrice] = useState(null);

  // Fetch BTC price on mount for USD reference (independent of bot)
  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        const data = await res.json();
        if (data?.bitcoin?.usd) setLiveBtcPrice(data.bitcoin.usd);
      } catch { /* ignore */ }
    };
    fetchPrice();
    const interval = setInterval(fetchPrice, 60000); // refresh every 60s
    return () => clearInterval(interval);
  }, []);

  // Use bot price if available, otherwise use fetched price
  const refPrice = btcPrice || liveBtcPrice;

  useEffect(() => {
    setLocalConfig({ ...config });
  }, [config]);

  const handleChange = (key, value) => {
    const updated = { ...localConfig, [key]: value };
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
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <span className="card-title" style={{ margin: 0 }}>Settings</span>
      </div>

      {/* Trading Quantities */}
      <div className="config-section-title">Trade Size</div>

      {QTY_FIELDS.map((field) => {
        const btcVal = parseFloat(localConfig[field.key]) || 0;
        const usdText = refPrice && btcVal
          ? `$${(btcVal * refPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
          : null;

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
              {usdText && <span className="config-qty-usd">{usdText}</span>}
            </div>
          </div>
        );
      })}

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
