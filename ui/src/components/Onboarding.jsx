import { useState } from 'react';
import krakenLogo from '../assets/kraken-logo.svg';
import grvtLogo from '../assets/grvt-logo.svg';
import bgSvg from '../assets/bg2.svg';

const STRATEGIES = [
  {
    key: 'kraken-grvt',
    tabLabel: 'Kraken + GRVT',
    title: (
      <>Kraken &amp; GRVT<br />Arbitrage Strategy</>
    ),
    description:
      'Complete the setup for both exchanges, then start earning from price differences automatically.',
  },
  {
    key: 'kraken-future',
    tabLabel: 'Kraken Future',
    title: (
      <>Kraken Futures<br />Directional Strategy</>
    ),
    description:
      'Trade BTC futures on Kraken with the bot opening and closing leveraged positions for you.',
  },
  {
    key: 'kraken-margin',
    tabLabel: 'Kraken Margin',
    title: (
      <>Kraken Margin<br />Directional Strategy</>
    ),
    description:
      'Trade BTC on Kraken spot with margin, using a fixed 10x leverage managed by the bot.',
  },
];

const KRAKEN_FUTURE_STEPS = [
  { text: <span>Register a Kraken account</span> },
  { text: <span><strong style={{ color: '#fff' }}>Complete KYC verification</strong></span> },
  { text: <span><strong style={{ color: '#fff' }}>Enable Futures trading</strong>&nbsp; in settings</span> },
  { text: <span>Deposit USDT or USD</span> },
  { text: <span><strong style={{ color: '#fff' }}>Transfer funds: Spot → Futures wallet</strong></span> },
];

const KRAKEN_MARGIN_STEPS = [
  { text: <span>Register a Kraken account</span> },
  { text: <span><strong style={{ color: '#fff' }}>Complete KYC verification</strong></span> },
  { text: <span><strong style={{ color: '#fff' }}>Enable Margin trading</strong>&nbsp; in settings</span> },
  { text: <span>Deposit USDT or USD into your Spot wallet</span> },
];

const GRVT_STEPS = [
  { text: <span>Register a GRVT account</span> },
  { text: <span>Complete account verification</span> },
  { text: <span><strong style={{ color: '#fff' }}>Deposit USDT to your trading account</strong></span> },
];

const stepStyle = { display: 'flex', gap: 10, alignItems: 'baseline' };
const numStyle = {
  color: 'var(--text-muted)',
  minWidth: 20,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
};

function StepsList({ steps }) {
  return (
    <div
      style={{
        fontSize: 12.5,
        color: 'var(--text-secondary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        marginBottom: 16,
        lineHeight: 1.55,
        fontFamily: "'Plus Jakarta Sans', var(--font-body)",
      }}
    >
      {steps.map((s, i) => (
        <div key={i} style={stepStyle}>
          <span style={numStyle}>{String(i + 1).padStart(2, '0')}</span>
          {s.text}
        </div>
      ))}
    </div>
  );
}

function ExchangeCard({ logo, alt, steps, signupUrl, signupLabel, onOpenUrl }) {
  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '20px 22px' }}>
      <img
        src={logo}
        alt={alt}
        style={{ height: 13, marginBottom: 14, display: 'block', opacity: 0.85 }}
      />
      <StepsList steps={steps} />
      <button onClick={() => onOpenUrl(signupUrl)} className="signup-btn">
        <span>{signupLabel}</span>
        <span style={{ fontSize: 14, opacity: 0.4 }}>→</span>
      </button>
    </div>
  );
}

