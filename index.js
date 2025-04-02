require("dotenv").config();
const { Keypair, Connection } = require("@solana/web3.js");
const bs58 = require("bs58");
const logger = require('./utils/logger');
const WalletManager = require("./lib/WalletManager");
const SwapManager = require("./lib/SwapManager");
const Overwatch = require("./lib/OverWatch");
const CoinStore = require('./lib/CoinStore');
const { SolanaTracker } = require("solana-swap");

const EventEmitter = require('events');
const runStartup = require('./bot/StartupManager');

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
    this.keypair = Keypair.fromSecretKey(bs58.decode ? bs58.decode(this.privateKey) : bs58.default.decode(this.privateKey));
    this.publicKeyb58 = String(this.keypair.publicKey.toBase58());
    this.connection = new Connection(this.config.rpcUrl);
    this.walletManager = new WalletManager(this.connection, this.privateKey, this.keypair, this.publicKeyb58);
    this.solanaTracker = new SolanaTracker(this.keypair, this.config.rpcUrl);
    this.swapManager = new SwapManager({
      connection: this.connection,
      privateKey: this.privateKey,
      keypair: this.keypair,
      publicKeyb58: this.publicKeyb58,
      config: this.config,
      soldPositionsFile: './soldPositions.json',
      positionsFile: './positions.json',
      solanaTracker: this.solanaTracker
    });
    this.overwatch = new Overwatch(this.connection, this.walletManager, this.keypair);
    this.buyingTokens = new Set();
    this.sellingPositions = new Set();
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

    try {
      // Fetch the latest trending coins
      const trendingCoins = await this.solanaTracker.getTrendingTokens();
      logger.info(`🔄 Syncing trending coins on startup...`);
      await CoinStore.syncTrendingCoins(trendingCoins);
      logger.info("✅ Trending coins synced successfully.");
    } catch (error) {
      logger.error("❌ Error syncing trending coins during startup.", { error: error.message });
    }

    this.once('startup:complete', () => {
      logger.info("🟢 Startup complete. Launching operations...");
      this.startHeartbeat();
      (async () => {
        try {
          await Promise.all([
            require("./bot/BuyOps").start(this),
            require("./bot/SellOps").start(this)
          ]);
        } catch (err) {
          logger.error("🔥 Error during operations startup", { error: err });
        }
      })();
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