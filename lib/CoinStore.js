const fs = require("fs").promises;
const logger = require("../utils/logger");

const COIN_FILE = "coins.json";

class CoinStore {
    constructor() {
        this.coins = [];
    }

    async load() {
        try {
            const data = await fs.readFile(COIN_FILE, "utf8");
            this.coins = JSON.parse(data);
            logger.info(`🔄 Loaded ${this.coins.length} coins from ${COIN_FILE}`);
        } catch (err) {
            if (err.code === "ENOENT") {
                logger.warn(`${COIN_FILE} not found. Starting fresh.`);
                this.coins = [];
                await this.save();
            } else {
                logger.error("❌ Error loading coins.json", { error: err });
            }
        }
    }

    async save() {
        try {
            await fs.writeFile(COIN_FILE, JSON.stringify(this.coins, null, 2));
            logger.info(`💾 Saved ${this.coins.length} coins to ${COIN_FILE}`);
            logger.debug(`[CoinStore] Saved coins: ${this.coins.map(c => c.token?.symbol).join(", ")}`);
        } catch (err) {
            logger.error("❌ Error saving coins.json", { error: err });
        }
    }

    getAll() {
        return this.coins;
    }

    findByMint(mint) {
        return this.coins.find((c) => c.token?.mint === mint);
    }

    hasPosition(mint) {
        const coin = this.findByMint(mint);
        return !!coin?.position;
    }

    filterByStatus(status) {
        return this.coins.filter((c) => c.status === status);
    }

    addOrUpdate(coin) {
        if (!coin?.token?.mint) {
            logger.warn("⚠️ [CoinStore] Skipping addOrUpdate — missing token or mint");
            return;
        }
        const index = this.coins.findIndex((c) => c.token?.mint === coin.token?.mint);
        if (index !== -1) {
            const existing = this.coins[index];
            const incoming = coin;
            logger.debug(`[CoinStore] Updating coin ${existing.token?.symbol} (mint: ${existing.token?.mint}). Existing status: ${existing.status}, incoming status: ${incoming.status}`);
            this.coins[index] = {
                ...existing,
                ...incoming,
                token: {
                    ...existing.token,
                    ...incoming.token
                },
                chartData: incoming.chartData !== undefined
                    ? { ...existing.chartData, ...incoming.chartData }
                    : existing.chartData,
                indicators: incoming.indicators !== undefined
                    ? { ...existing.indicators, ...incoming.indicators }
                    : existing.indicators,
                lastUpdated: Date.now()
            };
            logger.debug(`[CoinStore] Updated coin ${this.coins[index].token?.symbol} to new status: ${this.coins[index].status}.`);
        } else {
            this.coins.push({
                ...coin,
                position: coin.position ?? null,
                buys: coin.buys ?? [],
                sells: coin.sells ?? [],
                lastUpdated: Date.now()
            });
            logger.debug(`[CoinStore] Added new coin ${coin.token?.symbol} (mint: ${coin.token?.mint}) with status ${coin.status}`);
        }
    }

    deleteByMint(mint) {
        this.coins = this.coins.filter((c) => c.token?.mint !== mint);
    }
}

module.exports = new CoinStore();