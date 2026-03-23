import { useState, useEffect, useCallback } from 'react';
import UpdateModal from './components/UpdateModal';
import Onboarding from './components/Onboarding';
import ConfigPanel from './components/ConfigPanel';
import Dashboard from './components/Dashboard';
import LogViewer from './components/LogViewer';
import StatusBar from './components/StatusBar';
import logoSvg from './assets/logo.svg';

const api = window.electronAPI;

const FIXED_MODE = {
  mode: '3d',
  description: 'Kraken + GRVT',
  exchanges: ['kraken', 'grvt'],
  accountCount: 2,
};

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
  const maxLogs = 500;

  const addLog = useCallback((entry) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs((prev) => {
      const next = [...prev, { ...entry, time }];
      return next.length > maxLogs ? next.slice(-maxLogs) : next;
    });
  }, []);

  useEffect(() => {
    if (!api) {
      setCheckingUpdate(false);
      setVersion('dev');
      return;
    }

    api.getVersion().then(setVersion);

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

    return () => {
      clearInterval(updateInterval);
      cleanupLog();
      cleanupStatus();
      cleanupStarted();
      cleanupStopped();
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
    addLog({ type: 'info', message: 'Starting bot — opening Kraken & GRVT browsers...' });
    addLog({ type: 'info', message: 'Please log in to both exchanges in the browser windows.' });
    if (api) {
      await api.startBot(FIXED_MODE.mode, config);
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
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <Onboarding onComplete={() => { markOnboardingDone(); setSetupComplete(true); }} />
        </div>
        <StatusBar botRunning={false} version={version} status={{}} />
      </div>
    );
  }

  // Main dashboard
  return (
    <div className="app-container">
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
          />
        </div>

        <div className="sidebar">
          <ConfigPanel
            config={config}
            onSave={handleConfigSave}
            disabled={botRunning}
            onSwitchAccount={handleSwitchAccount}
          />
          <LogViewer logs={logs} onClear={() => setLogs([])} />
        </div>
      </div>

      <StatusBar botRunning={botRunning} version={version} status={status} />
    </div>
  );
}
