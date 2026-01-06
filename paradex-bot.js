import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

puppeteer.use(StealthPlugin());

// ---------- CONFIG ----------
const PARADEX_URL = "https://app.paradex.trade/trade/BTC-USD-PERP";
const PARADEX_REFERRAL_URL = "https://app.paradex.trade/r/instantcrypto";
const HEADLESS = process.argv.includes('--headless');

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
      cookiesPath: `./paradex-cookies-account${index + 1}.json`,
      profileDir: `/tmp/puppeteer-chrome-profile-${index + 1}-${emailHash}`,
      apiPort: 3001 + index
    };
  });
};

const ACCOUNTS = getAccountsFromEnv();
// ----------------------------

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function findByText(page, text, tagNames = ['button', 'a', 'div', 'span']) {
  for (const tag of tagNames) {
    const elements = await page.$$(tag);
    for (const el of elements) {
      const elText = await page.evaluate(e => e.textContent?.trim(), el);
      if (elText && elText.toLowerCase().includes(text.toLowerCase())) {
        return el;
      }
    }
  }
  return null;
}

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

async function isLoggedIn(page) {
  // Check if user is logged in by looking for account/portfolio elements
  await delay(2000);
  const loggedInIndicators = await page.evaluate(() => {
    const text = document.body.innerText;

    // Check for "Log in" button - if exists, we're NOT logged in
    const hasLoginBtn = Array.from(document.querySelectorAll('button')).some(
      b => b.textContent?.trim() === 'Log in'
    );

    // Check for actual trading interface elements that only appear when logged in
    const hasAccountInfo = text.includes('Available to trade') ||
                          text.includes('Account Value') ||
                          text.includes('Portfolio Value') ||
                          text.includes('Unrealized P&L');

    // More specific check - look for the trading form (Buy/Sell buttons in trading panel)
    const hasTradingInterface = Array.from(document.querySelectorAll('button')).some(
      b => {
        const btnText = b.textContent?.trim();
        return btnText === 'Buy' || btnText === 'Sell';
      }
    );

    // We're only logged in if we DON'T see login button AND we DO see trading interface
    return !hasLoginBtn && (hasAccountInfo || hasTradingInterface);
  });
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

async function login(page, browser, email, cookiesPath, isNewAccount = false) {
  console.log(`[${email}] Starting login process...`);

  try {
    // For new accounts, navigate to referral URL first
    if (isNewAccount) {
      console.log(`[${email}] New account detected - using referral link`);
      try {
        await page.goto(PARADEX_REFERRAL_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await delay(3000);
        console.log(
          `[${email}] Referral link applied: ${PARADEX_REFERRAL_URL}`
        );
      } catch (error) {
        console.log(`[${email}] Error loading referral link, continuing...`);
      }
    }

    // Find and click Log in button - check both app bar and modal
    // Button has data-dd-action-name="Connect wallet" and text "Log in"
    console.log(`[${email}] Looking for Log in button...`);
    let loginClicked = false;

    // Strategy 1: Find by data attribute (most reliable)
    const loginBtnByAttr = await page.$(
      'button[data-dd-action-name="Connect wallet"]'
    );
    if (loginBtnByAttr) {
      await loginBtnByAttr.click();
      loginClicked = true;
      console.log(`[${email}] Clicked Log in button (by data attribute)`);
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
      const alreadyLoggedIn = await isLoggedIn(page);
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
      for (let attempt = 0; attempt < 10; attempt++) {
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
        await delay(1000);
      }

      if (socialBtn) {
        await socialBtn.click();
        console.log(`[${email}] Clicked Email or Social button`);
        await delay(2000); // Wait for email input to appear
      } else {
        console.log(
          `[${email}] Email or Social button not found after retries, checking available buttons...`
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
              `[${email}] Email input appeared without clicking button - continuing...`
            );
          }
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
      for (let i = 0; i < 15; i++) {
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
              `[${email}] Email input found and visible (attempt ${i + 1})`
            );
            break;
          }
        }
        await delay(500);
      }

      if (emailInput) {
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
      const loggedIn = await isLoggedIn(page);
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
        const loggedIn = await isLoggedIn(page);
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

async function findByExactText(pg, text, tagNames = ["button", "div", "span"]) {
  for (const tag of tagNames) {
    const elements = await pg.$$(tag);
    for (const el of elements) {
      const elText = await pg.evaluate((e) => e.textContent?.trim(), el);
      if (elText === text) {
        return el;
      }
    }
  }
  return null;
}

async function getCurrentMarketPrice(page) {
  console.log("Fetching current market price...");

  try {
    // Try to get the current price from the page
    const price = await page.evaluate(() => {
      // Look for price displays - common patterns on trading interfaces
      const priceSelectors = [
        // Try to find the main price ticker
        '[class*="price"]',
        '[class*="ticker"]',
        '[class*="mark-price"]',
        '[class*="last-price"]',
        '[data-testid*="price"]',
      ];

      // Check all possible price elements
      for (const selector of priceSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim();
          // Look for USD prices (format: $XX,XXX.XX or XX,XXX.XX)
          const match = text?.match(
            /\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/
          );
          if (match) {
            const priceStr = match[1].replace(/,/g, "");
            const price = parseFloat(priceStr);
            // Validate it's a reasonable BTC price (between $1,000 and $500,000)
            if (price >= 1000 && price <= 500000) {
              return price;
            }
          }
        }
      }

      // Fallback: look for any large number that looks like a BTC price
      const allText = document.body.innerText;
      const priceMatches = allText.match(
        /\$?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)/g
      );
      if (priceMatches) {
        for (const match of priceMatches) {
          const priceStr = match.replace(/[$,]/g, "");
          const price = parseFloat(priceStr);
          if (price >= 1000 && price <= 500000) {
            return price;
          }
        }
      }

      return null;
    });

    if (price) {
      console.log(`✓ Current market price: $${price.toLocaleString()}`);
      return price;
    } else {
      console.log("⚠ Could not find market price on page");
      return null;
    }
  } catch (error) {
    console.error("Error fetching market price:", error.message);
    return null;
  }
}

async function getCurrentUnrealizedPnL(page) {
  // This function reads the current profit/loss from the Paradex page
  // Improved to detect losses even when displayed without minus sign (e.g., red color, parentheses)
  try {
    // First, click on "Positions" tab to see the P&L information
    const positionsTab = await findByExactText(page, "Positions", [
      "button",
      "div",
      "span",
    ]);
    if (positionsTab) {
      await positionsTab.click();
      await delay(1500); // Wait for page to update
    }

    // Now extract the P&L number from the page with improved loss detection
    const pnl = await page.evaluate(() => {
      const text = document.body.innerText;

      // Helper function to check if color indicates a loss (red colors)
      const isRedColor = (color) => {
        if (!color) return false;
        const lowerColor = color.toLowerCase();
        return (
          lowerColor.includes("rgb(255") ||
          lowerColor.includes("rgb(220") ||
          lowerColor.includes("rgb(239") ||
          lowerColor.includes("#ff") ||
          lowerColor.includes("#f00") ||
          lowerColor.includes("#ef") ||
          lowerColor.includes("red")
        );
      };

      // Strategy 1: Look for text containing "Unrealized P&L" and find the dollar amount nearby
      const allElements = Array.from(document.querySelectorAll("*"));
      for (const el of allElements) {
        // Skip style, script, and other non-content elements
        if (
          el.tagName === "STYLE" ||
          el.tagName === "SCRIPT" ||
          el.tagName === "NOSCRIPT"
        ) {
          continue;
        }

        // Skip elements that are not visible
        const computedStyle = window.getComputedStyle(el);
        if (
          computedStyle.display === "none" ||
          computedStyle.visibility === "hidden"
        ) {
          continue;
        }

        const elText = el.textContent || "";

        // Skip if text looks like CSS or code (contains CSS selectors, brackets, etc.)
        if (
          elText.includes(":where(") ||
          elText.includes("{color:") ||
          elText.includes("background-color:") ||
          elText.match(/^[a-z-]+:\s*[^;]+;/)
        ) {
          continue;
        }

        if (elText.includes("Unrealized P&L") || elText.includes("P&L")) {
          // Check if this element or nearby elements indicate a loss
          const color = computedStyle.color;
          const isRed = isRedColor(color);

          // Look for dollar amounts with or without minus
          const match = elText.match(
            /[\$]?([-]?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/
          );

          // Also check for parentheses format (2) = loss
          const parenMatch = elText.match(
            /\(([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\)/
          );

          if (match) {
            let value = parseFloat(match[1].replace(/,/g, ""));
            const originalValue = value;
            let conversionReason = null;
            const matchIndex = elText.indexOf(match[0]);

            // If value is in parentheses, it's a loss (make it negative)
            if (
              parenMatch &&
              Math.abs(value - parseFloat(parenMatch[1].replace(/,/g, ""))) <
                0.01
            ) {
              value = -Math.abs(value);
              conversionReason = "parentheses format";
            }
            // If displayed in red color, it's likely a loss
            else if (isRed && value > 0) {
              value = -Math.abs(value);
              conversionReason = "red color detected";
            }
            // If the text contains "loss" or "negative" nearby (but not in CSS), make it negative
            else if (value > 0) {
              const lowerText = elText.toLowerCase();
              const lossIndex = lowerText.indexOf("loss");
              const negativeIndex = lowerText.indexOf("negative");

              // Only convert if "loss" or "negative" appears near the number (within 50 chars)
              if (
                (lossIndex !== -1 && Math.abs(lossIndex - matchIndex) < 50) ||
                (negativeIndex !== -1 &&
                  Math.abs(negativeIndex - matchIndex) < 50)
              ) {
                value = -Math.abs(value);
                conversionReason = "loss/negative text found near P&L value";
              }
            }
            // Check parent elements for red color or loss indicators
            if (value > 0) {
              let parent = el.parentElement;
              for (let i = 0; i < 5 && parent; i++) {
                const parentStyle = window.getComputedStyle(parent);
                const parentColor = parentStyle.color;
                if (isRedColor(parentColor)) {
                  value = -Math.abs(value);
                  conversionReason = `parent element ${i + 1} has red color`;
                  break;
                }
                parent = parent.parentElement;
              }
            }

            // Make sure it's a reasonable P&L value (between -$100,000 and $100,000)
            if (value >= -100000 && value <= 100000) {
              // Return debug info along with value
              return {
                value: value,
                debug: {
                  originalValue: originalValue,
                  finalValue: value,
                  color: color,
                  isRed: isRed,
                  conversionReason: conversionReason,
                  elementText: elText.substring(0, 200), // Show more context
                  elementTag: el.tagName, // Add tag name for debugging
                },
              };
            }
          }
        }
      }

      // Strategy 2: Look for negative dollar amounts (losses) near "P&L" text
      const negativeMatches = text.match(
        /[\$]?([-][0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/g
      );
      if (negativeMatches) {
        for (const match of negativeMatches) {
          const value = parseFloat(match.replace(/[$,]/g, ""));
          if (value < 0 && value >= -100000) {
            // Check if this number is near "P&L" text
            const matchIndex = text.indexOf(match);
            const nearbyText = text.substring(
              Math.max(0, matchIndex - 50),
              matchIndex + 50
            );
            if (
              nearbyText.includes("P&L") ||
              nearbyText.includes("Unrealized")
            ) {
              return {
                value: value,
                debug: {
                  originalValue: value,
                  finalValue: value,
                  color: "N/A (negative match)",
                  isRed: false,
                  conversionReason: "negative sign in text",
                  elementText: nearbyText,
                },
              };
            }
          }
        }
      }

      // Strategy 3: Look for parentheses format (losses) near P&L text
      const parenMatches = text.match(
        /\(([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\)/g
      );
      if (parenMatches) {
        for (const match of parenMatches) {
          const matchIndex = text.indexOf(match);
          const nearbyText = text.substring(
            Math.max(0, matchIndex - 50),
            matchIndex + 50
          );
          if (
            nearbyText.includes("P&L") ||
            nearbyText.includes("Unrealized") ||
            nearbyText.toLowerCase().includes("loss")
          ) {
            const originalValue = parseFloat(match.replace(/[(),]/g, ""));
            const value = -Math.abs(originalValue);
            if (value >= -100000) {
              return {
                value: value,
                debug: {
                  originalValue: originalValue,
                  finalValue: value,
                  color: "N/A (parentheses match)",
                  isRed: false,
                  conversionReason: "parentheses format",
                  elementText: nearbyText,
                },
              };
            }
          }
        }
      }

      // Strategy 4: Look in the positions section for any dollar amount
      const positionsSection = text.match(
        /Position[^]*?P&L[^]*?([\$]?[-]?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/i
      );
      if (positionsSection) {
        let value = parseFloat(positionsSection[1].replace(/[$,]/g, ""));
        const originalValue = value;
        let conversionReason = null;

        // Check if nearby text suggests it's a loss
        const sectionIndex = text.indexOf(positionsSection[0]);
        const contextText = text.substring(
          Math.max(0, sectionIndex - 100),
          sectionIndex + 100
        );
        if (
          (contextText.toLowerCase().includes("loss") ||
            contextText.includes("(")) &&
          value > 0
        ) {
          value = -Math.abs(value);
          conversionReason = "loss text or parentheses in context";
        }

        if (value >= -100000 && value <= 100000) {
          return {
            value: value,
            debug: {
              originalValue: originalValue,
              finalValue: value,
              color: "N/A (positions section)",
              isRed: false,
              conversionReason: conversionReason,
              elementText: contextText.substring(0, 100),
            },
          };
        }
      }

      return null; // Couldn't find P&L
    });

    if (pnl !== null) {
      // Handle both old format (number) and new format (object with debug)
      let pnlValue, debugInfo;
      if (typeof pnl === "object" && pnl.value !== undefined) {
        pnlValue = pnl.value;
        debugInfo = pnl.debug;
      } else {
        pnlValue = pnl;
        debugInfo = null;
      }

      console.log(`Current Unrealized P&L: $${pnlValue.toLocaleString()}`);

      // Log debug information if available
      if (debugInfo) {
        console.log(
          `  [P&L Debug] Original Value: $${debugInfo.originalValue}`
        );
        console.log(`  [P&L Debug] Final Value: $${debugInfo.finalValue}`);
        console.log(`  [P&L Debug] Color: ${debugInfo.color}`);
        console.log(`  [P&L Debug] Is Red: ${debugInfo.isRed}`);
        if (debugInfo.elementTag) {
          console.log(`  [P&L Debug] Element Tag: ${debugInfo.elementTag}`);
        }
        if (debugInfo.conversionReason) {
          console.log(
            `  [P&L Debug] Converted to negative because: ${debugInfo.conversionReason}`
          );
        } else {
          console.log(`  [P&L Debug] No conversion applied (value kept as-is)`);
        }
        console.log(`  [P&L Debug] Element Text: ${debugInfo.elementText}`);
      }

      return pnlValue; // Return the P&L value (negative = loss, positive = profit)
    } else {
      console.log("Could not find Unrealized P&L on page");
      return null;
    }
  } catch (error) {
    console.error("Error fetching P&L:", error.message);
    return null;
  }
}

async function closeAllPositions(page, percent = 100) {
  console.log(`\n=== Closing Position (${percent}%) ===`);

  // Wait a moment for any previous actions to complete
  await delay(1000);

  // Click on Positions tab to see open positions
  const positionsTab = await findByExactText(page, "Positions", [
    "button",
    "div",
    "span",
  ]);
  if (positionsTab) {
    await positionsTab.click();
    console.log("Clicked Positions tab");
    await delay(2000); // Increased wait time for positions to load
  }

  // Check if there are any open positions
  console.log("Checking for open positions...");
  let hasPositions = false;
  for (let i = 0; i < 3; i++) {
    hasPositions = await page.evaluate(() => {
      const text = document.body.innerText;
      return (
        text.includes("Current Position") ||
        text.includes("Unrealized P&L") ||
        text.includes("Position Size") ||
        text.includes("Entry Price")
      );
    });

    if (hasPositions) {
      console.log("Found open positions!");
      break;
    }

    if (i < 2) {
      console.log(`Attempt ${i + 1}/3: No positions found yet, waiting...`);
      await delay(1500);
    }
  }

  if (!hasPositions) {
    console.log("No open positions found");
    return { success: true, message: "No positions to close" };
  }

  // Wait a bit more for UI to fully render
  await delay(1000);

  // Look for Close buttons with multiple strategies
  const closeButtonsDebug = await page.evaluate(() => {
    const allButtons = Array.from(
      document.querySelectorAll(
        'button, div[role="button"], a[role="button"], [class*="button"]'
      )
    );

    const candidates = [];

    for (const btn of allButtons) {
      const text = btn.textContent?.trim().toLowerCase();
      const isVisible = btn.offsetParent !== null;

      // Strategy 1: Text contains "close"
      if (text && (text.includes("close") || text === "x")) {
        candidates.push({
          text: btn.textContent?.trim(),
          visible: isVisible,
          className: btn.className,
          strategy: "text-match",
        });
      }

      // Strategy 2: Button near position-related text
      if (isVisible) {
        const parentText = btn.parentElement?.textContent?.toLowerCase() || "";
        if (
          parentText.includes("position") &&
          (text?.includes("close") ||
            text?.includes("exit") ||
            text?.includes("sell") ||
            text?.includes("buy"))
        ) {
          candidates.push({
            text: btn.textContent?.trim(),
            visible: isVisible,
            className: btn.className,
            strategy: "context-match",
          });
        }
      }

      // Strategy 3: Look for buttons with aria-label containing "close"
      const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";
      if (ariaLabel.includes("close") || ariaLabel.includes("exit")) {
        candidates.push({
          text: btn.textContent?.trim() || ariaLabel,
          visible: isVisible,
          className: btn.className,
          strategy: "aria-label",
        });
      }
    }

    return candidates;
  });

  console.log(
    `Found ${closeButtonsDebug.length} close-related buttons:`,
    JSON.stringify(closeButtonsDebug, null, 2)
  );

  // Try multiple strategies to find and click close button
  let closeBtn = null;
  let closeBtnClicked = false;

  // Strategy 1: Find by text "Close" using existing function
  closeBtn = await findByText(page, "Close", ["button", "div", "a"]);

  // Strategy 2: If not found, try to find by evaluating the page and click directly
  if (!closeBtn) {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll(
          'button, div[role="button"], a[role="button"]'
        )
      );
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toLowerCase();
        const isVisible = btn.offsetParent !== null;
        if (isVisible && text && (text.includes("close") || text === "x")) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      closeBtnClicked = true;
      console.log("Clicked Close button (via evaluate)");
    }
  }

  // Strategy 3: Try finding by aria-label and click directly
  if (!closeBtn && !closeBtnClicked) {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll(
          'button, div[role="button"], a[role="button"]'
        )
      );
      for (const btn of buttons) {
        const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";
        const isVisible = btn.offsetParent !== null;
        if (
          isVisible &&
          (ariaLabel.includes("close") || ariaLabel.includes("exit"))
        ) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      closeBtnClicked = true;
      console.log("Clicked Close button (via aria-label)");
    }
  }

  if (!closeBtn && !closeBtnClicked && closeButtonsDebug.length === 0) {
    console.log("No close buttons found after multiple strategies");
    return { success: false, error: "No close buttons found in positions" };
  }

  if (closeBtn && !closeBtnClicked) {
    await closeBtn.click();
    console.log("Clicked Close button");
  }

  // Wait for modal to appear (whether clicked via element or evaluate)
  if (closeBtn || closeBtnClicked) {
    await delay(2000); // Wait for modal to fully load

    // Select the percentage by clicking the percentage button in the modal
    console.log(`Setting close percentage to ${percent}%`);

    // Find and click the percentage button in the modal
    // These buttons are INSIDE the modal, below "Position Value (Closing)"
    const percentButtonClicked = await page.evaluate((targetPercent) => {
      const buttons = Array.from(document.querySelectorAll("button"));

      // Find buttons that are just the percentage (like "50%", "25%", etc)
      // AND are inside a modal (check for modal-related parent)
      for (const btn of buttons) {
        const text = btn.textContent?.trim();

        // Check if this is a percentage button
        if (text === `${targetPercent}%`) {
          // Check if it's in the modal by looking for modal-related parent elements
          let parent = btn.parentElement;
          let isInModal = false;

          // Check up to 10 levels up for modal indicators
          for (let i = 0; i < 10 && parent; i++) {
            const parentText = parent.textContent || "";
            if (
              parentText.includes("Close All Positions") ||
              parentText.includes("Position Value (Closing)")
            ) {
              isInModal = true;
              break;
            }
            parent = parent.parentElement;
          }

          if (isInModal) {
            console.log(`Found ${targetPercent}% button in modal, clicking it`);
            btn.click();
            return { success: true, clicked: text };
          }
        }
      }

      return {
        success: false,
        error: `${targetPercent}% button not found in modal`,
      };
    }, percent);

    if (!percentButtonClicked.success) {
      console.log(`Error: ${percentButtonClicked.error}`);
      return { success: false, error: percentButtonClicked.error };
    }

    console.log(`Clicked ${percentButtonClicked.clicked} button in modal`);
    await delay(800); // Reduced from 1500

    // Now look for the close confirmation button
    // The button text should have changed to match the percentage
    console.log(`Looking for close confirmation button...`);

    const closeConfirmBtn = await page.evaluate((targetPercent) => {
      const buttons = Array.from(document.querySelectorAll("button"));

      // Log all buttons for debugging
      console.log("All buttons in modal:");
      buttons.forEach((btn) => {
        const text = btn.textContent?.trim();
        if (text) console.log(`  - "${text}"`);
      });

      // Look for button with text like "Close 50% of All Positions"
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (
          text &&
          text.toLowerCase().includes("close") &&
          text.includes("%") &&
          text.toLowerCase().includes("position")
        ) {
          // Found the button, click it
          console.log(`Found and clicking: "${text}"`);
          btn.click();
          return { success: true, text: text };
        }
      }

      return { success: false };
    }, percent);

    if (closeConfirmBtn.success) {
      console.log(`Clicked button: "${closeConfirmBtn.text}"`);
      await delay(1000); // Reduced from 2000

      const errorMsg = await page.evaluate(() => {
        const errors = document.querySelectorAll(
          '[class*="error"], [class*="Error"]'
        );
        for (const err of errors) {
          if (err.textContent) return err.textContent;
        }
        return null;
      });

      if (errorMsg) {
        console.log("Close error:", errorMsg);
        return { success: false, error: errorMsg };
      }

      console.log(`Position closed successfully (${percent}%)!`);
      return { success: true, message: `Position closed at ${percent}%` };
    } else {
      console.log("Close confirmation button not found");
      return { success: false, error: "Close confirmation button not found" };
    }
  } else {
    console.log("Close button not found");
    return { success: false, error: "Close button not found" };
  }
}

async function setLeverage(page, leverage) {
  console.log(`\n=== Setting Leverage to ${leverage}x ===`);
  console.log(`Target leverage from config: ${leverage}`);

  try {
    await delay(1000);

    // Step 1: Find and click the leverage display (e.g., "50x") in the trading panel to open modal
    console.log("Looking for leverage button in trading panel...");
    const leverageOpened = await page.evaluate(() => {
      // Look for leverage display with various strategies
      const allElements = Array.from(
        document.querySelectorAll("button, div, span, a")
      );

      // Strategy 1: Find elements with "x" pattern (like "50x")
      let candidates = [];
      for (const el of allElements) {
        const text = el.textContent?.trim();
        // Look for pattern like "50x", "20x", etc.
        if (text && /^\d+x$/i.test(text)) {
          const rect = el.getBoundingClientRect();
          // Check if visible and has reasonable size
          if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
            candidates.push({
              element: el,
              text: text,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            });
          }
        }
      }

      console.log(`Found ${candidates.length} leverage button candidates`);
      candidates.forEach((c, i) => {
        console.log(
          `  ${i + 1}. "${c.text}" at (${Math.round(c.x)}, ${Math.round(
            c.y
          )}) size: ${Math.round(c.width)}x${Math.round(c.height)}`
        );
      });

      // Strategy 2: Filter for trading panel area
      // Look for elements that are in the upper-right area or near trading controls
      let bestCandidate = null;

      // First try: Look for leverage in the right half of the screen
      for (const candidate of candidates) {
        if (candidate.x > window.innerWidth / 2) {
          bestCandidate = candidate;
          console.log(`Selected candidate in right panel: "${candidate.text}"`);
          break;
        }
      }

      // Fallback: Just take the first visible one
      if (!bestCandidate && candidates.length > 0) {
        bestCandidate = candidates[0];
        console.log(`Using first available candidate: "${bestCandidate.text}"`);
      }

      if (bestCandidate) {
        console.log(`Clicking leverage button: ${bestCandidate.text}`);
        bestCandidate.element.click();
        return { success: true, found: bestCandidate.text };
      }

      return { success: false };
    });

    if (!leverageOpened.success) {
      console.log("⚠ Leverage button not found in trading panel");
      return { success: false, error: "Leverage button not found" };
    }

    console.log(
      `✓ Clicked leverage button: ${leverageOpened.found}, waiting for modal...`
    );
    await delay(2500); // Wait for "Adjust Leverage" modal to open

    // Step 2: Find the input field in the modal and enter the leverage value
    console.log(`Setting leverage to ${leverage} in the modal...`);

    // Find the leverage input field
    const inputInfo = await page.evaluate(() => {
      const inputs = document.querySelectorAll(
        'input[type="text"], input[type="number"], input:not([type])'
      );

      console.log(`Found ${inputs.length} input fields in modal`);

      // Strategy: Find input with numeric value in visible modal
      for (const input of inputs) {
        if (input.offsetParent === null) continue; // Skip hidden inputs

        const value = input.value || "";
        const placeholder = input.placeholder || "";

        console.log(`Input: value="${value}", placeholder="${placeholder}"`);

        // Check if this looks like a leverage input
        if (
          /^\d+$/.test(value) ||
          placeholder.toLowerCase().includes("leverage")
        ) {
          console.log(`Found leverage input with current value: "${value}"`);

          // Mark the input with a unique attribute so we can find it again
          input.setAttribute("data-leverage-input", "true");
          input.setAttribute("data-old-value", value);

          return {
            success: true,
            oldValue: value,
          };
        }
      }

      return { success: false, error: "Leverage input not found in modal" };
    });

    if (!inputInfo.success) {
      console.log(`⚠ Could not find leverage input: ${inputInfo.error}`);
      return { success: false, error: inputInfo.error };
    }

    // Now use Puppeteer to actually type into the input (for proper React state management)
    const leverageInput = await page.$('input[data-leverage-input="true"]');

    if (!leverageInput) {
      console.log(`⚠ Could not locate leverage input element`);
      return {
        success: false,
        error: "Could not locate leverage input element",
      };
    }

    // Triple-click to select all and position cursor
    await leverageInput.click({ clickCount: 3 });
    await delay(200);

    // Get current value
    let currentValue = await page.evaluate(() => {
      const input = document.querySelector('input[data-leverage-input="true"]');
      return input ? input.value : "";
    });

    console.log(`Current input value: "${currentValue}"`);

    // Move cursor to end of input
    await page.keyboard.press("End");
    await delay(100);

    // Delete all characters with backspace
    const deleteCount = currentValue.length;
    console.log(`Deleting ${deleteCount} characters with backspace...`);
    for (let i = 0; i < deleteCount; i++) {
      await page.keyboard.press("Backspace");
      await delay(30);
    }
    await delay(200);

    // Verify input is empty or has default "0"
    currentValue = await page.evaluate(() => {
      const input = document.querySelector('input[data-leverage-input="true"]');
      return input ? input.value : "";
    });
    console.log(`After deleting: "${currentValue}"`);

    // If there's still a "0", delete it too
    if (currentValue === "0") {
      await page.keyboard.press("Backspace");
      await delay(100);
    }

    // Now type the new leverage value
    const leverageStr = String(leverage);
    console.log(`Typing leverage value: "${leverageStr}"`);
    await page.keyboard.type(leverageStr, { delay: 100 });
    await delay(300);

    // Delete the trailing "0" if it appears
    console.log(`Pressing Delete to remove trailing "0"...`);
    await page.keyboard.press("Delete");
    await delay(200);

    // Verify the value was set
    const leverageSet = await page.evaluate(() => {
      const input = document.querySelector('input[data-leverage-input="true"]');
      if (input) {
        return {
          success: true,
          oldValue: input.getAttribute("data-old-value") || "unknown",
          newValue: input.value,
        };
      }
      return { success: false, error: "Input disappeared" };
    });

    if (!leverageSet.success) {
      console.log(`⚠ Could not set leverage value: ${leverageSet.error}`);
      return { success: false, error: leverageSet.error };
    }

    console.log(
      `✓ Changed leverage from ${leverageSet.oldValue} to ${leverageSet.newValue}`
    );

    // Wait for the UI to register the input change before clicking Confirm
    console.log("Waiting for UI to register the leverage change...");
    await delay(3000);

    // Step 3: Click the "Confirm" button
    console.log("Clicking Confirm button...");
    const confirmed = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (text === "Confirm" && btn.offsetParent !== null) {
          console.log(`Found and clicking Confirm button`);
          btn.click();
          return { success: true };
        }
      }
      return { success: false };
    });

    if (!confirmed.success) {
      console.log("⚠ Confirm button not found");
      return { success: false, error: "Confirm button not found" };
    }

    await delay(2000); // Wait for modal to close and settings to apply

    // Verify the leverage was actually applied by checking the display button
    console.log("Verifying leverage was applied...");
    const finalLeverage = await page.evaluate(() => {
      const allElements = Array.from(
        document.querySelectorAll("button, div, span, a")
      );
      for (const el of allElements) {
        const text = el.textContent?.trim();
        if (text && /^\d+x$/i.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
            return text;
          }
        }
      }
      return null;
    });

    if (finalLeverage) {
      console.log(
        `✓ Leverage successfully set to ${leverage}x (verified: ${finalLeverage})`
      );
    } else {
      console.log(
        `✓ Leverage set to ${leverage}x (verification skipped - display not found)`
      );
    }

    return { success: true, leverage: leverage };
  } catch (error) {
    console.error("Error setting leverage:", error.message);
    return { success: false, error: error.message };
  }
}

