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
        } catch (err) {
            logger.error("❌ Error saving coins.json", { error: err });
        }
    }

    getAll() {
        return this.coins;
    }

    findByMint(mint) {
        return this.coins.find((c) => c.contract === mint);
    }

    filterByStatus(status) {
        return this.coins.filter((c) => c.status === status);
    }

    addOrUpdate(coin) {
        const index = this.coins.findIndex((c) => c.contract === coin.contract);
        if (index !== -1) {
            this.coins[index] = { ...this.coins[index], ...coin };
        } else {
            this.coins.push(coin);
        }
    }

    deleteByMint(mint) {
        this.coins = this.coins.filter((c) => c.contract !== mint);
    }
}

module.exports = new CoinStore();