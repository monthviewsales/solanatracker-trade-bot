const { calculateIndicators } = require("../lib/indicators");
const {
    fetchTrendingTokens,
    fetchTokenDetails,
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
                    const chartData = await fetchChartData(entry.contract);
                    entry.chartData = chartData;

                    const indicators = calculateIndicators(chartData?.oclhv);
                    if (indicators) {
                        entry.indicators = indicators;
                        const isBuy = evaluateTrade(entry, config);
                        if (isBuy) {
                            entry.status = "target";
                        }
                    } else {
                        logger.warn(`[BuyOps] Not enough data to calculate indicators for ${entry.symbol}`);
                    }
                }
            }

            await CoinStore.save();

            // Execute buys
            let buys = 0;

            for (const entry of CoinStore.getAll()) {
                if (buys >= openSlots) break;
                if (entry.status !== "target") continue;

                const tokenData = await fetchTokenDetails(entry.contract);

                if (
                    tokenData &&
                    !bot.positions.has(entry.contract) &&
                    !bot.buyingTokens.has(entry.contract)
                ) {
                    bot.buyingTokens.add(entry.contract);

                    bot.performSwap({ token: tokenData }, true).catch((err) => {
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