async function executeTrade(
  page,
  { side, orderType, price, qty, setLeverageFirst = false, leverage = null }
) {
  console.log(`\n=== Executing Trade ===`);

  // Set leverage first if requested (legacy support for API calls)
  if (setLeverageFirst && leverage) {
    const leverageResult = await setLeverage(page, leverage);
    if (!leverageResult.success) {
      console.log(`⚠ Failed to set leverage: ${leverageResult.error}`);
      // Continue anyway - leverage setting might not be critical
    }
    await delay(1000);
  }

  // If limit order without price, fetch current market price
  if (orderType === "limit" && !price) {
    price = await getCurrentMarketPrice(page);
    if (!price) {
      console.log("❌ Could not fetch market price for limit order");
      return { success: false, error: "Could not fetch market price" };
    }
  }

  console.log(
    `Side: ${side}, Type: ${orderType}, Price: ${
      price || "market"
    }, Qty: ${qty}`
  );

  // No need to reload - just wait a moment for any previous actions to complete
  await delay(1000); // Reduced from 2000

  // 1. Select Buy or Sell
  if (side === "sell") {
    const sellBtn = await findByExactText(page, "Sell", ["button", "div"]);
    if (sellBtn) {
      await sellBtn.click();
      console.log("Selected SELL");
      await delay(500);
    }
  } else {
    const buyBtn = await findByExactText(page, "Buy", ["button", "div"]);
    if (buyBtn) {
      await buyBtn.click();
      console.log("Selected BUY");
      await delay(500);
    }
  }

  // 2. Select Market or Limit order type
  if (orderType === "limit") {
    const limitBtn = await findByExactText(page, "Limit", ["button", "div"]);
    if (limitBtn) {
      await limitBtn.click();
      console.log("Selected LIMIT order");
      await delay(500);
    }
  } else {
    const marketBtn = await findByExactText(page, "Market", ["button", "div"]);
    if (marketBtn) {
      await marketBtn.click();
      console.log("Selected MARKET order");
      await delay(500);
    }
  }

  await delay(1000);

  // 3. Find and fill inputs - Look for the Size input in the trading panel
  const inputs = await page.$$('input[type="text"], input:not([type])');
  let sizeInput = null;
  let priceInput = null;

  console.log(`Found ${inputs.length} text input elements on page`);

  for (const input of inputs) {
    const rect = await input.boundingBox();
    if (!rect) continue;

    // Look for inputs in the right panel (trading panel is on the right side)
    if (rect.x < 1100) continue;

    const inputInfo = await page.evaluate((el) => {
      // Get all text content around this input
      let parent = el.parentElement;
      let parentText = "";
      let labelText = "";

      // Check for label
      const labels = document.querySelectorAll("label");
      for (const label of labels) {
        if (label.control === el || label.contains(el)) {
          labelText = label.textContent?.trim() || "";
        }
      }

      // Get parent text
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.innerText) {
          parentText = parent.innerText;
          break;
        }
        parent = parent.parentElement;
      }

      return {
        placeholder: el.placeholder || "",
        value: el.value || "",
        id: el.id || "",
        name: el.name || "",
        parentText: parentText,
        labelText: labelText,
      };
    }, input);

    console.log(`Input at (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
    console.log(
      `  ID: "${inputInfo.id}", Name: "${inputInfo.name}", Placeholder: "${inputInfo.placeholder}"`
    );
    console.log(
      `  Label: "${
        inputInfo.labelText
      }", Parent: "${inputInfo.parentText.substring(0, 60)}"`
    );
    console.log(`  Current value: "${inputInfo.value}"`);

    // Check if this is the Size input
    const isSizeInput =
      inputInfo.parentText.includes("Size") ||
      inputInfo.labelText.includes("Size") ||
      inputInfo.placeholder.includes("Size") ||
      inputInfo.id.includes("size") ||
      inputInfo.name.includes("size");

    // Check if this is the Price input
    const isPriceInput =
      inputInfo.parentText.includes("Price") ||
      inputInfo.labelText.includes("Price") ||
      inputInfo.placeholder.includes("Price") ||
      inputInfo.id.includes("price") ||
      inputInfo.name.includes("price");

    if (isSizeInput && !sizeInput) {
      sizeInput = input;
      console.log("✓ Found size input!");
    } else if (isPriceInput && !priceInput && orderType === "limit") {
      priceInput = input;
      console.log("✓ Found price input!");
    }
  }

  // Enter price (for limit orders)
  if (orderType === "limit" && price) {
    if (priceInput) {
      await priceInput.click({ clickCount: 3 });
      await delay(100);
      await page.keyboard.press("Backspace");
      await priceInput.type(String(price), { delay: 30 });
      console.log(`Entered price: ${price}`);
    } else {
      const allInputs = await page.$$("input");
      for (const inp of allInputs) {
        const rect = await inp.boundingBox();
        if (rect && rect.x > 1000 && rect.y > 150 && rect.y < 300) {
          await inp.click({ clickCount: 3 });
          await delay(100);
          await page.keyboard.press("Backspace");
          await inp.type(String(price), { delay: 30 });
          console.log(`Entered price: ${price} (fallback)`);
          break;
        }
      }
    }
    await delay(300);
  }

  // Enter quantity/size
  if (!sizeInput) {
    console.log("❌ Size input not found! Cannot proceed with trade.");
    return { success: false, error: "Size input field not found" };
  }

  console.log("\n=== Entering Size ===");

  // Method 1: Clear and type
  await sizeInput.click();
  await delay(300);

  // Select all existing text (using Meta/Command on Mac)
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Meta");
  await delay(100);

  // Type the new value
  await page.keyboard.type(String(qty), { delay: 100 });
  await delay(500);

  // Verify the value was set
  let actualValue = await page.evaluate((el) => el.value, sizeInput);
  console.log(`Size input value after first attempt: "${actualValue}"`);

  // If value wasn't set properly, try alternative method
  if (
    !actualValue ||
    actualValue === "" ||
    Math.abs(parseFloat(actualValue) - parseFloat(qty)) > 0.0001
  ) {
    console.log("First attempt failed, trying alternative method...");

    // Focus the input
    await sizeInput.focus();
    await delay(200);

    // Clear using JavaScript
    await page.evaluate((el) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sizeInput);
    await delay(200);

    // Type again
    await sizeInput.type(String(qty), { delay: 100 });
    await delay(500);

    actualValue = await page.evaluate((el) => el.value, sizeInput);
    console.log(`Size input value after second attempt: "${actualValue}"`);
  }

  // If still not set, try direct value assignment
  if (
    !actualValue ||
    actualValue === "" ||
    Math.abs(parseFloat(actualValue) - parseFloat(qty)) > 0.0001
  ) {
    console.log("Second attempt failed, using direct assignment...");

    await page.evaluate(
      (el, value) => {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      },
      sizeInput,
      String(qty)
    );
    await delay(500);

    actualValue = await page.evaluate((el) => el.value, sizeInput);
    console.log(`Size input value after direct assignment: "${actualValue}"`);
  }

  // Final verification
  if (!actualValue || actualValue === "") {
    console.log("❌ Failed to set size value!");
    return { success: false, error: "Failed to enter size value" };
  }

  console.log(`✓ Successfully set size to: ${actualValue}`);
  await delay(1000);
  // 4. Click Confirm button
  const confirmText = side === "buy" ? "Confirm Buy" : "Confirm Sell";
  const confirmBtn = await findByText(page, confirmText, ["button"]);

  if (confirmBtn) {
    await confirmBtn.click();
    console.log(`Clicked "${confirmText}"`);
    await delay(2000);

    const errorMsg = await page.evaluate(() => {
      const errors = document.querySelectorAll(
        '[class*="error"], [class*="Error"]'
      );
      for (const err of errors) {
        if (err.textContent) return err.textContent;
      }
      return null;
    });

    if (errorMsg) {
      console.log("Trade error:", errorMsg);
      return { success: false, error: errorMsg };
    }

    console.log("Trade submitted successfully!");
    return { success: true, message: "Trade submitted" };
  } else {
    console.log(`Could not find "${confirmText}" button`);
    return { success: false, error: "Confirm button not found" };
  }
}

