# Paradex Trading Bot - Minimal Setup

A minimal setup for the Paradex automated trading bot using Puppeteer to control the web interface.

## Features

- Multi-account trading (2 accounts)
- Automated buy/sell cycles
- Position management
- Cookie-based session persistence
- Express API endpoints for manual control

## Prerequisites

- Node.js (v18 or higher)
- Google Chrome browser installed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Two Paradex accounts with email authentication

## Folder Structure

```
paradex-bot-mini/
├── paradex-bot.js                    # Main bot script
├── package.json                      # Node dependencies
├── .env                             # Configuration
├── paradex-cookies-account1.json    # Session cookies for account 1
├── paradex-cookies-account2.json    # Session cookies for account 2
└── README.md                        # This file
```

## Installation

1. Install dependencies:
```bash
npm install
```

## Configuration

Edit the `.env` file to configure trading parameters:

```env
# Quantity of BTC to buy (for account 1)
BUY_QTY=0.0005

# Quantity of BTC to sell (for account 2)
SELL_QTY=0.0005

# Time to wait before closing positions (in milliseconds)
TRADE_TIME=60000
```

## Account Configuration

The bot is configured for 2 accounts in `paradex-bot.js` (lines 19-32):

```javascript
const ACCOUNTS = [
  {
    email: "htet@aylab.io",
    cookiesPath: './paradex-cookies-account1.json',
    profileDir: '/tmp/puppeteer-chrome-profile-1',
    apiPort: 3001
  },
  {
    email: "n2113477@gmail.com",
    cookiesPath: './paradex-cookies-account2.json',
    profileDir: '/tmp/puppeteer-chrome-profile-2',
    apiPort: 3002
  }
];
```

**To change accounts:** Edit the email addresses in the ACCOUNTS array.

## Running the Bot

### With Browser UI (Recommended for First Run)
```bash
npm run bot
```

This will:
1. Open Chrome browsers for each account
2. Attempt to login with saved cookies
3. If cookies are invalid, prompt for email OTP verification
4. Start the automated trading loop

### Headless Mode (No UI)
```bash
npm run bot:headless
```

## Trading Flow

The bot executes the following cycle automatically:

1. **Close existing positions** (if any)
2. **Open new positions:**
   - Account 1: BUY BTC (quantity from BUY_QTY)
   - Account 2: SELL BTC (quantity from SELL_QTY)
3. **Wait** for the configured time (TRADE_TIME)
4. **Close all positions**
5. **Repeat** cycle

## API Endpoints

When running, each account has its own API server:

### Account 1: http://localhost:3001
### Account 2: http://localhost:3002

#### Available Endpoints:

**Health Check:**
```bash
curl http://localhost:3001/health
```

**Place Trade:**
```bash
# Market Buy
curl -X POST http://localhost:3001/trade \
  -H "Content-Type: application/json" \
  -d '{"side":"buy","orderType":"market","qty":0.001}'

# Limit Sell
curl -X POST http://localhost:3001/trade \
  -H "Content-Type: application/json" \
  -d '{"side":"sell","orderType":"limit","price":95000,"qty":0.001}'
```

**Close Positions:**
```bash
# Close 100% of position
curl -X POST http://localhost:3001/close-all \
  -H "Content-Type: application/json" \
  -d '{"percent":100}'

# Close 50% of position
curl -X POST http://localhost:3001/close-all \
  -H "Content-Type: application/json" \
  -d '{"percent":50}'
```

**Take Screenshot:**
```bash
curl http://localhost:3001/screenshot
```

## Graceful Shutdown

Press `Ctrl+C` to gracefully shutdown the bot. It will:
1. Stop the trading loop
2. Close all open positions
3. Close browser instances
4. Exit

## Troubleshooting

### "Login failed" or "Not logged in"
- Delete the cookie files and run again to re-authenticate
- Make sure you have access to the email for OTP codes

### "Size input not found"
- The Paradex UI may have changed
- Try running in non-headless mode to inspect the issue

### Browser crashes or freezes
- Check Chrome is installed at the correct path
- Ensure sufficient system resources
- Try closing other Chrome instances

### Trades not executing
- Check account balance and margin requirements
- Verify the trading pair (BTC-USD-PERP) is available
- Check console logs for specific error messages

## Important Notes

1. **Cookie Security:** The cookie JSON files contain authentication tokens. Keep them secure and don't commit to version control.

2. **Rate Limits:** Be aware of Paradex's rate limits when using the API endpoints.

3. **Risk Warning:** This bot executes real trades with real money. Always test with small amounts first.

4. **Chrome Path:** The bot expects Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (macOS). For other systems, edit line 761 in `paradex-bot.js`:
   ```javascript
   executablePath: '/path/to/your/chrome'
   ```

5. **First Run:** On first run, you'll need to complete email OTP verification for each account. After that, cookies will be saved for future runs.

## Development

To modify the bot behavior, edit `paradex-bot.js`:
- `executeTrade()` - Handles trade execution
- `closeAllPositions()` - Handles position closing
- `automatedTradingLoop()` - Main trading loop logic

## License

MIT
