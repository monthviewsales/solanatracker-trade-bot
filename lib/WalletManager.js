const { PublicKey } = require("@solana/web3.js");
const logger = require("../utils/logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WalletManager {
    constructor(connection, walletCacheTTL = 60000) {
        this.connection = connection;
        this.walletAmountCache = new Map();
        this.walletCacheTTL = walletCacheTTL;
    }

    async getWalletAmount(wallet, mint, retries = 3) {
        const now = Date.now();
        const cached = this.walletAmountCache.get(mint);
        if (cached && now - cached.timestamp < this.walletCacheTTL) {
            return cached.amount;
        }

        await sleep(5000);

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const tokenAccountInfo = await this.connection.getParsedTokenAccountsByOwner(
                    new PublicKey(wallet),
                    { mint: new PublicKey(mint) }
                );

                if (tokenAccountInfo.value?.length > 0) {
                    const balance = tokenAccountInfo.value[0].account.data.parsed.info.tokenAmount.uiAmount;
                    if (balance > 0) {
                        this.walletAmountCache.set(mint, { amount: balance, timestamp: Date.now() });
                        logger.info(`💰 [Wallet] Balance for ${mint}: ${balance}`);
                        return balance;
                    }
                }

                if (attempt < retries) {
                    const backoff = 5000 * Math.pow(2, attempt);
                    if (attempt % 2 === 0) {
                        logger.warn(`⏳ [Wallet] Retry ${attempt + 1}/${retries + 1} fetching balance for ${mint}`);
                    }
                    await sleep(backoff);
                }
            } catch (error) {
                if (attempt < retries) {
                    const backoff = 5000 * Math.pow(2, attempt);
                    await sleep(backoff);
                } else {
                    logger.error(`❌ [Wallet] Failed to fetch balance for ${mint} after all retries`, error);
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
