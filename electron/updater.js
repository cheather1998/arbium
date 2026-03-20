import https from 'https';
import { gt, valid, coerce } from 'semver';

const GITHUB_OWNER = 'Aylab-Company';
const GITHUB_REPO = 'paradex-ui-bot';
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'paradex-ui-bot',
        Accept: 'application/vnd.github.v3+json',
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse GitHub response'));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Check GitHub Releases for a newer version.
 * Returns { updateRequired, latestVersion, currentVersion, downloadUrl, releaseNotes }
 */
export async function checkForUpdates(currentVersion) {
  try {
    const release = await fetchJSON(RELEASES_URL);

    if (!release || !release.tag_name) {
      return { updateRequired: false, error: null, currentVersion };
    }

    // Parse version from tag (e.g., "v1.2.0" -> "1.2.0")
    const rawTag = release.tag_name.replace(/^v/, '');
    const latestVersion = valid(rawTag) || coerce(rawTag)?.version;

    if (!latestVersion) {
      return { updateRequired: false, error: 'Invalid version tag', currentVersion };
    }

    const currentParsed = valid(currentVersion) || coerce(currentVersion)?.version;
    if (!currentParsed) {
      return { updateRequired: false, error: 'Invalid current version', currentVersion };
    }

    const updateRequired = gt(latestVersion, currentParsed);

    return {
      updateRequired,
      latestVersion,
      currentVersion: currentParsed,
      downloadUrl: release.html_url || RELEASES_PAGE,
      releaseNotes: release.body || '',
    };
  } catch (err) {
    // Network error — don't block the app
    console.error('Update check failed:', err.message);
    return { updateRequired: false, error: err.message, currentVersion };
  }
}
