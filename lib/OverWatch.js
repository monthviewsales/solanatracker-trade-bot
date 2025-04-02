const fs = require("fs").promises;
const logger = require("../utils/logger");
const CoinStore = require("./CoinStore");
require("dotenv").config(); // Assuming config is imported from a config file

class Overwatch {
  constructor(connection, walletManager, keypair) {
    this.connection = connection;
    this.walletManager = walletManager;
    this.keypair = keypair;

    this.positionsFile = "positions.json";
    this.soldPositionsFile = "sold_positions.json";

    this.positions = new Map();
    this.soldPositions = [];
    this.coinStore = CoinStore;
    this.startValidationTimer();
  }

  async loadPositions() {
    const trailingStopPercent = parseFloat(process.env.TRAILING_STOP_PERCENT);
    try {
      const data = await fs.readFile(this.positionsFile, "utf8");
      if (!data.trim()) {
        logger.warn("Positions file is empty. Initializing with empty set.");
        this.positions = new Map();
        await this.savePositions();
        return;
      }
      try {
        const loaded = JSON.parse(data);
        this.positions = new Map(Object.entries(loaded));
        for (const [mint, position] of this.positions.entries()) {
          if (!position.highestPrice) position.highestPrice = position.entryPrice;
          if (!position.sl) position.sl = position.entryPrice * (1 - trailingStopPercent);
          logger.info(`[Overwatch] Added missing highestPrice and sl for ${position.symbol} during load.`);
        }
        logger.info(`📦 [Overwatch] Loaded ${this.positions.size} open positions`);
      } catch (parseErr) {
        logger.error("Malformed positions.json — falling back to empty set", { error: parseErr });
        await fs.writeFile(this.positionsFile + ".bak", data);
        this.positions = new Map();
        await this.savePositions();
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        logger.warn("No positions file found. Starting fresh.");
        await this.savePositions();
      } else {
        logger.error("Error loading positions", { error: err });
      }
    }
  }

  async savePositions() {
    try {
      const obj = Object.fromEntries(this.positions);
      await fs.writeFile(this.positionsFile, JSON.stringify(obj, null, 2));
      logger.info(`💾 [Overwatch] Saved ${this.positions.size} open positions`);
    } catch (err) {
      logger.error("Error saving positions", { error: err });
    }
  }

  async loadSoldPositions() {
    try {
      const data = await fs.readFile(this.soldPositionsFile, "utf8");
      try {
        this.soldPositions = JSON.parse(data);
        logger.info(`📤 [Overwatch] Loaded ${this.soldPositions.length} sold positions`);
      } catch (parseErr) {
        logger.error("Malformed sold_positions.json — falling back to empty array", { error: parseErr });
        await fs.writeFile(this.soldPositionsFile + ".bak", data);
        this.soldPositions = [];
        await this.saveSoldPositions();
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        logger.warn("No sold positions file found. Starting fresh.");
        this.soldPositions = [];
        await this.saveSoldPositions();
      } else {
        logger.error("Error loading sold positions", { error: err });
      }
    }
  }

  async saveSoldPositions() {
    try {
      await fs.writeFile(this.soldPositionsFile, JSON.stringify(this.soldPositions, null, 2));
      logger.info(`💾 [Overwatch] Saved ${this.soldPositions.length} sold positions`);
    } catch (err) {
      logger.error("Error saving sold positions", { error: err });
    }
  }

  startValidationTimer() {
    // Run validatePositions every 60 seconds (60000ms)
    setInterval(async () => {
      logger.info('[Overwatch] Running periodic position validation...');
      await this.validatePositions();
    }, 60000);
  }

