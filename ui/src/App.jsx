import { useState, useEffect, useCallback, useRef } from 'react';
import UpdateModal from './components/UpdateModal';
import Onboarding from './components/Onboarding';
import ConfigPanel from './components/ConfigPanel';
import Dashboard from './components/Dashboard';
import LogViewer from './components/LogViewer';
import StatusBar from './components/StatusBar';
import logoSvg from './assets/logo.svg';

const api = window.electronAPI;

const TRADING_MODES = {
  'kraken-only': {
    mode: 'kraken-only',
    description: 'Kraken Only',
    exchanges: ['kraken'],
    accountCount: 1,
  },
  'kraken-grvt': {
    mode: '3d',
    description: 'Kraken + GRVT',
    exchanges: ['kraken', 'grvt'],
    accountCount: 2,
  },
};

// Persist trading mode selection
function getSavedTradingMode() {
  try { return localStorage.getItem('trading_mode') || 'kraken-grvt'; }
  catch { return 'kraken-grvt'; }
}
function saveTradingMode(mode) {
  try { localStorage.setItem('trading_mode', mode); } catch {}
}

// Check if onboarding has been completed (persisted in localStorage)
function isOnboardingDone() {
  try { return localStorage.getItem('onboarding_complete') === 'true'; }
  catch { return false; }
}
function markOnboardingDone() {
  try { localStorage.setItem('onboarding_complete', 'true'); } catch {}
}
function resetOnboarding() {
  try { localStorage.removeItem('onboarding_complete'); } catch {}
}

