const { fetchWalletBasic } = require("../lib/solanaTrackerAPI");
const logger = require("../utils/logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

this.buyingTokens = new Set();

class WalletManager {
    constructor(connection, privateKey, keypair, publicKeyb58, walletCacheTTL = 60000) {
        this.connection = connection;
        this.privateKey = privateKey;
        this.keypair = keypair;
        this.publicKeyb58 = publicKeyb58;
        this.walletAmountCache = new Map();
        this.walletCacheTTL = walletCacheTTL;
        logger.info(`[WalletManager] Initialized with publicKey: ${this.publicKeyb58}`);
    }

    async getWalletAmount(wallet, mint, retries = 3) {
        const publicKey = String(this.publicKeyb58);
        const now = Date.now();
        const cached = this.walletAmountCache.get(mint);
        if (cached && now - cached.timestamp < this.walletCacheTTL) {
            return cached.amount;
        }
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                logger.info(`🪙 Fetching wallet basic info for ${publicKey} (attempt ${attempt + 1}/${retries + 1})`);
                const walletInfo = await fetchWalletBasic(publicKey);
                logger.info(`Received wallet basic info for ${publicKey}: ${JSON.stringify(walletInfo, null, 2)}`);

                if (walletInfo.tokens && walletInfo.tokens.length > 0) {
                    const token = walletInfo.tokens.find(t => {
                      const canonical = t.mint || t.address;
                      return canonical === mint;
                    });
                    if (token) {
                        const balance = token.balance;
                        logger.info(`💰 [Wallet] Balance for ${mint}: ${balance}`);
                        this.walletAmountCache.set(mint, { amount: balance, timestamp: Date.now() });
                        return balance;
                    }
                }

                if (attempt < retries) {
                    logger.warn(`⏳ [Wallet] Retry ${attempt + 1}/${retries + 1} fetching balance for ${mint}`);
                }
            } catch (error) {
                logger.error(`Error fetching wallet basic info for ${wallet} on attempt ${attempt + 1}: ${error}`);
                if (attempt >= retries) {
                    logger.error(`❌ [Wallet] Failed to fetch wallet basic info for ${wallet} after all retries`, error);
                }
            }
        }

        logger.warn(`⚠️ [Wallet] Gave up on ${mint} — no balance after ${retries} retries`);
        return null;
    }

    async updatePositionWalletCache(wallet, positions) {
        for (const mint of positions.keys()) {
            await this.getWalletAmount(wallet, mint);
        }
        logger.info("🔄 [Wallet] Cache updated for all held positions");
    }
}

module.exports = WalletManager;