  async validatePositions() {
    logger.info("🧹 [Overwatch] Validating wallet balances for active positions...");
    let removed = 0;

    for (const [mint, position] of this.positions.entries()) {
      let balance;
      try {
        let result = await this.walletManager.getWalletAmount(this.keypair, mint);

        // If the API returns an object with an address, check it.
        if (result && typeof result === "object" && "address" in result && "balance" in result) {
          if (result.address !== mint) {
            logger.warn(`[Overwatch] Mismatch: API returned address ${result.address} for mint ${mint}. Skipping update for ${position.symbol}.`);
            continue;
          }
          balance = result.balance;
        } else {
          balance = result;
        }

        if (balance > 0 && balance < position.amount) {
          logger.warn(`🔄 [Overwatch] Updating position ${position.symbol} (${mint}) — stored amount ${position.amount} is greater than wallet balance ${balance}. Updating to actual balance.`);
          // Update the position's amount to reflect the actual wallet balance
          position.amount = balance;

          // Update the CoinStore entry if available
          const coin = this.coinStore.findByMint(mint);
          if (coin && coin.position) {
            coin.position.amount = balance;
            this.coinStore.addOrUpdate(coin);
          }
        }
      } catch (err) {
        logger.error(`Error retrieving wallet amount for mint ${mint}:`, { error: err });
        continue;
      }
      if (!balance || balance === 0) {
        logger.warn(`🗑️ [Overwatch] Removing stale position ${position.symbol} (${mint}) — no balance`);
        this.positions.delete(mint);

        const soldEntry = {
          txid: position.txid,
          symbol: position.symbol,
          entryPrice: position.entryPrice,
          amount: position.amount,
          openTime: position.openTime,
          exitPrice: 0,
          pnl: -position.entryPrice * position.amount,
          pnlPercentage: -100,
          closeTime: Date.now(),
          closeTxid: "MANUAL"
        };

        this.soldPositions.push(soldEntry);
        await this.saveSoldPositions();

        const coin = this.coinStore.findByMint(mint);
        if (coin) {
          delete coin.position;
          coin.status = "sold";
          this.coinStore.addOrUpdate(coin);
        }

        removed++;
      }
    }

    if (removed > 0) {
      await this.savePositions();
      logger.info(`🧼 [Overwatch] Removed ${removed} stale position(s)`);
    } else {
      logger.info("✅ [Overwatch] All open positions validated successfully");
    }
  }

  async tagBuy({ mint, qty, entryPrice, txid }) {
    try {
      const coin = this.coinStore.findByMint(mint);
      if (!coin) {
        logger.warn(`tagBuy: Could not find coin for mint ${mint}`);
        return;
      }

      const timestamp = Date.now();
      const trailingStopPercent = parseFloat(process.env.TRAILING_STOP_PERCENT);
      const stopLoss = entryPrice * (1 - trailingStopPercent);
      coin.position = { qty, entryPrice, highestPrice: entryPrice, sl: stopLoss, txid, timestamp };
      logger.info(`[Overwatch] Initialized position for ${coin.token.symbol} with entry price: ${entryPrice}, highest price: ${entryPrice}, stop loss: ${stopLoss}`);

      // Update the active positions map in Overwatch
      this.positions.set(mint, coin.position);

      this.coinStore.addOrUpdate(coin);
      logger.info(`🟢 [BUY] ${coin.token.symbol} (${mint}) — qty: ${qty}, price: ${entryPrice}`);

      await this.savePositions();
    } catch (err) {
      logger.error(`Error in tagBuy for mint ${mint}:`, { error: err });
      await this.savePositions();
    }
  }

  async tagSell({ mint, qty, exitPrice, txid }) {
    try {
      const coin = this.coinStore.findByMint(mint);
      if (!coin || !coin.position) {
        logger.warn(`tagSell: No active position for mint ${mint}`);
        return;
      }

      const timestamp = Date.now();
      const { entryPrice } = coin.position;
      const pnl = (exitPrice - entryPrice) * qty;
      const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;

      const sellEntry = { qty, exitPrice, txid, timestamp, pnl, pnlPct };
      coin.sells = coin.sells || [];
      coin.sells.push(sellEntry);

      // Remove position (assume full exit for now)
      delete coin.position;
      coin.status = "sold";
      this.positions.delete(mint);

      this.coinStore.addOrUpdate(coin);
      logger.info(`🔴 [SELL] ${coin.token.symbol} (${mint}) — qty: ${qty}, exit: ${exitPrice}, PnL: ${pnl.toFixed(6)} (${pnlPct.toFixed(2)}%)`);

      await this.savePositions();
    } catch (err) {
      logger.error(`Error in tagSell for mint ${mint}:`, { error: err });
      await this.savePositions();
    }
  }
}

module.exports = Overwatch;
