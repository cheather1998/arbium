import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

// Multiple accounts configuration - read from environment variable or use defaults
const getAccountsFromEnv = () => {
    const emailsEnv = process.env.ACCOUNT_EMAILS;

    // If no ACCOUNT_EMAILS configured, use default placeholders
    // The actual login happens in the browser — emails are only used for logging and cookie file naming
    const DEFAULT_EMAILS = 'kraken-user@arbium.local,grvt-user@arbium.local,account3@arbium.local';
    const emails = (emailsEnv || DEFAULT_EMAILS).split(',').map(e => e.trim()).filter(e => e);

    if (emails.length === 0) {
      console.error('ERROR: No valid emails found');
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