const { calculateIndicators } = require("../lib/indicators");
const {
    fetchTrendingTokens,
    fetchChartData,
} = require("../lib/solanaTrackerAPI");

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
            const filtered = bot.filterTokens(trending); // this is your custom filter

            // Add new coins to CoinStore as "hold"
            for (const token of filtered) {
                const mint = token.token.mint;
                let entry = CoinStore.findByMint(mint);

                if (!entry) {
                    entry = {
                        symbol: token.token.symbol,
                        contract: mint,
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
                    const rawChartData = await fetchChartData(entry.contract);
                    const chartData = rawChartData.oclhv || [];
                    
                    // Store only the latest 50 candles to keep coins.json lean and performant.
                    // This is enough for indicators like RSI, EMA, and BB without bloating the file.
                    if (!Array.isArray(chartData) || chartData.length === 0) {
                        logger.warn(`[BuyOps] Invalid or empty chart data for ${entry.symbol}`);
                        CoinStore.addOrUpdate(entry);
                        continue;
                    }

                    const trimmedChart = chartData.slice(-50);
                    entry.chartData = { oclhv: trimmedChart };

                    if (!chartData || chartData.length < 20) {
                        entry.chartData = { oclhv: chartData };
                        logger.warn(`[BuyOps] Chart data too short for ${entry.symbol} — skipping`);
                        CoinStore.addOrUpdate(entry);
                        continue;
                    }

                    const indicators = calculateIndicators(trimmedChart);
                    if (!indicators || Object.keys(indicators).length === 0) {
                        logger.warn(`[BuyOps] Indicator calculation returned null or empty for ${entry.symbol}`);
                    } else {
                        logger.debug(`[BuyOps] Indicators for ${entry.symbol}: ${JSON.stringify(indicators)}`);
                        entry.indicators = indicators;
                        const isBuy = evaluateTrade(entry, config);
                        if (isBuy) {
                            logger.info(`[BuyOps] BUY SIGNAL for ${entry.symbol}`);
                            entry.status = "target";
                        } else {
                            logger.debug(`[BuyOps] Not buying ${entry.symbol}, failed filter check`);
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
                    !bot.positions.has(entry.contract) &&
                    !bot.buyingTokens.has(entry.contract)
                ) {
                    bot.buyingTokens.add(entry.contract);
                    bot.performSwap({ token: entry }, true).catch((err) => {
                        logger.error("Buy failed", { token: entry.symbol, error: err });
                    });
                    buys++;
                }
            }
        } catch (err) {
            logger.error("[BuyOps] Unexpected error", { error: err });
        }

        await sleep(config.delay);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}