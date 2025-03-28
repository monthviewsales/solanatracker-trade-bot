const { calculateIndicators } = require("../lib/indicators");
const {
    fetchTrendingTokens,
    fetchChartData,
} = require("../lib/solanaTrackerAPI");
const { filterTokens } = require("../lib/tokenUtils");

const { evaluateTrade } = require("../lib/indicators");
const logger = require("../utils/logger");

module.exports = {
    start(bot) {
        buyMonitor(bot);
    },
};

async function buyMonitor(bot) {
    const { CoinStore, config } = bot;

    while (true) {
        try {
            const openPositions = CoinStore.filterByStatus("open").length;
            const maxActive = config.maxActivePositions;
            const openSlots = maxActive - openPositions;

            if (openSlots <= 0) {
                await sleep(config.delay);
                continue;
            }

            const trending = await fetchTrendingTokens(config.trendingtimeframe);
            const filtered = filterTokens(trending, CoinStore);

            // Add new coins to CoinStore as "hold"
            for (const token of filtered) {
                const mint = token.token.mint;
                let entry = CoinStore.findByMint(mint);

                if (!entry) {
                    entry = {
                        token: token.token,
                        status: "hold",
                        chartData: {},
                    };
                    CoinStore.addOrUpdate(entry);
                }
            }

            await CoinStore.save();

            // Chart data + indicators + evaluate signals
            for (const entry of CoinStore.getAll()) {
                if (entry.status === "hold") {
                    await sleep(50); // back to fast mode now that rate limiter is lifted
                    const rawChartData = await fetchChartData(entry.token.mint);
                    const chartData = rawChartData.oclhv || [];
                    
                    // Store only the latest 50 candles to keep coins.json lean and performant.
                    // This is enough for indicators like RSI, EMA, and BB without bloating the file.
                    if (!Array.isArray(chartData) || chartData.length === 0) {
                        logger.warn(`⚠️ [BuyOps] Empty chart data for ${entry.token?.symbol || "UNKNOWN"}`);
                        CoinStore.addOrUpdate(entry);
                        continue;
                    }

                    const trimmedChart = chartData.slice(-50);
                    entry.chartData = { oclhv: trimmedChart };

                    if (!chartData || chartData.length < 20) {
                        entry.chartData = { oclhv: chartData };
                        logger.warn(`📉 [BuyOps] Chart data too short for ${entry.token?.symbol || "UNKNOWN"} — skipping`);
                        CoinStore.addOrUpdate(entry);
                        continue;
                    }

                    const indicators = calculateIndicators(trimmedChart);
                    if (!indicators || Object.keys(indicators).length === 0) {
                        logger.warn(`🧮 [BuyOps] No indicators generated for ${entry.token?.symbol || "UNKNOWN"}`);
                    } else {
                        logger.debug(`📊 [BuyOps] Indicators for ${entry.token?.symbol || "UNKNOWN"}: ${JSON.stringify(indicators)}`);
                        entry.indicators = indicators;
                        const isBuy = evaluateTrade(entry, config);
                        if (isBuy) {
                            logger.info(`🟢 [BuyOps] BUY SIGNAL for ${entry.token?.symbol || "UNKNOWN"}`);
                            entry.status = "target";
                        } else {
                            logger.debug(`⛔ [BuyOps] No buy: ${entry.token?.symbol || "UNKNOWN"} failed strategy check`);
                        }
                    }

                    CoinStore.addOrUpdate(entry);
                }
            }

            await CoinStore.save();

            // Execute buys
            let buys = 0;

            for (const entry of CoinStore.getAll()) {
                if (buys >= openSlots) break;
                if (entry.status !== "target") continue;

                if (
                    !bot.positions.has(entry.token.mint) &&
                    !bot.buyingTokens.has(entry.token.mint)
                ) {
                    bot.buyingTokens.add(entry.token.mint);
                    bot.performSwap({ token: entry.token }, true, bot.overwatch).catch((err) => {
                        logger.error("❌ [BuyOps] Swap failed", { token: entry.token?.symbol || "UNKNOWN", error: err });
                    });
                    buys++;
                }
            }
        } catch (err) {
            logger.error("🔥 [BuyOps] Unhandled error", { error: err });
        }

        await sleep(config.delay);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}