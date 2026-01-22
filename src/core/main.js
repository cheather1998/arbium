import dotenv from 'dotenv';
import { chooseTradingMode, delay } from '../utils/helpers.js';
import { closeAllPositionsOnShutdown, automatedTradingLoop } from '../core/loop.js';
import { launchAccount } from '../core/launch.js';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { ACCOUNTS } from '../config/accounts.js';
import { HEADLESS } from '../config/headless.js';

// Ensure environment variables are loaded
dotenv.config();

let isShuttingDown = false;

async function main() {
    console.log(`\n========================================`);
    console.log(`Starting Multi-Exchange Trading Bot`);
    console.log(`Headless mode: ${HEADLESS}`);
    console.log(`Number of accounts: ${ACCOUNTS.length}`);
    console.log(`========================================\n`);
  
    // Prompt user to choose trading mode
    const tradingMode = await chooseTradingMode();
    console.log(`\n✓ Selected: ${tradingMode.description}\n`);
  
    // Assign exchanges to accounts based on mode
    const accountsWithExchanges = ACCOUNTS.map((account, index) => {
      let exchangeName;
      if (index === 0) {
        // First account = BUY account
        exchangeName = tradingMode.buyExchange;
      } else {
        // Second account = SELL account
        exchangeName = tradingMode.sellExchange;
      }
      return {
        ...account,
        exchange: exchangeName,
        exchangeConfig: EXCHANGE_CONFIGS[exchangeName]
      };
    });
  
    console.log(`\n📋 Account Configuration:`);
    accountsWithExchanges.forEach((acc, idx) => {
      console.log(`   Account ${idx + 1} (${acc.email}): ${acc.exchangeConfig.name} - ${idx === 0 ? 'BUY' : 'SELL'}`);
    });
    console.log(``);
  
    console.log(
      `💡 Tip: If you changed account emails, old cookies will be auto-deleted.`
    );
    console.log(
      `    You can also manually delete paradex-cookies-*.json files to reset.\n`
    );
  
    // Launch all accounts in parallel with their exchange configs
    const accountPromises = accountsWithExchanges.map((account) => 
      launchAccount(account, account.exchangeConfig)
    );
    const results = await Promise.all(accountPromises);
  
    // Summary
    console.log(`\n========================================`);
    console.log(`Launch Summary:`);
    console.log(`========================================`);
  
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
  
    successful.forEach((r) => {
      const account = accountsWithExchanges.find((a) => a.email === r.email);
      console.log(`✓ ${r.email} on ${r.exchange || account.exchangeConfig.name} - API on port ${account.apiPort}`);
    });
  
    failed.forEach((r) => {
      console.log(`✗ ${r.email} - Failed to login`);
    });
  
    console.log(
      `\nTotal: ${successful.length} successful, ${failed.length} failed`
    );
    console.log(`========================================\n`);
  
    if (successful.length === 0) {
      console.log("No accounts logged in successfully. Exiting...");
      process.exit(1);
    }
  
    // Ensure we have exactly 2 accounts for the trading strategy
    if (successful.length !== 2) {
      console.log(`\n⚠️  Warning: Trading loop requires exactly 2 accounts.`);
      console.log(`Currently ${successful.length} accounts logged in.`);
      console.log(
        `Bot will run API servers but won't start automated trading.\n`
      );
      return;
    }
  
    // Setup graceful shutdown handlers
    const shutdownHandler = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
  
      console.log(`\n\n========================================`);
      console.log(`Shutdown signal received (Ctrl+C)`);
      console.log(`========================================`);
  
      // Stop trading loops
      console.log(`\nStopping trading loops...`);
  
      // Wait a moment for loops to detect shutdown flag
      await delay(2000);
  
      // Close all positions
      await closeAllPositionsOnShutdown(successful);
  
      // Close browsers
      console.log(`Closing browsers...`);
      for (const result of successful) {
        if (result.browser) {
          await result.browser.close();
        }
      }
  
      console.log(`Shutdown complete. Goodbye!\n`);
      process.exit(0);
    };
  
    process.on("SIGINT", shutdownHandler);
    process.on("SIGTERM", shutdownHandler);
  
    // Get emails from ACCOUNT_EMAILS in order (first = BUY, second = SELL)
    const emailsEnv = process.env.ACCOUNT_EMAILS;
    if (!emailsEnv) {
      console.log(`\n✗ Error: ACCOUNT_EMAILS not found in .env file.`);
      process.exit(1);
    }
  
    const emails = emailsEnv.split(',').map(e => e.trim()).filter(e => e);
    
    if (emails.length < 2) {
      console.log(`\n✗ Error: ACCOUNT_EMAILS must contain at least 2 emails (comma-separated).`);
      console.log(`Format: ACCOUNT_EMAILS=email1@example.com,email2@example.com`);
      console.log(`First email will be used for BUY, second email for SELL.`);
      process.exit(1);
    }
  
    const buyEmail = emails[0];
    const sellEmail = emails[1];
  
    console.log(`\n📋 Account assignment from ACCOUNT_EMAILS:`);
    console.log(`   BUY:  ${buyEmail} (first email)`);
    console.log(`   SELL: ${sellEmail} (second email)`);
  
    // Find accounts by email from successful logins
    // Exchange info should already be stored in the result from launchAccount
    const buyAccount = successful.find((r) => r.email === buyEmail);
    const sellAccount = successful.find((r) => r.email === sellEmail);
    
    // Ensure exchange info is stored (fallback to trading mode if missing)
    if (buyAccount && !buyAccount.exchange) {
      buyAccount.exchange = tradingMode.buyExchange;
    }
    if (sellAccount && !sellAccount.exchange) {
      sellAccount.exchange = tradingMode.sellExchange;
    }
  
    if (!buyAccount) {
      console.log(`\n✗ Error: First email "${buyEmail}" (for BUY) not found in successful accounts.`);
      console.log(`Available accounts: ${successful.map((r) => r.email).join(", ")}`);
      process.exit(1);
    }
  
    if (!sellAccount) {
      console.log(`\n✗ Error: Second email "${sellEmail}" (for SELL) not found in successful accounts.`);
      console.log(`Available accounts: ${successful.map((r) => r.email).join(", ")}`);
      process.exit(1);
    }
  
    if (buyAccount.email === sellAccount.email) {
      console.log(`\n✗ Error: First and second emails in ACCOUNT_EMAILS must be different.`);
      process.exit(1);
    }
  
    console.log(`\n✓ Using ${buyAccount.email} for BUY orders`);
    console.log(`✓ Using ${sellAccount.email} for SELL orders`);
  
    // Start automated trading loop
    console.log(`\n🤖 Starting automated trading in 5 seconds...`);
    await delay(5000);
  
    // Start the trading loop with accounts based on ACCOUNT_EMAILS order
    automatedTradingLoop(buyAccount, sellAccount).catch((error) => {
      console.error(`Trading loop error:`, error);
    });
  }

  export { main };