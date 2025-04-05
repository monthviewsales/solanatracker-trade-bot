const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const { SolanaTracker } = require("solana-swap");
const logger = require("../utils/logger");
const CoinManager = require("../lib/CoinManager");

module.exports = async function runStartup(bot) {
    try {
        logger.info("🔧 [STARTUP] Initializing wallet and RPC...");
        bot.keypair = Keypair.fromSecretKey(bs58.decode(bot.privateKey));
        bot.solanaTracker = new SolanaTracker(bot.keypair, bot.config.rpcUrl);

        logger.info("📥 [STARTUP] Loading unified coins.json...");
        await CoinManager.loadCoins();

        const allCoins = CoinManager.getAllCoins();
        const openPositions = allCoins.filter(coin => coin.status === 'open');
        const targets = allCoins.filter(coin => coin.status === 'target');

        logger.info(`✅ [STARTUP] Loaded ${openPositions.length} open positions`);
        logger.info(`🎯 [STARTUP] Loaded ${targets.length} targets`);

        // Optionally, validate open positions against on-chain data
        for (const coin of openPositions) {
            logger.info(`🔍 Validating position: ${coin.symbol}`);
            // You could call SolanaTracker to confirm balances or txs
        }

        // Attach the store to the bot for use in BuyOps/SellOps
        bot.CoinManager = CoinManager;

        logger.info("✅ [STARTUP] Startup phase complete.");
        bot.emit('startup:complete');

    } catch (err) {
        logger.error("❌ [STARTUP] Error during initialization", { error: err });
        bot.emit('startup:error', err);
    }
};
