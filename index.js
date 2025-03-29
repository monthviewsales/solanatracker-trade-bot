require("dotenv").config();
const { Keypair, PublicKey, Connection } = require("@solana/web3.js");
const bs58 = require("bs58");
const chalk = require("chalk");
const axios = require("axios");
const logger = require('./utils/logger');
const fs = require("fs").promises;
const WalletManager = require("./lib/WalletManager");
const SwapManager = require("./lib/SwapManager");
const Overwatch = require("./lib/OverWatch");
// API Work
const {
  fetchTrendingTokens,
  fetchChartData,
} = require('./lib/solanaTrackerAPI');
const { SolanaTracker } = require("solana-swap");

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
      maxAllowedPriceChange: parseFloat(process.env.MAX_PRICE_DIFF) || 0.02,
      markets: process.env.MARKETS?.split(",").map((m) => m.trim()) || ['raydium', 'orca', 'pumpfun', 'moonshot', 'raydium-cpmm'],
      maxActivePositions: parseInt(process.env.MAX_ACTIVE_POSITIONS) || 5,
    };

    this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
    
    this.privateKey = process.env.PRIVATE_KEY;
    
    this.connection = new Connection(this.config.rpcUrl);
    this.walletManager = new WalletManager(this.connection);
    this.swapManager = new SwapManager(this.connection, this.config, this.keypair, this.SOL_ADDRESS);
    this.overwatch = new Overwatch(this.connection, this.walletManager, this.keypair);
    
    this.buyingTokens = new Set();

    this.keypair = Keypair.fromSecretKey(bs58.decode ? bs58.decode(this.privateKey) : bs58.default.decode(this.privateKey));
    this.solanaTracker = new SolanaTracker(this.keypair, this.config.rpcUrl);
  }

  startHeartbeat() {
    setInterval(() => {
      logger.info(`Heartbeat: monitoring ${this.overwatch.positions.size} open positions`);
    }, 30000);
  }

  async start() {
    logger.info("🚀 Starting Trading Bot...");

    await this.overwatch.loadPositions();
    await this.overwatch.loadSoldPositions();
    await this.overwatch.validatePositions();

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