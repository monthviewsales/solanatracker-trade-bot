const fs = require("fs").promises;
const logger = require("../utils/logger");

function normalizeCoin(coin) {
  if (!coin) return {};
  if (!coin.token) {
    coin.token = {};
  }
  // If token.mint is missing but token.address exists, assign token.mint from token.address
  if (!coin.token.mint && coin.token.address) {
    coin.token.mint = coin.token.address;
  }
  // You can add additional normalization logic here if needed to enforce the baseline schema
  return coin;
}

const COIN_FILE = "coins.json";

class CoinStore {
    constructor() {
        this.coins = [];
    }

    async load() {
        try {
            const data = await fs.readFile(COIN_FILE, "utf8");
            this.coins = JSON.parse(data);
            this.coins = this.coins.map((coin) => {
                coin = normalizeCoin(coin);
                return {
                    ...coin,
                    position: {
                        highestPrice: coin.position?.highestPrice ?? coin.entryPrice,
                        sl: coin.position?.sl ?? coin.entryPrice * (1 - parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.05),
                        amount: coin.position?.amount ?? 1,
                    },
                    buys: coin.buys ?? [],
                    sells: coin.sells ?? [],
                    lastUpdated: coin.lastUpdated ?? Date.now(),
                };
            });
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
        coin = normalizeCoin(coin);
        if (!coin?.token?.mint) {
            logger.warn("⚠️ [CoinStore] Skipping addOrUpdate — missing token or mint");
            return;
        }
        const index = this.coins.findIndex((c) => c.token?.mint === coin.token?.mint);
        if (index !== -1) {
            const existing = this.coins[index];
            const incoming = coin;
            logger.debug(`[CoinStore] Updating coin ${existing.token?.symbol} (mint: ${existing.token?.mint}). Existing status: ${existing.status}, incoming status: ${incoming.status}`);
            
            // Ensure consistency of position fields
            const updatedPosition = {
                highestPrice: Number.isFinite(incoming.position?.highestPrice) ? incoming.position.highestPrice : existing.position?.highestPrice ?? incoming.entryPrice,
                sl: Number.isFinite(incoming.position?.sl) ? incoming.position.sl : (existing.position?.sl ?? incoming.entryPrice * (1 - parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.05)),
                amount: Number.isFinite(incoming.position?.amount) ? incoming.position.amount : existing.position?.amount ?? 1,
            };
            
            // Log any corrections made
            if (!Number.isFinite(updatedPosition.highestPrice) || !Number.isFinite(updatedPosition.sl) || !Number.isFinite(updatedPosition.amount)) {
                logger.warn(`[CoinStore] Corrected inconsistent position data for ${incoming.token?.symbol || "UNKNOWN"}`);
            }

            this.coins[index] = {
                ...existing,
                ...incoming,
                position: updatedPosition,
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
                position: {
                    ...coin.position,
                    highestPrice: coin.position?.highestPrice ?? coin.entryPrice,
                    sl: coin.position?.sl ?? coin.entryPrice * (1 - parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.05),
                    amount: coin.position?.amount ?? 1
                },
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

    async syncTrendingCoins(trendingCoins) {
        try {
            // Fetch all existing coins
            const existingCoins = this.getAll();

            // Prepare a set of trending mints for fast lookup
            const trendingMints = new Set(trendingCoins.map((coin) => coin.token && coin.token.mint));

            // Prepare the updated list
            const updatedCoins = existingCoins.filter((coin) => {
                // Keep coins that are trending or marked as "open" or "hold"
                if (trendingMints.has(coin.token?.mint) || ["open", "hold"].includes(coin.status)) {
                    return true;
                } else {
                    logger.info(`🗑️ Removing non-trending coin: ${coin.token?.symbol} (mint: ${coin.token?.mint})`);
                    return false;
                }
            });

            // Add new trending coins that aren't in the existing list
            trendingCoins.forEach((trendingCoin) => {
                if (!existingCoins.some((c) => c.token?.mint === trendingCoin.token?.mint)) {
                    const newCoin = {
                        token: {
                            mint: trendingCoin.token?.mint,
                            symbol: trendingCoin.token?.symbol || "UNKNOWN",
                        },
                        status: "target",
                        position: {
                            highestPrice: trendingCoin.price ?? 0,
                            sl: (trendingCoin.price ?? 0) * (1 - parseFloat(process.env.TRAILING_STOP_PERCENT) || 0.05),
                            amount: 1,
                        },
                        addedAt: Date.now(),
                        lastUpdated: Date.now(),
                    };
                    this.addOrUpdate(newCoin);
                    logger.info(`➕ Added new trending coin: ${trendingCoin.token?.symbol} (mint: ${trendingCoin.token?.mint})`);
                }
            });

            // Save the updated list to file
            this.coins = updatedCoins;
            await this.save();
            logger.info(`✅ Trending coins sync complete. Total coins: ${updatedCoins.length}`);
        } catch (error) {
            logger.error("❌ Error syncing trending coins", { error: error.message });
        }
    }
}

module.exports = new CoinStore();