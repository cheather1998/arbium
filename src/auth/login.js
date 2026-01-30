import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { delay } from '../utils/helpers.js';
import { findByText, findByExactText } from '../utils/helpers.js';
import { hasExtendedExchangeCookies, saveCookies, clearExtendedExchangeCookies } from '../utils/cookies.js';

async function isLoggedIn(page, exchangeConfig = null) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
    
    // For Extended Exchange, check for specific cookies first
    if (exchange.name === 'Extended Exchange') {
      const hasCookies = await hasExtendedExchangeCookies(page);
      if (hasCookies) {
        console.log(`[Extended Exchange] Found x10_access_token and x10_refresh_token cookies`);
        // Also check if trading interface is visible
        await delay(1000);
        const hasTradingInterface = await page.evaluate(() => {
          const text = document.body.innerText;
          const hasAccountInfo = text.includes('Available to trade') ||
                                text.includes('Account Value') ||
                                text.includes('Portfolio Value') ||
                                text.includes('Unrealized P&L') ||
                                text.includes('Balance') ||
                                text.includes('Equity');
          const hasTradingButtons = Array.from(document.querySelectorAll('button')).some(
            b => {
              const btnText = b.textContent?.trim();
              return btnText === 'Buy' || btnText === 'Sell' || btnText === 'Long' || btnText === 'Short';
            }
          );
          return hasAccountInfo || hasTradingButtons;
        });
        return hasTradingInterface;
      }
      return false;
    }
    
    // For Kraken and GRVT, check if trading interface is accessible
    // They might not have the same login indicators as Paradex
    if (exchange.name === 'Kraken' || exchange.name === 'GRVT') {
      await delay(2000);
      const isTradingPage = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        // Check for trading interface elements
        const hasTradingElements = 
          text.includes('buy') || 
          text.includes('sell') || 
          text.includes('market') || 
          text.includes('limit') ||
          text.includes('order') ||
          text.includes('position');
        
        // Check for price displays
        const hasPriceElements = document.querySelectorAll('[class*="price"], [class*="ticker"]').length > 0;
        
        // Check if there are trading buttons
        const hasTradingButtons = Array.from(document.querySelectorAll('button')).some(
          btn => {
            const btnText = btn.textContent?.trim().toLowerCase();
            return btnText === 'buy' || btnText === 'sell' || btnText === 'long' || btnText === 'short';
          }
        );
        
        return hasTradingElements || hasPriceElements || hasTradingButtons;
      });
      
      if (isTradingPage) {
        console.log(`[${exchange.name}] Trading interface detected - appears to be logged in`);
        return true;
      } else {
        console.log(`[${exchange.name}] Trading interface not detected - may need login`);
        return false;
      }
    }
    
    // For Paradex, use original logic
    // Check if user is logged in by looking for account/portfolio elements
    await delay(2000);
    const loggedInIndicators = await page.evaluate((exchangeName) => {
      const text = document.body.innerText;
  
      // Check for "Log in" button - if exists, we're NOT logged in
      const hasLoginBtn = Array.from(document.querySelectorAll('button')).some(
        b => b.textContent?.trim() === 'Log in'
      );
  
      // Check for actual trading interface elements that only appear when logged in
      // Generic indicators that work for both exchanges
      const hasAccountInfo = text.includes('Available to trade') ||
                            text.includes('Account Value') ||
                            text.includes('Portfolio Value') ||
                            text.includes('Unrealized P&L') ||
                            text.includes('Balance') ||
                            text.includes('Equity');
  
      // More specific check - look for the trading form (Buy/Sell buttons in trading panel)
      const hasTradingInterface = Array.from(document.querySelectorAll('button')).some(
        b => {
          const btnText = b.textContent?.trim();
          return btnText === 'Buy' || btnText === 'Sell' || btnText === 'Long' || btnText === 'Short';
        }
      );
  
      // We're only logged in if we DON'T see login button AND we DO see trading interface
      return !hasLoginBtn && (hasAccountInfo || hasTradingInterface);
    }, exchange.name);
    return loggedInIndicators;
  }
  
  // Helper function to handle Ethereum wallet connection error
  async function handleWalletConnectionError(page, email) {
    try {
      // Check if there's a wallet connection error
      const errorInfo = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        const hasError = (
          text.includes('ethereum wallet') ||
          text.includes('wallet connection') ||
          text.includes('connect wallet') ||
          text.includes('wallet error')
        );
        
        // Also check if Continue button exists
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const continueBtn = buttons.find(btn => {
          const btnText = btn.textContent?.trim().toLowerCase();
          const isVisible = btn.offsetParent !== null;
          return isVisible && (btnText === 'continue' || btnText.includes('continue'));
        });
        
        return { hasError, hasContinueButton: !!continueBtn };
      });
  
      if (errorInfo.hasError && errorInfo.hasContinueButton) {
        console.log(`[${email}] Wallet connection error detected, looking for Continue button...`);
        
        // Try to find and click Continue button
        let continueClicked = false;
        
        // Strategy 1: Find by text "Continue"
        const continueBtn = await findByText(page, 'Continue', ['button', 'div', 'span', 'a']);
        if (continueBtn) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, continueBtn);
          if (isVisible) {
            await continueBtn.click();
            continueClicked = true;
            console.log(`[${email}] Clicked Continue button (by text)`);
          }
        }
        
        // Strategy 2: Find by data attribute or class
        if (!continueClicked) {
          const continueBtnByAttr = await page.$('button[data-dd-action-name*="continue"], button[class*="continue"]');
          if (continueBtnByAttr) {
            const isVisible = await page.evaluate((el) => {
              return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
            }, continueBtnByAttr);
            if (isVisible) {
              await continueBtnByAttr.click();
              continueClicked = true;
              console.log(`[${email}] Clicked Continue button (by attribute)`);
            }
          }
        }
        
        // Strategy 3: Use evaluate to find and click
        if (!continueClicked) {
          const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
            const continueBtn = buttons.find(btn => {
              const text = btn.textContent?.trim().toLowerCase();
              const isVisible = btn.offsetParent !== null;
              return isVisible && (text === 'continue' || text.includes('continue'));
            });
            if (continueBtn) {
              continueBtn.click();
              return true;
            }
            return false;
          });
          if (clicked) {
            continueClicked = true;
            console.log(`[${email}] Clicked Continue button (via evaluate)`);
          }
        }
        
        if (continueClicked) {
          await delay(2000); // Wait for page to process
          console.log(`[${email}] Continue button clicked, waiting for page to update...`);
        } else {
          console.log(`[${email}] Continue button not found, but error was detected`);
        }
      }
    } catch (error) {
      console.log(`[${email}] Error handling wallet connection: ${error.message}`);
    }
  }
  
  async function login(page, browser, email, cookiesPath, isNewAccount = false, exchangeConfig = null) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
    console.log(`[${email}] Starting login process for ${exchange.name}...`);
  
    try {
      // Extended Exchange specific login flow
      if (exchange.name === 'Extended Exchange') {
        console.log(`[${email}] Extended Exchange - starting login flow...`);
        
        // Step 1: Clear cookies when bot starts
        console.log(`[${email}] Clearing Extended Exchange cookies...`);
        await clearExtendedExchangeCookies(page);
        await delay(1000);
        
        // Step 2: Look for Connect Wallet or Start Trading button
        console.log(`[${email}] Looking for Connect Wallet or Start Trading button...`);
        await delay(2000);
        
        let connectButtonClicked = false;
        
        // Strategy 1: Find "Connect Wallet" button
        const connectWalletBtn = await findByText(page, "Connect Wallet", ["button", "div", "span"]);
        if (connectWalletBtn) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, connectWalletBtn);
          if (isVisible) {
            await connectWalletBtn.click();
            connectButtonClicked = true;
            console.log(`[${email}] Clicked Connect Wallet button`);
          }
        }
        
        // Strategy 2: Find "Start Trading" button
        if (!connectButtonClicked) {
          const startTradingBtn = await findByText(page, "Start Trading", ["button", "div", "span"]);
          if (startTradingBtn) {
            const isVisible = await page.evaluate((el) => {
              return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
            }, startTradingBtn);
            if (isVisible) {
              await startTradingBtn.click();
              connectButtonClicked = true;
              console.log(`[${email}] Clicked Start Trading button`);
            }
          }
        }
        
        // Strategy 3: Use evaluate to find button
        if (!connectButtonClicked) {
          const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
            for (const btn of buttons) {
              const text = btn.textContent?.trim();
              const isVisible = btn.offsetParent !== null;
              if (isVisible && (text === 'Connect Wallet' || text === 'Start Trading')) {
                btn.click();
                return true;
              }
            }
            return false;
          });
          if (clicked) {
            connectButtonClicked = true;
            console.log(`[${email}] Clicked Connect Wallet/Start Trading button (via evaluate)`);
          }
        }
        
        if (!connectButtonClicked) {
          console.log(`[${email}] Could not find Connect Wallet or Start Trading button`);
          return false;
        }
        
        // Wait for modal/QR code to appear
        console.log(`[${email}] Waiting for modal/QR code to appear...`);
        console.log(`[${email}] User should scan QR code and connect wallet...`);
        await delay(3000);
        
        // Check if cookies are set (one-time check after waiting)
        const hasCookiesNow = await hasExtendedExchangeCookies(page);
        if (hasCookiesNow) {
          console.log(`[${email}] ✅ Extended Exchange cookies detected!`);
          
          // Save cookies
          await saveCookies(page, cookiesPath, email);
          
          // Click on Orders tab
          console.log(`[${email}] Clicking Orders tab...`);
          await clickOrdersTab(page, email);
          
          return true;
        }
        
        console.log(`[${email}] Extended Exchange login process - user should complete wallet connection`);
        return true; // Return true to allow manual completion
      }
  
      // Check if this exchange needs email login (only Paradex uses email login)
      // Kraken and GRVT might use different authentication methods
      if (exchange.name !== 'Paradex') {
        console.log(`[${email}] ${exchange.name} - checking if already logged in...`);
        // For non-Paradex exchanges (Kraken, GRVT), check if already logged in
        // They might use cookies or different auth methods
        const alreadyLoggedIn = await isLoggedIn(page, exchange);
        if (alreadyLoggedIn) {
          console.log(`[${email}] ✅ ${exchange.name} - Already logged in`);
          await saveCookies(page, cookiesPath, email);
          return true;
        } else {
          console.log(`[${email}] ⚠️  ${exchange.name} - Not logged in, but no specific login flow implemented`);
          console.log(`[${email}] Please log in manually in the browser window`);
          // Keep browser open for manual login
          return false; // Return false so browser stays open
        }
      }
  
      // Paradex login flow (original logic)
      // For new accounts, navigate to referral URL first
      if (isNewAccount) {
        console.log(`[${email}] New account detected - using referral link`);
        try {
          await page.goto(exchange.referralUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await delay(3000);
          console.log(
            `[${email}] Referral link applied: ${exchange.referralUrl}`
          );
        } catch (error) {
          console.log(`[${email}] Error loading referral link, continuing...`);
        }
      }
  
      // Find and click Log in button - check both app bar and modal
      // Button has data-dd-action-name="Connect wallet" and text "Log in"
      console.log(`[${email}] Looking for Log in button...`);
      let loginClicked = false;
  
      // Strategy 1: Find by data attribute (most reliable) - Paradex specific
      if (exchange.selectors.loginButton) {
        const loginBtnByAttr = await page.$(exchange.selectors.loginButton);
        if (loginBtnByAttr) {
          await loginBtnByAttr.click();
          loginClicked = true;
          console.log(`[${email}] Clicked Log in button (by data attribute)`);
        }
      }
  
      // Strategy 2: Find by text "Log in" in button
      if (!loginClicked) {
        const loginBtnByText = await findByText(page, "Log in", ["button"]);
        if (loginBtnByText) {
          await loginBtnByText.click();
          loginClicked = true;
          console.log(`[${email}] Clicked Log in button (by text)`);
        }
      }
  
      // Strategy 3: Find any visible button with "Log in" text using evaluate
      if (!loginClicked) {
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const btn = buttons.find((b) => {
            const text = b.textContent?.trim();
            return text === "Log in" && b.offsetParent !== null;
          });
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        });
        if (clicked) {
          loginClicked = true;
          console.log(`[${email}] Clicked Log in button (via evaluate)`);
        }
      }
  
      if (loginClicked) {
        // Wait for either navigation or modal to appear
        try {
          await Promise.race([
            page
              .waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 })
              .catch(() => null),
            page
              .waitForSelector(
                '[class*="modal"], [class*="Modal"], [role="dialog"]',
                { visible: true, timeout: 10000 }
              )
              .catch(() => null),
          ]);
        } catch (e) {
          // Continue anyway
        }
        await delay(2000);
      } else {
        console.log(
          `[${email}] No Log in button found - might already be logged in`
        );
        const alreadyLoggedIn = await isLoggedIn(page, exchange);
        if (alreadyLoggedIn) {
          return true;
        }
        console.log(`[${email}] Not logged in, continuing...`);
      }
  
      // For referral links, we need to click Log in AGAIN on the dashboard
      if (isNewAccount) {
        console.log(`[${email}] Looking for Log in button on dashboard...`);
        await delay(2000); // Wait for dashboard to load
  
        let loginBtn2Clicked = false;
  
        // Try to find login button again (might be in modal or app bar)
        const loginBtn2ByAttr = await page.$(
          'button[data-dd-action-name="Connect wallet"]'
        );
        if (loginBtn2ByAttr) {
          await loginBtn2ByAttr.click();
          loginBtn2Clicked = true;
          console.log(
            `[${email}] Clicked Log in button (second click - by data attribute)`
          );
        }
  
        if (!loginBtn2Clicked) {
          const loginBtn2ByText = await findByText(page, "Log in", ["button"]);
          if (loginBtn2ByText) {
            await loginBtn2ByText.click();
            loginBtn2Clicked = true;
            console.log(
              `[${email}] Clicked Log in button (second click - by text)`
            );
          }
        }
  
        if (!loginBtn2Clicked) {
          const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const btn = buttons.find((b) => {
              const text = b.textContent?.trim();
              return text === "Log in" && b.offsetParent !== null;
            });
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          });
          if (clicked) {
            loginBtn2Clicked = true;
            console.log(
              `[${email}] Clicked Log in button (second click - via evaluate)`
            );
          }
        }
  
        if (loginBtn2Clicked) {
          // Wait for modal to appear
          try {
            await page
              .waitForSelector(
                '[class*="modal"], [class*="Modal"], [role="dialog"]',
                { visible: true, timeout: 10000 }
              )
              .catch(() => null);
          } catch (e) {
            // Continue anyway
          }
          await delay(2000);
        } else {
          console.log(`[${email}] Second Log in button not found, continuing...`);
        }
      }
  
      // Wait for login modal/form to appear - check for email input or modal
      console.log(`[${email}] Waiting for login form to appear...`);
      let formReady = false;
      for (let i = 0; i < 15; i++) {
        // Check if email input is already visible (form might be ready)
        const emailInputCheck = await page.$(
          'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"], input[autocomplete="email"]'
        );
        if (emailInputCheck) {
          const isVisible = await page.evaluate((el) => {
            return (
              el.offsetParent !== null &&
              el.offsetWidth > 0 &&
              el.offsetHeight > 0
            );
          }, emailInputCheck);
          if (isVisible) {
            formReady = true;
            console.log(
              `[${email}] Email input already visible - form ready (attempt ${
                i + 1
              })`
            );
            break;
          }
        }
  
        // Also check for modal
        const modal = await page.$(
          '[class*="modal"], [class*="Modal"], [role="dialog"], [class*="Dialog"]'
        );
        if (modal) {
          const isVisible = await page.evaluate((el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return (
              el.offsetParent !== null &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              el.offsetWidth > 0 &&
              el.offsetHeight > 0
            );
          }, modal);
          if (isVisible) {
            console.log(`[${email}] Login modal detected (attempt ${i + 1})`);
            // Don't break yet - wait a bit more for content to load
            if (i >= 2) {
              formReady = true;
              break;
            }
          }
        }
        await delay(1000);
      }
  
      if (!formReady) {
        console.log(`[${email}] Form not fully ready, but continuing anyway...`);
      }
      await delay(2000); // Additional wait for modal content to load
  
      // Check if email input is already visible (might not need "Email or Social" click)
      const emailInputAlreadyVisible = await page.$(
        'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"], input[autocomplete="email"]'
      );
      let emailInputVisible = false;
      if (emailInputAlreadyVisible) {
        emailInputVisible = await page.evaluate((el) => {
          return (
            el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0
          );
        }, emailInputAlreadyVisible);
      }
  
      // Only click "Email or Social" if email input is not visible
      if (!emailInputVisible) {
        console.log(
          `[${email}] Email input not visible, looking for Email or Social button...`
        );
  
        // Try multiple text variations for the button
        const socialButtonTexts = [
          "Email or Social",
          "Email",
          "Social",
          "Continue with Email",
          "Sign in with Email",
          "Use Email",
        ];
  
        let socialBtn = null;
        const maxAttempts = 5; // Reduced from 10 to prevent long waits
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          for (const buttonText of socialButtonTexts) {
            socialBtn = await findByText(page, buttonText, [
              "button",
              "div",
              "span",
              "a",
            ]);
            if (socialBtn) {
              const isVisible = await page.evaluate((el) => {
                return (
                  el.offsetParent !== null &&
                  el.offsetWidth > 0 &&
                  el.offsetHeight > 0
                );
              }, socialBtn);
              if (isVisible) {
                console.log(
                  `[${email}] Found "${buttonText}" button (attempt ${
                    attempt + 1
                  })`
                );
                break;
              }
            }
          }
          if (socialBtn) break;
          if (attempt < maxAttempts - 1) {
            console.log(`[${email}] Email/Social button not found, retrying... (${attempt + 1}/${maxAttempts})`);
            await delay(1000);
          }
        }
  
        if (socialBtn) {
          await socialBtn.click();
          console.log(`[${email}] Clicked Email or Social button`);
          await delay(2000); // Wait for email input to appear
        } else {
          console.log(
            `[${email}] Email or Social button not found after ${maxAttempts} attempts, checking available buttons...`
          );
  
          // Debug: List all visible buttons to see what's available
          const availableButtons = await page.evaluate(() => {
            const buttons = Array.from(
              document.querySelectorAll(
                'button, div[role="button"], a[role="button"]'
              )
            );
            return buttons
              .filter((btn) => {
                const style = window.getComputedStyle(btn);
                return (
                  btn.offsetParent !== null &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  btn.offsetWidth > 0 &&
                  btn.offsetHeight > 0
                );
              })
              .map((btn) => btn.textContent?.trim())
              .filter((text) => text && text.length > 0)
              .slice(0, 10); // Limit to first 10
          });
          console.log(`[${email}] Available visible buttons:`, availableButtons);
  
          // Check one more time if email input appeared
          console.log(`[${email}] Checking if email input appeared...`);
          await delay(2000);
          const emailInputCheck = await page.$(
            'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"], input[autocomplete="email"]'
          );
          if (emailInputCheck) {
            const isVisible = await page.evaluate((el) => {
              return (
                el.offsetParent !== null &&
                el.offsetWidth > 0 &&
                el.offsetHeight > 0
              );
            }, emailInputCheck);
            if (isVisible) {
              console.log(
                `[${email}] ✅ Email input appeared without clicking button - continuing...`
              );
            } else {
              console.log(`[${email}] ⚠️  Email input found but not visible`);
            }
          } else {
            console.log(`[${email}] ⚠️  Email input still not found - will continue to wait for it in next step`);
          }
        }
      } else {
        console.log(
          `[${email}] Email input already visible, skipping Email or Social button`
        );
      }
  
      // Check if we're already on OTP screen (form might have auto-submitted)
      const isOtpScreen = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        const hasOtpInputs =
          document.querySelectorAll(
            'input[maxlength="1"], input[type="text"][maxlength="1"]'
          ).length >= 4;
        return (
          hasOtpInputs ||
          text.includes("verification code") ||
          text.includes("enter code") ||
          text.includes("6-digit")
        );
      });
  
      if (isOtpScreen) {
        console.log(
          `[${email}] Already on OTP screen - email form was auto-submitted, skipping email entry`
        );
      } else {
        // Wait for email input to appear with retry logic
        console.log(`[${email}] Waiting for email input field...`);
        let emailInput = null;
        const maxEmailWaitAttempts = 10; // Reduced from 15 to prevent long waits
        for (let i = 0; i < maxEmailWaitAttempts; i++) {
          emailInput = await page.$(
            'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"], input[autocomplete="email"]'
          );
          if (emailInput) {
            const isVisible = await page.evaluate((el) => {
              return (
                el.offsetParent !== null &&
                el.offsetWidth > 0 &&
                el.offsetHeight > 0
              );
            }, emailInput);
            if (isVisible) {
              console.log(
                `[${email}] ✅ Email input found and visible (attempt ${i + 1}/${maxEmailWaitAttempts})`
              );
              break;
            } else {
              if ((i + 1) % 3 === 0) {
                console.log(`[${email}] Email input found but not visible (attempt ${i + 1}/${maxEmailWaitAttempts})`);
              }
            }
          } else {
            if ((i + 1) % 3 === 0) {
              console.log(`[${email}] Still waiting for email input... (attempt ${i + 1}/${maxEmailWaitAttempts})`);
            }
          }
          if (i < maxEmailWaitAttempts - 1) {
            await delay(1000); // Increased from 500ms to 1000ms for better stability
          }
        }
        
        if (!emailInput) {
          console.log(`[${email}] ⚠️  Email input not found after ${maxEmailWaitAttempts} attempts`);
          console.log(`[${email}] Checking if already on OTP screen or logged in...`);
          // Check if we're already past email entry (OTP screen or logged in)
          const isOtpScreenCheck = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            const hasOtpInputs =
              document.querySelectorAll(
                'input[maxlength="1"], input[type="text"][maxlength="1"]'
              ).length >= 4;
            return (
              hasOtpInputs ||
              text.includes("verification code") ||
              text.includes("enter code") ||
              text.includes("6-digit")
            );
          });
          
          if (isOtpScreenCheck) {
            console.log(`[${email}] ✅ Already on OTP screen - skipping email entry`);
            emailInput = null; // Set to null so we skip email entry below
          } else {
            // Check if already logged in
            const alreadyLoggedIn = await isLoggedIn(page, exchange);
            if (alreadyLoggedIn) {
              console.log(`[${email}] ✅ Already logged in - skipping email entry`);
              return true;
            } else {
              console.log(`[${email}] ⚠️  Not on OTP screen and not logged in - will try to continue anyway...`);
            }
          }
        }
  
        if (emailInput) {
          console.log(`[${email}] Proceeding to enter email...`);
          // Clear and enter email
          await emailInput.click({ clickCount: 3 }); // Triple click to select all
          await delay(200);
          await page.keyboard.press("Backspace"); // Clear any existing text
          await delay(200);
          await emailInput.type(email, { delay: 50 });
          console.log(`[${email}] Entered email: ${email}`);
  
          // Trigger input events for React forms
          await page.evaluate((el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, emailInput);
  
          await delay(1000); // Wait for form validation
  
          // Click Submit - try multiple approaches
          console.log(`[${email}] Looking for Submit button...`);
          let submitClicked = false;
  
          // Strategy 1: Try clicking Submit button with various text variations
          const submitButtonTexts = [
            "Submit",
            "Continue",
            "Next",
            "Send",
            "Sign in",
          ];
          for (const buttonText of submitButtonTexts) {
            const submitBtn = await findByText(page, buttonText, [
              "button",
              "div",
              "span",
            ]);
            if (submitBtn) {
              const isEnabled = await page.evaluate((el) => {
                if (el.tagName === "BUTTON") {
                  return !el.disabled;
                }
                return el.offsetParent !== null;
              }, submitBtn);
              if (isEnabled) {
                await submitBtn.click();
                console.log(`[${email}] Clicked "${buttonText}" button`);
                submitClicked = true;
                break;
              }
            }
          }
  
          // Strategy 2: Try clicking any element with "Submit" text using page.evaluate
          if (!submitClicked) {
            const clicked = await page.evaluate(() => {
              const allElements = Array.from(
                document.querySelectorAll('button, div[role="button"]')
              );
              const submitElement = allElements.find((el) => {
                const text = el.textContent?.trim();
                return text === "Submit" && el.offsetParent !== null;
              });
              if (submitElement) {
                submitElement.click();
                return true;
              }
              return false;
            });
            if (clicked) {
              submitClicked = true;
              console.log(`[${email}] Clicked Submit via evaluate`);
            }
          }
  
          // Strategy 3: Press Enter on email input
          if (!submitClicked && emailInput) {
            console.log(
              `[${email}] Submit not found, pressing Enter on email input...`
            );
            await emailInput.focus();
            await delay(300);
            await page.keyboard.press("Enter");
            console.log(`[${email}] Pressed Enter`);
            submitClicked = true;
          }
  
          await delay(3000); // Wait for OTP screen
        } else {
          console.log(`[${email}] Email input not found after retries`);
          // Check if we're on OTP screen anyway
          const checkOtpAgain = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            const hasOtpInputs =
              document.querySelectorAll(
                'input[maxlength="1"], input[type="text"][maxlength="1"]'
              ).length >= 4;
            return (
              hasOtpInputs ||
              text.includes("verification code") ||
              text.includes("enter code")
            );
          });
          if (checkOtpAgain) {
            console.log(
              `[${email}] On OTP screen despite email input not found - continuing...`
            );
          }
        }
      }
    } catch (error) {
      console.error(`[${email}] Error during login flow:`, error.message);
      // Don't throw - login might have succeeded despite DOM changes
      console.log(
        `[${email}] Continuing despite error - will check login status...`
      );
    }
  
    // Wait for OTP code entry
    console.log("\n===========================================");
    console.log(`[${email}] Check your email for the verification code!`);
    console.log("===========================================\n");
  
    if (HEADLESS) {
      // In headless mode, prompt for OTP in terminal
      const otp = await prompt(`[${email}] Enter the 6-digit OTP code: `);
  
      // Find OTP input fields and enter code
      const otpInputs = await page.$$("input");
      let otpIndex = 0;
      for (const input of otpInputs) {
        const maxLength = await page.evaluate((el) => el.maxLength, input);
        if (maxLength === 1 && otpIndex < 6) {
          await input.type(otp[otpIndex], { delay: 100 });
          otpIndex++;
        }
      }
      console.log(`[${email}] OTP entered`);
      await delay(2000); // Wait for OTP to be processed
  
      // Check for Ethereum wallet connection error and click Continue
      // Check multiple times as error might appear after a delay
      for (let i = 0; i < 5; i++) {
        await handleWalletConnectionError(page, email);
        await delay(2000);
  
        // Check if we're logged in (error might be resolved)
        const loggedIn = await isLoggedIn(page, exchange);
        if (loggedIn) {
          console.log(`[${email}] Login detected after handling wallet error!`);
          break;
        }
      }
    } else {
      // In non-headless mode, wait for manual entry
      console.log(`[${email}] Please enter the OTP code in the browser...`);
  
      // Wait until we're logged in (check periodically)
      let attempts = 0;
      while (attempts < 40) {
        // Wait up to 2 minutes (40 × 3s)
        await delay(3000); // Check every 3 seconds
  
        // Check for wallet connection error and handle it
        const hasError = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return (
            text.includes("ethereum wallet") ||
            text.includes("wallet connection") ||
            text.includes("connect wallet")
          );
        });
  
        if (hasError) {
          console.log(
            `[${email}] Wallet connection error detected, looking for Continue button...`
          );
          await handleWalletConnectionError(page, email);
        }
  
        try {
          const loggedIn = await isLoggedIn(page, exchange);
          if (loggedIn) {
            console.log(`[${email}] Login detected!`);
            break;
          }
        } catch (error) {
          // Ignore errors during login check - might be DOM changes
          console.log(
            `[${email}] Waiting for login... (attempt ${attempts + 1}/40)`
          );
        }
        attempts++;
      }
    }
  
    await delay(3000);
    await saveCookies(page, cookiesPath, email);
    return true;
  }

  export { login, handleWalletConnectionError, isLoggedIn };