export default function App() {
  const [updateInfo, setUpdateInfo] = useState(null);
  const [checkingUpdate, setCheckingUpdate] = useState(true);
  const [botRunning, setBotRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState({});
  const [config, setConfig] = useState({});
  const [version, setVersion] = useState('');
  const [setupComplete, setSetupComplete] = useState(() => isOnboardingDone());
  const [showChromeModal, setShowChromeModal] = useState(false);
  const [tradingModeKey, setTradingModeKey] = useState(() => getSavedTradingMode());

  const handleTradingModeChange = (key) => {
    setTradingModeKey(key);
    saveTradingMode(key);
  };

  const currentMode = TRADING_MODES[tradingModeKey];
  const maxLogs = 2000;

  // Batch log updates every 2 seconds to prevent UI jank
  const logBufferRef = useRef([]);
  const flushTimerRef = useRef(null);

  const flushLogs = useCallback(() => {
    if (logBufferRef.current.length === 0) return;
    const batch = logBufferRef.current;
    logBufferRef.current = [];
    setLogs((prev) => {
      const next = [...prev, ...batch];
      return next.length > maxLogs ? next.slice(-maxLogs) : next;
    });
  }, []);

  const addLog = useCallback((entry) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    logBufferRef.current.push({ ...entry, time });
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        flushLogs();
      }, 2000);
    }
  }, [flushLogs]);

  useEffect(() => {
    if (!api) {
      setCheckingUpdate(false);
      setVersion('dev');
      return;
    }

    api.getVersion().then(setVersion).catch(() => setVersion('unknown'));

    api.checkForUpdates().then((result) => {
      if (result.updateRequired) setUpdateInfo(result);
      setCheckingUpdate(false);
    }).catch(() => setCheckingUpdate(false));

    // Periodic update check every 5 minutes while app is running
    const updateInterval = setInterval(() => {
      api.checkForUpdates().then((result) => {
        if (result.updateRequired) setUpdateInfo(result);
      }).catch(() => {});
    }, 5 * 60 * 1000);

    api.readConfig().then((result) => {
      if (result.success) setConfig(result.config);
    });

    const cleanupLog = api.onBotLog(addLog);
    const cleanupStatus = api.onBotStatus((data) => setStatus(data));
    const cleanupStarted = api.onBotStarted(() => setBotRunning(true));
    const cleanupStopped = api.onBotStopped(() => {
      setBotRunning(false);
      addLog({ type: 'info', message: 'Bot stopped.' });
    });

    const cleanupChrome = api.onChromeNotFound(() => {
      setShowChromeModal(true);
      setBotRunning(false);
    });

    return () => {
      clearInterval(updateInterval);
      cleanupLog();
      cleanupStatus();
      cleanupStarted();
      cleanupStopped();
      cleanupChrome();
    };
  }, [addLog]);

  const handleConfigSave = async (newConfig) => {
    if (api) {
      const result = await api.saveConfig(newConfig);
      if (result.success) {
        setConfig(newConfig);
        addLog({ type: 'info', message: 'Configuration saved.' });
      }
      return result;
    }
    setConfig(newConfig);
    return { success: true };
  };

  const handleStart = async () => {
    setLogs([]);
    setStatus({});
    const isKrakenOnly = tradingModeKey === 'kraken-only';
    if (isKrakenOnly) {
      addLog({ type: 'info', message: 'Starting bot — opening Kraken browser...' });
      addLog({ type: 'info', message: 'Please log in to Kraken in the browser window.' });
    } else {
      addLog({ type: 'info', message: 'Starting bot — opening Kraken & GRVT browsers...' });
      addLog({ type: 'info', message: 'Please log in to both exchanges in the browser windows.' });
    }
    if (api) {
      await api.startBot(currentMode.mode, config);
    } else {
      setBotRunning(true);
      addLog({ type: 'warn', message: '[Dev Mode] Electron API not available.' });
    }
  };

  const handleStop = async () => {
    addLog({ type: 'warn', message: 'Stopping bot...' });
    if (api) {
      await api.stopBot();
    } else {
      setBotRunning(false);
    }
  };

  const handleSwitchAccount = () => {
    if (botRunning) {
      addLog({ type: 'warn', message: 'Stop the bot before switching accounts.' });
      return;
    }
    resetOnboarding();
    setSetupComplete(false);
  };

  if (checkingUpdate) {
    return (
      <div className="app-container loading-screen">
        <div className="loading-spinner" />
        <p>Checking for updates...</p>
      </div>
    );
  }

  if (updateInfo?.updateRequired) {
    return <UpdateModal info={updateInfo} />;
  }

  // Setup page for new users
  if (!setupComplete) {
    return (
      <div className="app-container">
        <header className="app-header">
          <img src={logoSvg} alt="Arbium" style={{ height: 22 }} />
        </header>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Onboarding
            onComplete={() => { markOnboardingDone(); setSetupComplete(true); }}
          />
        </div>
        <StatusBar botRunning={false} version={version} status={{}} />
      </div>
    );
  }

  // Chrome not found modal
  const chromeModal = showChromeModal && (
    <div className="modal-overlay">
      <div className="modal-card" style={{ maxWidth: 440, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🌐</div>
        <h2 style={{ margin: '0 0 8px' }}>Google Chrome Required</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '0 0 20px', lineHeight: 1.5 }}>
          Arbium needs Google Chrome to run the trading bot.
          Please download and install Chrome, then restart Arbium.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (api) api.openExternal('https://www.google.com/chrome/');
            }}
          >
            Download Chrome
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setShowChromeModal(false)}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  // Main dashboard
  return (
    <div className="app-container">
      {chromeModal}
      <header className="app-header">
        <img src={logoSvg} alt="Arbium" style={{ height: 22 }} />
      </header>

      <div className="app-body">
        <div className="main-content">
          <Dashboard
            status={status}
            botRunning={botRunning}
            logs={logs}
            onStart={handleStart}
            onStop={handleStop}
            config={config}
            tradingMode={tradingModeKey}
            onTradingModeChange={handleTradingModeChange}
          />
        </div>

        <div className="sidebar">
          <ConfigPanel
            config={config}
            onSave={handleConfigSave}
            disabled={botRunning}
            onSwitchAccount={handleSwitchAccount}
            btcPrice={status.prices?.kraken || status.prices?.grvt || null}
          />
          <LogViewer logs={logs} onClear={() => setLogs([])} />
        </div>
      </div>

      <StatusBar botRunning={botRunning} version={version} status={status} />
    </div>
  );
}
