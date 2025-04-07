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
    if (!coin) return {};
    if (!coin.token) {
      coin.token = {};
      logger.warn('⚠️ [normalizeCoin] Missing token; initialized as empty object.');
    }
    // If token.mint is missing but token.address exists, assign token.mint
    if (!coin.token.mint && coin.token.address) {
      coin.token.mint = coin.token.address;
      logger.warn('⚠️ [normalizeCoin] Missing token.mint; assigned from token.address.');
    }
    if (!coin.token.symbol || coin.token.symbol.trim() === '') {
      coin.token.symbol = 'UNKNOWN';
      logger.warn('⚠️ [normalizeCoin] Missing token.symbol; set to "UNKNOWN".');
    }
    if (!coin.token.symbol || coin.token.symbol === "UNKNOWN") {
      logger.warn(`[CoinManager] Symbol missing or unknown for ${coin.token.mint}, fetching details...`);
      await this.updateCoinWithDetails(coin);
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
          let coin = {
            token: {
              mint: tokenEntry.address,
              symbol: tokenEntry.symbol || 'UNKNOWN'
            },
            status: coinStatus,
            position: {
              amount: tokenEntry.balance,
              entryPrice: undefined,
              highestPrice: undefined,
              sl: undefined,
              timestamp: Date.now(),
              lastValidated: Date.now()
            },
            buys: [],
            sells: [],
            lastUpdated: Date.now()
          };
          const updateCoin = await fetchTokenDetails(tokenEntry.address);
          coin.price = updateCoin;
          coin.symbol = updateCoin;
          coin = await this.normalizeCoin(coin); // Ensure completeness
          this.addOrUpdateCoin(coin);
          logger.debug(`[CoinManager] Added coin: ${tokenEntry.symbol || coin.token.mint} / ${tokenEntry.address} with status ${coinStatus}`);
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
  addOrUpdateCoin(coin) {
    coin = this.normalizeCoin(coin); // Ensure completeness
    if (!coin.token || !coin.token.mint) {
      logger.warn('⚠️ [CoinManager] Skipping addOrUpdate — missing token or mint');
      return;
    }
    const index = this.coins.findIndex((c) => c.token.mint === coin.token.mint);
    if (index !== -1) {
      const existing = this.coins[index];
      // Update position fields with consistency
      const updatedPosition = {
        highestPrice: Number.isFinite(coin.position?.highestPrice)
          ? coin.position.highestPrice
          : existing.position?.highestPrice ?? coin.position.entryPrice,
        sl: Number.isFinite(coin.position?.sl)
          ? coin.position.sl
          : existing.position?.sl ?? coin.position.entryPrice * (1 - TRAILING_STOP_PERCENT),
        amount: Number.isFinite(coin.position?.amount)
          ? coin.position.amount
          : existing.position?.amount ?? 1
      };
      this.coins[index] = {
        ...existing,
        ...coin,
        position: updatedPosition,
        token: {
          ...existing.token,
          ...coin.token
        },
        buys: coin.buys !== undefined ? coin.buys : existing.buys,
        sells: coin.sells !== undefined ? coin.sells : existing.sells,
        lastUpdated: Date.now()
      };
      logger.debug(`[CoinManager] Updated coin ${this.coins[index].token?.symbol} (mint: ${this.coins[index].token?.mint})`);
    } else {
      this.coins.push({
        ...coin,
        position: coin.position ? {
          ...coin.position,
          highestPrice: (coin.position.highestPrice !== undefined)
            ? coin.position.highestPrice
            : (coin.position.entryPrice !== undefined ? coin.position.entryPrice : 0),
          sl: (coin.position.sl !== undefined)
            ? coin.position.sl
            : (coin.position.entryPrice !== undefined ? coin.position.entryPrice * (1 - TRAILING_STOP_PERCENT) : undefined),
          amount: coin.position.amount ?? 1
        } : {},
        buys: coin.buys || [],
        sells: coin.sells || [],
        lastUpdated: Date.now()
      });
      logger.debug(`[CoinManager] Added new coin ${coin.token?.symbol} (mint: ${coin.token?.mint})`);
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
          const latestBuy = tradeHistory.trades.find(trade => trade.type === 'buy');
          if (latestBuy) {
            coin.position = coin.position || {};
            coin.position.entryPrice = latestBuy.priceUsd;
            logger.info(`[CoinManager] Filled missing entryPrice for ${tokenSymbol} with value: ${coin.position.entryPrice}`);
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