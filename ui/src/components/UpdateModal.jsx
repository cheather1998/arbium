export default function UpdateModal({ info }) {
  const api = window.electronAPI;

  const handleDownload = () => {
    if (api?.openExternal && info?.downloadUrl) {
      api.openExternal(info.downloadUrl);
    }
  };

  return (
    <div className="update-overlay">
      <div className="update-modal">
        <h2>Update Required</h2>
        <p className="update-subtitle">A new version of Arbium is ready to install.</p>

        <div className="version-info">
          <div className="version-box">
            <div className="version-label">Installed</div>
            <div className="version-number current">v{info.currentVersion}</div>
          </div>
          <div className="version-arrow">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 10h12m0 0l-4-4m4 4l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="version-box">
            <div className="version-label">Latest</div>
            <div className="version-number latest">v{info.latestVersion}</div>
          </div>
        </div>

        {info.releaseNotes && (
          <div className="release-notes">{info.releaseNotes}</div>
        )}

        <button className="update-download-btn" onClick={handleDownload}>
          Download Update
        </button>
        <p className="update-note">You must update to continue using Arbium.</p>
      </div>
    </div>
  );
}
