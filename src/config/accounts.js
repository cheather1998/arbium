import dotenv from 'dotenv';
dotenv.config();

// Multiple accounts configuration - read from environment variable
const getAccountsFromEnv = () => {
    const emailsEnv = process.env.ACCOUNT_EMAILS;
  
    if (!emailsEnv) {
      console.error('ERROR: ACCOUNT_EMAILS not found in .env file');
      process.exit(1);
    }
  
    const emails = emailsEnv.split(',').map(e => e.trim()).filter(e => e);
  
    if (emails.length === 0) {
      console.error('ERROR: No valid emails found in ACCOUNT_EMAILS');
      process.exit(1);
    }
  
    return emails.map((email, index) => {
      // Create a unique profile directory based on email hash to avoid conflicts
      const emailHash = Buffer.from(email).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
      return {
        email: email,
        cookiesPath: `./paradex-cookies-account${index + 1}.json`, // Keep same name for compatibility
        profileDir: `/tmp/puppeteer-chrome-profile-${index + 1}-${emailHash}`,
        apiPort: 3001 + index,
        exchange: null // Will be set based on trading mode
      };
    });
  };
  
  const ACCOUNTS = getAccountsFromEnv();

  export { ACCOUNTS };