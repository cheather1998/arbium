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
async function chooseTradingMode() {
    console.log(`\n========================================`);
    console.log(`Select Trading Mode:`);
    console.log(`========================================`);
    console.log(`1. Buy from Paradex, Sell from Paradex (Both accounts on Paradex)`);
    console.log(`2. Buy from Paradex, Sell from Extended Exchange`);
    console.log(`========================================\n`);
    
    const answer = await prompt(`Enter option (1 or 2): `);
    const mode = answer.trim();
    
    if (mode === '1') {
      return {
        mode: 1,
        buyExchange: 'paradex',
        sellExchange: 'paradex',
        description: 'Buy from Paradex, Sell from Paradex'
      };
    } else if (mode === '2') {
      return {
        mode: 2,
        buyExchange: 'paradex',
        sellExchange: 'extended',
        description: 'Buy from Paradex, Sell from Extended Exchange'
      };
    } else {
      console.log(`\n✗ Invalid option. Please enter 1 or 2.`);
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

export { delay, prompt, findByText, findByExactText, chooseTradingMode };