require("dotenv").config();
const { SolanaTracker } = require("solana-swap");
const { Keypair, PublicKey, Connection } = require("@solana/web3.js");
const bs58 = require("bs58");
const chalk = require("chalk");
const axios = require("axios");
const logger = require('./utils/logger');
const fs = require("fs").promises;
// API Work
const {
  fetchTrendingTokens,
  fetchChartData,
} = require('./lib/solanaTrackerAPI');

const EventEmitter = require('events');
const runStartup = require('./bot/StartupManager');

const session = axios.create({
  baseURL: "https://data.solanatracker.io/",
  timeout: 10000,
  headers: { "x-api-key": process.env.API_KEY },
});

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

class TradingBot extends EventEmitter {
  constructor() {
    super(); 
    this.walletAmountCache = new Map(); // mint => { amount, timestamp }
    this.walletCacheTTL = 60000; // 1 minute
    this.config = {
      amount: parseFloat(process.env.AMOUNT),
      delay: parseInt(process.env.DELAY),
      monitorInterval: parseInt(process.env.MONITOR_INTERVAL),
      trendingtimeframe: process.env.TREND_TIME,
      slippage: parseInt(process.env.SLIPPAGE),
      priorityFee: parseFloat(process.env.PRIORITY_FEE),
      useJito: process.env.JITO === "true",
      rpcUrl: process.env.RPC_URL,
      minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 0,
      maxLiquidity: parseFloat(process.env.MAX_LIQUIDITY) || Infinity,
      minMarketCap: parseFloat(process.env.MIN_MARKET_CAP) || 0,
      maxMarketCap: parseFloat(process.env.MAX_MARKET_CAP) || Infinity,
      minRiskScore: parseInt(process.env.MIN_RISK_SCORE) || 0,
      maxRiskScore: parseInt(process.env.MAX_RISK_SCORE) || 6,
      requireSocialData: process.env.REQUIRE_SOCIAL_DATA === "true",
      maxNegativePnL: parseFloat(process.env.MAX_NEGATIVE_PNL) || -Infinity,
      maxPositivePnL: parseFloat(process.env.MAX_POSITIVE_PNL) || Infinity,
      markets: process.env.MARKETS?.split(",").map((m) => m.trim()) || ['raydium', 'orca', 'pumpfun', 'moonshot', 'raydium-cpmm'],
      maxActivePositions: parseInt(process.env.MAX_ACTIVE_POSITIONS) || 5,
    };

    this.privateKey = process.env.PRIVATE_KEY;
    this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
    this.positions = new Map();
    this.positionsFile = "positions.json";
    this.soldPositionsFile = "sold_positions.json";
    this.soldPositions = [];
    this.seenTokens = new Set();
    this.buyingTokens = new Set();
    this.sellingPositions = new Set();

    // This is our coin stoage for now
    this.targetListFile = "target_list.json";
    this.targetList = [];

    this.connection = new Connection(this.config.rpcUrl);
  }

  filterTokens(tokens) {
    return tokens.filter((token) => {
      // Check target list override
      const targetEntry = this.targetList.find(entry => entry.contract === token.token.mint || entry.symbol === token.token.symbol);
      if (targetEntry) {
        if (targetEntry.status === "blacklist" || targetEntry.status === "hold") {
          return false;
        } else if (targetEntry.status === "target") {
          return true;
        }
      }

      const pool = token.pools?.[0];
      if (!pool) return false;
      const liquidity = pool.liquidity.usd;
      const marketCap = pool.marketCap.usd;
      const riskScore = token.risk.score;
      const hasSocialData = !!(
        token.token.twitter ||
        token.token.telegram ||
        token.token.website
      );
      const isInAllowedMarket = this.config.markets.includes(pool.market);

      return (
        liquidity >= this.config.minLiquidity &&
        liquidity <= this.config.maxLiquidity &&
        marketCap >= this.config.minMarketCap &&
        marketCap <= this.config.maxMarketCap &&
        riskScore >= this.config.minRiskScore &&
        riskScore <= this.config.maxRiskScore &&
        (!this.config.requireSocialData || hasSocialData) &&
        isInAllowedMarket &&
        !this.seenTokens.has(token.token.mint) &&
        !this.buyingTokens.has(token.token.mint)
      );
    });
  }

