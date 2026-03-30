import dotenv from 'dotenv';
import { chooseTradingMode, delay } from '../utils/helpers.js';
import { closeAllPositionsOnShutdown, automatedTradingLoop, automatedTradingLoop3Exchanges, automatedTradingLoop2Exchanges, testSingleExchangeTrading, automatedTradingLoopKrakenOnly } from '../core/loop.js';
import { launchAccount } from '../core/launch.js';
import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { ACCOUNTS } from '../config/accounts.js';
import { HEADLESS } from '../config/headless.js';
import { comparePricesFromExchanges } from '../trading/priceComparison.js';

// Ensure environment variables are loaded
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || ".env" });

let isShuttingDown = false;

async function main() {
    console.log(`\n========================================`);
    console.log(`Starting Multi-Exchange Trading Bot`);
    console.log(`Headless mode: ${HEADLESS}`);
    console.log(`Number of accounts: ${ACCOUNTS.length}`);
    console.log(`========================================\n`);
  
    // Prompt user to choose trading mode (or use provided mode)
    const tradingMode = await chooseTradingMode(main._modeInput);
    console.log(`\n✓ Selected: ${tradingMode.description}\n`);
  
    // Handle Kraken-Only continuous trading mode
    if (tradingMode.mode === 'kraken-only') {
      const exchangeConfig = EXCHANGE_CONFIGS.kraken;

      console.log(`\n📋 Kraken-Only Trading Configuration:`);
      console.log(`   Exchange: ${exchangeConfig.name}`);
      console.log(`   Mode: Continuous Trading (30s–5min randomized hold)\n`);

      // Find Kraken account
      let krakenAccount = ACCOUNTS.find(a => a.exchange === 'kraken' || a.assignedExchange === 'kraken');
      if (!krakenAccount && ACCOUNTS.length > 0) {
        krakenAccount = { ...ACCOUNTS[0], exchange: 'kraken', exchangeConfig };
      }

      if (!krakenAccount) {
        console.log(`\n✗ Error: No account found for Kraken`);
        process.exit(1);
      }

      krakenAccount = { ...krakenAccount, exchange: 'kraken', exchangeConfig };
      console.log(`   Account: ${krakenAccount.email}\n`);

      // Launch Kraken browser
      console.log(`\n🚀 Launching Kraken...`);
      const result = await launchAccount(krakenAccount, exchangeConfig);

      if (!result.success) {
        console.log(`\n✗ Failed to launch Kraken`);
        process.exit(1);
      }

      console.log(`\n✅ Kraken is ready! Starting continuous trading...\n`);

      // Setup graceful shutdown
      const shutdownHandler = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log(`\n\nShutting down Kraken-Only trading...`);
        try {
          await closeAllPositionsOnShutdown([result]);
        } catch (e) {}
        if (result.browser) {
          try { await result.browser.close(); } catch (e) {}
        }
        process.exit(0);
      };

      process.on('SIGINT', shutdownHandler);
      process.on('SIGTERM', shutdownHandler);

      // Start continuous trading loop
      await automatedTradingLoopKrakenOnly(result);
      return;
    }

    // Handle test modes (3a, 3b, 3c) - Single exchange testing
    if (tradingMode.mode === '3a' || tradingMode.mode === '3b' || tradingMode.mode === '3c') {
      const testExchangeName = tradingMode.testExchange; // 'kraken', 'grvt', or 'extended'
      const exchangeConfig = EXCHANGE_CONFIGS[testExchangeName];
      
      if (!exchangeConfig) {
        console.log(`\n✗ Error: Unknown exchange "${testExchangeName}"`);
        process.exit(1);
      }
      
      console.log(`\n📋 Testing Configuration:`);
      console.log(`   Exchange: ${exchangeConfig.name}`);
      console.log(`   Mode: Single Exchange Test (BUY + SELL)`);
      console.log(``);
      
      // Find account for this exchange from EXCHANGE_ACCOUNTS
      let testAccount = null;
      for (const account of ACCOUNTS) {
        if (account.exchange === testExchangeName || account.assignedExchange === testExchangeName) {
          testAccount = {
            ...account,
            exchange: testExchangeName,
            exchangeConfig: exchangeConfig
          };
          break;
        }
      }
      
      // If not found by exchange assignment, use first account (fallback)
      if (!testAccount && ACCOUNTS.length > 0) {
        console.log(`⚠️  Warning: No account explicitly assigned to ${testExchangeName}, using first account`);
        testAccount = {
          ...ACCOUNTS[0],
          exchange: testExchangeName,
          exchangeConfig: exchangeConfig
        };
      }
      
      if (!testAccount) {
        console.log(`\n✗ Error: No account found for ${exchangeConfig.name}`);
        console.log(`   Please configure EXCHANGE_ACCOUNTS with an account for ${testExchangeName}`);
        process.exit(1);
      }
      
      console.log(`   Account: ${testAccount.email}`);
      console.log(``);
      
      // Launch the single exchange
      console.log(`\n🚀 Launching ${exchangeConfig.name}...`);
      const result = await launchAccount(testAccount, exchangeConfig);
      
      if (!result.success && !result.keepBrowserOpen) {
        console.log(`\n✗ Failed to launch ${exchangeConfig.name}`);
        process.exit(1);
      }
      
      if (result.keepBrowserOpen) {
        console.log(`\n⚠️  Browser kept open for manual wallet connection (Extended Exchange)`);
        console.log(`   Please connect your wallet, then the test will continue automatically...`);
        // Wait for user to connect wallet
        await delay(10000); // Wait 10 seconds for wallet connection
      }
      
      // Start API server
      if (result.apiPort) {
        const { startApiServer } = await import('../api/server.js');
        await startApiServer(result.page, testAccount.email, testAccount.apiPort, exchangeConfig);
        console.log(`✅ API server started on port ${testAccount.apiPort}`);
      }
      
      // Run the test
      console.log(`\n🧪 Starting single exchange test in 3 seconds...`);
      await delay(3000);
      
      const testResult = await testSingleExchangeTrading({
        page: result.page,
        email: testAccount.email,
        exchange: exchangeConfig.name,
        exchangeConfig: exchangeConfig
      }, exchangeConfig.name);
      
      // Summary
      console.log(`\n\n========================================`);
      console.log(`Test Complete`);
      console.log(`========================================`);
      if (testResult.allPassed) {
        console.log(`✅ All tests PASSED for ${exchangeConfig.name}`);
      } else {
        console.log(`⚠️  Some tests FAILED for ${exchangeConfig.name}`);
        console.log(`   Review the logs above for details`);
      }
      console.log(`========================================\n`);
      
      // Setup graceful shutdown
      const shutdownHandler = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log(`\n\nShutting down...`);
        if (result.browser) {
          try {
            const pages = await result.browser.pages();
            for (const page of pages) {
              try {
                await page.close();
              } catch (e) {}
            }
            await result.browser.close();
          } catch (e) {
            console.log(`Error closing browser: ${e.message}`);
          }
        }
        process.exit(0);
      };
      
      process.on('SIGINT', shutdownHandler);
      process.on('SIGTERM', shutdownHandler);
      
      console.log(`\n✅ Test completed. Press Ctrl+C to exit.\n`);
      
      // Keep process alive
      return;
    }
  
    // Handle option 3 (Multi-Exchange Mode) - supports both 2 and 3 exchanges
    if (tradingMode.mode === 3 || tradingMode.mode === '3d' || tradingMode.mode === '3e' || tradingMode.mode === '3f') {
      const exchanges = tradingMode.exchanges; // ['kraken', 'grvt', 'extended'] or ['kraken', 'grvt'] etc.
      const exchangeCount = exchanges.length;
      const is2ExchangeMode = exchangeCount === 2;
      
      if (ACCOUNTS.length < exchangeCount) {
        console.log(`\n✗ Error: This option requires at least ${exchangeCount} accounts in EXCHANGE_ACCOUNTS or ACCOUNT_EMAILS.`);
        console.log(`Currently ${ACCOUNTS.length} accounts configured.`);
        process.exit(1);
      }
      
      const accountsWithExchanges = ACCOUNTS.slice(0, exchangeCount).map((account, index) => {
        const exchangeName = exchanges[index];
        return {
          ...account,
          exchange: exchangeName,
          exchangeConfig: EXCHANGE_CONFIGS[exchangeName]
        };
      });
      
      console.log(`\n📋 Account Configuration for ${tradingMode.description}:`);
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
      
      // Launch all accounts in parallel
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
      
      // Require all accounts to be logged in
      if (successful.length !== exchangeCount) {
        console.log(`\n⚠️  Warning: This option requires exactly ${exchangeCount} accounts.`);
        console.log(`Currently ${successful.length} accounts logged in.`);
        console.log(
          `Bot will run API servers but won't start automated trading.\n`
        );
      } else {
        console.log(`\n✅ All ${exchangeCount} exchanges are ready!`);
        console.log(`API servers are running for all exchanges.\n`);
      }
      
      // First step: Compare prices from all exchanges (initial comparison)
      const accountsWithPages = results.filter(r => r.page && r.browser);
      
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
              loginStatus: result.success ? 'logged_in' : 'browser_open'
            };
          }).filter(acc => acc !== null);
          
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
      
      // Start automated trading loop if all accounts are logged in
      if (successful.length === exchangeCount) {
        if (is2ExchangeMode) {
          // 2-exchange mode
          const account1 = successful.find((r) => {
            const account = accountsWithExchanges.find((a) => a.email === r.email);
            return account && account.exchange === exchanges[0];
          });
          const account2 = successful.find((r) => {
            const account = accountsWithExchanges.find((a) => a.email === r.email);
            return account && account.exchange === exchanges[1];
          });
          
          if (account1 && account2) {
            console.log(`\n🤖 Starting automated trading loop in 5 seconds...`);
            console.log(`   The loop will compare prices and execute trades automatically.`);
            console.log(`   Highest price exchange → SELL`);
            console.log(`   Lowest price exchange → BUY\n`);
            await delay(5000);
            
            console.log(`\n🔄 Launching automated trading loop (running in background)...`);
            automatedTradingLoop2Exchanges(account1, account2).catch((error) => {
              console.error(`\n❌ Trading loop error:`, error);
              console.error(error.stack);
            });
            console.log(`✅ Trading loop started successfully. It will run in the background.\n`);
          } else {
            console.log(`\n⚠️  Could not find both exchange accounts.`);
            console.log(`   ${exchanges[0]}: ${account1 ? '✓' : '✗'}`);
            console.log(`   ${exchanges[1]}: ${account2 ? '✓' : '✗'}`);
            console.log(`   Bot will run API servers but won't start automated trading.\n`);
          }
        } else {
          // 3-exchange mode
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

        // Skip position closing if force stop from Electron UI
        if (!global.__FORCE_STOP__) {
          await delay(2000);
          // Close all positions (only for successful logins)
          await closeAllPositionsOnShutdown(successful);
        } else {
          console.log(`Force stop — skipping position closing, closing browsers immediately...`);
        }
        
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

      // Skip position closing if force stop from Electron UI
      if (!global.__FORCE_STOP__) {
        // Wait a moment for loops to detect shutdown flag
        await delay(2000);
        // Close all positions
        await closeAllPositionsOnShutdown(successful);
      } else {
        console.log(`Force stop — skipping position closing, closing browsers immediately...`);
      }
  
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

  /**
   * Entry point for Electron subprocess.
   * Accepts a mode value directly, bypassing readline prompt.
   */
  async function mainWithMode(mode) {
    main._modeInput = mode;
    return main();
  }

  export { main, mainWithMode };