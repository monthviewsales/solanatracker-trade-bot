const fs = require("fs").promises;
const logger = require("../utils/logger");
const CoinStore = require("./CoinStore");

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
  }

  async loadPositions() {
    try {
      const data = await fs.readFile(this.positionsFile, "utf8");
      const loaded = JSON.parse(data);
      this.positions = new Map(Object.entries(loaded));
      logger.info(`📦 [Overwatch] Loaded ${this.positions.size} open positions`);
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
      this.soldPositions = JSON.parse(data);
      logger.info(`📤 [Overwatch] Loaded ${this.soldPositions.length} sold positions`);
    } catch (err) {
      if (err.code !== "ENOENT") {
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

  async validatePositions() {
    logger.info("🧹 [Overwatch] Validating wallet balances for active positions...");
    let removed = 0;

    for (const [mint, position] of this.positions.entries()) {
      const balance = await this.walletManager.getWalletAmount(this.keypair.publicKey.toBase58(), mint);
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

  tagBuy({ mint, qty, entryPrice, txid }) {
    const coin = this.coinStore.findByMint(mint);
    if (!coin) {
      logger.warn(`tagBuy: Could not find coin for mint ${mint}`);
      return;
    }

    const timestamp = Date.now();
    const buyEntry = { qty, entryPrice, txid, timestamp };

    coin.buys = coin.buys || [];
    coin.buys.push(buyEntry);

    // Update current position (replace or combine)
    coin.position = { qty, entryPrice, txid, timestamp };
    coin.status = "hold";

    this.coinStore.addOrUpdate(coin);
    logger.info(`🟢 [BUY] ${coin.token.symbol} (${mint}) — qty: ${qty}, price: ${entryPrice}`);
  }

  tagSell({ mint, qty, exitPrice, txid }) {
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

    this.coinStore.addOrUpdate(coin);
    logger.info(`🔴 [SELL] ${coin.token.symbol} (${mint}) — qty: ${qty}, exit: ${exitPrice}, PnL: ${pnl.toFixed(6)} (${pnlPct.toFixed(2)}%)`);
  }
}

module.exports = Overwatch;
