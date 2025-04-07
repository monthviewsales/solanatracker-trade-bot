const fs = require('fs').promises;
const logger = require('../utils/logger');
const { tradeHist, fetchWalletBasic, fetchTokenDetails } = require("../lib/solanaTrackerAPI");

const COIN_FILE = 'coins.json';
const TRAILING_STOP_PERCENT = parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.05;

class CoinManager {
  constructor(keypair) {
    this.coins = [];
    this.validationInterval = null;
    this.debounceTimer = null; // Initialize debounce timer
    this.keypair;
  }

  // Normalize coin to ensure it adheres to our baseline schema
  async normalizeCoin(coin) {
    // logger.debug(`[normalizeCoin] Raw coin data: ${JSON.stringify(coin, null, 2)}`);
    if (!coin) return {};
    if (coin && !coin.token) {
      coin.token = {};
      logger.warn('⚠️ [normalizeCoin] Missing token; initialized as empty object.');
    }

    if (!coin.token.mint) {
      coin.token.mint = coin.address || coin.id || null;
      logger.warn(`⚠️ [normalizeCoin] Missing token.mint; attempting to infer from address or id: ${coin.token.mint}`);
    }

    if (!coin.token.address) {
      coin.token.address = coin.token.mint || coin.address || coin.id || null;
      logger.warn(`⚠️ [normalizeCoin] Missing token.address; attempting to infer from mint or id: ${coin.token.address}`);
    }

    if (!coin.token.symbol || coin.token.symbol.trim() === '') {
      coin.token.symbol = coin.symbol || coin.name || 'UNKNOWN';
      logger.warn(`⚠️ [normalizeCoin] Missing token.symbol; attempting to infer from name or setting to "UNKNOWN": ${coin.token.symbol}`);
    }
    
    if (!coin.position) {
      coin.position = {};
      logger.warn('⚠️ [normalizeCoin] Missing position; initialized as empty object.');
    }
    coin.position.amount = coin.position.amount ?? 1;
    coin.position.entryPrice = coin.position.entryPrice ?? 0;
    coin.position.highestPrice = coin.position.highestPrice ?? coin.position.entryPrice;
    coin.position.sl = coin.position.sl ?? (coin.position.entryPrice * (1 - TRAILING_STOP_PERCENT));
    coin.position.timestamp = coin.position.timestamp ?? Date.now();

    if (!coin.token.mint) {
      logger.warn('⚠️ [normalizeCoin] Final check — token.mint is still missing after normalization.');
    }
    if (!coin.token.symbol || coin.token.symbol === "UNKNOWN") {
      logger.warn(`[CoinManager] Final check — symbol missing or unknown for ${coin.token.mint}`);
    }

    logger.info(`[CoinManager] Successfully normalized coin: ${coin.token.symbol} (mint: ${coin.token.mint})`);
    return coin;
  }

  // Log error helper method
  logError(message, error) {
    logger.error(message, { error: error });
  }

