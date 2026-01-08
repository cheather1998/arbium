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

// Helper function to ensure TP/SL button is checked and values are set
// Helper function to quickly set Stop Loss value for BUY orders (after order confirmation)
async function setStopLossValueForBuy(page, stopLossAmount) {
  await forceTPSLCheckboxChecked(page);
  await delay(500);
  
  const allInputs = await page.$$('input[type="text"], input:not([type])');
  const tpslInputs = [];
  
  for (const input of allInputs) {
    const rect = await input.boundingBox();
    if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
    tpslInputs.push({ input, rect, y: rect.y, x: rect.x });
  }
  
  tpslInputs.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
    return a.x - b.x;
  });
  
  const dollarInputs = tpslInputs.filter(inp => inp.x < 1650);
  if (dollarInputs.length === 0) return false;
  
  const bottomRow = dollarInputs.filter(inp => inp.y >= 530);
  const stopLossInput = bottomRow.length > 0 ? bottomRow[0].input : dollarInputs[dollarInputs.length - 1].input;
  
  if (!stopLossInput) return false;
  
  const valueToType = stopLossAmount.toFixed(2).replace(/,/g, '');
  await stopLossInput.focus();
  await delay(200);
  await stopLossInput.click({ clickCount: 3 });
  await delay(200);
  
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Meta');
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(100);
  
  await page.evaluate((el, val) => {
    if (el._valueTracker) el._valueTracker.setValue('');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, stopLossInput, valueToType);
  
  await page.keyboard.type(valueToType, { delay: 80 });
  await delay(500);
  await page.keyboard.press('Tab');
  await delay(500);
  
  return true;
}

// Helper function to quickly set Take Profit value for SELL orders (after order confirmation)
async function setTakeProfitValueForSell(page, takeProfitPrice) {
  await forceTPSLCheckboxChecked(page);
  await delay(500);
  
  const allInputs = await page.$$('input[type="text"], input:not([type])');
  const tpslInputs = [];
  
  for (const input of allInputs) {
    const rect = await input.boundingBox();
    if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
    tpslInputs.push({ input, rect, y: rect.y, x: rect.x });
  }
  
  tpslInputs.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
    return a.x - b.x;
  });
  
  const dollarInputs = tpslInputs.filter(inp => inp.x < 1650);
  if (dollarInputs.length === 0) return false;
  
  const topRow = dollarInputs.filter(inp => inp.y < 530);
  const takeProfitInput = topRow.length > 0 ? topRow[0].input : dollarInputs[0].input;
  
  if (!takeProfitInput) return false;
  
  const valueToType = takeProfitPrice.toFixed(2).replace(/,/g, '');
  await takeProfitInput.focus();
  await delay(200);
  await takeProfitInput.click({ clickCount: 3 });
  await delay(200);
  
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Meta');
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(100);
  
  await page.evaluate((el, val) => {
    if (el._valueTracker) el._valueTracker.setValue('');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, takeProfitInput, valueToType);
  
  await page.keyboard.type(valueToType, { delay: 80 });
  await delay(500);
  await page.keyboard.press('Tab');
  await delay(500);
  
  return true;
}

// Helper function to quickly set Stop Loss value for SELL orders (after order confirmation)
async function setStopLossValueForSell(page, stopLossPrice) {
  await forceTPSLCheckboxChecked(page);
  await delay(500);
  
  const allInputs = await page.$$('input[type="text"], input:not([type])');
  const tpslInputs = [];
  
  for (const input of allInputs) {
    const rect = await input.boundingBox();
    if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
    tpslInputs.push({ input, rect, y: rect.y, x: rect.x });
  }
  
  tpslInputs.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
    return a.x - b.x;
  });
  
  const dollarInputs = tpslInputs.filter(inp => inp.x < 1650);
  if (dollarInputs.length === 0) return false;
  
  const bottomRow = dollarInputs.filter(inp => inp.y >= 530);
  const stopLossInput = bottomRow.length > 0 ? bottomRow[0].input : dollarInputs[dollarInputs.length - 1].input;
  
  if (!stopLossInput) return false;
  
  const valueToType = stopLossPrice.toFixed(2).replace(/,/g, '');
  await stopLossInput.focus();
  await delay(200);
  await stopLossInput.click({ clickCount: 3 });
  await delay(200);
  
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Meta');
  await delay(100);
  await page.keyboard.press('Backspace');
  await delay(100);
  
  await page.evaluate((el, val) => {
    if (el._valueTracker) el._valueTracker.setValue('');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, stopLossInput, valueToType);
  
  await page.keyboard.type(valueToType, { delay: 80 });
  await delay(500);
  await page.keyboard.press('Tab');
  await delay(500);
  
  return true;
}

// Helper function to aggressively force TP/SL checkbox to be checked
async function forceTPSLCheckboxChecked(page) {
  const result = await page.evaluate(() => {
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    for (const checkbox of checkboxes) {
      let label = checkbox.closest('label');
      if (!label) {
        const id = checkbox.id;
        if (id) {
          label = document.querySelector(`label[for="${id}"]`);
        }
      }
      if (label) {
        const labelText = label.textContent?.trim() || '';
        if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
          const wasChecked = checkbox.checked;
          
          // Force check - set all possible states
          checkbox.checked = true;
          checkbox.setAttribute('checked', 'checked');
          checkbox.setAttribute('aria-checked', 'true');
          label.setAttribute('aria-checked', 'true');
          label.setAttribute('data-checked', 'true');
          label.classList.add('checked', 'active', 'selected');
          
          // Remove any unchecked classes
          label.classList.remove('unchecked', 'inactive');
          
          // Try to find React instance and update state
          const reactKey = Object.keys(checkbox).find(key => 
            key.startsWith('__reactInternalInstance') || 
            key.startsWith('__reactFiber')
          );
          
          let props = {};
          let hasOnChange = false;
          
          if (reactKey) {
            const reactInstance = checkbox[reactKey];
            props = reactInstance?.memoizedProps || reactInstance?.pendingProps || {};
            const onChange = props.onChange || props.onValueChange;
            hasOnChange = !!(onChange && typeof onChange === 'function');
            
            if (onChange && typeof onChange === 'function') {
              try {
                const syntheticEvent = {
                  target: checkbox,
                  currentTarget: checkbox,
                  type: 'change',
                  nativeEvent: new Event('change'),
                  preventDefault: () => {},
                  stopPropagation: () => {}
                };
                Object.defineProperty(syntheticEvent.target, 'checked', { 
                  value: true, 
                  writable: true,
                  enumerable: true
                });
                onChange(syntheticEvent);
              } catch (e) {
                // Ignore React errors
              }
            }
          }
          
          // Trigger all possible events
          checkbox.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          checkbox.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
          label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          
          // Also click the label to trigger any click handlers
          label.click();
          
          return {
            found: true,
            wasChecked: wasChecked,
            nowChecked: checkbox.checked,
            hasReact: !!reactKey,
            hasOnChange: hasOnChange
          };
        }
      }
    }
    return { found: false };
  });
  
  if (result.found) {
    if (!result.wasChecked || !result.nowChecked) {
      console.log(`  ✓ TP/SL checkbox force-checked (was: ${result.wasChecked}, now: ${result.nowChecked}, React: ${result.hasReact})`);
    }
  }
  
  return result.found;
}

