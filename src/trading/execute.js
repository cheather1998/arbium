import EXCHANGE_CONFIGS from '../config/exchanges.js';
import { executeTradeExtended } from './executeExtended.js';
import { executeTradeParadex } from './executeParadex.js';
import { executeTradeGrvt } from './executeGrvt.js';
import { executeTradeKraken } from './executeKraken.js';
import { getCurrentMarketPrice } from './executeBase.js';

/**
 * Main executeTrade function - routes to exchange-specific handlers
 * Maintains the same function signature for backward compatibility
 * @param {number} thresholdMetTime - Timestamp when opening threshold was met (for timing metrics)
 * @param {number} cycleCount - Current cycle number (for logging)
 * @param {string} side - Trade side ('BUY' or 'SELL') for logging
 * @param {string} email - Account email (for logging)
 */
export async function executeTrade(
    page,
    { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
    exchangeConfig = null,
    thresholdMetTime = null,
    cycleCount = null,
    sideLabel = '',
    email = ''
  ) {
    const exchange = exchangeConfig || EXCHANGE_CONFIGS.paradex; // Default to Paradex
  
  // Detect exchange type and route to appropriate handler
  const exchangeName = exchange.name?.toLowerCase() || '';
  
  if (exchangeName.includes('extended')) {
    return await executeTradeExtended(page, { side, orderType, price, qty, setLeverageFirst, leverage }, exchange, thresholdMetTime, cycleCount, sideLabel, email);
  } else if (exchangeName.includes('grvt')) {
    return await executeTradeGrvt(page, { side, orderType, price, qty, setLeverageFirst, leverage }, exchange, thresholdMetTime, cycleCount, sideLabel, email);
  } else if (exchangeName.includes('kraken')) {
    return await executeTradeKraken(page, { side, orderType, price, qty, setLeverageFirst, leverage }, exchange, thresholdMetTime, cycleCount, sideLabel, email);
    } else {
    // Default to Paradex (includes Paradex and any other exchanges)
    return await executeTradeParadex(page, { side, orderType, price, qty, setLeverageFirst, leverage }, exchange, thresholdMetTime, cycleCount, sideLabel, email);
  }
}

// Export getCurrentMarketPrice for backward compatibility
export { getCurrentMarketPrice };
