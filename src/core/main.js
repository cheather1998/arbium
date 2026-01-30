import dotenv from 'dotenv';
import { chooseTradingMode, delay } from '../utils/helpers.js';
import { closeAllPositionsOnShutdown, automatedTradingLoop, automatedTradingLoop3Exchanges } from '../core/loop.js';
import { launchAccount } from '../core/launch.js';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { ACCOUNTS } from '../config/accounts.js';
import { HEADLESS } from '../config/headless.js';
import { comparePricesFromExchanges } from '../trading/priceComparison.js';

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
  
    // Handle option 3 (Multi-Exchange Mode) separately
    if (tradingMode.mode === 3) {
      // Option 3: Kraken, GRVT, Extended
      if (ACCOUNTS.length < 3) {
        console.log(`\n✗ Error: Option 3 requires at least 3 accounts in EXCHANGE_ACCOUNTS or ACCOUNT_EMAILS.`);
        console.log(`Currently ${ACCOUNTS.length} accounts configured.`);
        process.exit(1);
      }
      
      const exchanges = tradingMode.exchanges; // ['kraken', 'grvt', 'extended']
      const accountsWithExchanges = ACCOUNTS.slice(0, 3).map((account, index) => {
        const exchangeName = exchanges[index];
        return {
          ...account,
          exchange: exchangeName,
          exchangeConfig: EXCHANGE_CONFIGS[exchangeName]
        };
      });
      
      console.log(`\n📋 Account Configuration for Option 3:`);
      accountsWithExchanges.forEach((acc, idx) => {
        console.log(`   Account ${idx + 1} (${acc.email}): ${acc.exchangeConfig.name}`);
      });
      console.log(``);
      
      console.log(
        `💡 Tip: If you changed account emails, old cookies will be auto-deleted.`
      );
      console.log(
        `    You can also manually delete paradex-cookies-*.json files to reset.\n`
      );
      
      // Launch all 3 accounts in parallel
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
      
      // For option 3, require all 3 accounts to be logged in
      if (successful.length !== 3) {
        console.log(`\n⚠️  Warning: Option 3 requires exactly 3 accounts.`);
        console.log(`Currently ${successful.length} accounts logged in.`);
        console.log(
          `Bot will run API servers but won't start automated trading.\n`
        );
      } else {
        console.log(`\n✅ All 3 exchanges are ready!`);
        console.log(`API servers are running for all exchanges.\n`);
      }
      
      // First step: Compare prices from all exchanges (initial comparison)
      // For Extended Exchange, even if login failed but browser is open, try to get price
      // (Extended Exchange uses wallet connection, not email login)
      const accountsWithPages = results.filter(r => r.page && r.browser); // All accounts with open pages
      
      if (accountsWithPages.length > 0) {
        console.log(`\n📊 Step 1: Comparing prices from all exchanges...`);
        console.log(`   Fetching prices from ${accountsWithPages.length} exchange(s)...`);
        console.log(`   Note: Extended Exchange uses wallet connection (not email login)\n`);
        
        try {
          const exchangeAccounts = accountsWithPages.map(result => {
            const account = accountsWithExchanges.find(a => a.email === result.email);
            if (!account) {
              console.log(`⚠️  Warning: Could not find account config for ${result.email}`);
              return null;
            }
            return {
              page: result.page,
              email: result.email,
              exchange: result.exchange || account.exchangeConfig.name,
              exchangeConfig: account.exchangeConfig,
              loginStatus: result.success ? 'logged_in' : 'browser_open' // Track login status
            };
          }).filter(acc => acc !== null); // Remove null entries
          
          if (exchangeAccounts.length > 0) {
            const priceComparison = await comparePricesFromExchanges(exchangeAccounts);
            
            if (priceComparison.success) {
              console.log(`\n✅ Price comparison completed successfully!`);
              console.log(`   Highest price: ${priceComparison.highest.exchange} at $${priceComparison.highest.price.toLocaleString()}`);
              console.log(`   Lowest price: ${priceComparison.lowest.exchange} at $${priceComparison.lowest.price.toLocaleString()}`);
              console.log(`   Price spread: ${priceComparison.comparison.priceDiffPercent}%\n`);
            } else {
              console.log(`\n⚠️  Price comparison failed: ${priceComparison.error}`);
              console.log(`   This might happen if Extended Exchange wallet is not connected yet.`);
            }
          } else {
            console.log(`\n⚠️  No valid exchange accounts found for price comparison`);
          }
        } catch (error) {
          console.error(`\n❌ Error during price comparison:`, error.message);
          console.error(error.stack);
        }
      } else {
        console.log(`\n⚠️  No accounts with open pages - skipping price comparison`);
      }
      
      // Start automated trading loop if all 3 accounts are logged in
      if (successful.length === 3) {
        // Find accounts by exchange name
        const krakenAccount = successful.find((r) => {
          const account = accountsWithExchanges.find((a) => a.email === r.email);
          return account && account.exchange === 'kraken';
        });
        const grvtAccount = successful.find((r) => {
          const account = accountsWithExchanges.find((a) => a.email === r.email);
          return account && account.exchange === 'grvt';
        });
        const extendedAccount = successful.find((r) => {
          const account = accountsWithExchanges.find((a) => a.email === r.email);
          return account && account.exchange === 'extended';
        });
        
        if (krakenAccount && grvtAccount && extendedAccount) {
          console.log(`\n🤖 Starting automated trading loop in 5 seconds...`);
          console.log(`   The loop will compare prices and execute trades automatically.`);
          console.log(`   Highest price exchange → SELL`);
          console.log(`   Lowest price exchange → BUY\n`);
          await delay(5000);
          
          // Start the 3-exchange trading loop
          console.log(`\n🔄 Launching automated trading loop (running in background)...`);
          automatedTradingLoop3Exchanges(krakenAccount, grvtAccount, extendedAccount).catch((error) => {
            console.error(`\n❌ Trading loop error:`, error);
            console.error(error.stack);
          });
          console.log(`✅ Trading loop started successfully. It will run in the background.\n`);
        } else {
          console.log(`\n⚠️  Could not find all 3 exchange accounts.`);
          console.log(`   Kraken: ${krakenAccount ? '✓' : '✗'}`);
          console.log(`   GRVT: ${grvtAccount ? '✓' : '✗'}`);
          console.log(`   Extended: ${extendedAccount ? '✓' : '✗'}`);
          console.log(`   Bot will run API servers but won't start automated trading.\n`);
        }
      }
      
      // Setup graceful shutdown handlers
      // Store results array for shutdown handler to access all browsers (including failed logins that kept browsers open)
      const allResults = results;
      
      const shutdownHandler = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        console.log(`\n\n========================================`);
        console.log(`Shutdown signal received (Ctrl+C)`);
        console.log(`========================================`);
        
        console.log(`\nStopping API servers...`);
        await delay(2000);
        
        // Close all positions (only for successful logins)
        await closeAllPositionsOnShutdown(successful);
        
        // Close ALL browsers - including failed logins that kept browsers open
        console.log(`Closing all browsers (including failed logins)...`);
        const closePromises = allResults.map(async (result) => {
          if (result.browser) {
            try {
              console.log(`Closing browser for ${result.email}...`);
              // Close all pages first (especially important for Extended Exchange)
              const pages = await result.browser.pages();
              console.log(`  Found ${pages.length} page(s) to close`);
              for (const page of pages) {
                try {
                  await page.close();
                } catch (pageError) {
                  // Ignore page close errors
                }
              }
              await delay(500);
              
              // Close browser with timeout
              await Promise.race([
                result.browser.close(),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Browser close timeout')), 5000)
                )
              ]);
              console.log(`✓ Closed browser for ${result.email}`);
            } catch (error) {
              console.log(`⚠ Error closing browser for ${result.email}: ${error.message}`);
              // Try force kill as last resort
              try {
                const pages = await result.browser.pages();
                for (const page of pages) {
                  await page.close().catch(() => {});
                }
                await result.browser.close().catch(() => {});
                console.log(`✓ Force closed browser for ${result.email}`);
              } catch (forceError) {
                console.log(`✗ Failed to force close browser for ${result.email}`);
              }
            }
          } else {
            console.log(`⚠ No browser found for ${result.email}`);
          }
        });
        
        // Wait for all browsers to close (or timeout)
        await Promise.allSettled(closePromises);
        await delay(1000);
        
        // Final check - try to close any remaining browsers
        console.log(`\nFinal check for remaining browsers...`);
        const remainingBrowsers = allResults.filter(r => r.browser);
        if (remainingBrowsers.length > 0) {
          console.log(`⚠ Found ${remainingBrowsers.length} browser(s) still open, attempting force close...`);
          for (const result of remainingBrowsers) {
            try {
              const pages = await result.browser.pages();
              for (const page of pages) {
                await page.close().catch(() => {});
              }
              await result.browser.close().catch(() => {});
              console.log(`✓ Force closed remaining browser for ${result.email}`);
            } catch (error) {
              console.log(`✗ Could not close browser for ${result.email}: ${error.message}`);
            }
          }
        }
        
        console.log(`Shutdown complete. Goodbye!\n`);
        process.exit(0);
      };
      
      process.on("SIGINT", shutdownHandler);
      process.on("SIGTERM", shutdownHandler);
      
      // Keep the process running for API servers
      console.log(`\n🔄 Bot is running in API mode. Press Ctrl+C to exit.\n`);
      return; // Exit early for option 3
    }
  
    // Assign exchanges to accounts based on mode (for options 1 and 2)
    // Only use first 2 accounts for Options 1 and 2
    const accountsWithExchanges = ACCOUNTS.slice(0, 2).map((account, index) => {
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
  
      // Close browsers - close all pages first, then browsers
      console.log(`Closing browsers...`);
      const closePromises = successful.map(async (result) => {
        if (result.browser) {
          try {
            // Close all pages first (especially important for Extended Exchange)
            const pages = await result.browser.pages();
            for (const page of pages) {
              try {
                await page.close();
              } catch (pageError) {
                // Ignore page close errors
              }
            }
            await delay(500);
            
            // Close browser with timeout
            await Promise.race([
              result.browser.close(),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Browser close timeout')), 3000)
              )
            ]);
            console.log(`✓ Closed browser for ${result.email}`);
          } catch (error) {
            console.log(`⚠ Error closing browser for ${result.email}: ${error.message}`);
            // Try force kill as last resort
            try {
              const pages = await result.browser.pages();
              for (const page of pages) {
                await page.close().catch(() => {});
              }
              await result.browser.close().catch(() => {});
            } catch (forceError) {
              console.log(`✗ Failed to force close browser for ${result.email}`);
            }
          }
        }
      });
      
      // Wait for all browsers to close (or timeout)
      await Promise.allSettled(closePromises);
      await delay(1000);
  
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