const fs = require('fs').promises;
const logger = require('../utils/logger');
const { tradeHist } = require("../lib/solanaTrackerAPI");

const COIN_FILE = 'coins.json';
const TRAILING_STOP_PERCENT = parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.05;

// Normalize coin to ensure it adheres to our baseline schema
function normalizeCoin(coin) {
  if (!coin) return {};
  if (!coin.token) {
    coin.token = {};
  }
  // If token.mint is missing but token.address exists, assign token.mint
  if (!coin.token.mint && coin.token.address) {
    coin.token.mint = coin.token.address;
  }
  return coin;
}

class CoinManager {
  constructor() {
    this.coins = [];
    this.validationInterval = null;
    this.debounceTimer = null; // Initialize debounce timer
  }
  
  // Add this new method inside the CoinManager class (e.g., before the closing brace)
  async resetCoinsFromWallet(walletManager, keypair) {
    logger.info("[CoinManager] Resetting coins from wallet...");
    // Clear the existing coins array
    this.coins = [];
    try {
      // Assume walletManager.getWalletTokens(keypair) returns an array of objects,
      // each with a structure like: { token: { mint, symbol, ... }, balance: number }
      const walletTokens = await walletManager.getWalletTokens(keypair);
      for (const tokenEntry of walletTokens) {
        // Only add tokens with a positive balance
        if (tokenEntry.balance > 0) {
          // Create a new coin entry with status "open"
          const coin = {
            token: tokenEntry.token,
            status: "open",
            position: {
              amount: tokenEntry.balance,
              // Leave entryPrice undefined so that fillMissingPositionData can update it later
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
          this.addOrUpdateCoin(coin);
        }
      }
      this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
      logger.info(`[CoinManager] Rebuilt coins.json with ${this.coins.length} coins from wallet.`);
    } catch (err) {
      logger.error(`[CoinManager] Error resetting coins from wallet: ${err.message}`, { error: err });
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
      this.coins = this.coins.map((coin) => {
        coin = normalizeCoin(coin);
        coin.position = coin.position || {};
        coin.position.highestPrice = coin.position.highestPrice ?? coin.position.entryPrice;
        coin.position.sl = coin.position.sl ?? (coin.position.entryPrice * (1 - TRAILING_STOP_PERCENT));
        coin.position.amount = coin.position.amount ?? 1;
        coin.buys = coin.buys || [];
        coin.sells = coin.sells || [];
        coin.lastUpdated = coin.lastUpdated || Date.now();
        return coin;
      });
      logger.info(`🔄 Loaded ${this.coins.length} coins from ${COIN_FILE}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn(`${COIN_FILE} not found. Starting fresh.`);
        this.coins = [];
        this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
      } else {
        logger.error('❌ Error loading coins.json', { error: err });
      }
    }
  }

  // Save coins to the unified data file
  async saveCoins() {
    try {
      await fs.writeFile(COIN_FILE, JSON.stringify(this.coins, null, 2));
      logger.info(`💾 Saved ${this.coins.length} coins to ${COIN_FILE}`);
    } catch (err) {
      logger.error('❌ Error saving coins.json', { error: err });
    }
  }

  // New method to fill missing required position data using trade history
  async debouncedSaveCoins() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    // Set a debounce delay (e.g., 1000ms). Adjust the delay as needed.
    this.debounceTimer = setTimeout(async () => {
      try {
        await fs.writeFile(COIN_FILE, JSON.stringify(this.coins, null, 2));
        logger.info(`💾 Saved ${this.coins.length} coins to ${COIN_FILE} (debounced)`);
      } catch (err) {
        logger.error('❌ Error saving coins.json (debounced)', { error: err });
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
    coin = normalizeCoin(coin);
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
    logger.info(`[CoinManager] Closed position for ${coin.token?.symbol} (mint: ${mint}). PnL: ${pnl.toFixed(6)} (${pnlPct.toFixed(2)}%)`);
    this.debouncedSaveCoins(); // Replace saveCoins with debouncedSaveCoins
  }

  // Validate open positions (simulate external wallet balance checks)
  async validatePositions(walletManager, keypair) {
    logger.info(`[CoinManager] Validating positions...`);
    const openCoins = this.coins.filter((coin) => coin.status === 'open' && coin.position);
    for (let coin of openCoins) {
      // Attempt to fill missing required position data (e.g., entryPrice)
      await this.fillMissingPositionData(coin, keypair.publicKey.toBase58());

      try {
        const mint = coin.token.mint;
        if (!walletManager || typeof walletManager.getWalletAmount !== 'function') {
          logger.error(`[CoinManager] Wallet manager not properly configured.`);
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
        logger.error(`[CoinManager] Error validating position for coin with mint ${coin.token?.mint}:`, { error: err });
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
        const tradeHistory = await tradeHist(coin.token.mint, publicKey);
        if (tradeHistory && Array.isArray(tradeHistory.trades) && tradeHistory.trades.length > 0) {
          // Find the latest 'buy' trade
          const latestBuy = tradeHistory.trades.find(trade => trade.type === 'buy');
          if (latestBuy) {
            coin.position = coin.position || {};
            coin.position.entryPrice = latestBuy.priceUsd;
            logger.info(`[CoinManager] Filled missing entryPrice for ${coin.token?.symbol} with value: ${coin.position.entryPrice}`);
          } else {
            logger.warn(`[CoinManager] No buy trade found in history for ${coin.token?.symbol}`);
          }
        } else {
          logger.warn(`[CoinManager] No trade history available for ${coin.token?.symbol}`);
        }
      } catch (err) {
        logger.error(`[CoinManager] Error fetching trade history for ${coin.token?.symbol}: ${err.message}`, { error: err });
      }
    }
  }
}

module.exports = new CoinManager();