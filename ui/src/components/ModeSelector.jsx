import { useState } from 'react';

const TRADING_MODES = [
  {
    mode: '3d',
    label: 'Kraken + GRVT',
    desc: 'Arbitrage between Kraken and GRVT',
    exchanges: ['kraken', 'grvt'],
    accountCount: 2,
  },
];

const TEST_MODES = [
  {
    mode: '3a',
    label: 'Test Kraken',
    desc: 'Single exchange test (BUY + SELL)',
    testExchange: 'kraken',
    accountCount: 1,
  },
  {
    mode: '3b',
    label: 'Test GRVT',
    desc: 'Single exchange test (BUY + SELL)',
    testExchange: 'grvt',
    accountCount: 1,
  },
];

export default function ModeSelector({ onSelect }) {
  const [selected, setSelected] = useState(null);

  const handleSelect = (modeConfig) => {
    setSelected(modeConfig.mode);
  };

  const handleStart = () => {
    const allModes = [...TRADING_MODES, ...TEST_MODES];
    const modeConfig = allModes.find((m) => m.mode === selected);
    if (modeConfig) {
      onSelect({
        mode: modeConfig.mode,
        description: `${modeConfig.label} - ${modeConfig.desc}`,
        buyExchange: modeConfig.buyExchange,
        sellExchange: modeConfig.sellExchange,
        exchanges: modeConfig.exchanges,
        testExchange: modeConfig.testExchange,
        accountCount: modeConfig.accountCount,
      });
    }
  };

  const renderCard = (m) => (
    <div
      key={m.mode}
      className={`mode-card ${selected === m.mode ? 'selected' : ''}`}
      onClick={() => handleSelect(m)}
    >
      {m.badge && <span className="mode-badge">{m.badge}</span>}
      <div className="mode-label">{m.label}</div>
      <div className="mode-desc">{m.desc}</div>
    </div>
  );

  return (
    <div className="mode-selector">
      <h2>Select Trading Mode</h2>
      <p>Choose a trading strategy to start the bot.</p>

      <div className="mode-grid">
        {TRADING_MODES.map(renderCard)}

        <div className="mode-section-title">Testing Modes</div>
        {TEST_MODES.map(renderCard)}
      </div>

      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <button
          className="btn btn-primary"
          disabled={selected === null}
          onClick={handleStart}
          style={{ padding: '10px 40px', fontSize: 14 }}
        >
          Start Bot
        </button>
      </div>
    </div>
  );
}
