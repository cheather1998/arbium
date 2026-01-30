import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { executeTradeExtended } from './executeExtended.js';
import { executeTradeParadex } from './executeParadex.js';
import { executeTradeGrvt } from './executeGrvt.js';
import { executeTradeKraken } from './executeKraken.js';
import { getCurrentMarketPrice } from './executeBase.js';

/**
 * Main executeTrade function - routes to exchange-specific handlers
 * Maintains the same function signature for backward compatibility
 */
export async function executeTrade(
    page,
    { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
    exchangeConfig = null
  ) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
  
  // Detect exchange type and route to appropriate handler
  const exchangeName = exchange.name?.toLowerCase() || '';
  
  if (exchangeName.includes('extended')) {
    return await executeTradeExtended(page, { side, orderType, price, qty, setLeverageFirst, leverage }, exchange);
  } else if (exchangeName.includes('grvt')) {
    return await executeTradeGrvt(page, { side, orderType, price, qty, setLeverageFirst, leverage }, exchange);
  } else if (exchangeName.includes('kraken')) {
    return await executeTradeKraken(page, { side, orderType, price, qty, setLeverageFirst, leverage }, exchange);
    } else {
    // Default to Paradex (includes Paradex and any other exchanges)
    return await executeTradeParadex(page, { side, orderType, price, qty, setLeverageFirst, leverage }, exchange);
  }
}

// Export getCurrentMarketPrice for backward compatibility
export { getCurrentMarketPrice };