  // New method to update coin with details
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
        logger.info(`[CoinManager] Updated coin ${coin.token.symbol} using fetchTokenDetails.`);
      } else {
        logger.warn(`[CoinManager] No detailed info available for ${coin.token.mint}`);
      }
    } catch (err) {
      this.logError(`[CoinManager] Error updating coin details for ${coin.token.mint}`, err);
    }
  }

  // Reset coins from wallet
  async resetCoinsFromWallet(walletManager, keypair) {
    const pubKey = keypair.publicKey
    logger.info(`[CoinManager] Resetting coins from wallet ${pubKey}`);
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
                      logger.info(`[CoinManager] Fetched symbol for ${tokenEntry.address}: ${symbol}`);
                  } else {
                      logger.warn(`[CoinManager] Failed to retrieve symbol for ${tokenEntry.address}, keeping as UNKNOWN`);
                  }
              } catch (err) {
                  logger.error(`[CoinManager] Error fetching token details for ${tokenEntry.address}: ${err.message}`);
              }
          }
          logger.debug(`[CoinManager] Final symbol for ${tokenEntry.address}: ${symbol}`);
          
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
          this.addOrUpdateCoin(coin);
          await this.fillMissingPositionData(coin, keypair.publicKey.toBase58());
          logger.debug(`[CoinManager] Filled missing position data for ${coin.token?.symbol} (mint: ${coin.token?.mint})`);
          logger.info(`[CoinManager] Initialized entry price for ${symbol} (mint: ${tokenEntry.address}) at ${tokenEntry.price?.usd}`);
          logger.debug(`[CoinManager] Added coin: ${symbol} / ${tokenEntry.address} with status ${coinStatus}`);
        }
      }
      this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
      logger.info(`[CoinManager] Rebuilt coins.json with ${this.coins.length} coins from wallet.`);
    } catch (err) {
      this.logError(`[CoinManager] Error resetting coins from wallet: ${err.message}`, err);
    }
  }

  // Alias for backward compatibility with previous usage
  findByMint(mint) {
    return this.getCoin(mint);
  }

  // Load coins from the unified data file
  async loadCoins() {
    try {
      const data = await fs.readFile(COIN_FILE, 'utf8');
      this.coins = JSON.parse(data) || [];
      // Normalize each coin and ensure position defaults
      this.coins = await Promise.all(this.coins.map(async (coin) => {
        coin = await this.normalizeCoin(coin);
        return coin;
      }));
      logger.info(`🔄 Loaded ${this.coins.length} coins from ${COIN_FILE}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn(`${COIN_FILE} not found. Starting fresh.`);
        this.coins = [];
        this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
      } else {
        this.logError('❌ Error loading coins.json', err);
      }
    }
  }

  // Save coins to the unified data file
  async saveCoins() {
    try {
      await fs.writeFile(COIN_FILE, JSON.stringify(this.coins, null, 2));
      logger.info(`💾 Saved ${this.coins.length} coins to ${COIN_FILE}`);
    } catch (err) {
      this.logError('❌ Error saving coins.json', err);
    }
  }

  // New method to fill missing required position data using trade history
  async debouncedSaveCoins() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(async () => {
      try {
        await fs.writeFile(COIN_FILE, JSON.stringify(this.coins, null, 2));
        logger.info(`💾 Saved ${this.coins.length} coins to ${COIN_FILE} (debounced)`);
      } catch (err) {
        this.logError('❌ Error saving coins.json (debounced)', err);
      }
      this.debounceTimer = null;
    }, 1000);
  }

  // Retrieve all coins
  getAllCoins() {
    return this.coins;
  }

  // Find a coin by its mint address
  getCoin(mint) {
    return this.coins.find((coin) => coin.token && coin.token.mint === mint);
  }

  // Add a new coin or update an existing one
  async addOrUpdateCoin(coin) {
    const normalizedCoin = await this.normalizeCoin(coin);
    if (typeof normalizedCoin.then === 'function') {
      logger.error('❌ [CoinManager] Normalization returned a promise instead of an object.');
      return;
    }
    logger.debug(`[CoinManager] Successfully awaited normalization for ${normalizedCoin.token?.symbol} (mint: ${normalizedCoin.token?.mint})`);
    if (!normalizedCoin.token || !normalizedCoin.token.mint) {
      logger.warn('⚠️ [CoinManager] Skipping addOrUpdate — missing token or mint');
      return;
    }
    const index = this.coins.findIndex((c) => c.token.mint === normalizedCoin.token.mint);
    if (index !== -1) {
      const existing = this.coins[index];
      // Update position fields with consistency
      const updatedPosition = {
        highestPrice: Number.isFinite(normalizedCoin.position?.highestPrice)
          ? normalizedCoin.position.highestPrice
          : existing.position?.highestPrice ?? normalizedCoin.position.entryPrice,
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
        position: updatedPosition,
        token: {
          ...existing.token,
          ...normalizedCoin.token
        },
        buys: normalizedCoin.buys !== undefined ? normalizedCoin.buys : existing.buys,
        sells: normalizedCoin.sells !== undefined ? normalizedCoin.sells : existing.sells,
        lastUpdated: Date.now()
      };
      logger.debug(`[CoinManager] Updated coin ${this.coins[index].token?.symbol} (mint: ${this.coins[index].token?.mint})`);
    } else {
      this.coins.push({
        ...normalizedCoin,
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
      logger.debug(`[CoinManager] Added new coin ${normalizedCoin.token?.symbol} (mint: ${normalizedCoin.token?.mint})`);
    }
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  // Delete a coin by its mint address
  deleteCoinByMint(mint) {
    this.coins = this.coins.filter((coin) => coin.token?.mint !== mint);
  }

  // Open a position for a coin (e.g., after a buy)
  openPosition(mint, positionData) {
    let coin = this.getCoin(mint);
    if (!coin) {
      logger.warn(`[CoinManager] Cannot open position; coin with mint ${mint} not found.`);
      return;
    }
    coin.position = {
      ...positionData,
      highestPrice: positionData.entryPrice,
      sl: positionData.sl || (positionData.entryPrice * (1 - TRAILING_STOP_PERCENT)),
      amount: positionData.amount || 1,
      timestamp: Date.now(),
      lastValidated: Date.now()
    };
    coin.status = 'open';
    
    if (global.bot && global.bot.positions && typeof global.bot.positions.set === 'function') {
      global.bot.positions.set(mint, coin.position);
    }
    
    logger.info(`[CoinManager] Opened position for ${coin.token?.symbol} (mint: ${mint}) at entry price ${positionData.entryPrice}`);
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  // Close a position for a coin (e.g., after a sell)
  closePosition(mint, sellData) {
    let coin = this.getCoin(mint);
    if (!coin || !coin.position) {
      logger.warn(`[CoinManager] Cannot close position; no active position for coin with mint ${mint}`);
      return;
    }
    const { entryPrice, amount } = coin.position;
    const pnl = (sellData.exitPrice - entryPrice) * amount;
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
    
    logger.info(`[CoinManager] Closed position for ${coin.token?.symbol} (mint: ${mint}). PnL: ${pnl.toFixed(6)} (${pnlPct.toFixed(2)}%)`);
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  // Validate open positions (simulate external wallet balance checks)
  async validatePositions(walletManager, keypair) {
    logger.info(`[CoinManager] Validating positions...`);
    const openCoins = this.coins.filter((coin) => coin.status === 'open' && coin.position);
    for (let coin of openCoins) {
      // Normalize coin before validation
      coin = await this.normalizeCoin(coin);

      // Attempt to fill missing required position data (e.g., entryPrice)
      await this.fillMissingPositionData(coin, keypair.publicKey.toBase58());

      if (coin.token.symbol === "UNKNOWN") {
        logger.warn(`[CoinManager] Unknown symbol detected for ${coin.token.mint}, attempting update...`);
        await this.updateCoinWithDetails(coin);
      }

      try {
        const mint = coin.token.mint;
        if (!walletManager || typeof walletManager.getWalletAmount !== 'function') {
          logger.error(`[CoinManager] WalletManager not properly configured.`);
          continue;
        }
        let result = await walletManager.getWalletAmount(keypair, mint);
        let balance = (result && typeof result === 'object' && 'balance' in result) ? result.balance : result;
        if (balance > 0 && balance < coin.position.amount) {
          logger.warn(`[CoinManager] Updating position for ${coin.token?.symbol} (mint: ${mint}). Stored amount ${coin.position.amount} is greater than wallet balance ${balance}.`);
          coin.position.amount = balance;
        }
        coin.position.lastValidated = Date.now();
      } catch (err) {
        this.logError(`[CoinManager] Error validating position for coin with mint ${coin.token?.mint}:`, err);
      }
    }
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  // Start periodic validation of positions
  startValidationTimer(walletManager, keypair, intervalMs = 60000) {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
    }
    this.validationInterval = setInterval(() => {
      this.validatePositions(walletManager, keypair);
    }, intervalMs);
  }

  // New method to fill missing required position data using trade history
  async fillMissingPositionData(coin, publicKey) {
    if (!coin.position || !Number.isFinite(coin.position.entryPrice)) {
      try {
        const tokenSymbol = coin.token?.symbol || coin.price?.token?.symbol || 'UNKNOWN';
        const tradeHistory = await tradeHist(coin.token.mint, publicKey);
        if (tradeHistory && Array.isArray(tradeHistory.trades) && tradeHistory.trades.length > 0) {
          // Find the latest 'buy' trade
          const buyTrades = tradeHistory.trades.filter(trade => trade.type === 'buy');
          logger.debug(`[CoinManager] Found ${buyTrades.length} buy trades for ${tokenSymbol}`);
          const latestBuy = buyTrades.sort((a, b) => b.time - a.time)[0];
          if (latestBuy) {
            coin.position = coin.position || {};
            coin.position.entryPrice = latestBuy.priceUsd;
            logger.info(`[CoinManager] Filled missing entryPrice for ${tokenSymbol} with value: ${coin.position.entryPrice}`);
            await this.addOrUpdateCoin(coin);
            logger.info(`[CoinManager] Successfully updated coin ${coin.token.symbol} with new entry price: ${coin.position.entryPrice}`);
          } else {
            logger.warn(`[CoinManager] No buy trade found in history for ${tokenSymbol}`);
          }
        } else {
          logger.warn(`[CoinManager] No trade history available for ${tokenSymbol}`);
        }
      } catch (err) {
        this.logError(`[CoinManager] Error fetching trade history for ${tokenSymbol}: ${err.message}`, err);
      }
    }
  }
}

module.exports = new CoinManager();