import { useEffect, useRef, useState } from 'react';

const LOG_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'error', label: 'Errors' },
  { key: 'warn', label: 'Warnings' },
  { key: 'info', label: 'Info' },
];

export default function LogViewer({ logs, onClear }) {
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const [filter, setFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);

  const filteredLogs = filter === 'all' ? logs : logs.filter((l) => l.type === filter);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs.length, autoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const errorCount = logs.filter((l) => l.type === 'error').length;

  return (
    <div className="log-viewer">
      <div className="log-header">
        <div className="log-header-left">
          <h3>Logs</h3>
          {errorCount > 0 && (
            <span className="log-error-badge">{errorCount}</span>
          )}
        </div>
        <div className="log-header-right">
          <div className="log-filters">
            {LOG_FILTERS.map((f) => (
              <button
                key={f.key}
                className={`log-filter-btn ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClear}>Clear</button>
        </div>
      </div>
      <div className="log-content" ref={containerRef} onScroll={handleScroll}>
        {filteredLogs.length === 0 ? (
          <div className="log-empty">
            {filter !== 'all' ? `No ${filter} logs.` : 'No logs yet. Start the bot to see output.'}
          </div>
        ) : (
          filteredLogs.map((entry, i) => (
            <div key={i} className={`log-line ${entry.type || ''}`}>
              <span className="log-time">{entry.time}</span>
              <span className="log-msg">{entry.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      {!autoScroll && filteredLogs.length > 10 && (
        <button
          className="log-scroll-btn"
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