function startApiServer(page, apiPort, email) {
  let isReady = true;
  const apiApp = express();
  apiApp.use(express.json());

  // Health check
  apiApp.get("/health", (req, res) => {
    res.json({ status: "ok", ready: isReady, account: email });
  });

  // Place trade
  apiApp.post("/trade", async (req, res) => {
    const { side, orderType, price, qty, leverage, setLeverageFirst } =
      req.body;

    if (!side || !["buy", "sell"].includes(side)) {
      return res
        .status(400)
        .json({ error: "Invalid side. Use 'buy' or 'sell'" });
    }
    if (!orderType || !["market", "limit"].includes(orderType)) {
      return res
        .status(400)
        .json({ error: "Invalid orderType. Use 'market' or 'limit'" });
    }
    // Price is now optional for limit orders - will fetch current market price if not provided
    if (!qty || qty <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid qty. Must be positive number" });
    }

    try {
      const result = await executeTrade(page, {
        side,
        orderType,
        price,
        qty,
        leverage,
        setLeverageFirst: setLeverageFirst || false,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Close all positions
  apiApp.post("/close-all", async (req, res) => {
    const { percent = 100 } = req.body;

    // Validate percent
    if (percent < 0 || percent > 100) {
      return res
        .status(400)
        .json({ error: "Percent must be between 0 and 100" });
    }

    try {
      const result = await closeAllPositions(page, percent);
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Screenshot endpoint
  apiApp.get("/screenshot", async (req, res) => {
    const filename = `screenshot-${email}-${Date.now()}.png`;
    await page.screenshot({ path: filename });
    res.json({ success: true, file: filename });
  });

  apiApp.listen(apiPort, () => {
    console.log(`\n========================================`);
    console.log(`[${email}] Trade API running on http://localhost:${apiPort}`);
    console.log(`========================================\n`);
    console.log(`Endpoints:`);
    console.log(`  GET  /health      - Check if bot is ready`);
    console.log(`  POST /trade       - Place a trade`);
    console.log(`  POST /close-all   - Close all positions`);
    console.log(`  GET  /screenshot  - Take screenshot\n`);
    console.log(`Examples:`);
    console.log(
      `  # Place a limit buy order at market price (price auto-fetched)`
    );
    console.log(`  curl -X POST http://localhost:${apiPort}/trade \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"side":"buy","orderType":"limit","qty":0.001}'\n`);
    console.log(`  # Place a limit order with 40x leverage`);
    console.log(`  curl -X POST http://localhost:${apiPort}/trade \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(
      `    -d '{"side":"buy","orderType":"limit","qty":0.001,"leverage":40,"setLeverageFirst":true}'\n`
    );
    console.log(`  # Close 100% of position`);
    console.log(`  curl -X POST http://localhost:${apiPort}/close-all \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"percent":100}'\n`);
    console.log(`  # Close 50% of position`);
    console.log(`  curl -X POST http://localhost:${apiPort}/close-all \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"percent":50}'\n`);
  });
}

async function launchAccount(accountConfig) {
  const { email, cookiesPath, profileDir, apiPort } = accountConfig;

  try {
    console.log(`\n[${email}] Launching browser instance...`);

    // Clean up old profile directories for this account slot if email changed
    // Look for old profile dirs with pattern /tmp/puppeteer-chrome-profile-{index}-*
    const accountIndex = cookiesPath.match(/account(\d+)/)?.[1];
    if (accountIndex) {
      const profilePattern = `/tmp/puppeteer-chrome-profile-${accountIndex}-`;
      try {
        const tmpFiles = fs.readdirSync("/tmp");
        tmpFiles.forEach((file) => {
          if (
            file.startsWith(`puppeteer-chrome-profile-${accountIndex}-`) &&
            `/tmp/${file}` !== profileDir
          ) {
            const oldProfilePath = path.join("/tmp", file);
            console.log(
              `[${email}] Cleaning up old profile directory: ${oldProfilePath}`
            );
            try {
              fs.rmSync(oldProfilePath, { recursive: true, force: true });
            } catch (e) {
              console.log(
                `[${email}] Could not delete old profile (may be in use): ${e.message}`
              );
            }
          }
        });
      } catch (e) {
        // Ignore errors reading /tmp
      }
    }

    const browser = await puppeteer.launch({
      headless: HEADLESS,
      // executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: profileDir,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--window-size=1920,1080",
      ],
      defaultViewport: HEADLESS ? { width: 1920, height: 1080 } : null,
    });

    const page = await browser.newPage();

    // Set default navigation timeout to 60 seconds (increased from default 30s)
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Try to load saved cookies - check if this is a new account
    const hasExistingCookies = await loadCookies(page, cookiesPath, email);
    const isNewAccount = !hasExistingCookies;

    if (isNewAccount) {
      console.log(`[${email}] New account detected - no existing cookies`);
    }

    console.log(`[${email}] Opening Paradex...`);

    // If new account, use referral URL; otherwise use regular trading URL
    const targetUrl = isNewAccount ? PARADEX_REFERRAL_URL : PARADEX_URL;

    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      if (isNewAccount) {
        console.log(
          `[${email}] Loaded with referral link: ${PARADEX_REFERRAL_URL}`
        );
      }
    } catch (error) {
      console.log(`[${email}] Page load timeout, attempting to continue...`);
    }

    // If cookies were loaded, reload the page to ensure cookies are applied
    if (hasExistingCookies) {
      console.log(
        `[${email}] Cookies loaded, reloading page to apply cookies...`
      );
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(5000); // Wait for page to fully load with cookies
      } catch (error) {
        console.log(`[${email}] Reload timeout, continuing...`);
      }
    } else {
      await delay(5000);
    }

    // Check if logged in - retry multiple times if cookies exist
    let loggedIn = false;
    const maxLoginChecks = hasExistingCookies ? 5 : 1; // More retries if cookies exist
    for (let i = 0; i < maxLoginChecks; i++) {
      loggedIn = await isLoggedIn(page);
      console.log(
        `[${email}] Logged in:`,
        loggedIn,
        hasExistingCookies ? `(check ${i + 1}/${maxLoginChecks})` : ""
      );
      if (loggedIn) {
        break; // Exit early if logged in
      }
      if (i < maxLoginChecks - 1) {
        await delay(2000); // Wait before retrying
      }
    }

    // Only attempt login if we're really not logged in after all checks
    if (!loggedIn) {
      console.log(
        `[${email}] Not logged in after ${maxLoginChecks} check(s), starting login process...`
      );
      await login(page, browser, email, cookiesPath, isNewAccount);
      await delay(3000);
      loggedIn = await isLoggedIn(page);
    } else {
      console.log(
        `[${email}] Already logged in with existing cookies, skipping login process`
      );
    }

    // If logged in and we were on referral page, navigate to trading page
    if (loggedIn && isNewAccount) {
      const currentUrl = page.url();
      if (!currentUrl.includes("app.paradex.trade/trade")) {
        console.log(`[${email}] Navigating to trading page after login...`);
        try {
          await page.goto(PARADEX_URL, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await delay(3000);
        } catch (error) {
          console.log(`[${email}] Navigation error, continuing...`);
        }
      }
    }

    if (loggedIn) {
      console.log(`\n[${email}] *** Successfully logged in! ***\n`);

      // Ensure we're on the trading page (not redirected to status page)
      const currentUrl = page.url();
      if (!currentUrl.includes("app.paradex.trade/trade")) {
        console.log(
          `[${email}] Redirected to ${currentUrl}, navigating back to trading page...`
        );
        try {
          await page.goto(PARADEX_URL, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await delay(3000);
        } catch (error) {
          console.log(`[${email}] Navigation error, continuing...`);
        }
      }

      // Setup TP/SL checkbox and stop loss on page load
      console.log(`\n[${email}] Setting up TP/SL on page load...`);
      try {
        await delay(2000); // Wait for page to fully load
        
        // Close any popups first (like leverage popup)
        await page.evaluate(() => {
          // Press Escape to close any modals
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          // Try to find and close modal/popup elements
          const modals = document.querySelectorAll('[role="dialog"], .modal, [class*="Modal"]');
          modals.forEach(modal => {
            const closeBtn = modal.querySelector('button, [aria-label*="close" i]');
            if (closeBtn) closeBtn.click();
          });
        });
        await delay(300);
        
        // Find and click TP/SL checkbox using mouse coordinates
        const tpslInfo = await page.evaluate(() => {
          // Find label with "TP/SL" text
          const labels = Array.from(document.querySelectorAll('label'));
          for (const label of labels) {
            const labelText = label.textContent?.trim() || '';
            if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
              // Find associated checkbox or button
              const checkbox = label.control || label.querySelector('input[type="checkbox"]');
              if (checkbox && checkbox.offsetParent !== null) {
                const rect = checkbox.getBoundingClientRect();
                return { 
                  found: true, 
                  alreadyChecked: checkbox.checked,
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2
                };
              }
              // Try label itself
              const rect = label.getBoundingClientRect();
              return { 
                found: true, 
                alreadyChecked: false,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
              };
            }
          }
          return { found: false };
        });
        
        let tpslFound = { found: false };
        if (tpslInfo.found) {
          if (tpslInfo.alreadyChecked) {
            console.log(`✓ TP/SL checkbox already checked`);
            tpslFound = { found: true, alreadyChecked: true };
          } else {
            // Click using mouse coordinates (more reliable)
            try {
              await page.mouse.move(tpslInfo.x, tpslInfo.y);
              await delay(100);
              await page.mouse.click(tpslInfo.x, tpslInfo.y, { delay: 50 });
              console.log(`✓ TP/SL checkbox clicked at coordinates (${tpslInfo.x}, ${tpslInfo.y})`);
              tpslFound = { found: true, alreadyChecked: false };
            } catch (e) {
              console.log(`⚠ Mouse click failed, trying JavaScript click: ${e.message}`);
              // Fallback to JavaScript click
              const jsClick = await page.evaluate(() => {
                const labels = Array.from(document.querySelectorAll('label'));
                for (const label of labels) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    const checkbox = label.control || label.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                      checkbox.click();
                      return true;
                    }
                    label.click();
                    return true;
                  }
                }
                return false;
              });
              if (jsClick) {
                console.log(`✓ TP/SL checkbox clicked via JavaScript`);
                tpslFound = { found: true, alreadyChecked: false };
              }
            }
          }
        }
        
        if (tpslFound.found) {
          console.log(`✓ TP/SL checkbox ${tpslFound.alreadyChecked ? 'already checked' : 'clicked'}`);
          await delay(1500); // Wait for inputs to appear
          
          // Set stop loss value if configured
          const stopLossValue = parseFloat(process.env.STOP_LOSS);
          if (stopLossValue && stopLossValue > 0) {
            console.log(`Setting stop loss to $${stopLossValue}...`);
            await delay(500); // Wait a bit more for inputs to fully render
            
            // Find and set stop loss input - be very specific to avoid Price input
            const stopLossInput = await page.evaluate((value) => {
              // Strategy 1: Find label with EXACT "Stop Loss" text (not "Price" or "Size")
              const labels = Array.from(document.querySelectorAll('label'));
              for (const label of labels) {
                const labelText = label.textContent?.trim() || '';
                // Must be exactly "Stop Loss" (case insensitive) and NOT contain "Price" or "Size"
                if ((labelText === 'Stop Loss' || labelText.toLowerCase() === 'stop loss') &&
                    !labelText.toLowerCase().includes('price') &&
                    !labelText.toLowerCase().includes('size') &&
                    !labelText.toLowerCase().includes('quantity')) {
                  
                  // Find associated input - try multiple ways
                  let input = label.control;
                  if (!input) {
                    const labelFor = label.getAttribute('for');
                    if (labelFor) input = document.getElementById(labelFor);
                  }
                  if (!input) {
                    input = label.querySelector('input[type="text"], input[type="number"], input:not([type])');
                  }
                  if (!input) {
                    // Check siblings - but make sure it's not Price or Size
                    let sibling = label.nextElementSibling;
                    let checkCount = 0;
                    while (sibling && checkCount < 5) {
                      if (sibling.tagName === 'INPUT') {
                        // Verify this input is not Price or Size
                        const siblingContext = sibling.parentElement?.textContent?.toLowerCase() || '';
                        if (!siblingContext.includes('price') && !siblingContext.includes('size') && !siblingContext.includes('quantity')) {
                          input = sibling;
                          break;
                        }
                      } else {
                        const candidate = sibling.querySelector('input[type="text"], input[type="number"], input:not([type])');
                        if (candidate) {
                          const candidateContext = candidate.parentElement?.textContent?.toLowerCase() || '';
                          if (!candidateContext.includes('price') && !candidateContext.includes('size') && !candidateContext.includes('quantity')) {
                            input = candidate;
                            break;
                          }
                        }
                      }
                      sibling = sibling.nextElementSibling;
                      checkCount++;
                    }
                  }
                  
                  // Verify the input is actually in a "Stop Loss" context
                  if (input && input.offsetParent !== null) {
                    let parent = input.parentElement;
                    let hasStopLossContext = false;
                    for (let i = 0; i < 5 && parent; i++) {
                      const parentText = parent.textContent?.toLowerCase() || '';
                      if (parentText.includes('stop loss') && !parentText.includes('price') && !parentText.includes('size')) {
                        hasStopLossContext = true;
                        break;
                      }
                      parent = parent.parentElement;
                    }
                    
                    if (hasStopLossContext) {
                      input.setAttribute('data-stop-loss-input', 'true');
                      return { found: true, selector: 'input[data-stop-loss-input="true"]' };
                    }
                  }
                }
              }
              
              // Strategy 2: Find input by position - must be below "Take Profit" and in TP/SL section
              const allInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'));
              let takeProfitInput = null;
              
              // First find Take Profit input
              for (const inp of allInputs) {
                if (inp.offsetParent === null) continue;
                let parent = inp.parentElement;
                for (let i = 0; i < 7 && parent; i++) {
                  const parentText = parent.textContent?.toLowerCase() || '';
                  if (parentText.includes('take profit') && !parentText.includes('price') && !parentText.includes('size')) {
                    takeProfitInput = inp;
                    break;
                  }
                  parent = parent.parentElement;
                }
                if (takeProfitInput) break;
              }
              
              // If we found Take Profit, find the input directly below it (should be Stop Loss)
              if (takeProfitInput) {
                const tpRect = takeProfitInput.getBoundingClientRect();
                for (const inp of allInputs) {
                  if (inp === takeProfitInput || inp.offsetParent === null) continue;
                  
                  // Check it's not Price or Size
                  let parent = inp.parentElement;
                  let isPriceOrSize = false;
                  for (let i = 0; i < 3 && parent; i++) {
                    const parentText = parent.textContent?.toLowerCase() || '';
                    if (parentText.includes('price') || parentText.includes('size') || parentText.includes('quantity')) {
                      isPriceOrSize = true;
                      break;
                    }
                    parent = parent.parentElement;
                  }
                  
                  if (isPriceOrSize) continue;
                  
                  const inpRect = inp.getBoundingClientRect();
                  // Check if this input is below Take Profit and in same column
                  if (inpRect.y > tpRect.y && Math.abs(inpRect.x - tpRect.x) < 50) {
                    // Verify it has "Stop Loss" context
                    parent = inp.parentElement;
                    for (let i = 0; i < 5 && parent; i++) {
                      const parentText = parent.textContent?.toLowerCase() || '';
                      if (parentText.includes('stop loss') && !parentText.includes('price') && !parentText.includes('size')) {
                        inp.setAttribute('data-stop-loss-input', 'true');
                        return { found: true, selector: 'input[data-stop-loss-input="true"]' };
                      }
                      parent = parent.parentElement;
                    }
                  }
                }
              }
              
              return { found: false };
            }, stopLossValue);
            
            if (stopLossInput.found) {
              // Always use keyboard typing (most reliable for making value visible)
              console.log(`Found stop loss input, typing value: ${stopLossValue}...`);
              const inputElement = await page.$(stopLossInput.selector);
              
              if (inputElement) {
                // Get coordinates for more reliable clicking
                const inputBox = await inputElement.boundingBox();
                if (inputBox) {
                  // Click at the center of the input field
                  await page.mouse.move(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
                  await delay(100);
                  await page.mouse.click(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
                } else {
                  // Fallback to element click
                  await inputElement.click({ clickCount: 1 });
                }
                
                await delay(300);
                
                // Select all existing text
                await page.keyboard.down('Control');
                await page.keyboard.press('a');
                await page.keyboard.up('Control');
                await delay(100);
                
                // Clear the field
                await page.keyboard.press('Backspace');
                await delay(100);
                
                // Type the value character by character (this makes it visible)
                const valueStr = String(stopLossValue);
                console.log(`Typing: "${valueStr}" character by character...`);
                for (let i = 0; i < valueStr.length; i++) {
                  await page.keyboard.type(valueStr[i], { delay: 80 });
                }
                
                await delay(400);
                
                // Press Tab or click outside to trigger change event
                await page.keyboard.press('Tab');
                await delay(200);
                
                // Verify the value is visible
                const actualValue = await page.evaluate((selector) => {
                  const input = document.querySelector(selector);
                  if (!input) return '';
                  
                  // Check both value and textContent (for React components)
                  const value = input.value || '';
                  const textContent = input.textContent || '';
                  const displayValue = value || textContent;
                  
                  // Also check if the input's parent shows the value
                  let parentValue = '';
                  let parent = input.parentElement;
                  for (let i = 0; i < 3 && parent; i++) {
                    if (parent.textContent && parent.textContent.trim()) {
                      parentValue = parent.textContent.trim();
                      break;
                    }
                    parent = parent.parentElement;
                  }
                  
                  return displayValue || parentValue;
                }, stopLossInput.selector);
                
                if (actualValue && (actualValue.includes(String(stopLossValue)) || Math.abs(parseFloat(actualValue) - stopLossValue) < 0.01)) {
                  console.log(`✓ Stop loss value visible in input: "${actualValue}"`);
                } else {
                  // Try React onValueChange as additional trigger
                  console.log(`Value not visible, trying React onValueChange...`);
                  await page.evaluate((selector, value) => {
                    const input = document.querySelector(selector);
                    if (!input) return false;
                    
                    const reactKey = Object.keys(input).find(key => 
                      key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')
                    );
                    
                    if (reactKey) {
                      let fiber = input[reactKey];
                      let depth = 0;
                      while (fiber && depth < 15) {
                        if (fiber.memoizedProps && fiber.memoizedProps.onValueChange) {
                          try {
                            fiber.memoizedProps.onValueChange(
                              { value: String(value), formattedValue: String(value), floatValue: value },
                              { source: 'api' }
                            );
                            return true;
                          } catch (e) {
                            // Continue
                          }
                        }
                        fiber = fiber.return || fiber._owner;
                        depth++;
                      }
                    }
                    return false;
                  }, stopLossInput.selector, stopLossValue);
                  
                  await delay(300);
                  
                  // Check again
                  const finalValue = await page.evaluate((selector) => {
                    const input = document.querySelector(selector);
                    return input ? (input.value || input.textContent || '') : '';
                  }, stopLossInput.selector);
                  
                  if (finalValue) {
                    console.log(`✓ Stop loss set to: "${finalValue}"`);
                  } else {
                    console.log(`⚠ Stop loss value typed but not visible. Value may be set internally.`);
                  }
                }
              } else {
                console.log(`⚠ Could not locate stop loss input element`);
              }
            } else {
              console.log(`⚠ Stop loss input not found`);
            }
          }
        } else {
          console.log(`⚠ TP/SL checkbox not found`);
        }
      } catch (error) {
        console.log(`[${email}] Error setting up TP/SL: ${error.message} (continuing anyway)`);
      }

      // Start the API server for this account
      startApiServer(page, apiPort, email);

      return { browser, page, email, success: true };
    } else {
      console.log(`[${email}] Failed to login.`);
      await browser.close();
      return { email, success: false };
    }
  } catch (error) {
    console.error(`\n✗ [${email}] Error during account launch:`, error.message);
    return { email, success: false, error: error.message };
  }
}

// Trading configuration from environment variables
const TRADE_CONFIG = {
  buyQty: parseFloat(process.env.BUY_QTY) || 0.0005, // BTC quantity for BUY
  sellQty: parseFloat(process.env.SELL_QTY) || 0.0005, // BTC quantity for SELL
  waitTime: parseInt(process.env.TRADE_TIME) || 60000, // Time to wait before closing (milliseconds)
  leverage: parseInt(process.env.LEVERAGE) || 20, // Leverage multiplier
  stopLoss: parseFloat(process.env.STOP_LOSS) || null, // Maximum loss in USD (null = disabled)
};

let isShuttingDown = false;

async function automatedTradingLoop(account1Result, account2Result) {
  const { page: page1, email: email1 } = account1Result;
  const { page: page2, email: email2 } = account2Result;

  let cycleCount = 0;

  console.log(`\n========================================`);
  console.log(`Starting Automated Trading Loop`);
  console.log(`Account 1 (${email1}): BUY ${TRADE_CONFIG.buyQty} BTC`);
  console.log(`Account 2 (${email2}): SELL ${TRADE_CONFIG.sellQty} BTC`);
  console.log(`Leverage: ${TRADE_CONFIG.leverage}x`);
  console.log(`Close after: Random time between 10s and 3min`);
  console.log(`========================================\n`);

  // Set leverage ONCE at the beginning for both accounts
  console.log(`\n🔧 Setting leverage for both accounts...`);
  const leveragePromises = [
    setLeverage(page1, TRADE_CONFIG.leverage),
    setLeverage(page2, TRADE_CONFIG.leverage),
  ];

  const leverageResults = await Promise.all(leveragePromises);

  if (leverageResults[0].success) {
    console.log(`✓ [${email1}] Leverage set to ${TRADE_CONFIG.leverage}x`);
  } else {
    console.log(
      `⚠ [${email1}] Failed to set leverage: ${leverageResults[0].error}`
    );
  }

  if (leverageResults[1].success) {
    console.log(`✓ [${email2}] Leverage set to ${TRADE_CONFIG.leverage}x`);
  } else {
    console.log(
      `⚠ [${email2}] Failed to set leverage: ${leverageResults[1].error}`
    );
  }

  console.log(`\n✓ Leverage configured. Starting trading cycles...\n`);
  await delay(2000);

  while (!isShuttingDown) {
    cycleCount++;
    console.log(
      `\n>>> CYCLE ${cycleCount} - ${new Date().toLocaleTimeString()}`
    );

    try {
      // Step 0: Close any existing positions FIRST
      console.log(`\n[CYCLE ${cycleCount}] Checking for existing positions...`);
      const initialClosePromises = [
        closeAllPositions(page1, 100),
        closeAllPositions(page2, 100),
      ];

      const initialCloseResults = await Promise.all(initialClosePromises);

      if (initialCloseResults[0].success) {
        console.log(`✓ [${email1}] Existing positions checked/closed`);
      }
      if (initialCloseResults[1].success) {
        console.log(`✓ [${email2}] Existing positions checked/closed`);
      }

      // Small delay to ensure positions are fully closed
      await delay(2000);

      // Step 1: Execute trades in parallel with limit orders at market price
      console.log(`\n[CYCLE ${cycleCount}] Opening new positions...`);
      const tradePromises = [
        executeTrade(page1, {
          side: "buy",
          orderType: "limit",
          qty: TRADE_CONFIG.buyQty,
          // Leverage already set at the beginning, price will be fetched automatically
        }),
        executeTrade(page2, {
          side: "sell",
          orderType: "limit",
          qty: TRADE_CONFIG.sellQty,
          // Leverage already set at the beginning, price will be fetched automatically
        }),
      ];

      const tradeResults = await Promise.all(tradePromises);

      // Check if both trades succeeded
      const trade1Success = tradeResults[0].success;
      const trade2Success = tradeResults[1].success;

      if (trade1Success) {
        console.log(`✓ [${email1}] BUY executed successfully`);
      } else {
        console.log(`✗ [${email1}] BUY failed: ${tradeResults[0].error}`);
      }

      if (trade2Success) {
        console.log(`✓ [${email2}] SELL executed successfully`);
      } else {
        console.log(`✗ [${email2}] SELL failed: ${tradeResults[1].error}`);
      }

      // Only proceed to wait and close if BOTH trades succeeded
      if (!trade1Success || !trade2Success) {
        console.log(
          `\n✗ [CYCLE ${cycleCount}] One or both trades failed. Skipping wait and retrying in 5 seconds...`
        );
        await delay(5000);
        continue; // Skip to next cycle
      }

      console.log(
        `\n✓ [CYCLE ${cycleCount}] Both trades executed successfully!`
      );

      // Step 2: Wait for random time between 10 seconds and 3 minutes (only after both trades succeed)
      const minWaitTime = 10000; // 10 seconds
      const maxWaitTime = 180000; // 3 minutes
      const randomWaitTime =
        Math.floor(Math.random() * (maxWaitTime - minWaitTime + 1)) +
        minWaitTime;

      console.log(
        `\n[CYCLE ${cycleCount}] Waiting ${
          randomWaitTime / 1000
        } seconds before closing...`
      );
      if (TRADE_CONFIG.stopLoss) {
        console.log(
          `[CYCLE ${cycleCount}] Stop loss enabled: $${TRADE_CONFIG.stopLoss} (will monitor P&L)`
        );
      }

      // Break wait into smaller chunks to allow faster shutdown and stop-loss checking
      const checkInterval = 2000; // Check every 2 seconds (changed from 1000 to allow P&L checks)
      const totalChecks = Math.ceil(randomWaitTime / checkInterval);

      for (let i = 0; i < totalChecks; i++) {
        if (isShuttingDown) {
          console.log(
            `\n[CYCLE ${cycleCount}] Shutdown detected during wait period`
          );
          break;
        }

        // Check stop loss if enabled
        if (TRADE_CONFIG.stopLoss) {
          try {
            // Get current P&L for both accounts
            const pnl1 = await getCurrentUnrealizedPnL(page1);
            const pnl2 = await getCurrentUnrealizedPnL(page2);

            const stopLossThreshold = -Math.abs(TRADE_CONFIG.stopLoss);

            // Debug logging every 5 checks (every 10 seconds) to see what's being compared
            if (i > 0 && i % 5 === 0) {
              console.log(
                `[CYCLE ${cycleCount}] Stop Loss Check - ${email1}: $${
                  pnl1 !== null ? pnl1.toLocaleString() : "N/A"
                }, ${email2}: $${
                  pnl2 !== null ? pnl2.toLocaleString() : "N/A"
                }, Threshold: $${stopLossThreshold.toLocaleString()}`
              );
            }

            // Check if Account 1 has exceeded stop loss
            // Changed from < to <= so it triggers at exactly the stop loss amount
            // Example: if stopLoss=1.5, we check if pnl1 <= -1.5
            if (pnl1 !== null && pnl1 <= stopLossThreshold) {
              console.log(
                `\n🚨 [CYCLE ${cycleCount}] STOP LOSS TRIGGERED for ${email1}!`
              );
              console.log(
                `   Current P&L: $${pnl1.toLocaleString()}, Stop Loss: -$${
                  TRADE_CONFIG.stopLoss
                }`
              );
              console.log(
                `   Condition: ${pnl1} <= ${stopLossThreshold} = ${
                  pnl1 <= stopLossThreshold
                }`
              );
              console.log(`   Closing positions immediately...`);

              // Close both accounts' positions to maintain balance
              await closeAllPositions(page1, 100);
              await closeAllPositions(page2, 100);

              console.log(
                `✓ [CYCLE ${cycleCount}] Positions closed due to stop loss`
              );
              break; // Exit the wait loop immediately
            }

            // Check if Account 2 has exceeded stop loss
            // Changed from < to <= so it triggers at exactly the stop loss amount
            if (pnl2 !== null && pnl2 <= stopLossThreshold) {
              console.log(
                `\n🚨 [CYCLE ${cycleCount}] STOP LOSS TRIGGERED for ${email2}!`
              );
              console.log(
                `   Current P&L: $${pnl2.toLocaleString()}, Stop Loss: -$${
                  TRADE_CONFIG.stopLoss
                }`
              );
              console.log(
                `   Condition: ${pnl2} <= ${stopLossThreshold} = ${
                  pnl2 <= stopLossThreshold
                }`
              );
              console.log(`   Closing positions immediately...`);

              // Close both accounts' positions to maintain balance
              await closeAllPositions(page1, 100);
              await closeAllPositions(page2, 100);

              console.log(
                `✓ [CYCLE ${cycleCount}] Positions closed due to stop loss`
              );
              break; // Exit the wait loop immediately
            }

            // Log P&L status every 10 checks (every 20 seconds) so you can see what's happening
            if (i > 0 && i % 10 === 0) {
              console.log(
                `[CYCLE ${cycleCount}] P&L Check - ${email1}: $${
                  pnl1 !== null ? pnl1.toLocaleString() : "N/A"
                }, ${email2}: $${pnl2 !== null ? pnl2.toLocaleString() : "N/A"}`
              );
            }
          } catch (error) {
            // If P&L check fails, don't break the loop - just log and continue
            console.log(
              `[CYCLE ${cycleCount}] Error checking P&L: ${error.message}`
            );
          }
        }

        await delay(checkInterval);

        // Show countdown every 10 seconds
        const remaining = randomWaitTime - (i + 1) * checkInterval;
        if (remaining > 0 && remaining % 10000 === 0) {
          console.log(
            `[CYCLE ${cycleCount}] ${remaining / 1000}s remaining...`
          );
        }
      }

      if (isShuttingDown) {
        console.log(`[CYCLE ${cycleCount}] Breaking loop due to shutdown`);
        break;
      }

      // Step 3: Close positions in parallel
      console.log(`\n[CYCLE ${cycleCount}] Closing positions...`);
      const closePromises = [
        closeAllPositions(page1, 100),
        closeAllPositions(page2, 100),
      ];

      const closeResults = await Promise.all(closePromises);

      const close1Success = closeResults[0].success;
      const close2Success = closeResults[1].success;

      if (close1Success) {
        console.log(`✓ [${email1}] Position closed successfully`);
      } else {
        console.log(
          `✗ [${email1}] Close failed: ${
            closeResults[0].error || closeResults[0].message
          }`
        );
      }

      if (close2Success) {
        console.log(`✓ [${email2}] Position closed successfully`);
      } else {
        console.log(
          `✗ [${email2}] Close failed: ${
            closeResults[1].error || closeResults[1].message
          }`
        );
      }

      // Check if both positions closed successfully
      if (close1Success && close2Success) {
        console.log(
          `\n✓ [CYCLE ${cycleCount}] Completed successfully at ${new Date().toLocaleTimeString()}`
        );
      } else {
        console.log(
          `\n⚠ [CYCLE ${cycleCount}] Completed with some errors at ${new Date().toLocaleTimeString()}`
        );
      }

      // Small delay before next cycle
      if (!isShuttingDown) {
        console.log(`\nStarting next cycle in 3 seconds...`);
        await delay(3000);
      }
    } catch (error) {
      console.error(`\n✗ [CYCLE ${cycleCount}] Error:`, error.message);
      console.log(`Waiting 5 seconds before retry...`);
      await delay(5000);
    }
  }

  console.log(`\n[Trading Loop] Exited after ${cycleCount} cycles`);
}

async function closeAllPositionsOnShutdown(results) {
  console.log(`\n========================================`);
  console.log(`Closing all positions before shutdown...`);
  console.log(`========================================\n`);

  const closePromises = results.map(async (result) => {
    if (result.success && result.page) {
      try {
        console.log(`[${result.email}] Closing positions...`);
        const closeResult = await closeAllPositions(result.page, 100);
        if (closeResult.success) {
          console.log(`✓ [${result.email}] Positions closed`);
        } else {
          console.log(
            `✗ [${result.email}] ${closeResult.error || closeResult.message}`
          );
        }
      } catch (error) {
        console.error(`✗ [${result.email}] Error closing:`, error.message);
      }
    }
  });

  await Promise.all(closePromises);
  console.log(`\n[Shutdown] All positions closed. Exiting...\n`);
}

async function main() {
  console.log(`\n========================================`);
  console.log(`Starting Paradex Multi-Account Bot`);
  console.log(`Headless mode: ${HEADLESS}`);
  console.log(`Number of accounts: ${ACCOUNTS.length}`);
  console.log(`Referral code: instantcrypto (auto-applied for new accounts)`);
  console.log(`========================================\n`);
  console.log(
    `💡 Tip: If you changed account emails, old cookies will be auto-deleted.`
  );
  console.log(
    `    You can also manually delete paradex-cookies-*.json files to reset.\n`
  );

  // Launch all accounts in parallel
  const accountPromises = ACCOUNTS.map((account) => launchAccount(account));
  const results = await Promise.all(accountPromises);

  // Summary
  console.log(`\n========================================`);
  console.log(`Launch Summary:`);
  console.log(`========================================`);

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  successful.forEach((r) => {
    const account = ACCOUNTS.find((a) => a.email === r.email);
    console.log(`✓ ${r.email} - API on port ${account.apiPort}`);
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

  // Start automated trading loop
  console.log(`\n🤖 Starting automated trading in 5 seconds...`);
  await delay(5000);

  // Start the trading loop with both accounts
  automatedTradingLoop(successful[0], successful[1]).catch((error) => {
    console.error(`Trading loop error:`, error);
  });
}

main().catch(console.error);

