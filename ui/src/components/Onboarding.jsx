export default function Onboarding({ onComplete }) {
  const api = window.electronAPI;

  const openUrl = (url) => {
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank');
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '40px 20px' }}>
      <h2 style={{ fontSize: 24, marginBottom: 6 }}>Getting Started</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 28 }}>
        Complete the steps below for both exchanges before you start trading.
      </p>

      {/* Kraken */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>Kraken</div>

        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>1.</span>
              <span>Register a Kraken account</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>2.</span>
              <span><strong style={{ color: 'var(--yellow)' }}>Complete KYC identity verification</strong> — required to access futures trading</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>3.</span>
              <span><strong style={{ color: 'var(--yellow)' }}>Enable Futures trading</strong> in your account settings</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>4.</span>
              <span>Deposit USDT or USD to your Kraken account</span>
            </div>
            <div style={{
              display: 'flex', gap: 8, background: 'var(--yellow-bg)', padding: '8px 10px',
              borderRadius: 'var(--radius-sm)', border: '1px solid rgba(210,153,34,0.2)',
            }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>5.</span>
              <span style={{ color: 'var(--yellow)' }}>
                <strong>Transfer funds from Spot to Futures wallet</strong> — the bot trades on the Futures market, funds in Spot will not be used
              </span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => openUrl('https://www.kraken.com/sign-up')}>
            Register
          </button>
          <button className="btn btn-sm" onClick={() => openUrl('https://www.kraken.com/u/funding')}>
            Deposit & Transfer
          </button>
          <button className="btn btn-sm" onClick={() => openUrl('https://pro.kraken.com/app/trade/futures-btc-usd-perp')}>
            Futures Trading
          </button>
        </div>
      </div>

      {/* GRVT */}
      <div className="card" style={{ marginBottom: 28 }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>GRVT</div>

        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>1.</span>
              <span>Register a GRVT account</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>2.</span>
              <span>Complete account verification</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 18 }}>3.</span>
              <span>Deposit USDT to your GRVT trading account</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => openUrl('https://grvt.io')}>
            Register
          </button>
          <button className="btn btn-sm" onClick={() => openUrl('https://grvt.io/exchange/perpetual/BTC-USDT')}>
            Open Exchange
          </button>
        </div>
      </div>

      <button className="btn btn-primary" onClick={onComplete}
        style={{ width: '100%', padding: '12px', fontSize: 15 }}>
        I'm ready — go to dashboard
      </button>
    </div>
  );
}