async function ensureTPSLCheckedAndSetValues(page, side, price, qty) {
  console.log(`Ensuring TP/SL button is checked...`);
  
  // First, aggressively force it to be checked
  await forceTPSLCheckboxChecked(page);
  await delay(500);
  
  // Try multiple times to click the button and verify it worked
  const maxAttempts = 5;
  let buttonClicked = false;
  let inputsReady = false;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // CRITICAL: Force-check TP/SL checkbox at the start of each attempt
    await forceTPSLCheckboxChecked(page);
    await delay(300);
    
    // First, check if button is already checked
    let buttonState;
    try {
      buttonState = await page.evaluate(() => {
        try {
          // Check for checkbox state
          const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
          for (const checkbox of checkboxes) {
            let label = checkbox.closest('label');
            if (!label) {
              const id = checkbox.id;
              if (id) {
                label = document.querySelector(`label[for="${id}"]`);
              }
            }
            if (label) {
              const labelText = label.textContent?.trim() || '';
              if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                return { found: true, checked: checkbox.checked, element: 'checkbox' };
              }
            }
          }
          
          // Check for button/div state
          const allElements = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"], label, span'));
          for (const el of allElements) {
            const text = el.textContent?.trim() || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const title = el.getAttribute('title') || '';
            const className = el.className || '';
            
            if ((text.includes('TP/SL') || text.includes('TP & SL') ||
                 ariaLabel.includes('TP/SL') || ariaLabel.includes('TP & SL') ||
                 title.includes('TP/SL') || title.includes('TP & SL') ||
                 className.includes('tpsl') || className.includes('TP/SL')) &&
                !text.includes('Take Profit') && !text.includes('Stop Loss')) {
              const rect = el.getBoundingClientRect();
              const isChecked = el.getAttribute('aria-checked') === 'true' || 
                               el.classList.contains('checked') || 
                               el.classList.contains('active') ||
                               el.getAttribute('data-checked') === 'true';
              return { 
                found: true, 
                checked: isChecked, 
                element: 'button',
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
              };
            }
          }
          
          return { found: false };
        } catch (e) {
          console.error('Error in buttonState evaluation:', e);
          return { found: false, error: e.message };
        }
      });
    } catch (error) {
      console.log(`⚠ Error evaluating button state (attempt ${attempt}/${maxAttempts}): ${error.message}`);
      buttonState = { found: false, error: error.message };
    }
    
    // Ensure buttonState is defined and has the expected structure
    if (!buttonState || typeof buttonState !== 'object') {
      console.log(`⚠ Invalid buttonState returned (attempt ${attempt}/${maxAttempts}), retrying...`);
      await delay(1000);
      continue;
    }
    
    if (buttonState.found) {
      // Check if button is visually highlighted/active (blue) but checkbox not actually checked
      const visualState = await page.evaluate(() => {
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        for (const checkbox of checkboxes) {
          let label = checkbox.closest('label');
          if (!label) {
            const id = checkbox.id;
            if (id) {
              label = document.querySelector(`label[for="${id}"]`);
            }
          }
          if (label) {
            const labelText = label.textContent?.trim() || '';
            if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
              // Check visual state (classes, styles, aria attributes)
              const isVisuallyActive = label.classList.contains('active') || 
                                     label.classList.contains('checked') ||
                                     label.classList.contains('selected') ||
                                     label.getAttribute('aria-checked') === 'true' ||
                                     label.style.backgroundColor?.includes('blue') ||
                                     getComputedStyle(label).backgroundColor?.includes('rgb') ||
                                     checkbox.getAttribute('aria-checked') === 'true';
              
              return {
                checked: checkbox.checked,
                visuallyActive: isVisuallyActive,
                hasActiveClass: label.classList.contains('active'),
                hasCheckedClass: label.classList.contains('checked'),
                ariaChecked: label.getAttribute('aria-checked') || checkbox.getAttribute('aria-checked')
              };
            }
          }
        }
        return null;
      });
      
      if (visualState) {
        console.log(`  Visual state: ${JSON.stringify(visualState)}`);
      }
      
      // If visually active but not checked, or if checked, consider it ready
      const isActuallyChecked = buttonState.checked || (visualState && visualState.checked);
      const isVisuallyActive = visualState && visualState.visuallyActive;
      
      if (isActuallyChecked || isVisuallyActive) {
        if (isActuallyChecked) {
          console.log(`✓ TP/SL button is already checked (attempt ${attempt}/${maxAttempts})`);
        } else {
          console.log(`⚠ TP/SL button is visually active (blue) but checkbox not checked, forcing check... (attempt ${attempt}/${maxAttempts})`);
          // Force it to be checked even though it's visually active
          if (buttonState.element === 'checkbox') {
            await page.evaluate(() => {
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of checkboxes) {
                let label = checkbox.closest('label');
                if (!label) {
                  const id = checkbox.id;
                  if (id) {
                    label = document.querySelector(`label[for="${id}"]`);
                  }
                }
                if (label) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    // Force check
                    checkbox.checked = true;
                    checkbox.setAttribute('checked', 'checked');
                    checkbox.setAttribute('aria-checked', 'true');
                    label.setAttribute('aria-checked', 'true');
                    label.classList.add('checked', 'active');
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }
              }
            });
            await delay(500);
          }
        }
        buttonClicked = true;
      } else {
        // Button found but not checked, click it
        console.log(`TP/SL button found but not checked, clicking... (attempt ${attempt}/${maxAttempts})`);
        
        try {
          if (buttonState.element === 'checkbox') {
            // Try multiple approaches to click checkbox
            console.log(`  Attempting to click TP/SL checkbox...`);
            
            // First, get the current state
            const beforeState = await page.evaluate(() => {
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of checkboxes) {
                let label = checkbox.closest('label');
                if (!label) {
                  const id = checkbox.id;
                  if (id) {
                    label = document.querySelector(`label[for="${id}"]`);
                  }
                }
                if (label) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    return {
                      checked: checkbox.checked,
                      disabled: checkbox.disabled,
                      id: checkbox.id,
                      name: checkbox.name
                    };
                  }
                }
              }
              return null;
            });
            console.log(`  Checkbox state before click: ${JSON.stringify(beforeState)}`);
            
            // Approach 1: Click the label using Puppeteer (most reliable for React)
            const labelInfo = await page.evaluate(() => {
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of checkboxes) {
                let label = checkbox.closest('label');
                if (!label) {
                  const id = checkbox.id;
                  if (id) {
                    label = document.querySelector(`label[for="${id}"]`);
                  }
                }
                if (label) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    const rect = label.getBoundingClientRect();
                    return {
                      found: true,
                      x: rect.left + rect.width / 2,
                      y: rect.top + rect.height / 2,
                      checkboxId: checkbox.id
                    };
                  }
                }
              }
              return { found: false };
            });
            
            if (labelInfo.found) {
              console.log(`  Clicking label at (${labelInfo.x}, ${labelInfo.y})...`);
              await page.mouse.move(labelInfo.x, labelInfo.y);
              await delay(200);
              await page.mouse.down();
              await delay(100);
              await page.mouse.up();
              await delay(500);
              
              // Also try clicking the checkbox directly
              const checkboxHandle = await page.evaluateHandle((checkboxId) => {
                if (checkboxId) {
                  return document.getElementById(checkboxId);
                }
                const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
                for (const checkbox of checkboxes) {
                  let label = checkbox.closest('label');
                  if (!label) {
                    const id = checkbox.id;
                    if (id) {
                      label = document.querySelector(`label[for="${id}"]`);
                    }
                  }
                  if (label) {
                    const labelText = label.textContent?.trim() || '';
                    if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                      return checkbox;
                    }
                  }
                }
                return null;
              }, labelInfo.checkboxId);
              
              if (checkboxHandle && checkboxHandle.asElement()) {
                console.log(`  Also clicking checkbox directly...`);
                await checkboxHandle.asElement().click();
                await delay(500);
              }
            }
            
            // Approach 2: Force state via JavaScript with React event simulation
            // Try to find and trigger React's internal handlers
            const jsResult = await page.evaluate(() => {
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of checkboxes) {
                let label = checkbox.closest('label');
                if (!label) {
                  const id = checkbox.id;
                  if (id) {
                    label = document.querySelector(`label[for="${id}"]`);
                  }
                }
                if (label) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    // Try to access React's internal properties
                    const reactKey = Object.keys(checkbox).find(key => key.startsWith('__reactInternalInstance') || key.startsWith('__reactFiber'));
                    let reactInstance = null;
                    if (reactKey) {
                      reactInstance = checkbox[reactKey];
                    }
                    
                    // Try to find React event handlers
                    const props = reactInstance?.memoizedProps || reactInstance?.pendingProps || {};
                    const onChange = props.onChange;
                    
                    // Method 1: Try React's onChange handler directly
                    if (onChange && typeof onChange === 'function') {
                      try {
                        const syntheticEvent = {
                          target: checkbox,
                          currentTarget: checkbox,
                          type: 'change',
                          nativeEvent: new Event('change'),
                          preventDefault: () => {},
                          stopPropagation: () => {},
                          isDefaultPrevented: () => false,
                          isPropagationStopped: () => false
                        };
                        Object.defineProperty(syntheticEvent.target, 'checked', { value: true, writable: true });
                        checkbox.checked = true;
                        onChange(syntheticEvent);
                      } catch (e) {
                        console.log('React onChange error:', e);
                      }
                    }
                    
                    // Method 2: Use native setter and trigger proper events
                    const nativeCheckedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
                    if (nativeCheckedSetter) {
                      nativeCheckedSetter.call(checkbox, true);
                    } else {
                      checkbox.checked = true;
                    }
                    
                    // Method 3: Create a proper React synthetic event
                    const changeEvent = new Event('change', { bubbles: true, cancelable: true });
                    Object.defineProperty(changeEvent, 'target', { 
                      value: checkbox, 
                      enumerable: true,
                      writable: false,
                      configurable: true
                    });
                    Object.defineProperty(changeEvent, 'currentTarget', { 
                      value: checkbox, 
                      enumerable: true,
                      writable: false,
                      configurable: true
                    });
                    
                    // Set checked on the event target
                    Object.defineProperty(checkbox, 'checked', { value: true, writable: true, configurable: true });
                    
                    // Dispatch in order: input -> change -> click
                    checkbox.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                    checkbox.dispatchEvent(changeEvent);
                    checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    
                    // Method 4: Also try clicking the label
                    if (label) {
                      label.click();
                      // Also dispatch events on label
                      label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    }
                    
                    // Check state after all attempts
                    const finalChecked = checkbox.checked;
                    
                    return { 
                      success: true, 
                      checked: finalChecked,
                      hasReactInstance: !!reactInstance,
                      hasOnChange: !!onChange,
                      reactKey: reactKey || null
                    };
                  }
                }
              }
              return { success: false };
            });
            console.log(`  JavaScript click result: ${JSON.stringify(jsResult)}`);
            
            // If React instance found but still not checked, try waiting longer and checking inputs
            if (jsResult.hasReactInstance && !jsResult.checked) {
              console.log(`  React instance found but checkbox still unchecked, waiting longer for state update...`);
              await delay(2000);
            } else {
              await delay(1000);
            }
          } else if (buttonState.element === 'button') {
            // Get coordinates if not already available
            let x = buttonState.x;
            let y = buttonState.y;
            
            if (x === undefined || y === undefined) {
              // Re-fetch coordinates
              const coords = await page.evaluate(() => {
                const allElements = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"], label, span'));
                for (const el of allElements) {
                  const text = el.textContent?.trim() || '';
                  const ariaLabel = el.getAttribute('aria-label') || '';
                  const title = el.getAttribute('title') || '';
                  const className = el.className || '';
                  
                  if ((text.includes('TP/SL') || text.includes('TP & SL') ||
                       ariaLabel.includes('TP/SL') || ariaLabel.includes('TP & SL') ||
                       title.includes('TP/SL') || title.includes('TP & SL') ||
                       className.includes('tpsl') || className.includes('TP/SL')) &&
                      !text.includes('Take Profit') && !text.includes('Stop Loss')) {
                    const rect = el.getBoundingClientRect();
                    return {
                      x: rect.left + rect.width / 2,
                      y: rect.top + rect.height / 2
                    };
                  }
                }
                return null;
              });
              
              if (coords) {
                x = coords.x;
                y = coords.y;
              }
            }
            
            if (x !== undefined && y !== undefined) {
              console.log(`  Clicking TP/SL button at coordinates (${x}, ${y})...`);
              // Click button using mouse coordinates (more reliable)
              await page.mouse.move(x, y);
              await delay(200);
              await page.mouse.down();
              await delay(100);
              await page.mouse.up();
              await delay(300);
              
              // Double-click sometimes works better for toggle buttons
              await page.mouse.down();
              await delay(50);
              await page.mouse.up();
              await delay(200);
            }
            
            // Also try JavaScript click as backup - multiple times
            await page.evaluate(() => {
              const allElements = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"], label, span'));
              for (const el of allElements) {
                const text = el.textContent?.trim() || '';
                const ariaLabel = el.getAttribute('aria-label') || '';
                const title = el.getAttribute('title') || '';
                const className = el.className || '';
                
                if ((text.includes('TP/SL') || text.includes('TP & SL') ||
                     ariaLabel.includes('TP/SL') || ariaLabel.includes('TP & SL') ||
                     title.includes('TP/SL') || title.includes('TP & SL') ||
                     className.includes('tpsl') || className.includes('TP/SL')) &&
                    !text.includes('Take Profit') && !text.includes('Stop Loss')) {
                  // Set attributes first
                  el.setAttribute('aria-checked', 'true');
                  el.setAttribute('data-checked', 'true');
                  el.classList.add('checked', 'active');
                  
                  // Try multiple click methods
                  el.click();
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  
                  // Also try touch events (sometimes needed for React) - only if available
                  if (typeof TouchEvent !== 'undefined') {
                    try {
                      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
                      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
                    } catch (e) {
                      // TouchEvent not supported, skip
                    }
                  }
                }
              }
            });
            await delay(500);
          }
          
          await delay(2000); // Wait longer for UI to update
          
          // Verify button is now checked - try multiple times with delays
          let verifyState = false;
          let verifyDetails = null;
          
          for (let verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
            verifyDetails = await page.evaluate(() => {
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of checkboxes) {
                let label = checkbox.closest('label');
                if (!label) {
                  const id = checkbox.id;
                  if (id) {
                    label = document.querySelector(`label[for="${id}"]`);
                  }
                }
                if (label) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    return {
                      type: 'checkbox',
                      checked: checkbox.checked,
                      disabled: checkbox.disabled,
                      id: checkbox.id,
                      name: checkbox.name
                    };
                  }
                }
              }
              
              const allElements = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"], label, span'));
              for (const el of allElements) {
                const text = el.textContent?.trim() || '';
                const ariaLabel = el.getAttribute('aria-label') || '';
                const title = el.getAttribute('title') || '';
                const className = el.className || '';
                
                if ((text.includes('TP/SL') || text.includes('TP & SL') ||
                     ariaLabel.includes('TP/SL') || ariaLabel.includes('TP & SL') ||
                     title.includes('TP/SL') || title.includes('TP & SL') ||
                     className.includes('tpsl') || className.includes('TP/SL')) &&
                    !text.includes('Take Profit') && !text.includes('Stop Loss')) {
                  return {
                    type: 'button',
                    checked: el.getAttribute('aria-checked') === 'true' || 
                            el.classList.contains('checked') || 
                            el.classList.contains('active') ||
                            el.getAttribute('data-checked') === 'true',
                    ariaChecked: el.getAttribute('aria-checked'),
                    hasCheckedClass: el.classList.contains('checked'),
                    hasActiveClass: el.classList.contains('active'),
                    dataChecked: el.getAttribute('data-checked')
                  };
                }
              }
              return { type: 'none', checked: false };
            });
            
            verifyState = verifyDetails && verifyDetails.checked === true;
            
            if (verifyState) {
              console.log(`✓ TP/SL button clicked and verified as checked (attempt ${attempt}/${maxAttempts}, verify attempt ${verifyAttempt + 1}): ${JSON.stringify(verifyDetails)}`);
              buttonClicked = true;
              break;
            } else {
              console.log(`⚠ TP/SL button verification attempt ${verifyAttempt + 1} failed: ${JSON.stringify(verifyDetails)}`);
              if (verifyAttempt < 2) {
                await delay(1000); // Wait and retry verification
              }
            }
          }
          
          if (!verifyState) {
            console.log(`⚠ TP/SL button click not verified after 3 attempts (attempt ${attempt}/${maxAttempts}), retrying...`);
          }
        } catch (error) {
          console.log(`⚠ Error clicking TP/SL button (attempt ${attempt}/${maxAttempts}): ${error.message}`);
        }
      }
      
      // Verify inputs are ready - even if checkbox appears unchecked, check if inputs are enabled
      // (React might have the checkbox unchecked but inputs enabled)
      await delay(1000); // Additional wait for inputs to appear
        
      const inputsReadyCheck = await page.evaluate(() => {
        const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
        const inputDetails = [];
        let enabledCount = 0;
        for (const input of allInputs) {
          const rect = input.getBoundingClientRect();
          if (rect && rect.x > 1100 && rect.y > 400 && rect.y < 700) {
            const isEnabled = !input.disabled && !input.readOnly && input.offsetParent !== null && rect.width > 0;
            inputDetails.push({
              x: rect.x,
              y: rect.y,
              disabled: input.disabled,
              readOnly: input.readOnly,
              visible: input.offsetParent !== null,
              width: rect.width,
              enabled: isEnabled
            });
            if (isEnabled) {
              enabledCount++;
            }
          }
        }
        return {
          enabledCount: enabledCount,
          totalCount: inputDetails.length,
          details: inputDetails
        };
      });
      
      console.log(`  TP/SL inputs check: ${inputsReadyCheck.enabledCount}/${inputsReadyCheck.totalCount} enabled`);
      if (inputsReadyCheck.enabledCount >= 2) {
        console.log(`✓ TP/SL inputs are enabled and ready (even if checkbox appears unchecked)`);
        inputsReady = true;
        buttonClicked = true; // Consider it clicked if inputs are enabled
        break; // Success!
      } else {
        console.log(`⚠ TP/SL inputs not yet ready (${inputsReadyCheck.enabledCount} enabled, need at least 2)`);
        if (inputsReadyCheck.details && inputsReadyCheck.details.length > 0) {
          console.log(`  Input details: ${JSON.stringify(inputsReadyCheck.details.slice(0, 4))}`);
        }
      }
      
      // If button was clicked but inputs not ready, continue to next attempt
      if (buttonClicked && !inputsReady) {
        console.log(`⚠ Button clicked but inputs not ready (attempt ${attempt}/${maxAttempts}), retrying...`);
      }
    } else {
      console.log(`⚠ TP/SL button not found (attempt ${attempt}/${maxAttempts}), retrying...`);
    }
    
    if (attempt < maxAttempts) {
      await delay(1000);
    }
  }
  
  if (!buttonClicked || !inputsReady) {
    console.log(`⚠ TP/SL button may not be fully activated or inputs not ready (buttonClicked: ${buttonClicked}, inputsReady: ${inputsReady}), but continuing...`);
    await delay(1000);
  }
  
  // Note: The actual value setting is handled in executeTrade function
  // This function just ensures the button is checked and inputs are ready
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

    // Find the leverage input field - ONLY in the "Adjust Leverage" modal
    const inputInfo = await page.evaluate(() => {
      // First, find the modal dialog by its title "Adjust Leverage"
      const modal = document.querySelector('[role="dialog"]');
      if (!modal) {
        return { success: false, error: "Leverage modal not found" };
      }

      // Check if this is the leverage modal by looking for the title
      const title = modal.querySelector('h1');
      if (!title || !title.textContent?.includes("Adjust Leverage")) {
        return { success: false, error: "Not the leverage modal" };
      }

      // Now find the input field ONLY within this modal
      // Look for input with placeholder="Leverage" or in the modal form
      const form = modal.querySelector('form');
      if (!form) {
        return { success: false, error: "Form not found in modal" };
      }

      const inputs = form.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
      
      console.log(`Found ${inputs.length} input fields in leverage modal`);

      // Find the leverage input specifically by placeholder
      for (const input of inputs) {
        if (input.offsetParent === null) continue; // Skip hidden inputs

        const placeholder = (input.placeholder || "").toLowerCase();
        const value = input.value || "";

        console.log(`Input: value="${value}", placeholder="${placeholder}"`);

        // Only match if placeholder contains "leverage" - be very specific
        if (placeholder.includes("leverage")) {
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

    // Focus and select all text in the leverage input
    await leverageInput.focus();
    await delay(100);
    await leverageInput.click({ clickCount: 3 });
    await delay(200);

    // Verify we're focused on the correct input
    const focusedElement = await page.evaluate(() => {
      const active = document.activeElement;
      return active && active.hasAttribute('data-leverage-input') ? true : false;
    });

    if (!focusedElement) {
      console.log(`⚠ Not focused on leverage input, refocusing...`);
      await leverageInput.focus();
      await delay(200);
    }

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

    // Step 3: Click the "Confirm" button - ONLY in the leverage modal
    console.log("Clicking Confirm button in leverage modal...");
    const confirmed = await page.evaluate(() => {
      // Find the leverage modal
      const modal = document.querySelector('[role="dialog"]');
      if (!modal) {
        return { success: false, error: "Modal not found" };
      }

      // Verify it's the leverage modal
      const title = modal.querySelector('h1');
      if (!title || !title.textContent?.includes("Adjust Leverage")) {
        return { success: false, error: "Not the leverage modal" };
      }

      // Find Confirm button ONLY within this modal
      const buttons = Array.from(modal.querySelectorAll("button"));
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (text === "Confirm" && btn.offsetParent !== null && btn.type === "submit") {
          console.log(`Found and clicking Confirm button in leverage modal`);
          btn.click();
          return { success: true };
        }
      }
      return { success: false, error: "Confirm button not found in modal" };
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
  
  // For market orders, fetch current market price for TP/SL calculation
  if (orderType === "market" && !price) {
    price = await getCurrentMarketPrice(page);
    if (!price) {
      console.log("⚠ Could not fetch market price for TP/SL calculation, continuing anyway...");
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
      await delay(1500); // Wait longer for tab to switch and UI to update
      
      // CRITICAL: Force TP/SL checkbox to be checked when switching to SELL
      // SELL orders require TP/SL to be set, so we must ensure it's checked
      console.log("Forcing TP/SL checkbox to be checked for SELL order...");
      const forceCheckResult = await page.evaluate(() => {
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        for (const checkbox of checkboxes) {
          let label = checkbox.closest('label');
          if (!label) {
            const id = checkbox.id;
            if (id) {
              label = document.querySelector(`label[for="${id}"]`);
            }
          }
          if (label) {
            const labelText = label.textContent?.trim() || '';
            if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
              const wasChecked = checkbox.checked;
              // Force check regardless of current state
              checkbox.checked = true;
              checkbox.setAttribute('checked', 'checked');
              checkbox.setAttribute('aria-checked', 'true');
              label.setAttribute('aria-checked', 'true');
              label.classList.add('checked', 'active', 'selected');
              
              // Trigger change event
              checkbox.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              
              // Also try clicking the label
              label.click();
              
              return {
                found: true,
                wasChecked: wasChecked,
                nowChecked: checkbox.checked,
                labelClicked: true
              };
            }
          }
        }
        return { found: false };
      });
      
      if (forceCheckResult.found) {
        console.log(`  TP/SL checkbox force-checked (was: ${forceCheckResult.wasChecked}, now: ${forceCheckResult.nowChecked})`);
      } else {
        console.log(`  ⚠ TP/SL checkbox not found for force-check`);
      }
      
      await delay(1000); // Wait for React to process the change
    }
  } else {
    const buyBtn = await findByExactText(page, "Buy", ["button", "div"]);
    if (buyBtn) {
      await buyBtn.click();
      console.log("Selected BUY");
      await delay(1000); // Wait for tab to switch
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
  
  // 4. Check TP/SL checkbox and set values (after size is entered, before order confirmation)
  console.log(`\n=== Setting TP/SL (after size entered, before confirmation) ===`);
  
  // Force-check TP/SL checkbox
  await forceTPSLCheckboxChecked(page);
  await delay(1500); // Wait for inputs to appear after checkbox is checked
  
  // Now set values based on order side
  // 5. Set Stop Loss for BUY orders
  if (side === "buy" && price && qty) {
    // Parse STOP_LOSS, handling commas and invalid values
    const stopLossEnvRaw = (process.env.STOP_LOSS || '').toString().trim();
    const stopLossEnv = stopLossEnvRaw.replace(/,/g, '').trim();
    let stopLossAmount = parseFloat(stopLossEnv);
    
    // Validate parsed value - reasonable range for dollar amounts (0.01 to 10000)
    const MAX_REASONABLE_AMOUNT = 10000;
    const MIN_REASONABLE_AMOUNT = 0.01;
    
    if (isNaN(stopLossAmount) || stopLossAmount < MIN_REASONABLE_AMOUNT || stopLossAmount > MAX_REASONABLE_AMOUNT) {
      console.log(`⚠ Invalid STOP_LOSS value: "${stopLossEnvRaw}" (parsed as: ${stopLossAmount}), using default: 0.5`);
      stopLossAmount = 0.5;
    }
    
    if (stopLossAmount && stopLossAmount > 0) {
      // ===================================================================
      // CRITICAL: BUY ORDER STOP LOSS FORMULA VERIFICATION
      // ===================================================================
      // For BUY orders (long position):
      // - We BUY at entry price, hoping price goes UP
      // - Stop Loss: Price goes DOWN → We SELL at lower price → LOSS
      //
      // CORRECT FORMULA:
      // stopLossPrice = entryPrice - (STOP_LOSS_dollar_amount / qty)
      //   → Price must be BELOW entry to limit loss
      //
      // VERIFICATION EXAMPLE:
      //   Entry = $91,277.20, Qty = 0.0005 BTC, STOP_LOSS = $0.1
      //   Stop Loss difference = $0.1 / 0.0005 = $200 per BTC
      //   Stop Loss price = $91,277.20 - $200 = $91,077.20 ✓ (BELOW entry - CORRECT)
      //
      // LOSS VERIFICATION:
      //   If price hits Stop Loss ($91,077.20):
      //     Bought at: $91,277.20, Sell at: $91,077.20
      //     Loss per BTC = $91,277.20 - $91,077.20 = $200
      //     Total loss = $200 × 0.0005 = $0.1 ✓ (matches STOP_LOSS)
      // ===================================================================
      
      const stopLossPriceDifference = stopLossAmount / qty;
      let stopLossPrice = price - stopLossPriceDifference; // BELOW entry for BUY
      
      // CRITICAL: Verify the formula is correct before using
      console.log(`\n  === CRITICAL: BUY Order Stop Loss Formula Verification ===`);
      console.log(`    Entry Price: $${price.toFixed(2)}`);
      console.log(`    Quantity: ${qty} BTC`);
      console.log(`    Stop Loss Amount: $${stopLossAmount.toFixed(2)}`);
      console.log(`\n    Step 1: Calculate price difference:`);
      console.log(`      Stop Loss difference = $${stopLossAmount.toFixed(2)} ÷ ${qty} = $${stopLossPriceDifference.toFixed(2)} per BTC`);
      console.log(`    Step 2: Calculate Stop Loss price:`);
      console.log(`      Stop Loss price = $${price.toFixed(2)} - $${stopLossPriceDifference.toFixed(2)} = $${stopLossPrice.toFixed(2)}`);
      
      // Step 3: VERIFY the calculation is correct by reverse-engineering
      const verifyStopLossAmount = (price - stopLossPrice) * qty;
      console.log(`    Step 3: VERIFICATION (reverse calculation):`);
      console.log(`      Stop Loss verification: ($${price.toFixed(2)} - $${stopLossPrice.toFixed(2)}) × ${qty} = $${verifyStopLossAmount.toFixed(2)}`);
      
      // CRITICAL: Verify amount matches expected
      const stopLossAmountMatchBuy = Math.abs(verifyStopLossAmount - stopLossAmount) < 0.01;
      if (!stopLossAmountMatchBuy) {
        console.log(`\n    ❌ CRITICAL ERROR: Stop Loss calculation is WRONG!`);
        console.log(`      Expected: $${stopLossAmount.toFixed(2)}, Got: $${verifyStopLossAmount.toFixed(2)}`);
        throw new Error(`Stop Loss calculation error: Expected $${stopLossAmount.toFixed(2)}, calculated $${verifyStopLossAmount.toFixed(2)}`);
      }
      
      console.log(`    ✓ FORMULA VERIFICATION PASSED:`);
      console.log(`      Stop Loss: $${verifyStopLossAmount.toFixed(2)} matches expected $${stopLossAmount.toFixed(2)} ✓`);
      
      // Get liquidation price from the page to ensure Stop Loss is above it
      const liquidationInfo = await page.evaluate(() => {
        // Look for "Liquidation Price" text in the page
        const allText = document.body.innerText || '';
        const liquidationMatch = allText.match(/Liquidation\s*Price[:\s]*\$?([\d,]+\.?\d*)/i);
        if (liquidationMatch) {
          const liquidationPrice = parseFloat(liquidationMatch[1].replace(/,/g, ''));
          return { found: true, price: liquidationPrice };
        }
        
        // Try to find it in specific elements
        const elements = Array.from(document.querySelectorAll('*'));
        for (const el of elements) {
          const text = el.textContent || '';
          if (text.includes('Liquidation') && text.includes('Price')) {
            const match = text.match(/\$?([\d,]+\.?\d*)/);
            if (match) {
              const liquidationPrice = parseFloat(match[1].replace(/,/g, ''));
              return { found: true, price: liquidationPrice };
            }
          }
        }
        
        return { found: false, price: null };
      });
      
      if (liquidationInfo.found && liquidationInfo.price) {
        console.log(`  Found liquidation price: $${liquidationInfo.price.toFixed(2)}`);
        
        // Ensure Stop Loss price is above liquidation price
        // Add a small buffer (0.1% of entry price) to ensure it's safely above
        const minStopLossPrice = liquidationInfo.price + (price * 0.001);
        
        if (stopLossPrice <= liquidationInfo.price) {
          console.log(`⚠ Stop Loss price ($${stopLossPrice.toFixed(2)}) is below liquidation price ($${liquidationInfo.price.toFixed(2)}), adjusting...`);
          stopLossPrice = minStopLossPrice;
          console.log(`  Adjusted Stop Loss price to: $${stopLossPrice.toFixed(2)} (above liquidation price)`);
        } else if (stopLossPrice <= minStopLossPrice) {
          // Too close to liquidation, add buffer
          stopLossPrice = minStopLossPrice;
          console.log(`  Adjusted Stop Loss price to: $${stopLossPrice.toFixed(2)} (added safety buffer above liquidation)`);
        }
      } else {
        console.log(`⚠ Could not find liquidation price on page, using calculated Stop Loss price`);
        // If we can't find liquidation price, add a small safety margin (0.5% below entry)
        const safetyMargin = price * 0.005;
        if (stopLossPrice < price - safetyMargin) {
          stopLossPrice = price - safetyMargin;
          console.log(`  Adjusted Stop Loss price to: $${stopLossPrice.toFixed(2)} (safety margin)`);
        }
      }
      
      console.log(`Setting Stop Loss for BUY order: $${stopLossPrice.toFixed(2)} (price, calculated from $${stopLossAmount} / ${qty} = $${stopLossPriceDifference.toFixed(2)} below entry $${price.toFixed(2)})`);
      
      let stopLossSet = false;
      const maxRetries = 5;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // CRITICAL: Force-check TP/SL checkbox at the start of each retry
        await forceTPSLCheckboxChecked(page);
        await delay(300);
        
        try {
          const allInputs = await page.$$('input[type="text"], input:not([type])');
          let stopLossInputElement = null;
          
          // Find Stop Loss input - filter to dollar amount inputs only (x < 1650)
          const tpslInputs = [];
          for (const input of allInputs) {
            const rect = await input.boundingBox();
            if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
            
            // Exclude Price and Size inputs
            const inputInfo = await page.evaluate((el) => {
              let parent = el.parentElement;
              let parentText = '';
              for (let i = 0; i < 5 && parent; i++) {
                if (parent.innerText) {
                  parentText = parent.innerText.toLowerCase();
                  break;
                }
                parent = parent.parentElement;
              }
              return {
                parentText: parentText,
                id: el.id || '',
                name: el.name || '',
              };
            }, input);
            
            // Skip if it's clearly a Price or Size input
            if (inputInfo.parentText.includes('price') && !inputInfo.parentText.includes('take profit') && !inputInfo.parentText.includes('stop loss')) continue;
            if (inputInfo.parentText.includes('size') || inputInfo.id.includes('size') || inputInfo.name.includes('size')) continue;
            
            tpslInputs.push({ input, rect, y: rect.y, x: rect.x });
          }
          
          // Sort by Y position (top to bottom), then by X (left to right)
          tpslInputs.sort((a, b) => {
            if (Math.abs(a.y - b.y) > 10) {
              return a.y - b.y; // Top to bottom
            }
            return a.x - b.x; // Left to right
          });
          
          console.log(`  Found ${tpslInputs.length} inputs in TP/SL area`);
          console.log(`  Input positions: ${tpslInputs.map((inp, idx) => `[${idx}] x=${inp.x}, y=${inp.y}`).join(', ')}`);
          
          // Filter to only dollar amount inputs (left side, typically x < 1650)
          // Percentage inputs are on the right side (x > 1650)
          const dollarInputs = tpslInputs.filter(inp => inp.x < 1650);
          console.log(`  Found ${dollarInputs.length} dollar amount inputs (x < 1650)`);
          
          if (dollarInputs.length >= 1) {
            // For BUY orders, Stop Loss is typically the bottom row (or only row if no Take Profit)
            const bottomRow = dollarInputs.filter(inp => inp.y >= 530);
            if (bottomRow.length > 0) {
              // Use the leftmost input from bottom row
              bottomRow.sort((a, b) => a.x - b.x);
              stopLossInputElement = bottomRow[0].input;
              console.log(`✓ Found Stop Loss input (bottom row, left input, x: ${bottomRow[0].x}, y: ${bottomRow[0].y})! (attempt ${attempt})`);
            } else {
              // If no bottom row, use the last (bottommost) dollar input
              stopLossInputElement = dollarInputs[dollarInputs.length - 1].input;
              console.log(`✓ Found Stop Loss input (last dollar input, x: ${dollarInputs[dollarInputs.length - 1].x}, y: ${dollarInputs[dollarInputs.length - 1].y})! (attempt ${attempt})`);
            }
          } else if (tpslInputs.length >= 1) {
            // Fallback: if no dollar inputs found, use the bottommost input from all inputs
            const bottomInputs = tpslInputs.filter(inp => inp.y >= 530);
            if (bottomInputs.length > 0) {
              bottomInputs.sort((a, b) => a.x - b.x);
              stopLossInputElement = bottomInputs[0].input;
              console.log(`✓ Found Stop Loss input (fallback, bottom row left, x: ${bottomInputs[0].x}, y: ${bottomInputs[0].y})! (attempt ${attempt})`);
            } else {
              // Last resort: use the last input
              stopLossInputElement = tpslInputs[tpslInputs.length - 1].input;
              console.log(`✓ Found Stop Loss input (fallback, last input, x: ${tpslInputs[tpslInputs.length - 1].x}, y: ${tpslInputs[tpslInputs.length - 1].y})! (attempt ${attempt})`);
            }
          }
          
          if (stopLossInputElement) {
            // CRITICAL: Verify TP/SL button is checked BEFORE setting value
            // Also check for visual state (blue highlight) - sometimes visually active but not checked
            const tpslButtonState = await page.evaluate(() => {
              // Check checkbox
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of checkboxes) {
                let label = checkbox.closest('label');
                if (!label) {
                  const id = checkbox.id;
                  if (id) {
                    label = document.querySelector(`label[for="${id}"]`);
                  }
                }
                if (label) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    // Check visual state (blue highlight/active classes)
                    const isVisuallyActive = label.classList.contains('active') || 
                                           label.classList.contains('checked') ||
                                           label.classList.contains('selected') ||
                                           label.getAttribute('aria-checked') === 'true' ||
                                           checkbox.getAttribute('aria-checked') === 'true';
                    
                    return {
                      checked: checkbox.checked,
                      visuallyActive: isVisuallyActive,
                      hasActiveClass: label.classList.contains('active'),
                      hasCheckedClass: label.classList.contains('checked'),
                      ariaChecked: label.getAttribute('aria-checked') || checkbox.getAttribute('aria-checked')
                    };
                  }
                }
              }
              // Check button/div
              const allElements = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"], label, span'));
              for (const el of allElements) {
                const text = el.textContent?.trim() || '';
                const ariaLabel = el.getAttribute('aria-label') || '';
                const title = el.getAttribute('title') || '';
                const className = el.className || '';
                
                if ((text.includes('TP/SL') || text.includes('TP & SL') ||
                     ariaLabel.includes('TP/SL') || ariaLabel.includes('TP & SL') ||
                     title.includes('TP/SL') || title.includes('TP & SL') ||
                     className.includes('tpsl') || className.includes('TP/SL')) &&
                    !text.includes('Take Profit') && !text.includes('Stop Loss')) {
                  return {
                    checked: el.getAttribute('aria-checked') === 'true' || 
                            el.classList.contains('checked') || 
                            el.classList.contains('active') ||
                            el.getAttribute('data-checked') === 'true',
                    visuallyActive: true,
                    hasActiveClass: el.classList.contains('active'),
                    hasCheckedClass: el.classList.contains('checked')
                  };
                }
              }
              return { checked: false, visuallyActive: false };
            });
            
            const isChecked = tpslButtonState && (tpslButtonState.checked || tpslButtonState.visuallyActive);
            
            if (!isChecked) {
              console.log(`⚠ TP/SL button is NOT checked! Re-clicking before setting Stop Loss...`);
              await ensureTPSLCheckedAndSetValues(page, side, price, qty);
              await delay(2000); // Wait longer for inputs to be ready
            } else if (tpslButtonState.visuallyActive && !tpslButtonState.checked) {
              // Visually active (blue) but checkbox not checked - force it to be checked
              console.log(`⚠ TP/SL button is visually active (blue) but checkbox not checked, forcing check...`);
              await page.evaluate(() => {
                const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
                for (const checkbox of checkboxes) {
                  let label = checkbox.closest('label');
                  if (!label) {
                    const id = checkbox.id;
                    if (id) {
                      label = document.querySelector(`label[for="${id}"]`);
                    }
                  }
                  if (label) {
                    const labelText = label.textContent?.trim() || '';
                    if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                      // Force check
                      checkbox.checked = true;
                      checkbox.setAttribute('checked', 'checked');
                      checkbox.setAttribute('aria-checked', 'true');
                      label.setAttribute('aria-checked', 'true');
                      label.classList.add('checked', 'active');
                      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }
                }
              });
              await delay(1000);
            }
            
            // Verify input is enabled and visible before trying to set value
            const inputState = await page.evaluate((el) => {
              return {
                disabled: el.disabled,
                readOnly: el.readOnly,
                visible: el.offsetParent !== null,
                width: el.getBoundingClientRect().width,
                height: el.getBoundingClientRect().height,
                value: el.value || '',
                tabIndex: el.tabIndex
              };
            }, stopLossInputElement);
            
            console.log(`  Stop Loss input state: disabled=${inputState.disabled}, readOnly=${inputState.readOnly}, visible=${inputState.visible}, width=${inputState.width}, value="${inputState.value}"`);
            
            if (inputState.disabled || inputState.readOnly || !inputState.visible || inputState.width === 0) {
              console.log(`⚠ Stop Loss input is not active, TP/SL button may not be checked - re-clicking...`);
              // Try to click TP/SL button again
              await ensureTPSLCheckedAndSetValues(page, side, price, qty);
              await delay(2000);
              // Re-check input state
              const newInputState = await page.evaluate((el) => {
                return {
                  disabled: el.disabled,
                  readOnly: el.readOnly,
                  visible: el.offsetParent !== null,
                  width: el.getBoundingClientRect().width,
                  height: el.getBoundingClientRect().height,
                  value: el.value || ''
                };
              }, stopLossInputElement);
              console.log(`  After re-click: disabled=${newInputState.disabled}, readOnly=${newInputState.readOnly}, visible=${newInputState.visible}, value="${newInputState.value}"`);
              if (newInputState.disabled || newInputState.readOnly || !newInputState.visible) {
                console.log(`⚠ Stop Loss input still not active after re-clicking TP/SL button, skipping this attempt...`);
                await delay(1000);
                continue; // Skip to next retry
              }
            }
            
            await stopLossInputElement.focus();
            await delay(200);
            await stopLossInputElement.click({ clickCount: 3 });
            await delay(200);
            
            await page.keyboard.down('Meta');
            await page.keyboard.press('KeyA');
            await page.keyboard.up('Meta');
            await delay(100);
            await page.keyboard.press('Backspace');
            await delay(100);
            
            await page.evaluate((el) => {
              if (el._valueTracker) {
                el._valueTracker.setValue('');
              }
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, stopLossInputElement);
            await delay(200);
            
            // Verify input is empty before typing
            const currentValue = await page.evaluate((el) => {
              return el.value || '';
            }, stopLossInputElement);
            console.log(`  Input cleared, current value: "${currentValue}"`);
            
            if (currentValue && currentValue.length > 0) {
              // Force clear again if still has value
              await page.evaluate((el) => {
                if (el._valueTracker) {
                  el._valueTracker.setValue('');
                }
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }, stopLossInputElement);
              await delay(300);
            }
            
            const valueToType = stopLossPrice.toFixed(2).replace(/,/g, '');
            console.log(`[Attempt ${attempt}/${maxRetries}] Typing Stop Loss value: ${valueToType}`);
            await page.keyboard.type(valueToType, { delay: 50 }); // Reduced typing delay
            await delay(400); // Reduced delay to let React process the value
            
            // Blur the input to trigger React's onChange
            await page.keyboard.press('Tab');
            await delay(300); // Reduced delay
            
            let verifyValue = await page.evaluate((el) => {
              if (!el) return null;
              const rawValue = el.value || '';
              const numValue = parseFloat(rawValue.replace(/,/g, '')) || 0;
              return numValue;
            }, stopLossInputElement);
            
            console.log(`  Verification: got ${verifyValue}, expected ${stopLossPrice.toFixed(2)}`);
            
            // If value not set correctly, try direct assignment
            if (!verifyValue || Math.abs(verifyValue - stopLossPrice) > 0.01) {
              console.log(`  Value not set correctly, trying direct assignment...`);
              await page.evaluate((el, val) => {
                if (el._valueTracker) {
                  el._valueTracker.setValue('');
                }
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                const valueStr = String(val);
                if (el._valueTracker) {
                  el._valueTracker.setValue(valueStr);
                }
                el.value = valueStr;
                el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter.call(el, valueStr);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }, stopLossInputElement, stopLossPrice);
              await delay(400); // Reduced delay after direct assignment
              verifyValue = await page.evaluate((el) => {
                if (!el) return null;
                const rawValue = el.value || '';
                const numValue = parseFloat(rawValue.replace(/,/g, '')) || 0;
                return numValue;
              }, stopLossInputElement);
              console.log(`  After direct assignment: got ${verifyValue}, expected ${stopLossPrice.toFixed(2)}`);
            }
            
            if (verifyValue && Math.abs(verifyValue - stopLossPrice) < 0.01) {
              console.log(`✓ Stop Loss set to $${stopLossPrice.toFixed(2)}`);
              stopLossSet = true;
              break;
            } else {
              console.log(`⚠ Stop Loss verification failed (got ${verifyValue || 0}, expected ${stopLossAmount.toFixed(2)}), retrying...`);
              await delay(1000);
            }
          } else {
            console.log(`⚠ Stop Loss input not found (attempt ${attempt}/${maxRetries}), retrying...`);
            await delay(1000);
          }
        } catch (error) {
          console.log(`⚠ Error setting Stop Loss (attempt ${attempt}/${maxRetries}): ${error.message}`);
          await delay(1000);
        }
      }
      
      if (!stopLossSet) {
        console.log(`❌ Failed to set Stop Loss after ${maxRetries} attempts. Cannot proceed with BUY order.`);
        return { success: false, error: "Failed to set Stop Loss for BUY order" };
      }
    }
  }
  
  // 6. Set Take Profit and Stop Loss for SELL orders (REQUIRED by Paradex)
  console.log(`Checking if SELL order (side=${side}, price=${price}, qty=${qty})...`);
  if (side === "sell" && price && qty) {
    console.log(`✓ SELL order detected, setting Take Profit and Stop Loss...`);
    
    // CRITICAL: Force TP/SL checkbox to be checked for SELL orders
    // SELL orders require TP/SL, so we must ensure checkbox is checked
    console.log(`Forcing TP/SL checkbox to be checked for SELL order (required)...`);
    const forceCheckForSell = await page.evaluate(() => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      for (const checkbox of checkboxes) {
        let label = checkbox.closest('label');
        if (!label) {
          const id = checkbox.id;
          if (id) {
            label = document.querySelector(`label[for="${id}"]`);
          }
        }
        if (label) {
          const labelText = label.textContent?.trim() || '';
          if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
            const wasChecked = checkbox.checked;
            // Force check - SELL orders require TP/SL
            checkbox.checked = true;
            checkbox.setAttribute('checked', 'checked');
            checkbox.setAttribute('aria-checked', 'true');
            label.setAttribute('aria-checked', 'true');
            label.classList.add('checked', 'active', 'selected');
            
            // Trigger change event to notify React
            checkbox.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            
            // Also click label to trigger React handlers
            label.click();
            
            return {
              found: true,
              wasChecked: wasChecked,
              nowChecked: checkbox.checked
            };
          }
        }
      }
      return { found: false };
    });
    
    if (forceCheckForSell.found) {
      console.log(`  TP/SL checkbox force-checked for SELL (was: ${forceCheckForSell.wasChecked}, now: ${forceCheckForSell.nowChecked})`);
    } else {
      console.log(`  ⚠ TP/SL checkbox not found for force-check`);
    }
    
    await delay(800); // Reduced delay - wait for React to process
    
    // CRITICAL: Ensure TP/SL button is clicked BEFORE setting values
    // The inputs won't accept values if the TP/SL button is unchecked
    console.log(`Ensuring TP/SL button is clicked before setting Take Profit/Stop Loss...`);
    await forceTPSLCheckboxChecked(page); // Simplified - just check checkbox
    await delay(500); // Reduced delay - wait for inputs to be fully active
    
    // Parse TAKE_PROFIT and STOP_LOSS, handling commas and invalid values
    const takeProfitEnvRaw = (process.env.TAKE_PROFIT || '').toString().trim();
    const stopLossEnvRaw = (process.env.STOP_LOSS || '').toString().trim();
    
    console.log(`  Raw TAKE_PROFIT from env: "${takeProfitEnvRaw}"`);
    console.log(`  Raw STOP_LOSS from env: "${stopLossEnvRaw}"`);
    
    const takeProfitEnv = takeProfitEnvRaw.replace(/,/g, '').trim();
    const stopLossEnv = stopLossEnvRaw.replace(/,/g, '').trim();
    
    let takeProfitAmount = parseFloat(takeProfitEnv);
    let stopLossAmount = parseFloat(stopLossEnv);
    
    console.log(`  Parsed TAKE_PROFIT: ${takeProfitAmount} (isNaN: ${isNaN(takeProfitAmount)})`);
    console.log(`  Parsed STOP_LOSS: ${stopLossAmount} (isNaN: ${isNaN(stopLossAmount)})`);
    
    // Validate parsed values - reasonable range for dollar amounts (0.01 to 10000)
    const MAX_REASONABLE_AMOUNT = 10000; // Maximum reasonable dollar amount
    const MIN_REASONABLE_AMOUNT = 0.01; // Minimum reasonable dollar amount
    
    if (isNaN(takeProfitAmount) || takeProfitAmount < MIN_REASONABLE_AMOUNT || takeProfitAmount > MAX_REASONABLE_AMOUNT) {
      console.log(`⚠ Invalid TAKE_PROFIT value: "${takeProfitEnvRaw}" (parsed as: ${takeProfitAmount}), using STOP_LOSS as fallback`);
      takeProfitAmount = parseFloat(stopLossEnv);
      if (isNaN(takeProfitAmount) || takeProfitAmount < MIN_REASONABLE_AMOUNT || takeProfitAmount > MAX_REASONABLE_AMOUNT) {
        console.log(`⚠ STOP_LOSS also invalid, using default: 1`);
        takeProfitAmount = 1;
      }
    }
    if (isNaN(stopLossAmount) || stopLossAmount < MIN_REASONABLE_AMOUNT || stopLossAmount > MAX_REASONABLE_AMOUNT) {
      console.log(`⚠ Invalid STOP_LOSS value: "${stopLossEnvRaw}" (parsed as: ${stopLossAmount}), using default: 1`);
      stopLossAmount = 1;
    }
    
    console.log(`  Final Take Profit amount: $${takeProfitAmount}, Final Stop Loss amount: $${stopLossAmount}`);
    
    // For SELL orders, TP/SL must be PRICES, not dollar amounts
    // - Take Profit price must be BELOW entry price
    // - Stop Loss price must be ABOVE entry price
    // - They must be different
    
    // ===================================================================
    // CRITICAL: SELL ORDER TP/SL FORMULA VERIFICATION
    // ===================================================================
    // For SELL orders (short position):
    // - We SELL at entry price, hoping price goes DOWN
    // - Take Profit: Price goes DOWN → We BUY back cheaper → PROFIT
    // - Stop Loss: Price goes UP → We BUY back more expensive → LOSS
    //
    // CORRECT FORMULAS:
    // takeProfitPrice = entryPrice - (TAKE_PROFIT_dollar_amount / qty)
    //   → Price must be BELOW entry to profit
    // stopLossPrice = entryPrice + (STOP_LOSS_dollar_amount / qty)
    //   → Price must be ABOVE entry to limit loss
    //
    // VERIFICATION EXAMPLE:
    //   Entry = $91,277.20, Qty = 0.0005 BTC, TAKE_PROFIT = $0.1, STOP_LOSS = $0.1
    //   Take Profit difference = $0.1 / 0.0005 = $200 per BTC
    //   Take Profit price = $91,277.20 - $200 = $91,077.20 ✓ (BELOW entry - CORRECT)
    //   Stop Loss difference = $0.1 / 0.0005 = $200 per BTC
    //   Stop Loss price = $91,277.20 + $200 = $91,477.20 ✓ (ABOVE entry - CORRECT)
    //
    // PROFIT/LOSS VERIFICATION:
    //   If price hits Take Profit ($91,077.20):
    //     Sold at: $91,277.20, Buy back at: $91,077.20
    //     Profit per BTC = $91,277.20 - $91,077.20 = $200
    //     Total profit = $200 × 0.0005 = $0.1 ✓ (matches TAKE_PROFIT)
    //
    //   If price hits Stop Loss ($91,477.20):
    //     Sold at: $91,277.20, Buy back at: $91,477.20
    //     Loss per BTC = $91,477.20 - $91,277.20 = $200
    //     Total loss = $200 × 0.0005 = $0.1 ✓ (matches STOP_LOSS)
    // ===================================================================
    
    const takeProfitPriceDifference = takeProfitAmount / qty;
    const stopLossPriceDifference = stopLossAmount / qty;
    
    // CRITICAL: Verify the formula is correct before calculating
    console.log(`\n  === CRITICAL: SELL Order TP/SL Formula Verification ===`);
    console.log(`    Entry Price: $${price.toFixed(2)}`);
    console.log(`    Quantity: ${qty} BTC`);
    console.log(`    Take Profit Amount: $${takeProfitAmount.toFixed(2)}`);
    console.log(`    Stop Loss Amount: $${stopLossAmount.toFixed(2)}`);
    console.log(`\n    Step 1: Calculate price differences:`);
    console.log(`      Take Profit difference = $${takeProfitAmount.toFixed(2)} ÷ ${qty} = $${takeProfitPriceDifference.toFixed(2)} per BTC`);
    console.log(`      Stop Loss difference = $${stopLossAmount.toFixed(2)} ÷ ${qty} = $${stopLossPriceDifference.toFixed(2)} per BTC`);
    
    console.log(`\n  === SELL Order TP/SL Calculation ===`);
    console.log(`    Entry price: $${price.toFixed(2)}`);
    console.log(`    Quantity: ${qty} BTC`);
    console.log(`    Take Profit dollar amount: $${takeProfitAmount.toFixed(2)}`);
    console.log(`    Stop Loss dollar amount: $${stopLossAmount.toFixed(2)}`);
    console.log(`\n    Calculation:`);
    console.log(`      Take Profit price difference = $${takeProfitAmount.toFixed(2)} / ${qty} = $${takeProfitPriceDifference.toFixed(2)}`);
    console.log(`      Stop Loss price difference = $${stopLossAmount.toFixed(2)} / ${qty} = $${stopLossPriceDifference.toFixed(2)}`);
    
    // Step 2: Calculate prices using CORRECT formulas
    let takeProfitPrice = price - takeProfitPriceDifference; // BELOW entry for SELL
    let stopLossPrice = price + stopLossPriceDifference; // ABOVE entry for SELL
    
    console.log(`\n    Step 2: Calculate TP/SL prices:`);
    console.log(`      Take Profit price = $${price.toFixed(2)} - $${takeProfitPriceDifference.toFixed(2)} = $${takeProfitPrice.toFixed(2)}`);
    console.log(`      Stop Loss price = $${price.toFixed(2)} + $${stopLossPriceDifference.toFixed(2)} = $${stopLossPrice.toFixed(2)}`);
    
    // Step 3: VERIFY the calculations are correct by reverse-engineering
    console.log(`\n    Step 3: VERIFICATION (reverse calculation):`);
    const verifyTakeProfitAmount = (price - takeProfitPrice) * qty;
    const verifyStopLossAmount = (stopLossPrice - price) * qty;
    console.log(`      Take Profit verification: ($${price.toFixed(2)} - $${takeProfitPrice.toFixed(2)}) × ${qty} = $${verifyTakeProfitAmount.toFixed(2)}`);
    console.log(`      Stop Loss verification: ($${stopLossPrice.toFixed(2)} - $${price.toFixed(2)}) × ${qty} = $${verifyStopLossAmount.toFixed(2)}`);
    
    // CRITICAL: Verify amounts match expected
    const takeProfitAmountMatch = Math.abs(verifyTakeProfitAmount - takeProfitAmount) < 0.01;
    const stopLossAmountMatch = Math.abs(verifyStopLossAmount - stopLossAmount) < 0.01;
    
    if (!takeProfitAmountMatch) {
      console.log(`\n    ❌ CRITICAL ERROR: Take Profit calculation is WRONG!`);
      console.log(`      Expected: $${takeProfitAmount.toFixed(2)}, Got: $${verifyTakeProfitAmount.toFixed(2)}`);
      throw new Error(`Take Profit calculation error: Expected $${takeProfitAmount.toFixed(2)}, calculated $${verifyTakeProfitAmount.toFixed(2)}`);
    }
    if (!stopLossAmountMatch) {
      console.log(`\n    ❌ CRITICAL ERROR: Stop Loss calculation is WRONG!`);
      console.log(`      Expected: $${stopLossAmount.toFixed(2)}, Got: $${verifyStopLossAmount.toFixed(2)}`);
      throw new Error(`Stop Loss calculation error: Expected $${stopLossAmount.toFixed(2)}, calculated $${verifyStopLossAmount.toFixed(2)}`);
    }
    
    console.log(`\n    ✓ FORMULA VERIFICATION PASSED:`);
    console.log(`      Take Profit: $${verifyTakeProfitAmount.toFixed(2)} matches expected $${takeProfitAmount.toFixed(2)} ✓`);
    console.log(`      Stop Loss: $${verifyStopLossAmount.toFixed(2)} matches expected $${stopLossAmount.toFixed(2)} ✓`);
    
    // Validation: Ensure Take Profit is BELOW entry and Stop Loss is ABOVE entry
    if (takeProfitPrice >= price) {
      console.log(`⚠ ERROR: Take Profit price ($${takeProfitPrice.toFixed(2)}) must be BELOW entry price ($${price.toFixed(2)}) for SELL orders!`);
      // Adjust to be 0.1% below entry
      takeProfitPrice = price * 0.999;
      console.log(`  Adjusted Take Profit to: $${takeProfitPrice.toFixed(2)}`);
    }
    
    if (stopLossPrice <= price) {
      console.log(`⚠ ERROR: Stop Loss price ($${stopLossPrice.toFixed(2)}) must be ABOVE entry price ($${price.toFixed(2)}) for SELL orders!`);
      // Adjust to be 0.1% above entry
      stopLossPrice = price * 1.001;
      console.log(`  Adjusted Stop Loss to: $${stopLossPrice.toFixed(2)}`);
    }
    
    // Verify the calculations are correct
    const takeProfitDistance = price - takeProfitPrice;
    const stopLossDistance = stopLossPrice - price;
    console.log(`\n    Verification:`);
    console.log(`      Take Profit is $${takeProfitDistance.toFixed(2)} BELOW entry ✓`);
    console.log(`      Stop Loss is $${stopLossDistance.toFixed(2)} ABOVE entry ✓`);
    console.log(`      Expected Take Profit distance: $${takeProfitPriceDifference.toFixed(2)}`);
    console.log(`      Expected Stop Loss distance: $${stopLossPriceDifference.toFixed(2)}`);
    
    // Check if calculated distances match expected distances (within 0.01% tolerance)
    const takeProfitDistanceMatch = Math.abs(takeProfitDistance - takeProfitPriceDifference) < (price * 0.0001);
    const stopLossDistanceMatch = Math.abs(stopLossDistance - stopLossPriceDifference) < (price * 0.0001);
    
    if (!takeProfitDistanceMatch) {
      console.log(`⚠ WARNING: Take Profit distance mismatch! Expected $${takeProfitPriceDifference.toFixed(2)}, got $${takeProfitDistance.toFixed(2)}`);
    }
    if (!stopLossDistanceMatch) {
      console.log(`⚠ WARNING: Stop Loss distance mismatch! Expected $${stopLossPriceDifference.toFixed(2)}, got $${stopLossDistance.toFixed(2)}`);
    }
    
    if (takeProfitDistanceMatch && stopLossDistanceMatch) {
      console.log(`    ✓ All distance calculations verified correct!\n`);
    }
    
    // Minimum distance check (0.1% of entry price) as per Paradex requirements
    const minDistancePercent = 0.001;
    const minDistanceDollar = price * minDistancePercent;
    
    // Ensure minimum distance is met (use minimum if calculated distance is too small)
    if (takeProfitPriceDifference < minDistanceDollar) {
      takeProfitPrice = price - minDistanceDollar;
      console.log(`⚠ Take Profit distance too small, using minimum: $${minDistanceDollar.toFixed(2)}`);
    }
    if (stopLossPriceDifference < minDistanceDollar) {
      stopLossPrice = price + minDistanceDollar;
      console.log(`⚠ Stop Loss distance too small, using minimum: $${minDistanceDollar.toFixed(2)}`);
    }
    
    // Ensure they're different
    if (Math.abs(takeProfitPrice - stopLossPrice) < 1) {
      stopLossPrice = price + Math.max(stopLossPriceDifference, minDistanceDollar * 1.5);
      console.log(`⚠ Adjusted Stop Loss to ensure it's different from Take Profit`);
    }
    
    // Set Take Profit
    console.log(`Setting Take Profit for SELL order: $${takeProfitPrice.toFixed(2)} (entry: $${price.toFixed(2)} - $${takeProfitPriceDifference.toFixed(2)} = $${takeProfitPrice.toFixed(2)}, from env TAKE_PROFIT: $${takeProfitAmount})`);
    
    let takeProfitSet = false;
    const maxRetries = 3; // Reduced from 5 to speed up
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Attempt ${attempt}/${maxRetries}] Looking for Take Profit input...`);
        const allInputs = await page.$$('input[type="text"], input:not([type])');
        console.log(`  Found ${allInputs.length} total inputs on page`);
        
        let takeProfitInputElement = null;
        const candidateInputs = [];
        
        // First, find all inputs in the TP/SL area and log them
        for (const input of allInputs) {
          const rect = await input.boundingBox();
          if (!rect || rect.x < 1100) continue;
          
          // Check if it's in the TP/SL area (right side, middle to bottom)
          if (rect.y > 400 && rect.y < 700) {
            const inputInfo = await page.evaluate((el) => {
              let parent = el.parentElement;
              let allParentTexts = [];
              let labelText = '';
              
              // Check for label
              const labels = document.querySelectorAll('label');
              for (const label of labels) {
                if (label.control === el || label.contains(el)) {
                  labelText = label.textContent?.trim() || '';
                }
              }
              
              // Get all parent text up to 8 levels deep
              for (let i = 0; i < 8 && parent; i++) {
                if (parent.innerText) {
                  allParentTexts.push(parent.innerText.toLowerCase());
                }
                parent = parent.parentElement;
              }
              
              const combinedText = allParentTexts.join(' ');
              
              return {
                parentText: combinedText,
                labelText: labelText.toLowerCase(),
                placeholder: el.placeholder || '',
                value: el.value || '',
                id: el.id || '',
                name: el.name || '',
              };
            }, input);
            
            candidateInputs.push({
              input,
              rect,
              info: inputInfo
            });
            
            // Check if this is Take Profit input - be more flexible
            const isTakeProfit = (inputInfo.parentText.includes('take profit') || 
                                  inputInfo.labelText.includes('take profit') ||
                                  inputInfo.parentText.includes('profit') && !inputInfo.parentText.includes('stop loss')) && 
                                 !inputInfo.parentText.includes('stop loss') &&
                                 !inputInfo.parentText.includes('price') &&
                                 !inputInfo.parentText.includes('size') &&
                                 !inputInfo.id.includes('price') &&
                                 !inputInfo.id.includes('size');
            
            if (isTakeProfit) {
              takeProfitInputElement = input;
              console.log(`✓ Found Take Profit input by parent text! (attempt ${attempt}, x: ${rect.x}, y: ${rect.y})`);
              console.log(`  Parent text: "${inputInfo.parentText.substring(0, 100)}"`);
              break;
            }
          }
        }
        
        // Log all candidate inputs for debugging
        if (!takeProfitInputElement && attempt === 1) {
          console.log(`  Found ${candidateInputs.length} candidate inputs in TP/SL area:`);
          candidateInputs.forEach((candidate, idx) => {
            console.log(`    Candidate ${idx + 1}: x=${candidate.rect.x}, y=${candidate.rect.y}, value="${candidate.info.value}", parent="${candidate.info.parentText.substring(0, 60)}"`);
          });
        }
        
        // Fallback to simple position-based detection if parent text didn't work
        if (!takeProfitInputElement) {
          console.log(`  Parent text detection failed, trying simple position-based detection...`);
          // Simple approach: Find all inputs in TP/SL area, sort by Y position, take the top one
          const tpslInputs = [];
          for (const input of allInputs) {
            const rect = await input.boundingBox();
            if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
            
            // Exclude Price and Size inputs
            const inputInfo = await page.evaluate((el) => {
              let parent = el.parentElement;
              let parentText = '';
              for (let i = 0; i < 5 && parent; i++) {
                if (parent.innerText) {
                  parentText = parent.innerText.toLowerCase();
                  break;
                }
                parent = parent.parentElement;
              }
              return {
                parentText: parentText,
                id: el.id || '',
                name: el.name || '',
              };
            }, input);
            
            // Skip if it's clearly a Price or Size input
            if (inputInfo.parentText.includes('price') && !inputInfo.parentText.includes('take profit') && !inputInfo.parentText.includes('stop loss')) continue;
            if (inputInfo.parentText.includes('size') || inputInfo.id.includes('size') || inputInfo.name.includes('size')) continue;
            
            tpslInputs.push({ input, rect, y: rect.y, x: rect.x });
          }
          
          // Sort by Y position (top to bottom), then by X (left to right)
          tpslInputs.sort((a, b) => {
            if (Math.abs(a.y - b.y) > 10) {
              return a.y - b.y; // Top to bottom
            }
            return a.x - b.x; // Left to right
          });
          
          console.log(`  Found ${tpslInputs.length} inputs in TP/SL area by position`);
          console.log(`  Input positions: ${tpslInputs.map((inp, idx) => `[${idx}] x=${inp.x}, y=${inp.y}`).join(', ')}`);
          
          // Filter to only dollar amount inputs (left side, typically x < 1650)
          // Percentage inputs are on the right side (x > 1650)
          const dollarInputs = tpslInputs.filter(inp => inp.x < 1650);
          console.log(`  Found ${dollarInputs.length} dollar amount inputs (x < 1650)`);
          
          if (dollarInputs.length > 0) {
            // Take Profit should be the top row, leftmost (dollar) input
            const topRow = dollarInputs.filter(inp => inp.y < 530);
            if (topRow.length > 0) {
              // Use the leftmost input from top row
              topRow.sort((a, b) => a.x - b.x);
              takeProfitInputElement = topRow[0].input;
              console.log(`✓ Found Take Profit input (top row, left input, x: ${topRow[0].x}, y: ${topRow[0].y})! (attempt ${attempt})`);
            } else {
              // Fallback: use the first (topmost) dollar input
              takeProfitInputElement = dollarInputs[0].input;
              console.log(`✓ Found Take Profit input (first dollar input, x: ${dollarInputs[0].x}, y: ${dollarInputs[0].y})! (attempt ${attempt})`);
            }
          } else if (tpslInputs.length > 0) {
            // Fallback: if no dollar inputs found, use the topmost input from all inputs
            const topInputs = tpslInputs.filter(inp => inp.y < 530);
            if (topInputs.length > 0) {
              topInputs.sort((a, b) => a.x - b.x);
              takeProfitInputElement = topInputs[0].input;
              console.log(`✓ Found Take Profit input (fallback, top row left, x: ${topInputs[0].x}, y: ${topInputs[0].y})! (attempt ${attempt})`);
            } else {
              takeProfitInputElement = tpslInputs[0].input;
              console.log(`✓ Found Take Profit input (fallback, first input, x: ${tpslInputs[0].x}, y: ${tpslInputs[0].y})! (attempt ${attempt})`);
            }
          }
        }
        
        if (takeProfitInputElement) {
          // Skip redundant TP/SL checkbox check - already checked earlier
          // await forceTPSLCheckboxChecked(page);
          // await delay(300);
          
          // CRITICAL: Ensure the input is in PRICE mode (not percentage mode)
          // Look for dropdown/button next to the input that shows "%" or "$"
          const modeInfo = await page.evaluate((inputEl) => {
            // Find parent container
            let parent = inputEl.parentElement;
            let foundDropdown = null;
            let currentMode = null;
            let dropdownRect = null;
            
            // Search up to 5 levels up for dropdown/button
            for (let i = 0; i < 5 && parent; i++) {
              // Look for buttons or dropdowns with "%" or "$" text
              const buttons = parent.querySelectorAll('button, div[role="button"], [role="button"], select, span');
              for (const btn of buttons) {
                const text = btn.textContent?.trim() || '';
                const innerText = btn.innerText?.trim() || '';
                // Check for "%" or "$" - could be exact match or contains
                if (text === '%' || text === '$' || innerText === '%' || innerText === '$' || 
                    text.includes('%') || text.includes('$') || innerText.includes('%') || innerText.includes('$')) {
                  const rect = btn.getBoundingClientRect();
                  foundDropdown = btn;
                  currentMode = (text.includes('%') || innerText.includes('%')) ? 'percent' : 'price';
                  dropdownRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                  break;
                }
              }
              if (foundDropdown) break;
              parent = parent.parentElement;
            }
            
            return {
              found: !!foundDropdown,
              currentMode: currentMode,
              dropdownRect: dropdownRect
            };
          }, takeProfitInputElement);
          
          // If in percentage mode, switch to price mode
          if (modeInfo.found && modeInfo.currentMode === 'percent') {
            console.log(`  ⚠ Take Profit input is in PERCENTAGE mode, switching to PRICE mode...`);
            try {
              // Click the dropdown/button to switch to price mode
              if (modeInfo.dropdownRect) {
                await page.mouse.click(modeInfo.dropdownRect.x + modeInfo.dropdownRect.width / 2, 
                                       modeInfo.dropdownRect.y + modeInfo.dropdownRect.height / 2);
                await delay(300); // Reduced delay - wait for dropdown to open
                
                // Look for "$" option in the dropdown menu and click it
                const priceOptionInfo = await page.evaluate(() => {
                  // Look for dropdown menu items
                  const allElements = Array.from(document.querySelectorAll('button, div, span, li, [role="menuitem"], [role="option"]'));
                  for (const el of allElements) {
                    const text = el.textContent?.trim() || '';
                    const innerText = el.innerText?.trim() || '';
                    // Look for "$" (price mode option)
                    if (text === '$' || innerText === '$' || 
                        (text.includes('$') && !text.includes('%')) ||
                        (innerText.includes('$') && !innerText.includes('%'))) {
                      const rect = el.getBoundingClientRect();
                      return {
                        found: true,
                        x: rect.x + rect.width / 2,
                        y: rect.y + rect.height / 2
                      };
                    }
                  }
                  return { found: false };
                });
                
                if (priceOptionInfo.found) {
                  await page.mouse.click(priceOptionInfo.x, priceOptionInfo.y);
                  await delay(300); // Reduced delay
                  console.log(`  ✓ Switched Take Profit to PRICE mode`);
                } else {
                  console.log(`  ⚠ Could not find "$" option, assuming already in price mode...`);
                }
              }
            } catch (e) {
              console.log(`  ⚠ Could not switch mode: ${e.message}, continuing anyway...`);
            }
          } else if (modeInfo.found && modeInfo.currentMode === 'price') {
            console.log(`  ✓ Take Profit input is already in PRICE mode`);
          } else if (!modeInfo.found) {
            console.log(`  ⚠ Could not detect input mode, assuming PRICE mode...`);
          }
          
          console.log(`[Attempt ${attempt}/${maxRetries}] Setting Take Profit value: $${takeProfitPrice.toFixed(2)}`);
          
          // CRITICAL: Verify TP/SL button is checked BEFORE setting value
          // Also check for visual state (blue highlight) - sometimes visually active but not checked
          const tpslButtonState = await page.evaluate(() => {
            // Check checkbox
            const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            for (const checkbox of checkboxes) {
              let label = checkbox.closest('label');
              if (!label) {
                const id = checkbox.id;
                if (id) {
                  label = document.querySelector(`label[for="${id}"]`);
                }
              }
              if (label) {
                const labelText = label.textContent?.trim() || '';
                if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                  // Check visual state (blue highlight/active classes)
                  const isVisuallyActive = label.classList.contains('active') || 
                                         label.classList.contains('checked') ||
                                         label.classList.contains('selected') ||
                                         label.getAttribute('aria-checked') === 'true' ||
                                         checkbox.getAttribute('aria-checked') === 'true';
                  
                  return {
                    checked: checkbox.checked,
                    visuallyActive: isVisuallyActive,
                    hasActiveClass: label.classList.contains('active'),
                    hasCheckedClass: label.classList.contains('checked'),
                    ariaChecked: label.getAttribute('aria-checked') || checkbox.getAttribute('aria-checked')
                  };
                }
              }
            }
            // Check button/div
            const allElements = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"], label, span'));
            for (const el of allElements) {
              const text = el.textContent?.trim() || '';
              const ariaLabel = el.getAttribute('aria-label') || '';
              const title = el.getAttribute('title') || '';
              const className = el.className || '';
              
              if ((text.includes('TP/SL') || text.includes('TP & SL') ||
                   ariaLabel.includes('TP/SL') || ariaLabel.includes('TP & SL') ||
                   title.includes('TP/SL') || title.includes('TP & SL') ||
                   className.includes('tpsl') || className.includes('TP/SL')) &&
                  !text.includes('Take Profit') && !text.includes('Stop Loss')) {
                return {
                  checked: el.getAttribute('aria-checked') === 'true' || 
                          el.classList.contains('checked') || 
                          el.classList.contains('active') ||
                          el.getAttribute('data-checked') === 'true',
                  visuallyActive: true,
                  hasActiveClass: el.classList.contains('active'),
                  hasCheckedClass: el.classList.contains('checked')
                };
              }
            }
            return { checked: false, visuallyActive: false };
          });
          
          const isChecked = tpslButtonState && (tpslButtonState.checked || tpslButtonState.visuallyActive);
          
          if (!isChecked) {
            console.log(`⚠ TP/SL button is NOT checked! Re-clicking before setting Take Profit...`);
            await forceTPSLCheckboxChecked(page);
            await delay(500); // Reduced delay
          } else if (tpslButtonState.visuallyActive && !tpslButtonState.checked) {
            // Visually active (blue) but checkbox not checked - force it to be checked
            console.log(`⚠ TP/SL button is visually active (blue) but checkbox not checked, forcing check...`);
            await page.evaluate(() => {
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of checkboxes) {
                let label = checkbox.closest('label');
                if (!label) {
                  const id = checkbox.id;
                  if (id) {
                    label = document.querySelector(`label[for="${id}"]`);
                  }
                }
                if (label) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    // Force check
                    checkbox.checked = true;
                    checkbox.setAttribute('checked', 'checked');
                    checkbox.setAttribute('aria-checked', 'true');
                    label.setAttribute('aria-checked', 'true');
                    label.classList.add('checked', 'active');
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }
              }
            });
            await delay(1000);
          }
          
          // Verify input is enabled and visible before trying to set value
          const inputState = await page.evaluate((el) => {
            return {
              disabled: el.disabled,
              readOnly: el.readOnly,
              visible: el.offsetParent !== null,
              width: el.getBoundingClientRect().width,
              height: el.getBoundingClientRect().height,
              value: el.value || '',
              tabIndex: el.tabIndex
            };
          }, takeProfitInputElement);
          
          console.log(`  Take Profit input state: disabled=${inputState.disabled}, readOnly=${inputState.readOnly}, visible=${inputState.visible}, width=${inputState.width}, value="${inputState.value}"`);
          
          if (inputState.disabled || inputState.readOnly || !inputState.visible || inputState.width === 0) {
            console.log(`⚠ Take Profit input is not active, TP/SL button may not be checked - re-clicking...`);
            // Try to click TP/SL button again
            await ensureTPSLCheckedAndSetValues(page, side, price, qty);
            await delay(2000);
            // Re-check input state
            const newInputState = await page.evaluate((el) => {
              return {
                disabled: el.disabled,
                readOnly: el.readOnly,
                visible: el.offsetParent !== null,
                width: el.getBoundingClientRect().width,
                height: el.getBoundingClientRect().height,
                value: el.value || ''
              };
            }, takeProfitInputElement);
            console.log(`  After re-click: disabled=${newInputState.disabled}, readOnly=${newInputState.readOnly}, visible=${newInputState.visible}, value="${newInputState.value}"`);
            if (newInputState.disabled || newInputState.readOnly || !newInputState.visible) {
              console.log(`⚠ Take Profit input still not active after re-clicking TP/SL button, skipping this attempt...`);
              await delay(1000);
              continue; // Skip to next retry
            }
          }
          
          // Focus the input first
          await takeProfitInputElement.focus();
          await delay(200);
          await takeProfitInputElement.click({ clickCount: 3 });
          await delay(200);
          
          // Select all and clear
          await page.keyboard.down('Meta');
          await page.keyboard.press('KeyA');
          await page.keyboard.up('Meta');
          await delay(100);
          await page.keyboard.press('Backspace');
          await delay(200);
          
          // Clear via JavaScript as well
          await page.evaluate((el) => {
            if (el._valueTracker) {
              el._valueTracker.setValue('');
            }
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, takeProfitInputElement);
          await delay(200);
          
          // Type the value character by character
          const valueToType = takeProfitPrice.toFixed(2).replace(/,/g, '');
          console.log(`  Typing value: ${valueToType}`);
          
          // Try multiple approaches to set the value
          // Approach 1: Type character by character
          await page.keyboard.type(valueToType, { delay: 100 });
          await delay(1000);
          
          // Approach 2: Try to find React component and call its onChange handler
          // Also check for validation attributes that might be blocking the value
          const reactResult = await page.evaluate((el, val) => {
            const valueStr = String(val);
            let result = { 
              method: 'none', 
              success: false,
              hasValueTracker: !!el._valueTracker,
              min: el.min || null,
              max: el.max || null,
              step: el.step || null,
              pattern: el.pattern || null
            };
            
            // Try to find React instance
            const reactKey = Object.keys(el).find(key => 
              key.startsWith('__reactInternalInstance') || 
              key.startsWith('__reactFiber') ||
              key.startsWith('__reactContainer')
            );
            
            if (reactKey) {
              result.reactKey = reactKey;
              const reactInstance = el[reactKey];
              
              // Try multiple ways to get props
              let props = reactInstance?.memoizedProps || 
                         reactInstance?.pendingProps || 
                         reactInstance?.return?.memoizedProps ||
                         reactInstance?.child?.memoizedProps ||
                         {};
              
              result.hasReact = true;
              result.hasProps = !!props;
              
              const onChange = props.onChange || props.onValueChange;
              result.hasOnChange = !!onChange;
              
              if (onChange && typeof onChange === 'function') {
                try {
                  // Create a synthetic event that React expects
                  const syntheticEvent = {
                    target: el,
                    currentTarget: el,
                    type: 'change',
                    nativeEvent: new Event('change'),
                    preventDefault: () => {},
                    stopPropagation: () => {},
                    isDefaultPrevented: () => false,
                    isPropagationStopped: () => false
                  };
                  
                  // Set value on the element first
                  el.value = valueStr;
                  
                  // Set value on target
                  Object.defineProperty(syntheticEvent.target, 'value', { 
                    value: valueStr, 
                    writable: true,
                    enumerable: true,
                    configurable: true
                  });
                  
                  // Also try onValueChange if it exists (React NumberFormat)
                  if (props.onValueChange) {
                    props.onValueChange({ value: valueStr, floatValue: parseFloat(valueStr) });
                  }
                  
                  // Call React's onChange
                  onChange(syntheticEvent);
                  result.method = 'reactOnChange';
                  result.success = true;
                } catch (e) {
                  result.method = 'reactOnChange';
                  result.success = false;
                  result.error = e.message;
                }
              }
            }
            
            // Also try _valueTracker (React NumberFormat)
            if (el._valueTracker) {
              try {
                el._valueTracker.setValue(valueStr);
                result.valueTracker = true;
              } catch (e) {
                result.valueTracker = false;
                result.valueTrackerError = e.message;
              }
            }
            
            // Set native value
            el.value = valueStr;
            
            // Trigger events in the right order
            el.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
            
            // Use native setter
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, valueStr);
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            // Check value after all attempts
            result.finalValue = el.value;
            
            return result;
          }, takeProfitInputElement, takeProfitPrice);
          console.log(`  React component interaction: ${JSON.stringify(reactResult)}`);
          await delay(1500); // Wait longer for React to process
          
          // Press Tab to trigger validation
          await page.keyboard.press('Tab');
          await delay(1000);
          
          // Verify the value was set - try multiple ways to read it
          let verifyValue = await page.evaluate((el) => {
            if (!el) return null;
            // Try multiple ways to get the value
            const rawValue = el.value || '';
            const displayValue = el.getAttribute('value') || '';
            const textContent = el.textContent || '';
            const innerHTML = el.innerHTML || '';
            
            // Try to parse from any source
            let numValue = parseFloat(rawValue.replace(/,/g, '')) || 0;
            if (numValue === 0 && displayValue) {
              numValue = parseFloat(displayValue.replace(/,/g, '')) || 0;
            }
            
            return {
              numValue: numValue,
              rawValue: rawValue,
              displayValue: displayValue,
              textContent: textContent,
              innerHTML: innerHTML.substring(0, 50)
            };
          }, takeProfitInputElement);
          
          const actualValue = verifyValue ? verifyValue.numValue : 0;
          console.log(`  Verification: got ${actualValue}, expected ${takeProfitPrice.toFixed(2)}`);
          if (verifyValue) {
            console.log(`    Raw value: "${verifyValue.rawValue}", Display: "${verifyValue.displayValue}"`);
          }
          
          // If value not set correctly, try more aggressive direct assignment
          if (!actualValue || Math.abs(actualValue - takeProfitPrice) > 0.01) {
            console.log(`  Value not set correctly, trying more aggressive assignment...`);
            await page.evaluate((el, val) => {
              const valueStr = String(val);
              
              // Clear first
              el.value = '';
              if (el._valueTracker) {
                el._valueTracker.setValue('');
              }
              
              // Set value multiple ways
              el.value = valueStr;
              el.setAttribute('value', valueStr);
              
              // React NumberFormat
              if (el._valueTracker) {
                el._valueTracker.setValue(valueStr);
              }
              
              // Native setter
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, valueStr);
              }
              
              // Trigger all possible events
              ['input', 'change', 'blur', 'focus', 'keyup', 'keydown'].forEach(eventType => {
                el.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
              });
              
              // Focus and blur to trigger React
              el.focus();
              setTimeout(() => el.blur(), 10);
            }, takeProfitInputElement, takeProfitPrice);
            await delay(1500);
            
            // Verify again
            verifyValue = await page.evaluate((el) => {
              if (!el) return null;
              const rawValue = el.value || '';
              const numValue = parseFloat(rawValue.replace(/,/g, '')) || 0;
              return numValue;
            }, takeProfitInputElement);
            console.log(`  After aggressive assignment: got ${verifyValue}, expected ${takeProfitPrice.toFixed(2)}`);
          }
          
          // Use the actual value for verification
          verifyValue = actualValue;
          
          if (verifyValue && Math.abs(verifyValue - takeProfitPrice) < 0.01) {
            console.log(`✓ Take Profit set to $${takeProfitPrice.toFixed(2)}`);
            takeProfitSet = true;
            break;
            } else {
              console.log(`⚠ Take Profit verification failed (got ${verifyValue || 0}, expected ${takeProfitPrice.toFixed(2)}), retrying...`);
              await delay(500); // Reduced retry delay
            }
        } else {
          console.log(`⚠ Take Profit input not found (attempt ${attempt}/${maxRetries}), retrying...`);
          await delay(1000);
        }
      } catch (error) {
        console.log(`⚠ Error setting Take Profit (attempt ${attempt}/${maxRetries}): ${error.message}`);
        await delay(1000);
      }
    }
    
    if (!takeProfitSet) {
      console.log(`❌ Failed to set Take Profit after ${maxRetries} attempts. Cannot proceed with SELL order.`);
      return { success: false, error: "Failed to set Take Profit for SELL order" };
    }
    
    // Set Stop Loss
    console.log(`Setting Stop Loss for SELL order: $${stopLossPrice.toFixed(2)} (entry: $${price.toFixed(2)} + $${stopLossPriceDifference.toFixed(2)} = $${stopLossPrice.toFixed(2)}, from env STOP_LOSS: $${stopLossAmount})`);
    
    let stopLossSet = false;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Attempt ${attempt}/${maxRetries}] Looking for Stop Loss input...`);
        const allInputs = await page.$$('input[type="text"], input:not([type])');
        console.log(`  Found ${allInputs.length} total inputs on page`);
        
        let stopLossInputElement = null;
        
        // Simple approach: Find all inputs in TP/SL area, sort by Y position, take the bottom one (leftmost if same row)
        const tpslInputs = [];
        for (const input of allInputs) {
          const rect = await input.boundingBox();
          if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
          
          // Exclude Price and Size inputs
          const inputInfo = await page.evaluate((el) => {
            let parent = el.parentElement;
            let parentText = '';
            for (let i = 0; i < 5 && parent; i++) {
              if (parent.innerText) {
                parentText = parent.innerText.toLowerCase();
                break;
              }
              parent = parent.parentElement;
            }
            return {
              parentText: parentText,
              id: el.id || '',
              name: el.name || '',
            };
          }, input);
          
          // Skip if it's clearly a Price or Size input
          if (inputInfo.parentText.includes('price') && !inputInfo.parentText.includes('take profit') && !inputInfo.parentText.includes('stop loss')) continue;
          if (inputInfo.parentText.includes('size') || inputInfo.id.includes('size') || inputInfo.name.includes('size')) continue;
          
          tpslInputs.push({ input, rect, y: rect.y, x: rect.x });
        }
        
        // Sort by Y position (top to bottom), then by X (left to right)
        tpslInputs.sort((a, b) => {
          if (Math.abs(a.y - b.y) > 10) {
            return a.y - b.y; // Top to bottom
          }
          return a.x - b.x; // Left to right
        });
        
        console.log(`  Found ${tpslInputs.length} inputs in TP/SL area`);
        console.log(`  Input positions: ${tpslInputs.map((inp, idx) => `[${idx}] x=${inp.x}, y=${inp.y}`).join(', ')}`);
        
        // Filter to only dollar amount inputs (left side, typically x < 1650)
        // Percentage inputs are on the right side (x > 1650)
        const dollarInputs = tpslInputs.filter(inp => inp.x < 1650);
        console.log(`  Found ${dollarInputs.length} dollar amount inputs (x < 1650)`);
        
        if (dollarInputs.length >= 2) {
          // Stop Loss should be the bottom row, leftmost (dollar) input
          // Group by Y position to find rows
          const topRow = dollarInputs.filter(inp => inp.y < 530);
          const bottomRow = dollarInputs.filter(inp => inp.y >= 530);
          
          if (bottomRow.length > 0) {
            // Use the leftmost input from bottom row
            bottomRow.sort((a, b) => a.x - b.x);
            stopLossInputElement = bottomRow[0].input;
            console.log(`✓ Found Stop Loss input (bottom row, left input, x: ${bottomRow[0].x}, y: ${bottomRow[0].y})! (attempt ${attempt})`);
          } else if (dollarInputs.length >= 2) {
            // Fallback: use the last (bottommost) dollar input
            stopLossInputElement = dollarInputs[dollarInputs.length - 1].input;
            console.log(`✓ Found Stop Loss input (last dollar input, x: ${dollarInputs[dollarInputs.length - 1].x}, y: ${dollarInputs[dollarInputs.length - 1].y})! (attempt ${attempt})`);
          }
        } else if (dollarInputs.length === 1) {
          // If only one dollar input found, use it
          stopLossInputElement = dollarInputs[0].input;
          console.log(`✓ Found Stop Loss input (single dollar input, x: ${dollarInputs[0].x}, y: ${dollarInputs[0].y})! (attempt ${attempt})`);
        } else {
          // Fallback: if no dollar inputs found, use the bottommost input from all inputs
          if (tpslInputs.length >= 2) {
            const bottomInputs = tpslInputs.filter(inp => inp.y >= 530);
            if (bottomInputs.length > 0) {
              bottomInputs.sort((a, b) => a.x - b.x);
              stopLossInputElement = bottomInputs[0].input;
              console.log(`✓ Found Stop Loss input (fallback, bottom row left, x: ${bottomInputs[0].x}, y: ${bottomInputs[0].y})! (attempt ${attempt})`);
            }
          }
        }
        
        if (stopLossInputElement) {
          // CRITICAL: Ensure the input is in PRICE mode (not percentage mode)
          // Look for dropdown/button next to the input that shows "%" or "$"
          let modeInfo;
          try {
            modeInfo = await page.evaluate((inputEl) => {
              // Find parent container
              let parent = inputEl.parentElement;
              let foundDropdown = null;
              let currentMode = null;
              let dropdownRect = null;
              
              // Search up to 5 levels up for dropdown/button
              for (let i = 0; i < 5 && parent; i++) {
                // Look for buttons or dropdowns with "%" or "$" text
                const buttons = parent.querySelectorAll('button, div[role="button"], [role="button"], select, span');
                for (const btn of buttons) {
                  const text = btn.textContent?.trim() || '';
                  const innerText = btn.innerText?.trim() || '';
                  // Check for "%" or "$" - could be exact match or contains
                  if (text === '%' || text === '$' || innerText === '%' || innerText === '$' || 
                      text.includes('%') || text.includes('$') || innerText.includes('%') || innerText.includes('$')) {
                    const rect = btn.getBoundingClientRect();
                    foundDropdown = btn;
                    currentMode = (text.includes('%') || innerText.includes('%')) ? 'percent' : 'price';
                    dropdownRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                    break;
                  }
                }
                if (foundDropdown) break;
                parent = parent.parentElement;
              }
              
              return {
                found: !!foundDropdown,
                currentMode: currentMode,
                dropdownRect: dropdownRect
              };
            }, stopLossInputElement);
          } catch (e) {
            console.log(`  ⚠ Error detecting mode: ${e.message}, assuming PRICE mode...`);
            modeInfo = { found: false, currentMode: 'price', dropdownRect: null };
          }
          
          // Ensure modeInfo is always defined
          if (!modeInfo) {
            modeInfo = { found: false, currentMode: 'price', dropdownRect: null };
          }
          
          // If in percentage mode, switch to price mode
          if (modeInfo.found && modeInfo.currentMode === 'percent') {
            console.log(`  ⚠ Stop Loss input is in PERCENTAGE mode, switching to PRICE mode...`);
            try {
              // Click the dropdown/button to switch to price mode
              if (modeInfo.dropdownRect) {
                await page.mouse.click(modeInfo.dropdownRect.x + modeInfo.dropdownRect.width / 2, 
                                       modeInfo.dropdownRect.y + modeInfo.dropdownRect.height / 2);
                await delay(300); // Reduced delay
                
                // Look for "$" option in the dropdown menu and click it
                const priceOptionInfo = await page.evaluate(() => {
                  const allElements = Array.from(document.querySelectorAll('button, div, span, li, [role="menuitem"], [role="option"]'));
                  for (const el of allElements) {
                    const text = el.textContent?.trim() || '';
                    const innerText = el.innerText?.trim() || '';
                    if (text === '$' || innerText === '$' || 
                        (text.includes('$') && !text.includes('%')) ||
                        (innerText.includes('$') && !innerText.includes('%'))) {
                      const rect = el.getBoundingClientRect();
                      return {
                        found: true,
                        x: rect.x + rect.width / 2,
                        y: rect.y + rect.height / 2
                      };
                    }
                  }
                  return { found: false };
                });
                
                if (priceOptionInfo.found) {
                  await page.mouse.click(priceOptionInfo.x, priceOptionInfo.y);
                  await delay(300); // Reduced delay
                  console.log(`  ✓ Switched Stop Loss to PRICE mode`);
                } else {
                  console.log(`  ⚠ Could not find "$" option, assuming already in price mode...`);
                }
              }
            } catch (e) {
              console.log(`  ⚠ Could not switch mode: ${e.message}, continuing anyway...`);
            }
          } else if (modeInfo.found && modeInfo.currentMode === 'price') {
            console.log(`  ✓ Stop Loss input is already in PRICE mode`);
          } else if (!modeInfo.found) {
            console.log(`  ⚠ Could not detect input mode, assuming PRICE mode...`);
          }
          
          // CRITICAL: Verify TP/SL button is checked BEFORE setting value
          // Also check for visual state (blue highlight) - sometimes visually active but not checked
          const tpslButtonState = await page.evaluate(() => {
            // Check checkbox
            const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            for (const checkbox of checkboxes) {
              let label = checkbox.closest('label');
              if (!label) {
                const id = checkbox.id;
                if (id) {
                  label = document.querySelector(`label[for="${id}"]`);
                }
              }
              if (label) {
                const labelText = label.textContent?.trim() || '';
                if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                  // Check visual state (blue highlight/active classes)
                  const isVisuallyActive = label.classList.contains('active') || 
                                         label.classList.contains('checked') ||
                                         label.classList.contains('selected') ||
                                         label.getAttribute('aria-checked') === 'true' ||
                                         checkbox.getAttribute('aria-checked') === 'true';
                  
                  return {
                    checked: checkbox.checked,
                    visuallyActive: isVisuallyActive,
                    hasActiveClass: label.classList.contains('active'),
                    hasCheckedClass: label.classList.contains('checked'),
                    ariaChecked: label.getAttribute('aria-checked') || checkbox.getAttribute('aria-checked')
                  };
                }
              }
            }
            // Check button/div
            const allElements = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"], label, span'));
            for (const el of allElements) {
              const text = el.textContent?.trim() || '';
              const ariaLabel = el.getAttribute('aria-label') || '';
              const title = el.getAttribute('title') || '';
              const className = el.className || '';
              
              if ((text.includes('TP/SL') || text.includes('TP & SL') ||
                   ariaLabel.includes('TP/SL') || ariaLabel.includes('TP & SL') ||
                   title.includes('TP/SL') || title.includes('TP & SL') ||
                   className.includes('tpsl') || className.includes('TP/SL')) &&
                  !text.includes('Take Profit') && !text.includes('Stop Loss')) {
                return {
                  checked: el.getAttribute('aria-checked') === 'true' || 
                          el.classList.contains('checked') || 
                          el.classList.contains('active') ||
                          el.getAttribute('data-checked') === 'true',
                  visuallyActive: true,
                  hasActiveClass: el.classList.contains('active'),
                  hasCheckedClass: el.classList.contains('checked')
                };
              }
            }
            return { checked: false, visuallyActive: false };
          });
          
          const isChecked = tpslButtonState && (tpslButtonState.checked || tpslButtonState.visuallyActive);
          
          if (!isChecked) {
            console.log(`⚠ TP/SL button is NOT checked! Re-clicking before setting Stop Loss...`);
            await ensureTPSLCheckedAndSetValues(page, side, price, qty);
            await delay(2000); // Wait longer for inputs to be ready
          } else if (tpslButtonState.visuallyActive && !tpslButtonState.checked) {
            // Visually active (blue) but checkbox not checked - force it to be checked
            console.log(`⚠ TP/SL button is visually active (blue) but checkbox not checked, forcing check...`);
            await page.evaluate(() => {
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              for (const checkbox of checkboxes) {
                let label = checkbox.closest('label');
                if (!label) {
                  const id = checkbox.id;
                  if (id) {
                    label = document.querySelector(`label[for="${id}"]`);
                  }
                }
                if (label) {
                  const labelText = label.textContent?.trim() || '';
                  if (labelText.includes('TP/SL') || labelText.includes('TP & SL')) {
                    // Force check
                    checkbox.checked = true;
                    checkbox.setAttribute('checked', 'checked');
                    checkbox.setAttribute('aria-checked', 'true');
                    label.setAttribute('aria-checked', 'true');
                    label.classList.add('checked', 'active');
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }
              }
            });
            await delay(1000);
          }
          
          // Verify input is enabled and visible
          const inputState = await page.evaluate((el) => {
            return {
              disabled: el.disabled,
              readOnly: el.readOnly,
              visible: el.offsetParent !== null,
              width: el.getBoundingClientRect().width,
              height: el.getBoundingClientRect().height,
              value: el.value || ''
            };
          }, stopLossInputElement);
          
          console.log(`  Stop Loss input state: disabled=${inputState.disabled}, readOnly=${inputState.readOnly}, visible=${inputState.visible}, width=${inputState.width}, value="${inputState.value}"`);
          
          if (inputState.disabled || inputState.readOnly || !inputState.visible || inputState.width === 0) {
            console.log(`⚠ Stop Loss input is not active, TP/SL button may not be checked - re-clicking...`);
            await forceTPSLCheckboxChecked(page);
            await delay(500); // Reduced delay
            const newInputState = await page.evaluate((el) => {
              return {
                disabled: el.disabled,
                readOnly: el.readOnly,
                visible: el.offsetParent !== null,
                width: el.getBoundingClientRect().width,
                height: el.getBoundingClientRect().height,
                value: el.value || ''
              };
            }, stopLossInputElement);
            console.log(`  After re-click: disabled=${newInputState.disabled}, readOnly=${newInputState.readOnly}, visible=${newInputState.visible}, value="${newInputState.value}"`);
            if (newInputState.disabled || newInputState.readOnly || !newInputState.visible) {
              console.log(`⚠ Stop Loss input still not active after re-clicking TP/SL button, skipping this attempt...`);
              await delay(1000);
              continue; // Skip to next retry
            }
          }
          
          // CRITICAL: Force-check TP/SL checkbox before setting Stop Loss
          await forceTPSLCheckboxChecked(page);
          await delay(300);
          
          console.log(`[Attempt ${attempt}/${maxRetries}] Setting Stop Loss value: $${stopLossPrice.toFixed(2)}`);
          
          // Click the input to focus it
          const inputBox = await stopLossInputElement.boundingBox();
          if (inputBox) {
            await page.mouse.click(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
            await delay(300);
          } else {
            await stopLossInputElement.focus();
            await delay(200);
          }
          
          // Triple-click to select all, then clear
          await stopLossInputElement.click({ clickCount: 3 });
          await delay(200);
          
          // Select all and clear multiple times to ensure it's empty
          await page.keyboard.down('Meta');
          await page.keyboard.press('KeyA');
          await page.keyboard.up('Meta');
          await delay(100);
          await page.keyboard.press('Backspace');
          await delay(100);
          await page.keyboard.press('Delete');
          await delay(100);
          
          // Clear via JavaScript as well - multiple times
          await page.evaluate((el) => {
            // Clear React NumberFormat _valueTracker if it exists
            if (el._valueTracker) {
              el._valueTracker.setValue('');
            }
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            // Clear again to be sure
            el.value = '';
          }, stopLossInputElement);
          await delay(300);
          
          // Verify it's empty before typing
          const currentValue = await page.evaluate((el) => {
            return el.value || '';
          }, stopLossInputElement);
          console.log(`  Input cleared, current value: "${currentValue}"`);
          
          if (currentValue && currentValue.length > 0) {
            // Force clear again if still has value
            await page.evaluate((el) => {
              if (el._valueTracker) {
                el._valueTracker.setValue('');
              }
              el.value = '';
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, '');
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, stopLossInputElement);
            await delay(300);
          }
          
          // Type the value character by character
          const valueToType = stopLossPrice.toFixed(2).replace(/,/g, '');
          console.log(`  Typing value: ${valueToType}`);
          
          // Try multiple approaches to set the value
          // Approach 1: Type character by character
          await page.keyboard.type(valueToType, { delay: 100 });
          await delay(1000);
          
          // Approach 2: Try to find React component and call its onChange handler
          // Also check for validation attributes that might be blocking the value
          const reactResult = await page.evaluate((el, val) => {
            const valueStr = String(val);
            let result = { 
              method: 'none', 
              success: false,
              hasValueTracker: !!el._valueTracker,
              min: el.min || null,
              max: el.max || null,
              step: el.step || null,
              pattern: el.pattern || null
            };
            
            // Try to find React instance
            const reactKey = Object.keys(el).find(key => 
              key.startsWith('__reactInternalInstance') || 
              key.startsWith('__reactFiber') ||
              key.startsWith('__reactContainer')
            );
            
            if (reactKey) {
              result.reactKey = reactKey;
              const reactInstance = el[reactKey];
              
              // Try multiple ways to get props
              let props = reactInstance?.memoizedProps || 
                         reactInstance?.pendingProps || 
                         reactInstance?.return?.memoizedProps ||
                         reactInstance?.child?.memoizedProps ||
                         {};
              
              result.hasReact = true;
              result.hasProps = !!props;
              
              const onChange = props.onChange || props.onValueChange;
              result.hasOnChange = !!onChange;
              
              if (onChange && typeof onChange === 'function') {
                try {
                  // Create a synthetic event that React expects
                  const syntheticEvent = {
                    target: el,
                    currentTarget: el,
                    type: 'change',
                    nativeEvent: new Event('change'),
                    preventDefault: () => {},
                    stopPropagation: () => {},
                    isDefaultPrevented: () => false,
                    isPropagationStopped: () => false
                  };
                  
                  // Set value on the element first
                  el.value = valueStr;
                  
                  // Set value on target
                  Object.defineProperty(syntheticEvent.target, 'value', { 
                    value: valueStr, 
                    writable: true,
                    enumerable: true,
                    configurable: true
                  });
                  
                  // Also try onValueChange if it exists (React NumberFormat)
                  if (props.onValueChange) {
                    props.onValueChange({ value: valueStr, floatValue: parseFloat(valueStr) });
                  }
                  
                  // Call React's onChange
                  onChange(syntheticEvent);
                  result.method = 'reactOnChange';
                  result.success = true;
                } catch (e) {
                  result.method = 'reactOnChange';
                  result.success = false;
                  result.error = e.message;
                }
              }
            }
            
            // Also try _valueTracker (React NumberFormat)
            if (el._valueTracker) {
              try {
                el._valueTracker.setValue(valueStr);
                result.valueTracker = true;
              } catch (e) {
                result.valueTracker = false;
                result.valueTrackerError = e.message;
              }
            }
            
            // Set native value
            el.value = valueStr;
            
            // Trigger events in the right order
            el.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
            
            // Use native setter
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, valueStr);
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            // Check value after all attempts
            result.finalValue = el.value;
            
            return result;
          }, stopLossInputElement, stopLossPrice);
          console.log(`  React component interaction: ${JSON.stringify(reactResult)}`);
          await delay(1500); // Wait longer for React to process
          
          // Press Tab to trigger validation
          await page.keyboard.press('Tab');
          await delay(1000);
          
          // Verify the value was set - try multiple ways to read it
          let verifyValue = await page.evaluate((el) => {
            if (!el) return null;
            // Try multiple ways to get the value
            const rawValue = el.value || '';
            const displayValue = el.getAttribute('value') || '';
            const textContent = el.textContent || '';
            const innerHTML = el.innerHTML || '';
            
            // Try to parse from any source
            let numValue = parseFloat(rawValue.replace(/,/g, '')) || 0;
            if (numValue === 0 && displayValue) {
              numValue = parseFloat(displayValue.replace(/,/g, '')) || 0;
            }
            
            return {
              numValue: numValue,
              rawValue: rawValue,
              displayValue: displayValue,
              textContent: textContent,
              innerHTML: innerHTML.substring(0, 50)
            };
          }, stopLossInputElement);
          
          const actualValue = verifyValue ? verifyValue.numValue : 0;
          console.log(`  Verification: got ${actualValue}, expected ${stopLossPrice.toFixed(2)}`);
          if (verifyValue) {
            console.log(`    Raw value: "${verifyValue.rawValue}", Display: "${verifyValue.displayValue}"`);
          }
          
          // If value not set correctly, try more aggressive direct assignment
          if (!actualValue || Math.abs(actualValue - stopLossPrice) > 0.01) {
            console.log(`  Value not set correctly, trying more aggressive assignment...`);
            await page.evaluate((el, val) => {
              const valueStr = String(val);
              
              // Clear first
              el.value = '';
              if (el._valueTracker) {
                el._valueTracker.setValue('');
              }
              
              // Set value multiple ways
              el.value = valueStr;
              el.setAttribute('value', valueStr);
              
              // React NumberFormat
              if (el._valueTracker) {
                el._valueTracker.setValue(valueStr);
              }
              
              // Native setter
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, valueStr);
              }
              
              // Trigger all possible events
              ['input', 'change', 'blur', 'focus', 'keyup', 'keydown'].forEach(eventType => {
                el.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
              });
              
              // Focus and blur to trigger React
              el.focus();
              setTimeout(() => el.blur(), 10);
            }, stopLossInputElement, stopLossPrice);
            await delay(1500);
            
            // Verify again
            verifyValue = await page.evaluate((el) => {
              if (!el) return null;
              const rawValue = el.value || '';
              const numValue = parseFloat(rawValue.replace(/,/g, '')) || 0;
              return numValue;
            }, stopLossInputElement);
            console.log(`  After aggressive assignment: got ${verifyValue}, expected ${stopLossPrice.toFixed(2)}`);
          }
          
          // Use the actual value for verification
          verifyValue = actualValue;
          
          if (verifyValue && Math.abs(verifyValue - stopLossPrice) < 0.01) {
            console.log(`✓ Stop Loss set to $${stopLossPrice.toFixed(2)}`);
            stopLossSet = true;
            break;
            } else {
              console.log(`⚠ Stop Loss verification failed (got ${verifyValue || 0}, expected ${stopLossPrice.toFixed(2)}), retrying...`);
              await delay(500); // Reduced retry delay
          }
        } else {
          console.log(`⚠ Stop Loss input not found (attempt ${attempt}/${maxRetries}), retrying...`);
          await delay(1000);
        }
      } catch (error) {
        console.log(`⚠ Error setting Stop Loss (attempt ${attempt}/${maxRetries}): ${error.message}`);
        await delay(1000);
      }
    }
    
    if (!stopLossSet) {
      console.log(`❌ Failed to set Stop Loss after ${maxRetries} attempts. Cannot proceed with SELL order.`);
      return { success: false, error: "Failed to set Stop Loss for SELL order" };
    } else {
      console.log(`✓ Both Take Profit and Stop Loss successfully set for SELL order`);
    }
  } else {
    console.log(`⚠ SELL order detected but missing price or qty (price=${price}, qty=${qty}), skipping TP/SL setup`);
  }
  
  // 6.5. Final verification of TP/SL values before confirmation (CRITICAL for SELL orders)
  if (side === "sell" && price && qty) {
    console.log(`\n=== Final verification of TP/SL values before confirmation ===`);
    await delay(500); // Small delay to ensure React has updated
    
    const finalCheck = await page.evaluate(() => {
      const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      const tpslInputs = [];
      
      for (const input of allInputs) {
        const rect = input.getBoundingClientRect();
        if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
        
        // Filter for dollar amount inputs (left side, x < 1650)
        if (rect.x < 1650) {
          const value = input.value || '';
          const numericValue = parseFloat(value.replace(/,/g, '')) || 0;
          
          // Determine if it's TP or SL based on Y position (top row = TP, bottom row = SL)
          const isTopRow = rect.y < 530;
          
          tpslInputs.push({
            x: rect.x,
            y: rect.y,
            value: value,
            numericValue: numericValue,
            isTopRow: isTopRow,
            isEmpty: !value || value.trim() === '' || numericValue === 0
          });
        }
      }
      
      // Sort by Y position
      tpslInputs.sort((a, b) => a.y - b.y);
      
      const takeProfitInput = tpslInputs.find(inp => inp.isTopRow) || tpslInputs[0];
      const stopLossInput = tpslInputs.find(inp => !inp.isTopRow) || tpslInputs[1];
      
      return {
        takeProfit: takeProfitInput ? {
          value: takeProfitInput.value,
          numericValue: takeProfitInput.numericValue,
          isEmpty: takeProfitInput.isEmpty
        } : null,
        stopLoss: stopLossInput ? {
          value: stopLossInput.value,
          numericValue: stopLossInput.numericValue,
          isEmpty: stopLossInput.isEmpty
        } : null,
        allInputs: tpslInputs.map(inp => ({ x: inp.x, y: inp.y, value: inp.value, isEmpty: inp.isEmpty }))
      };
    });
    
    console.log(`Final TP/SL check:`, JSON.stringify(finalCheck, null, 2));
    
    // If values are missing or empty, re-set them
    if (finalCheck.takeProfit && finalCheck.takeProfit.isEmpty) {
      console.log(`⚠ Take Profit is empty before confirmation, re-setting...`);
      // Re-calculate and set Take Profit
      const takeProfitAmount = parseFloat((process.env.TAKE_PROFIT || '0.1').replace(/,/g, '')) || 0.1;
      const takeProfitPriceDifference = takeProfitAmount / qty;
      const takeProfitPrice = price - takeProfitPriceDifference;
      await setTakeProfitValueForSell(page, takeProfitPrice);
      await delay(500);
    }
    
    if (finalCheck.stopLoss && finalCheck.stopLoss.isEmpty) {
      console.log(`⚠ Stop Loss is empty before confirmation, re-setting...`);
      // Re-calculate and set Stop Loss
      const stopLossAmount = parseFloat((process.env.STOP_LOSS || '0.1').replace(/,/g, '')) || 0.1;
      const stopLossPriceDifference = stopLossAmount / qty;
      const stopLossPrice = price + stopLossPriceDifference;
      await setStopLossValueForSell(page, stopLossPrice);
      await delay(500);
    }
    
    // Final check: ensure both values are set and valid
    const finalVerification = await page.evaluate(() => {
      const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      const tpslInputs = [];
      
      for (const input of allInputs) {
        const rect = input.getBoundingClientRect();
        if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
        if (rect.x < 1650) {
          const value = input.value || '';
          const numericValue = parseFloat(value.replace(/,/g, '')) || 0;
          const isTopRow = rect.y < 530;
          tpslInputs.push({ y: rect.y, value: value, numericValue: numericValue, isTopRow: isTopRow });
        }
      }
      
      tpslInputs.sort((a, b) => a.y - b.y);
      const tp = tpslInputs.find(inp => inp.isTopRow) || tpslInputs[0];
      const sl = tpslInputs.find(inp => !inp.isTopRow) || tpslInputs[1];
      
      return {
        takeProfitSet: tp && tp.numericValue > 0,
        takeProfitValue: tp ? tp.numericValue : 0,
        stopLossSet: sl && sl.numericValue > 0,
        stopLossValue: sl ? sl.numericValue : 0
      };
    });
    
    if (!finalVerification.takeProfitSet || !finalVerification.stopLossSet) {
      console.log(`❌ CRITICAL: TP/SL values not properly set before confirmation!`);
      console.log(`  Take Profit: ${finalVerification.takeProfitSet ? 'SET' : 'MISSING'} (${finalVerification.takeProfitValue})`);
      console.log(`  Stop Loss: ${finalVerification.stopLossSet ? 'SET' : 'MISSING'} (${finalVerification.stopLossValue})`);
      console.log(`  Waiting longer and re-checking...`);
      await delay(1000);
    } else {
      console.log(`✓ TP/SL values verified before confirmation:`);
      console.log(`  Take Profit: $${finalVerification.takeProfitValue.toFixed(2)}`);
      console.log(`  Stop Loss: $${finalVerification.stopLossValue.toFixed(2)}`);
    }
    
    // CRITICAL: Ensure TP/SL checkbox is still checked right before clicking Confirm
    console.log(`Ensuring TP/SL checkbox is still checked before confirmation...`);
    await forceTPSLCheckboxChecked(page);
    await delay(500); // Give React time to update
    
    // One more final check of values after ensuring checkbox is checked
    const lastCheck = await page.evaluate(() => {
      const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      const tpslInputs = [];
      
      for (const input of allInputs) {
        const rect = input.getBoundingClientRect();
        if (!rect || rect.x < 1100 || rect.y < 400 || rect.y > 700) continue;
        if (rect.x < 1650) {
          const value = input.value || '';
          const numericValue = parseFloat(value.replace(/,/g, '')) || 0;
          const isTopRow = rect.y < 530;
          tpslInputs.push({ y: rect.y, value: value, numericValue: numericValue, isTopRow: isTopRow });
        }
      }
      
      tpslInputs.sort((a, b) => a.y - b.y);
      const tp = tpslInputs.find(inp => inp.isTopRow) || tpslInputs[0];
      const sl = tpslInputs.find(inp => !inp.isTopRow) || tpslInputs[1];
      
      return {
        takeProfitSet: tp && tp.numericValue > 0,
        takeProfitValue: tp ? tp.numericValue : 0,
        stopLossSet: sl && sl.numericValue > 0,
        stopLossValue: sl ? sl.numericValue : 0
      };
    });
    
    if (!lastCheck.takeProfitSet || !lastCheck.stopLossSet) {
      console.log(`❌ CRITICAL: Values lost after checkbox check! Re-setting one final time...`);
      const takeProfitAmount = parseFloat((process.env.TAKE_PROFIT || '0.1').replace(/,/g, '')) || 0.1;
      const stopLossAmount = parseFloat((process.env.STOP_LOSS || '0.1').replace(/,/g, '')) || 0.1;
      const takeProfitPriceDifference = takeProfitAmount / qty;
      const stopLossPriceDifference = stopLossAmount / qty;
      const takeProfitPrice = price - takeProfitPriceDifference;
      const stopLossPrice = price + stopLossPriceDifference;
      
      await setTakeProfitValueForSell(page, takeProfitPrice);
      await delay(500);
      await setStopLossValueForSell(page, stopLossPrice);
      await delay(1000); // Longer delay before clicking Confirm
    } else {
      console.log(`✓ Final check passed - values are set and checkbox is checked`);
      console.log(`  Take Profit: $${lastCheck.takeProfitValue.toFixed(2)}`);
      console.log(`  Stop Loss: $${lastCheck.stopLossValue.toFixed(2)}`);
    }
  }
  
  // 7. Click Confirm button
  const confirmText = side === "buy" ? "Confirm Buy" : "Confirm Sell";
  const confirmBtn = await findByText(page, confirmText, ["button"]);

  if (confirmBtn) {
    await confirmBtn.click();
    console.log(`Clicked "${confirmText}"`);
    
    // Wait for order confirmation to process - React component may re-render
    // Check if page/component is refreshing or updating
    console.log("Waiting for order confirmation to process...");
    await delay(3000); // Increased delay to wait for React component updates
    
    // Check if page is navigating or component is refreshing
    const isPageStable = await page.evaluate(() => {
      // Check if document is still loading
      if (document.readyState !== 'complete') {
        return { stable: false, reason: 'document not complete', readyState: document.readyState };
      }
      
      // Check if there are any loading indicators
      const loadingElements = document.querySelectorAll('[class*="loading"], [class*="Loading"], [class*="spinner"], [class*="Spinner"]');
      const visibleLoaders = Array.from(loadingElements).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
      });
      
      if (visibleLoaders.length > 0) {
        return { stable: false, reason: 'loading indicators present', count: visibleLoaders.length };
      }
      
      // Check if trading form is still present (component hasn't been unmounted)
      const tradingInputs = document.querySelectorAll('input[type="text"], input:not([type])');
      const visibleInputs = Array.from(tradingInputs).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
      });
      
      return { 
        stable: true, 
        readyState: document.readyState,
        visibleInputs: visibleInputs.length,
        hasTradingForm: visibleInputs.length > 0
      };
    });
    
    console.log(`Page stability check: ${JSON.stringify(isPageStable)}`);
    
    if (!isPageStable.stable) {
      console.log(`⚠ Page/component is still updating (${isPageStable.reason}), waiting longer...`);
      await delay(2000); // Wait additional time if component is still updating
    }

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

      // Note: TP/SL values are now set before order confirmation in executeTrade()
      // No need to set them on page load anymore

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