export default function Onboarding({ onComplete }) {
  const api = window.electronAPI;
  const [activeKey, setActiveKey] = useState('kraken-grvt');
  const active = STRATEGIES.find((s) => s.key === activeKey) || STRATEGIES[0];
  const activeIndex = STRATEGIES.findIndex((s) => s.key === activeKey);

  const openUrl = (url) => {
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank');
  };

  const krakenCard = (
    <ExchangeCard
      logo={krakenLogo}
      alt="Kraken"
      steps={activeKey === 'kraken-margin' ? KRAKEN_MARGIN_STEPS : KRAKEN_FUTURE_STEPS}
      signupUrl="https://kraken.pxf.io/VxoaX3"
      signupLabel="Sign up with Kraken"
      onOpenUrl={openUrl}
    />
  );

  const grvtCard = (
    <ExchangeCard
      logo={grvtLogo}
      alt="GRVT"
      steps={GRVT_STEPS}
      signupUrl="https://grvt.io"
      signupLabel="Sign up with GRVT"
      onOpenUrl={openUrl}
    />
  );

  return (
    <div style={{ position: 'relative', overflow: 'hidden', height: 'calc(100vh - 40px)' }}>
      {/* Background SVG */}
      <img
        src={bgSvg}
        alt=""
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      {/* Gradient button animation */}
      <style>{`
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .ready-btn {
          background: linear-gradient(135deg, #289EFF, #5DD4A8, #82FF15, #289EFF);
          background-size: 300% 300%;
          animation: gradientShift 8s ease infinite;
          transition: transform 0.2s ease, filter 0.2s ease;
        }
        .ready-btn:hover {
          transform: translateY(-1px);
          filter: brightness(1.05);
        }
        .ready-btn:active {
          transform: translateY(0px);
        }
        .signup-btn {
          padding: 10px 16px;
          font-size: 13px;
          background: #fff;
          color: #0a0a0a;
          border: none;
          font-weight: 600;
          border-radius: 10px;
          cursor: pointer;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: background 0.2s ease, transform 0.15s ease;
          font-family: 'Plus Jakarta Sans', sans-serif;
          letter-spacing: -0.2px;
        }
        .signup-btn:hover {
          background: #e0e0e0;
          transform: translateY(-1px);
        }
        .signup-btn:active {
          background: #d0d0d0;
          transform: translateY(0px);
        }
        .onboarding-tabs {
          position: relative;
          display: inline-flex;
          padding: 3px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          margin-bottom: 22px;
        }
        .onboarding-tab {
          position: relative;
          z-index: 1;
          padding: 8px 16px;
          font-size: 12.5px;
          font-weight: 600;
          color: var(--text-muted);
          background: transparent;
          border: none;
          border-radius: 9px;
          cursor: pointer;
          font-family: 'Plus Jakarta Sans', sans-serif;
          letter-spacing: -0.1px;
          transition: color 0.2s ease;
          white-space: nowrap;
        }
        .onboarding-tab.active {
          color: #fff;
        }
        .onboarding-tab-indicator {
          position: absolute;
          top: 3px;
          bottom: 3px;
          width: calc((100% - 6px) / 3);
          background: rgba(255, 255, 255, 0.08);
          border-radius: 9px;
          transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          z-index: 0;
        }
      `}</style>

      {/* Content */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '32px 56px',
          gap: 80,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Left side — tabs + title + CTA */}
        <div style={{ flex: '0 0 340px' }}>
          <div className="onboarding-tabs">
            <div
              className="onboarding-tab-indicator"
              style={{ left: `calc(3px + (100% - 6px) / 3 * ${activeIndex})` }}
            />
            {STRATEGIES.map((s) => (
              <button
                key={s.key}
                className={`onboarding-tab ${activeKey === s.key ? 'active' : ''}`}
                onClick={() => setActiveKey(s.key)}
              >
                {s.tabLabel}
              </button>
            ))}
          </div>

          <h2
            style={{
              fontFamily: "'Space Grotesk', var(--font-heading)",
              fontSize: 36,
              marginBottom: 18,
              letterSpacing: '-0.04em',
              fontWeight: 600,
              lineHeight: 1.2,
              color: '#fff',
            }}
          >
            {active.title}
          </h2>
          <p
            style={{
              fontFamily: "'Plus Jakarta Sans', var(--font-body)",
              color: 'var(--text-muted)',
              fontSize: 14,
              marginBottom: 28,
              lineHeight: 1.7,
            }}
          >
            {active.description}
          </p>

          <button
            onClick={() => onComplete?.(activeKey)}
            className="ready-btn"
            style={{
              padding: '11px 32px',
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 10,
              color: '#111',
              border: 'none',
              cursor: 'pointer',
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              letterSpacing: '-0.01em',
            }}
          >
            I'm ready — start trading
          </button>
        </div>

        {/* Right side — exchange cards for the active strategy */}
        <div
          style={{
            flex: '0 1 390px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {activeKey === 'kraken-grvt' && (
            <>
              {krakenCard}
              {grvtCard}
            </>
          )}
          {activeKey === 'kraken-future' && krakenCard}
          {activeKey === 'kraken-margin' && krakenCard}
        </div>
      </div>
    </div>
  );
}
