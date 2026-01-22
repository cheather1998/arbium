import fs from 'fs';

async function saveCookies(page, cookiesPath, email) {
    const cookies = await page.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  
    // Save email metadata alongside cookies
    const metadataPath = cookiesPath.replace('.json', '-metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify({ email, lastUpdated: new Date().toISOString() }, null, 2));
  
    console.log("Cookies saved to", cookiesPath);
  }
  
  async function loadCookies(page, cookiesPath, expectedEmail) {
    if (fs.existsSync(cookiesPath)) {
      // Check metadata to see if cookies belong to a different account
      const metadataPath = cookiesPath.replace('.json', '-metadata.json');
      if (fs.existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          if (metadata.email && metadata.email !== expectedEmail) {
            console.log(`[${expectedEmail}] Cookie email mismatch: cookie has ${metadata.email}, expected ${expectedEmail}`);
            console.log(`[${expectedEmail}] Deleting old cookies for different account`);
            fs.unlinkSync(cookiesPath);
            fs.unlinkSync(metadataPath);
            return false;
          }
        } catch (e) {
          console.log(`[${expectedEmail}] Error reading metadata, treating as new account`);
          fs.unlinkSync(cookiesPath);
          if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
          return false;
        }
      }
  
      const cookies = JSON.parse(fs.readFileSync(cookiesPath));
      await page.setCookie(...cookies);
      console.log("Cookies loaded from", cookiesPath);
      return true;
    }
    return false;
  }
  
  // Check if Extended Exchange cookies exist
  async function hasExtendedExchangeCookies(page) {
    const cookies = await page.cookies();
    const hasAccessToken = cookies.some(c => c.name === 'x10_access_token');
    const hasRefreshToken = cookies.some(c => c.name === 'x10_refresh_token');
    return hasAccessToken && hasRefreshToken;
  }
  
  // Clear Extended Exchange cookies
  async function clearExtendedExchangeCookies(page) {
    console.log(`Clearing Extended Exchange cookies...`);
    try {
      const cookies = await page.cookies();
      const extendedCookies = cookies.filter(c => 
        c.name === 'x10_access_token' || c.name === 'x10_refresh_token'
      );
      
      if (extendedCookies.length > 0) {
        // Delete cookies by setting them with past expiry
        for (const cookie of extendedCookies) {
          await page.deleteCookie({
            name: cookie.name,
            domain: cookie.domain
          });
        }
        console.log(`Cleared ${extendedCookies.length} Extended Exchange cookie(s)`);
        return true;
      }
      console.log(`No Extended Exchange cookies to clear`);
      return false;
    } catch (error) {
      console.log(`Error clearing Extended Exchange cookies: ${error.message}`);
      return false;
    }
  }

  export { saveCookies, loadCookies, hasExtendedExchangeCookies, clearExtendedExchangeCookies };