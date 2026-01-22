import express from 'express';
import { executeTrade } from '../trading/execute.js';
import { closeAllPositions } from '../trading/positions.js';

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

  export { startApiServer };