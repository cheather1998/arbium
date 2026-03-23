import readline from 'readline';

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

// Prompt user to choose trading mode
// If modeInput is provided (from Electron UI), skip readline prompt
async function chooseTradingMode(modeInput) {
    let mode;
    if (modeInput !== undefined && modeInput !== null) {
      // Programmatic mode (from Electron UI)
      mode = String(modeInput).trim();
    } else {
      // Interactive CLI mode
      console.log(`\n========================================`);
      console.log(`Select Trading Mode:`);
      console.log(`========================================`);
      console.log(`1. Buy from Paradex, Sell from Paradex (Both accounts on Paradex)`);
      console.log(`2. Buy from Paradex, Sell from Extended Exchange`);
      console.log(`3. Multi-Exchange Mode (Kraken, GRVT, Extended)`);
      console.log(`\n--- Option 3: Multi-Exchange Modes ---`);
      console.log(`3. All 3 Exchanges (Kraken, GRVT, Extended)`);
      console.log(`3d. Kraken + GRVT (2 Exchanges)`);
      console.log(`3e. Kraken + Extended (2 Exchanges)`);
      console.log(`3f. GRVT + Extended (2 Exchanges)`);
      console.log(`\n--- Option 3: Testing Modes ---`);
      console.log(`3a. Test Kraken Exchange Only (BUY + SELL)`);
      console.log(`3b. Test GRVT Exchange Only (BUY + SELL)`);
      console.log(`3c. Test Extended Exchange Only (BUY + SELL)`);
      console.log(`========================================\n`);

      const answer = await prompt(`Enter option (1, 2, 3, 3d, 3e, 3f, 3a, 3b, or 3c): `);
      mode = answer.trim();
    }
    
    if (mode === '1') {
      return {
        mode: 1,
        buyExchange: 'paradex',
        sellExchange: 'paradex',
        description: 'Buy from Paradex, Sell from Paradex',
        accountCount: 2
      };
    } else if (mode === '2') {
      return {
        mode: 2,
        buyExchange: 'paradex',
        sellExchange: 'extended',
        description: 'Buy from Paradex, Sell from Extended Exchange',
        accountCount: 2
      };
    } else if (mode === '3') {
      return {
        mode: 3,
        exchanges: ['kraken', 'grvt', 'extended'],
        description: 'Multi-Exchange Mode - All 3 Exchanges (Kraken, GRVT, Extended)',
        accountCount: 3
      };
    } else if (mode === '3d') {
      return {
        mode: '3d',
        exchanges: ['kraken', 'grvt'],
        description: 'Multi-Exchange Mode - Kraken + GRVT (2 Exchanges)',
        accountCount: 2
      };
    } else if (mode === '3e') {
      return {
        mode: '3e',
        exchanges: ['kraken', 'extended'],
        description: 'Multi-Exchange Mode - Kraken + Extended (2 Exchanges)',
        accountCount: 2
      };
    } else if (mode === '3f') {
      return {
        mode: '3f',
        exchanges: ['grvt', 'extended'],
        description: 'Multi-Exchange Mode - GRVT + Extended (2 Exchanges)',
        accountCount: 2
      };
    } else if (mode === '3a') {
      return {
        mode: '3a',
        testExchange: 'kraken',
        description: 'Test Kraken Exchange Only (BUY + SELL)',
        accountCount: 1
      };
    } else if (mode === '3b') {
      return {
        mode: '3b',
        testExchange: 'grvt',
        description: 'Test GRVT Exchange Only (BUY + SELL)',
        accountCount: 1
      };
    } else if (mode === '3c') {
      return {
        mode: '3c',
        testExchange: 'extended',
        description: 'Test Extended Exchange Only (BUY + SELL)',
        accountCount: 1
      };
    } else {
      console.log(`\n✗ Invalid option. Please enter 1, 2, 3, 3d, 3e, 3f, 3a, 3b, or 3c.`);
      process.exit(1);
    }
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

  async function findByExactText(pg, text, tagNames = ["button", "div", "span"]) {
    // Optimized: Use single page.evaluate() call instead of per-element calls
    const selector = tagNames.join(', ');
    try {
      const elementHandle = await Promise.race([
        pg.evaluateHandle(
          (selector, searchText) => {
            const elements = Array.from(document.querySelectorAll(selector));
            for (const el of elements) {
              const elText = el.textContent?.trim();
              if (elText === searchText) {
                const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
                if (isVisible) {
                  return el;
                }
              }
            }
            return null;
          },
          selector,
          text
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('findByExactText timeout after 10 seconds')), 10000)
        )
      ]);

      const element = elementHandle.asElement();
      if (element) {
        // Verify the text matches (double-check)
        const elText = await pg.evaluate(e => e.textContent?.trim(), element);
        if (elText === text) {
          return element;
        }
      }
      return null;
    } catch (error) {
      if (error.message && error.message.includes('timeout')) {
        console.log(`⚠️  findByExactText timed out after 10 seconds for text: "${text}"`);
        return null;
      }
      throw error;
    }
  }

/**
 * Close NotifyBarWrapper notifications on GRVT exchange
 * @param {Page} page - Puppeteer page object
 * @param {Object} exchange - Exchange configuration object
 * @param {string} context - Context description for logging (e.g., "before cleanup", "on page load")
 * @returns {Promise<number>} - Number of notifications closed
 */
async function closeNotifyBarWrapperNotifications(page, exchange, context = '') {
  // Only for GRVT exchange
  if (exchange.name !== 'GRVT' && exchange.name?.toLowerCase() !== 'grvt') {
    return 0;
  }

  try {
    const closedCount = await page.evaluate(() => {
      const notifyBars = Array.from(document.querySelectorAll('[data-sentry-component="NotifyBarWrapper"]'));
      let closed = 0;
      for (const notifyBar of notifyBars) {
        const style = window.getComputedStyle(notifyBar);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          const closeButton = notifyBar.querySelector('span[data-sentry-component="_IconWrapper"]');
          if (closeButton && closeButton.offsetParent !== null) {
            closeButton.click();
            closed++;
          }
        }
      }
      return closed;
    });

    if (closedCount > 0) {
      const contextMsg = context ? ` ${context}` : '';
      console.log(`[${exchange.name}] ✅ Closed ${closedCount} NotifyBarWrapper notification(s)${contextMsg}`);
      await delay(300);
    }
    return closedCount;
  } catch (error) {
    console.log(`[${exchange.name}] ⚠️  Error closing NotifyBarWrapper notifications: ${error.message}`);
    return 0;
  }
}

export { delay, prompt, findByText, findByExactText, chooseTradingMode, closeNotifyBarWrapperNotifications };