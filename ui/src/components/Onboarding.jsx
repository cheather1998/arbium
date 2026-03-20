import krakenLogo from '../assets/kraken-logo.svg';
import grvtLogo from '../assets/grvt-logo.svg';

export default function Onboarding({ onComplete }) {
  const api = window.electronAPI;

  const openUrl = (url) => {
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank');
  };

  const stepStyle = { display: 'flex', gap: 10, alignItems: 'baseline' };
  const numStyle = { color: 'var(--text-muted)', minWidth: 20, fontFamily: 'var(--font-mono)', fontSize: 11 };
  const linkBtn = {
    padding: '10px 0', fontSize: 14, background: 'var(--accent-gradient)', color: '#242222',
    border: 'none', fontWeight: 600, borderRadius: 10, cursor: 'pointer', width: '100%',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'opacity 0.15s',
  };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '48px 24px' }}>
      <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: 28, marginBottom: 8, letterSpacing: '-0.03em', fontWeight: 500 }}>
        GRVT & Kraken Arbitrage Strategy
      </h2>
      <p style={{ fontFamily: 'var(--font-body)', color: 'var(--text-muted)', fontSize: 14, marginBottom: 36, lineHeight: 1.5 }}>
        Complete the steps below for both exchanges before you start trading.
      </p>

      {/* Kraken */}
      <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '22px 24px', marginBottom: 12 }}>
        <img src={krakenLogo} alt="Kraken" style={{ height: 18, marginBottom: 16, display: 'block' }} />

        <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 18, lineHeight: 1.55 }}>
          <div style={stepStyle}>
            <span style={numStyle}>01</span>
            <span>Register a Kraken account</span>
          </div>
          <div style={stepStyle}>
            <span style={numStyle}>02</span>
            <span><strong style={{ color: '#fff' }}>Complete KYC identity verification</strong> — required for futures</span>
          </div>
          <div style={stepStyle}>
            <span style={numStyle}>03</span>
            <span><strong style={{ color: '#fff' }}>Enable Futures trading</strong> in account settings</span>
          </div>
          <div style={stepStyle}>
            <span style={numStyle}>04</span>
            <span>Deposit USDT or USD to your Kraken account</span>
          </div>
          <div style={{ ...stepStyle, background: 'rgba(255,255,255,0.04)', margin: '2px -12px', padding: '10px 12px', borderRadius: 8 }}>
            <span style={numStyle}>05</span>
            <span style={{ color: '#fff', fontWeight: 500 }}>
              Transfer funds from Spot to Futures wallet
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => openUrl('https://kraken.pxf.io/VxoaX3')} style={linkBtn}>
            Register Kraken with us <span style={{ fontSize: 13, opacity: 0.6 }}>{'\u2197'}</span>
          </button>
        </div>
      </div>

      {/* GRVT */}
      <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '22px 24px', marginBottom: 32 }}>
        <img src={grvtLogo} alt="GRVT" style={{ height: 18, marginBottom: 16, display: 'block' }} />

        <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 18, lineHeight: 1.55 }}>
          <div style={stepStyle}>
            <span style={numStyle}>01</span>
            <span>Register a GRVT account</span>
          </div>
          <div style={stepStyle}>
            <span style={numStyle}>02</span>
            <span>Complete account verification</span>
          </div>
          <div style={stepStyle}>
            <span style={numStyle}>03</span>
            <span>Deposit USDT to your GRVT trading account</span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => openUrl('https://grvt.io')} style={linkBtn}>
            Register GRVT <span style={{ fontSize: 13, opacity: 0.6 }}>{'\u2197'}</span>
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
        <button onClick={onComplete}
          style={{ padding: '10px 36px', fontSize: 13, fontWeight: 500, borderRadius: 10, background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: 'none', cursor: 'pointer', transition: 'color 0.15s', fontFamily: 'var(--font-btn)' }}>
          I'm ready — go to dashboard
        </button>
      </div>
    </div>
  );
}
