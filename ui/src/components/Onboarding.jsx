import krakenLogo from '../assets/kraken-logo.svg';
import grvtLogo from '../assets/grvt-logo.svg';
import bgSvg from '../assets/bg2.svg';

export default function Onboarding({ onComplete }) {
  const api = window.electronAPI;

  const openUrl = (url) => {
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank');
  };

  const stepStyle = { display: 'flex', gap: 10, alignItems: 'baseline' };
  const numStyle = { color: 'var(--text-muted)', minWidth: 20, fontFamily: 'var(--font-mono)', fontSize: 11 };
  const registerBtn = {
    padding: '10px 16px', fontSize: 13, background: '#fff', color: '#0a0a0a',
    border: 'none', fontWeight: 600, borderRadius: 10, cursor: 'pointer', width: '100%',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    transition: 'opacity 0.15s',
    fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '-0.2px',
  };

  return (
    <div style={{ position: 'relative', overflow: 'hidden', height: 'calc(100vh - 40px)' }}>
      {/* Background SVG */}
      <img src={bgSvg} alt="" style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        objectFit: 'cover', pointerEvents: 'none', zIndex: 0,
      }} />

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
      `}</style>

      {/* Content */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '32px 56px', gap: 80, position: 'relative', zIndex: 1 }}>
        {/* Left side — title + CTA */}
        <div style={{ flex: '0 0 320px' }}>
          <h2 style={{
            fontFamily: "'Space Grotesk', var(--font-heading)",
            fontSize: 38, marginBottom: 18, letterSpacing: '-0.04em', fontWeight: 600, lineHeight: 1.2,
            color: '#fff',
          }}>
            <>GRVT &amp; Kraken<br />Arbitrage Strategy</>
          </h2>
          <p style={{ fontFamily: "'Plus Jakarta Sans', var(--font-body)", color: 'var(--text-muted)', fontSize: 14, marginBottom: 28, lineHeight: 1.7 }}>
            Complete the setup for both exchanges, then start earning from price differences automatically.
          </p>

          <button onClick={onComplete} className="ready-btn"
            style={{
              padding: '11px 32px', fontSize: 13, fontWeight: 600, borderRadius: 10,
              color: '#111', border: 'none', cursor: 'pointer',
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              letterSpacing: '-0.01em',
            }}>
            I'm ready — start trading
          </button>
        </div>

        {/* Right side — exchange cards */}
        <div style={{ flex: '0 1 390px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Kraken */}
          <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '20px 22px' }}>
            <img src={krakenLogo} alt="Kraken" style={{ height: 13, marginBottom: 14, display: 'block', opacity: 0.85 }} />

            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 16, lineHeight: 1.55, fontFamily: "'Plus Jakarta Sans', var(--font-body)" }}>
              <div style={stepStyle}>
                <span style={numStyle}>01</span>
                <span>Register a Kraken account</span>
              </div>
              <div style={stepStyle}>
                <span style={numStyle}>02</span>
                <span><strong style={{ color: '#fff' }}>Complete KYC verification</strong></span>
              </div>
              <div style={stepStyle}>
                <span style={numStyle}>03</span>
                <span><strong style={{ color: '#fff' }}>Enable Futures trading</strong>&nbsp; in settings</span>
              </div>
              <div style={stepStyle}>
                <span style={numStyle}>04</span>
                <span>Deposit USDT or USD</span>
              </div>
              <div style={stepStyle}>
                <span style={numStyle}>05</span>
                <span>Transfer funds: Spot → Futures wallet</span>
              </div>
            </div>

            <button onClick={() => openUrl('https://kraken.pxf.io/VxoaX3')} className="signup-btn">
              <span>Sign up with Kraken</span>
              <span style={{ fontSize: 14, opacity: 0.4 }}>→</span>
            </button>
          </div>

          {/* GRVT */}
          <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '20px 22px' }}>
            <img src={grvtLogo} alt="GRVT" style={{ height: 13, marginBottom: 14, display: 'block', opacity: 0.85 }} />

            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 16, lineHeight: 1.55, fontFamily: "'Plus Jakarta Sans', var(--font-body)" }}>
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
                <span>Deposit USDT to your trading account</span>
              </div>
            </div>

            <button onClick={() => openUrl('https://grvt.io')} className="signup-btn">
              <span>Sign up with GRVT</span>
              <span style={{ fontSize: 14, opacity: 0.4 }}>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
