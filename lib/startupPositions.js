const fs = require("fs").promises;
const logger = require("../utils/logger");
const CoinStore = require("./CoinStore");
const { tradeHist } = require("./solanaTrackerAPI")
require("dotenv").config();

async function main() {
  const positionsFile = "positions.json";
  const soldPositionsFile = "sold_positions.json";
  let positions = new Map();
  let soldPositions = [];
  const trailingStopPercent = parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.1;
  const trailingTakeProfitPercent = parseFloat(process.env.TRAILING_TP_PERCENT) || 0.05;

  // Load positions from file
  try {
    const data = await fs.readFile(positionsFile, "utf8");
    if (data.trim()) {
      const loaded = JSON.parse(data);
      positions = new Map(Object.entries(loaded));
      //  Add code to check position.entryPrice if it doesnt exist use the APIs to get it.

      // Normalize each position: set highestPrice and stop loss if not set
      for (const [mint, position] of positions.entries()) {
        if (!position.highestPrice) {
          position.highestPrice = position.entryPrice;
        }
        if (!position.sl) {
          position.sl = position.entryPrice * (1 - trailingStopPercent);
        }
        if (!position.tp) {
          position.tp = position.entryPrice + (position.entryPrice * trailingTakeProfitPercent);
        }
        logger.info(`Initialized position for ${position.symbol} (${mint})`);
      }
    } else {
      logger.warn("Positions file is empty. Starting with empty positions.");
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      logger.warn("Positions file not found. Starting fresh with empty positions.");
    } else {
      logger.error("Error reading positions file", { error: err });
    }
  }

  // Load sold positions from file
  try {
    const data = await fs.readFile(soldPositionsFile, "utf8");
    if (data.trim()) {
      soldPositions = JSON.parse(data);
      logger.info(`Loaded ${soldPositions.length} sold positions`);
    } else {
      logger.warn("Sold positions file is empty. Starting with empty sold positions.");
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      logger.warn("Sold positions file not found. Starting fresh with empty sold positions.");
    } else {
      logger.error("Error reading sold positions file", { error: err });
    }
  }

  // Simulated walletManager for demo purposes.
  // Replace this with your actual walletManager implementation.
  const walletManager = {
    async getWalletAmount(mint) {
      // Replace with a real call. For now, randomly simulate a balance.
      return Math.random() > 0.5 ? Math.floor(Math.random() * 10) + 1 : 0;
    }
  };

  // Validate positions by checking wallet balances
  let removed = 0;
  let updated = false;
  for (const [mint, position] of positions.entries()) {
    try {
      const balance = await walletManager.getWalletAmount(mint);
      // If balance is non-zero but less than what's recorded, update the position amount.
      if (balance > 0 && balance < position.amount) {
        logger.warn(`Updating position ${position.symbol} (${mint}): stored amount ${position.amount} > wallet balance ${balance}`);
        position.amount = balance;
        updated = true;
      }
      // If balance is zero, remove the position and log it as a sold position.
      if (!balance || balance === 0) {
        logger.warn(`Removing stale position ${position.symbol} (${mint}): wallet balance is ${balance}`);
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
        soldPositions.push(soldEntry);
        positions.delete(mint);
        removed++;
      }
    } catch (err) {
      logger.error(`Error checking wallet balance for ${mint}`, { error: err });
    }
  }

  if (removed > 0 || updated) {
    logger.info(`Positions updated: ${removed} removed, ${updated ? 'some updated' : 'none updated'}.`);
  } else {
    logger.info("All positions validated successfully.");
  }

  // Save updated positions
  try {
    const obj = Object.fromEntries(positions);
    await fs.writeFile(positionsFile, JSON.stringify(obj, null, 2));
    logger.info(`Saved ${positions.size} open positions to ${positionsFile}`);
  } catch (err) {
    logger.error("Error saving positions", { error: err });
  }

  // Save sold positions
  try {
    await fs.writeFile(soldPositionsFile, JSON.stringify(soldPositions, null, 2));
    logger.info(`Saved ${soldPositions.length} sold positions to ${soldPositionsFile}`);
  } catch (err) {
    logger.error("Error saving sold positions", { error: err });
  }
}

main()
  .then(() => {
    logger.info("Startup positions script completed.");
    process.exit(0);
  })
  .catch(err => {
    logger.error("Startup positions script failed.", { error: err });
    process.exit(1);
  });