  async getWalletAmount(wallet, mint, retries = 3) {
    const now = Date.now();
    const cached = this.walletAmountCache.get(mint);
    if (cached && (now - cached.timestamp < this.walletCacheTTL)) {
      return cached.amount;
    }
    await sleep(5000); // Initial pause before attempts
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const tokenAccountInfo =
          await this.connection.getParsedTokenAccountsByOwner(
            new PublicKey(wallet),
            {
              mint: new PublicKey(mint),
            }
          );

        if (tokenAccountInfo.value) {
          const balance =
            tokenAccountInfo.value[0].account.data.parsed.info.tokenAmount
              .uiAmount;

          if (balance > 0) {
            this.walletAmountCache.set(mint, { amount: balance, timestamp: Date.now() });
            logger.info(`Wallet balance for token ${mint}: ${balance}`);
            return balance;
          }
        }

        if (attempt < retries) {
          const backoff = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s...
          if (attempt % 2 === 0) {
            logger.warn(`Retry ${attempt + 1}/${retries + 1} getting wallet for ${mint}`);
          }
          await sleep(backoff);
        }
      } catch (error) {
        if (attempt < retries) {
          const backoff = 5000 * Math.pow(2, attempt);
          await sleep(backoff);
        } else {
          logger.error(
            `All attempts failed. Error getting wallet amount for token ${mint}:`,
            error
          );
        }
      }
    }

    logger.warn(
      `Failed to get wallet amount for token ${mint} after ${retries} retries.`
    );
    return null;
  }

  async performSwap(token, isBuy) {
    // Use token.token if available; otherwise, fallback to token directly.
    const tokenInfo = token.token || token;
    if (!tokenInfo?.symbol || !tokenInfo?.mint) {
      logger.error("Invalid tokenInfo passed to performSwap", { token });
      return false;
    }
    logger.info(
      `${isBuy ? chalk.white("[BUYING]") : chalk.white("[SELLING]")
      } [${this.keypair.publicKey.toBase58()}] [${tokenInfo.symbol}] [${tokenInfo.mint}]`
    );

    const { amount, slippage, priorityFee } = this.config;
    // Determine the swap tokens based on buy or sell.
    const [fromToken, toToken] = isBuy
      ? [this.SOL_ADDRESS, tokenInfo.mint]
      : [tokenInfo.mint, this.SOL_ADDRESS];
    const poolData = token.pools ? token.pools[0] : null;

    try {
      let swapAmount;
      if (isBuy) {
        swapAmount = amount;
      } else {
        const position = this.positions.get(tokenInfo.mint);
        if (!position) {
          logger.error(
            `No position found for ${tokenInfo.symbol} when trying to sell`
          );
          return false;
        }
        swapAmount = position.amount;
      }


      const swapResponse = await this.solanaTracker.getSwapInstructions(
        fromToken,
        toToken,
        swapAmount,
        slippage,
        this.keypair.publicKey.toBase58(),
        priorityFee
      );

      const swapOptions = this.buildSwapOptions();
      const txid = await this.solanaTracker.performSwap(
        swapResponse,
        swapOptions
      );
      this.logTransaction(txid, isBuy, { token: tokenInfo });

      if (isBuy) {
        const tokenAmount = await this.getWalletAmount(
          this.keypair.publicKey.toBase58(),
          tokenInfo.mint
        );
        if (!tokenAmount) {
          logger.error(`Swap failed for ${tokenInfo.mint}`);
          return false;
        }
        this.positions.set(tokenInfo.mint, {
          txid,
          symbol: tokenInfo.symbol,
          entryPrice: poolData ? poolData.price.quote : 0,
          amount: tokenAmount,
          openTime: Date.now(),
        });
        this.seenTokens.add(tokenInfo.mint);
        this.buyingTokens.delete(tokenInfo.mint);
      } else {
        const position = this.positions.get(tokenInfo.mint);
        if (position) {
          const exitPrice = poolData ? poolData.price.quote : 0;
          const pnl = (exitPrice - position.entryPrice) * position.amount;
          const pnlPercentage =
            (pnl / (position.entryPrice * position.amount)) * 100;

          const soldPosition = {
            ...position,
            exitPrice,
            pnl,
            pnlPercentage,
            closeTime: Date.now(),
            closeTxid: txid,
          };

          this.soldPositions.push(soldPosition);
          logger.info(
            `Closed position for ${tokenInfo.symbol}. PnL: (${pnlPercentage.toFixed(2)}%)`
          );
          this.positions.delete(tokenInfo.mint);
          this.sellingPositions.delete(tokenInfo.mint);
          await this.saveSoldPositions();
        }
      }

      await this.savePositions();
      this.walletAmountCache.delete(tokenInfo.mint);
      return txid;
    } catch (error) {
      logger.error(`Swap failed for ${isBuy ? "buy" : "sell"} [${tokenInfo.symbol}] [${tokenInfo.mint}]`, {
        message: error.message,
        response: error.response?.data,
        stack: error.stack,
      poolData: poolData ? poolData : "No pool data",
      });
      logger.debug(`Full token data on swap failure: ${JSON.stringify(token, null, 2)}`);
      if (isBuy) {
        this.buyingTokens.delete(tokenInfo.mint);
      } else {
        this.sellingPositions.delete(tokenInfo.mint);
      }
      return false;
    }
  }

  buildSwapOptions() {
    return {
      sendOptions: { skipPreflight: true },
      confirmationRetries: 30,
      confirmationRetryTimeout: 1000,
      lastValidBlockHeightBuffer: 150,
      resendInterval: 1000,
      confirmationCheckInterval: 1000,
      commitment: "processed",
      jito: this.config.useJito ? { enabled: true, tip: 0.0001 } : undefined,
    };
  }

  logTransaction(txid, isBuy, token) {
    logger.info(
      `${isBuy ? chalk.green("[BOUGHT]") : chalk.red("[SOLD]")} ${
        token.token.symbol
      } [${txid}]`
    );
  }

  async loadSoldPositions() {
    try {
      const data = await fs.readFile(this.soldPositionsFile, "utf8");
      this.soldPositions = JSON.parse(data);
      logger.info(
        `Loaded ${this.soldPositions.length} sold positions from file`
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Error loading sold positions", { error });
      }
    }
  }

  async saveSoldPositions() {
    try {
      await fs.writeFile(
        this.soldPositionsFile,
        JSON.stringify(this.soldPositions, null, 2)
      );
        logger.info(`Saved ${this.soldPositions.length} sold positions to file`);
    } catch (error) {
      logger.error("Error saving sold positions", { error });
    }
  }

  async saveTargetList() {
    try {
      const fileContent = `/*\nData specification for target list:\n{\n  "targets": [\n    {\n      "symbol": "TOKEN_SYMBOL",\n      "contract": "TOKEN_CONTRACT_ADDRESS",\n      "status": "hold", // possible values: "hold", "target", "blacklist"\n      "chartData": {} // one minute OHLCV data\n    }\n  ]\n}\n*/\n{\n  "targets": ${JSON.stringify(this.targetList, null, 2)}\n}`;
      await fs.writeFile(this.targetListFile, fileContent);
      logger.info(`Saved ${this.targetList.length} target list entries to ${this.targetListFile}`);
    } catch (error) {
      logger.error("Error saving target list", { error });
    }
  }

  async loadTargetList() {
    try {
      const data = await fs.readFile(this.targetListFile, "utf8");
      // Remove header comments if present
      const jsonData = data.replace(/\/\*[\s\S]*?\*\//, "").trim();
      const parsed = JSON.parse(jsonData);
      this.targetList = parsed.targets;
      logger.info(`Loaded ${this.targetList.length} target list entries from ${this.targetListFile}`);
    } catch (error) {
      if (error.code === "ENOENT") {
        logger.warn(`${this.targetListFile} not found. Starting with empty target list.`);
        this.targetList = [];
        // Create the file with a header comment and empty target list
        await fs.writeFile(
          this.targetListFile,
          `/*\nData specification for target list:\n{\n  "targets": [\n    {\n      "symbol": "TOKEN_SYMBOL",\n      "contract": "TOKEN_CONTRACT_ADDRESS",\n      "status": "hold", // possible values: "hold", "target", "blacklist"\n      "chartData": {} // one minute OHLCV data\n    }\n  ]\n}\n*/\n{\n  "targets": []\n}`
        );
      } else {
        logger.error("Error loading target list", { error });
      }
    }
  }
  
  async loadPositions() {
    try {
      const data = await fs.readFile(this.positionsFile, "utf8");
      const loadedPositions = JSON.parse(data);
      this.positions = new Map(Object.entries(loadedPositions));
      this.seenTokens = new Set(this.positions.keys());
      logger.info(`Loaded ${this.positions.size} positions from file`);
    } catch (error) {
      if (error.code === "ENOENT") {
        logger.warn("positions.json not found. Starting fresh.");
        await this.savePositions();
      } else {
        logger.error("Error loading positions", { error });
      }
    }
  }

  async savePositions() {
    try {
      const positionsObject = Object.fromEntries(this.positions);
      await fs.writeFile(
        this.positionsFile,
        JSON.stringify(positionsObject, null, 2)
      );
      logger.info(`Saved ${this.positions.size} positions to file`);
    } catch (error) {
      logger.error("Error saving positions", { error });
    }
  }

  async updatePositionWalletCache() {
    const wallet = this.keypair.publicKey.toBase58();
    for (const mint of this.positions.keys()) {
      await this.getWalletAmount(wallet, mint);
    }
    logger.info('Updated wallet cache for loaded positions');
  }

  startHeartbeat() {
    setInterval(() => {
      logger.info(`Heartbeat: monitoring ${this.positions.size} open positions`);
    }, 30000);
  }

  async validatePositions() {
    logger.info("Validating loaded positions with wallet balances...");

    let removed = 0;
    for (const [mint, position] of this.positions.entries()) {
      const balance = await this.getWalletAmount(this.keypair.publicKey.toBase58(), mint);
      if (!balance || balance === 0) {
        logger.warn(`Removing stale position for ${position.symbol} (${mint}) — no balance in wallet.`);
        this.positions.delete(mint);
        this.seenTokens.delete(mint);
        
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
        
        try {
          await this.saveSoldPositions();
          logger.info(`Logged manual sale of ${position.symbol} to sold_positions.json`);
        } catch (e) {
          logger.error("Error writing to sold_positions.json", { message: e.message });
        }
        
        removed++;
      }
    }

    if (removed > 0) {
      await this.savePositions();
      logger.info(`Removed ${removed} stale position(s) from positions file.`);
    } else {
      logger.info("All loaded positions are valid.");
    }
  }

  async start() {
    logger.info("🚀 Starting Trading Bot...");

    this.once('startup:complete', () => {
      logger.info("🟢 Startup complete. Launching operations...");
      this.startHeartbeat();
      require("./bot/BuyOps").start(this);
      require("./bot/SellOps").start(this);
    });

    this.once('startup:error', (err) => {
      logger.error("🔥 Startup failed. Exiting.", { error: err });
      process.exit(1);
    });

    await runStartup(this);
  }
}

const bot = new TradingBot();
bot.start().catch((error) => console.error("Error in bot execution", error));