export default function UpdateModal({ info }) {
  const api = window.electronAPI;

  const handleDownload = () => {
    api.openExternal(info.downloadUrl);
  };

  return (
    <div className="update-overlay">
      <div className="update-modal">
        <h2>Update Required</h2>
        <p>A new version of Arbium is available.</p>
        <p>You must update to continue using the application.</p>

        <div className="version-info">
          <div>
            <div className="version-label">Current</div>
            <div className="current">v{info.currentVersion}</div>
          </div>
          <div style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>→</div>
          <div>
            <div className="version-label">Latest</div>
            <div className="latest">v{info.latestVersion}</div>
          </div>
        </div>

        {info.releaseNotes && (
          <div className="release-notes">{info.releaseNotes}</div>
        )}

        <button className="btn btn-primary" onClick={handleDownload}>
          Download Update
        </button>
      </div>
    </div>
  );
}
