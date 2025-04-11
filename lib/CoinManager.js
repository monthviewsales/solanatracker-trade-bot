const fs = require('fs').promises;
const logger = require('../utils/logger');
const { tradeHist, fetchWalletBasic, fetchTokenDetails, fetchChartData } = require("../lib/solanaTrackerAPI");

const COIN_FILE = 'coins.json';
const TRAILING_STOP_PERCENT = parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.05;

/**
 * Fetches chart data for a given mint with retry logic.
 *
 * @param {string} mint - The mint address of the token.
 * @param {number} [retries=2] - Number of retry attempts.
 * @param {number} [delayMs=500] - Delay between retries in milliseconds.
 * @returns {Promise<Object>} The fetched chart data.
 */
async function fetchChartDataWithRetry(mint, retries = 2, delayMs = 500) {
    let attempt = 0;
    while (attempt <= retries) {
        try {
            const start = Date.now();
            const data = await fetchChartData(mint);
            const duration = Date.now() - start;
            logger.debug(`[CoinManager] fetchChartData for ${mint} took ${duration}ms`);
            return data;
        } catch (err) {
            attempt++;
            if (attempt > retries) throw err;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

/**
 * Manages coin data including normalization, updating, persistence, and position management.
*/
class CoinManager {
  
/**
 * Creates a new CoinManager instance.
 *
 * @param {*} keypair - The keypair used for wallet operations.
 */
   constructor(keypair) {
    this.coins = [];
    this.validationInterval = null;
    this.debounceTimer = null; // Initialize debounce timer
    this.keypair;
  }

  /**
   * Normalizes a coin object to ensure it adheres to the baseline schema.
   *
   * @param {Object} coin - The coin object to normalize.
   * @returns {Promise<Object>} The normalized coin.
   */
  async normalizeCoin(coin) {
    // logger.debug(`[normalizeCoin] Raw coin data: ${JSON.stringify(coin, null, 2)}`);
    if (!coin) return {};
    if (coin && !coin.token) {
      coin.token = {};
      logger.warn('⚠️ [CoinManager] normalizeCoin: Missing token; initialized as empty object.');
    }

    if (!coin.token.mint) {
      coin.token.mint = coin.address || coin.id || null;
      logger.warn(`⚠️ [CoinManager] normalizeCoin: Missing token.mint; attempting to infer from address or id: ${coin.token.mint}`);
    }

    if (!coin.token.address) {
      coin.token.address = coin.token.mint || coin.address || coin.id || null;
      logger.warn(`⚠️ [CoinManager] normalizeCoin: Missing token.address; attempting to infer from mint or id: ${coin.token.address}`);
    }

    if (!coin.token.symbol || coin.token.symbol.trim() === '') {
      coin.token.symbol = coin.symbol || coin.name || 'UNKNOWN';
      logger.warn(`⚠️ [CoinManager] normalizeCoin: Missing token.symbol; attempting to infer from name or setting to "UNKNOWN": ${coin.token.symbol}`);
    }
    
    if (!coin.position) {
      coin.position = {};
      logger.warn('⚠️ [CoinManager] normalizeCoin: Missing position; initialized as empty object.');
    }
    coin.position.amount = coin.position.amount ?? 1;
    coin.position.entryPrice = coin.position.entryPrice ?? 0;
    coin  .position.highestPrice = coin.position.highestPrice ?? coin.position.entryPrice;
    coin.position.sl = coin.position.sl ?? (coin.position.entryPrice * (1 - TRAILING_STOP_PERCENT));
    coin.position.timestamp = coin.position.timestamp ?? Date.now();

    if (!coin.token.mint) {
      logger.warn('⚠️ [CoinManager] normalizeCoin: Final check — token.mint is still missing after normalization.');
    }
    if (!coin.token.symbol || coin.token.symbol === "UNKNOWN") {
      logger.warn(`⚠️ [CoinManager] normalizeCoin: Final check — symbol missing or unknown for ${coin.token.mint}`);
    }

    if (!coin.status || coin.status === "") {
      coin.status = 'hold';
      logger.warn(`⚠️ [CoinManager] normalizeCoin: ${coin.token.mint} has a bad status and we set it to 'hold'`);
    }

    logger.info(`[CoinManager] normalizeCoin: Successfully normalized coin: ${coin.token.symbol} (mint: ${coin.token.mint})`);
    return coin;
  }

  /**
   * Logs an error message along with an error object.
   *
   * @param {string} message - The error message.
   * @param {Error} error - The error object.
   */
  logError(message, error) {
    logger.error(message, { error: error });
  }

  /**
   * Updates a coin object with additional details fetched from an external API.
   *
   * @param {Object} coin - The coin object to update.
   * @returns {Promise<void>}
   */
  async updateCoinWithDetails(coin) {
    try {
      const tokenDetails = await fetchTokenDetails(coin.token.mint);
      if (tokenDetails && tokenDetails.token) {
        coin.token.name = tokenDetails.token.name || coin.token.name;
        coin.token.symbol = tokenDetails.token.symbol || coin.token.symbol;
        coin.token.uri = tokenDetails.token.uri || coin.token.uri;
        coin.token.decimals = tokenDetails.token.decimals || coin.token.decimals;
        coin.token.image = tokenDetails.token.image || coin.token.image;
        coin.marketCap = tokenDetails.pools?.[0]?.marketCap?.usd || coin.marketCap;
        coin.lastUpdated = Date.now();
        logger.info(`[CoinManager] updateCoinWithDetails: Updated coin ${coin.token.symbol} using fetchTokenDetails.`);
        if (!coin.chartData || coin.chartData.length === 0) {
            coin.chartData = await fetchChartDataWithRetry(coin.token.mint);
          logger.info(`[CoinManager] updateCoinWithDetails: Updated chart data for ${coin.token.symbol}`);
        }
      } else {
        logger.warn(`[CoinManager] updateCoinWithDetails: No detailed info available for ${coin.token.mint}`);
      }
    } catch (err) {
      this.logError(`[CoinManager] updateCoinWithDetails: Error updating coin details for ${coin.token.mint}`, err);
    }
  }

  /**
   * Resets coins from the wallet by fetching token data and initializing coin objects.
   *
   * @param {Object} walletManager - The wallet manager instance.
   * @param {*} keypair - The keypair associated with the wallet.
   * @returns {Promise<void>}
   */
  async resetCoinsFromWallet(walletManager, keypair) {
    const pubKey = keypair.publicKey
    logger.info(`[CoinManager] resetCoinsFromWallet: Resetting coins from wallet ${pubKey}`);
    // Clear the existing coins array
    this.coins = [];
    try {
      const walletResponse = await fetchWalletBasic(keypair.publicKey);
      const walletTokens = walletResponse.tokens;
      for (const tokenEntry of walletTokens) {
        if (tokenEntry.balance > 0) {
          const coinStatus = tokenEntry.address === "So11111111111111111111111111111111111111112" ? "blacklist" : "open";
          
          let symbol = tokenEntry.symbol || 'UNKNOWN';
          if (symbol === 'UNKNOWN') {
              try {
                  const tokenDetails = await fetchTokenDetails(tokenEntry.address);
                  if (tokenDetails?.token?.symbol) {
                      symbol = tokenDetails.token.symbol;
                    logger.info(`[CoinManager] resetCoinsFromWallet: Fetched symbol for ${tokenEntry.address}: ${symbol}`);
                  } else {
                    logger.warn(`[CoinManager] resetCoinsFromWallet: Failed to retrieve symbol for ${tokenEntry.address}, keeping as UNKNOWN`);
                  }
              } catch (err) {
                logger.error(`[CoinManager] resetCoinsFromWallet: Error fetching token details for ${tokenEntry.address}: ${err.message}`);
              }
          }
          logger.debug(`[CoinManager] resetCoinsFromWallet: Final symbol for ${tokenEntry.address}: ${symbol}`);
          
          let coin = {
            token: {
              mint: tokenEntry.address,
              symbol: symbol
            },
            status: coinStatus,
            position: {
              amount: tokenEntry.balance,
              entryPrice: tokenEntry.price?.usd || 0,
              highestPrice: tokenEntry.price?.usd || 0,
              sl: (tokenEntry.price?.usd || 0) * (1 - TRAILING_STOP_PERCENT),
              timestamp: Date.now(),
              lastValidated: Date.now()
            },
            buys: [],
            sells: [],
            lastUpdated: Date.now()
          };
          const updateCoin = await fetchTokenDetails(tokenEntry.address);
          coin.price = updateCoin;
          coin = await this.normalizeCoin(coin); // Ensure completeness
          if (!coin.chartData || coin.chartData.length === 0) {
              coin.chartData = await fetchChartDataWithRetry(coin.token.mint);
            logger.info(`[CoinManager] resetCoinsFromWallet: Fetched chart data for ${coin.token.symbol}`);
          }
          await this.addOrUpdateCoin(coin);
          await this.fillMissingPositionData(coin, keypair.publicKey.toBase58());
          logger.debug(`[CoinManager] resetCoinsFromWallet: Filled missing position data for ${coin.token?.symbol} (mint: ${coin.token?.mint})`);
          logger.info(`[CoinManager] resetCoinsFromWallet: Initialized entry price for ${symbol} (mint: ${tokenEntry.address}) at ${tokenEntry.price?.usd}`);
          logger.debug(`[CoinManager] resetCoinsFromWallet: Added coin: ${symbol} / ${tokenEntry.address} with status ${coinStatus}`);
        }
      }
      this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
      logger.info(`[CoinManager] resetCoinsFromWallet: Rebuilt coins.json with ${this.coins.length} coins from wallet.`);
    } catch (err) {
      this.logError(`[CoinManager] resetCoinsFromWallet: Error resetting coins from wallet: ${err.message}`, err);
    }
  }

  /**
   * Finds a coin by its mint address.
   *
   * @param {string} mint - The mint address of the coin.
   * @returns {Object|undefined} The found coin or undefined.
   */
  findByMint(mint) {
    return this.getCoin(mint);
  }

  /**
   * Loads coins from the local JSON file and normalizes each coin.
   *
   * @returns {Promise<void>}
   */
  async loadCoins() {
    try {
      const data = await fs.readFile(COIN_FILE, 'utf8');
      this.coins = JSON.parse(data) || [];
      // Normalize each coin and ensure position defaults and chart data
      this.coins = await Promise.all(this.coins.map(async (coin) => {
        coin = await this.normalizeCoin(coin);
        coin.chartData = coin.chartData || [];
        return coin;
      }));
      logger.info(`🔄 [CoinManager] loadCoins: Loaded ${this.coins.length} coins from ${COIN_FILE}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn(`${COIN_FILE} not found. Starting fresh.`);
        this.coins = [];
        this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
      } else {
        this.logError('❌ [CoinManager] loadCoins: Error loading coins.json', err);
      }
    }
  }

  /**
   * Saves the current coins array to the JSON file.
   *
   * @returns {Promise<void>}
   */
  async saveCoins() {
    try {
      await fs.writeFile(COIN_FILE, JSON.stringify(this.coins, null, 2));
      logger.info(`💾 [CoinManager] saveCoins: Saved ${this.coins.length} coins to ${COIN_FILE}`);
    } catch (err) {
      this.logError('❌ [CoinManager] saveCoins: Error saving coins.json', err);
    }
  }

  /**
   * Saves coins to file in a debounced manner to minimize disk writes.
   *
   * @returns {Promise<void>}
   */
  async debouncedSaveCoins() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(async () => {
      try {
        const snapshot = [...this.coins];
        await fs.writeFile(COIN_FILE, JSON.stringify(snapshot, null, 2));
        logger.info(`💾 [CoinManager]debouncedSaveCoins: Saved ${snapshot.length} coins to ${COIN_FILE} (debounced)`);
      } catch (err) {
        this.logError('❌ [CoinManager]debouncedSaveCoins: Error saving coins.json (debounced)', err);
      }
      this.debounceTimer = null;
    }, 1000);
  }

  /**
   * Retrieves all coins.
   *
   * @returns {Object[]} An array of coin objects.
   */
  getAllCoins() {
    return this.coins;
  }

  /**
   * Retrieves a coin by its mint address.
   *
   * @param {string} mint - The mint address of the coin.
   * @returns {Object|undefined} The coin if found, else undefined.
   */
  getCoin(mint) {
    return this.coins.find((coin) => coin.token && coin.token.mint === mint);
  }

  /**
   * Adds a new coin or updates an existing coin in the collection.
   *
   * @param {Object} coin - The coin object to add or update.
   * @returns {Promise<void>}
   */
  async addOrUpdateCoin(coin) {
    const normalizedCoin = await this.normalizeCoin(coin);
    if (typeof normalizedCoin.then === 'function') {
      logger.error('❌ [CoinManager] addOrUpdateCoin: Normalization returned a promise instead of an object.');
      return;
    }
    logger.debug(`[CoinManager] addOrUpdateCoin: Successfully awaited normalization for ${normalizedCoin.token?.symbol} (mint: ${normalizedCoin.token?.mint})`);
    if (coin.chartData) {
        normalizedCoin.chartData = coin.chartData;
    }
    if (!normalizedCoin.token || !normalizedCoin.token.mint) {
      logger.warn('⚠️ [CoinManager] addOrUpdateCoin: Skipping addOrUpdate — missing token or mint');
      return;
    }
    const index = this.coins.findIndex((c) => c.token.mint === normalizedCoin.token.mint);
    if (index !== -1) {
      const existing = this.coins[index];
      // Update position fields with consistency
      const updatedPosition = {
        entryPrice: Number.isFinite(normalizedCoin.position?.entryPrice)
          ? normalizedCoin.position.entryPrice
          : existing.position?.entryPrice ?? 0,
        highestPrice: Number.isFinite(normalizedCoin.position?.highestPrice)
          ? (normalizedCoin.position.highestPrice > (existing.position?.highestPrice || 0)
                ? normalizedCoin.position.highestPrice
                : existing.position?.highestPrice)
          : (existing.position?.highestPrice ?? normalizedCoin.position.entryPrice),
        sl: Number.isFinite(normalizedCoin.position?.sl)
          ? normalizedCoin.position.sl
          : existing.position?.sl ?? normalizedCoin.position.entryPrice * (1 - TRAILING_STOP_PERCENT),
        amount: Number.isFinite(normalizedCoin.position?.amount)
          ? normalizedCoin.position.amount
          : existing.position?.amount ?? 1
      };
      this.coins[index] = {
        ...existing,
        ...normalizedCoin,
        status: normalizedCoin.status !== undefined ? normalizedCoin.status : existing.status,
        position: updatedPosition,
        token: {
          ...existing.token,
          ...normalizedCoin.token
        },
        buys: normalizedCoin.buys !== undefined ? normalizedCoin.buys : existing.buys,
        sells: normalizedCoin.sells !== undefined ? normalizedCoin.sells : existing.sells,
        lastUpdated: Date.now()
      };
      logger.debug(`[CoinManager] addOrUpdateCoin: Updated coin ${this.coins[index].token?.symbol} (mint: ${this.coins[index].token?.mint})`);
    } else {
      this.coins.push({
        ...normalizedCoin,
        status: normalizedCoin.status !== undefined ? normalizedCoin.status : coin.status,
        position: normalizedCoin.position ? {
          ...normalizedCoin.position,
          highestPrice: (normalizedCoin.position.highestPrice !== undefined)
            ? normalizedCoin.position.highestPrice
            : (normalizedCoin.position.entryPrice !== undefined ? normalizedCoin.position.entryPrice : 0),
          sl: (normalizedCoin.position.sl !== undefined)
            ? normalizedCoin.position.sl
            : (normalizedCoin.position.entryPrice !== undefined ? normalizedCoin.position.entryPrice * (1 - TRAILING_STOP_PERCENT) : undefined),
          amount: normalizedCoin.position.amount ?? 1
        } : {},
        buys: normalizedCoin.buys || [],
        sells: normalizedCoin.sells || [],
        lastUpdated: Date.now()
      });
      logger.debug(`[CoinManager] addOrUpdateCoin: Added new coin ${normalizedCoin.token?.symbol} (mint: ${normalizedCoin.token?.mint})`);
    }
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  /**
   * Deletes a coin based on its mint address.
   *
   * @param {string} mint - The mint address of the coin to delete.
   */
  deleteCoinByMint(mint) {
    this.coins = this.coins.filter((coin) => coin.token?.mint !== mint);
  }

  /**
   * Opens a position for a coin using the provided position data.
   *
   * @param {string} mint - The mint address of the coin.
   * @param {Object} positionData - Data required to open the position (e.g., entryPrice, sl).
   */
  openPosition(mint, positionData) {
    let coin = this.getCoin(mint);
    if (!coin) {
      logger.warn(`[CoinManager] openPosition: Cannot open position; coin with mint ${mint} not found.`);
      return;
    }
    const amount = positionData.amount ?? positionData.qty ?? 1;
    coin.position = {
      ...positionData,
      amount,
      highestPrice: positionData.entryPrice,
      sl: positionData.sl || (positionData.entryPrice * (1 - TRAILING_STOP_PERCENT)),
      timestamp: Date.now(),
      lastValidated: Date.now()
    };
    coin.status = 'open';
    
    if (global.bot && global.bot.positions && typeof global.bot.positions.set === 'function') {
      global.bot.positions.set(mint, coin.position);
    }
    
    logger.info(`[CoinManager] openPosition: Opened position for ${coin.token?.symbol} (mint: ${mint}) at entry price ${positionData.entryPrice}`);
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  /**
   * Closes the position for a coin using sell data.
   *
   * @param {string} mint - The mint address of the coin.
   * @param {Object} sellData - Sell data including exit price, transaction ID, etc.
   */
  closePosition(mint, sellData) {
    let coin = this.getCoin(mint);
    if (!coin || !coin.position) {
      logger.warn(`[CoinManager] closePosition: Cannot close position; no active position for coin with mint ${mint}`);
      return;
    }
    const { entryPrice, amount: recordedAmount } = coin.position;
    const closeAmount = sellData.qty ?? recordedAmount;
    const pnl = (sellData.exitPrice - entryPrice) * closeAmount;
    const pnlPct = ((sellData.exitPrice - entryPrice) / entryPrice) * 100;
    const sellEntry = {
      exitPrice: sellData.exitPrice,
      txid: sellData.txid,
      timestamp: Date.now(),
      pnl,
      pnlPct,
      qty: sellData.qty
    };
    coin.sells = coin.sells || [];
    coin.sells.push(sellEntry);
    coin.status = 'closed';
    delete coin.position;

    if (global.bot && global.bot.positions && typeof global.bot.positions.delete === 'function') {
      global.bot.positions.delete(mint);
    }
    
    logger.info(`[CoinManager] closePosition: Closed position for ${coin.token?.symbol} (mint: ${mint}). PnL: ${pnl.toFixed(6)} (${pnlPct.toFixed(2)}%)`);
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  /**
   * Validates open positions by comparing stored data with wallet balances.
   *
   * @param {Object} walletManager - The wallet manager instance.
   * @param {*} keypair - The keypair associated with the wallet.
   * @returns {Promise<void>}
   */
  async validatePositions(walletManager, keypair) {
    logger.info(`[CoinManager] validatePositions: Validating positions...`);
    const openCoins = this.coins.filter((coin) => coin.status === 'open' && coin.position);
    for (let coin of openCoins) {
      // Normalize coin before validation
      coin = await this.normalizeCoin(coin);

      // Attempt to fill missing required position data (e.g., entryPrice)
      await this.fillMissingPositionData(coin, keypair.publicKey.toBase58());

      if (coin.token.symbol === "UNKNOWN") {
        logger.warn(`[CoinManager] validatePositions: Unknown symbol detected for ${coin.token.mint}, attempting update...`);
        await this.updateCoinWithDetails(coin);
      }

      try {
        const mint = coin.token.mint;
        if (!walletManager || typeof walletManager.getWalletAmount !== 'function') {
          logger.error(`[CoinManager] validatePositions: WalletManager not properly configured.`);
          continue;
        }
        let result = await walletManager.getWalletAmount(keypair, mint);
        let balance = (result && typeof result === 'object' && 'balance' in result) ? result.balance : result;
        if (balance > 0 && balance < coin.position.amount) {
          logger.warn(`[CoinManager] validatePositions: Updating position for ${coin.token?.symbol} (mint: ${mint}). Stored amount ${coin.position.amount} is greater than wallet balance ${balance}.`);
          coin.position.amount = balance;
        }
        coin.position.lastValidated = Date.now();
      } catch (err) {
        this.logError(`[CoinManager] validatePositions: Error validating position for coin with mint ${coin.token?.mint}:`, err);
      }
    }
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  /**
   * Starts a periodic timer to validate coin positions.
   *
   * @param {Object} walletManager - The wallet manager instance.
   * @param {*} keypair - The keypair associated with the wallet.
   * @param {number} [intervalMs=60000] - The interval between validations in milliseconds.
   */
  startValidationTimer(walletManager, keypair, intervalMs = 60000) {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
    }
    this.validationInterval = setInterval(() => {
      this.validatePositions(walletManager, keypair);
    }, intervalMs);
  }

  /**
   * Fills in missing position data for a coin using trade history.
   *
   * @param {Object} coin - The coin object to update.
   * @param {string} publicKey - The public key used to fetch trade history.
   * @returns {Promise<void>}
   */
  async fillMissingPositionData(coin, publicKey) {
    if (!coin.position || !Number.isFinite(coin.position.entryPrice) || coin.position.entryPrice <= 0) {
      try {
        const tokenSymbol = coin.token?.symbol || coin.price?.token?.symbol || 'UNKNOWN';
        const tradeHistory = await tradeHist(coin.token.mint, publicKey);
        if (tradeHistory && Array.isArray(tradeHistory.trades) && tradeHistory.trades.length > 0) {
          // Find the latest 'buy' trade
          const buyTrades = tradeHistory.trades.filter(trade => trade.type === 'buy');
          logger.debug(`[CoinManager] fillMissingPositionData: Found ${buyTrades.length} buy trades for ${tokenSymbol}`);
          const latestBuy = buyTrades.sort((a, b) => b.time - a.time)[0];
          if (latestBuy) {
            coin.position = coin.position || {};
            coin.position.entryPrice = latestBuy.priceUsd;
            logger.info(`[CoinManager] fillMissingPositionData: Filled missing entryPrice for ${tokenSymbol} with value: ${coin.position.entryPrice}`);
            await this.addOrUpdateCoin(coin);
            logger.info(`[CoinManager] fillMissingPositionData: Successfully updated coin ${coin.token.symbol} with new entry price: ${coin.position.entryPrice}`);
          } else {
            logger.warn(`[CoinManager] fillMissingPositionData: No buy trade found in history for ${tokenSymbol}`);
          }
        } else {
          logger.warn(`[CoinManager] fillMissingPositionData: No trade history available for ${tokenSymbol}`);
        }
      } catch (err) {
        this.logError(`[CoinManager] fillMissingPositionData: Error fetching trade history for ${tokenSymbol}: ${err.message}`, err);
      }
    }
  }
}

module.exports = new CoinManager();