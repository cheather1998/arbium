export default function StatusBar({ botRunning, version, status }) {
  const cycleTime = status?.cycleTime ?? null;
  const cycle = status?.cycle ?? 0;
  const tradesExecuted = status?.tradesExecuted ?? 0;

  const speedLabel = cycleTime
    ? cycleTime < 1000 ? `${cycleTime}ms/cycle` : `${(cycleTime / 1000).toFixed(1)}s/cycle`
    : null;

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <div className="status-indicator">
          <span className={`status-dot ${botRunning ? 'running' : 'stopped'}`} />
          <span>{botRunning ? 'Running' : 'Idle'}</span>
        </div>
        {botRunning && speedLabel && (
          <>
            <span className="status-sep" />
            <span className="status-metric">{speedLabel}</span>
            <span className="status-sep" />
            <span className="status-metric">Cycles: {cycle}</span>
            <span className="status-sep" />
            <span className="status-metric">Trades: {tradesExecuted}</span>
          </>
        )}
      </div>
      <span className="status-version">v{version || '...'}</span>
    </div>
  );
}
