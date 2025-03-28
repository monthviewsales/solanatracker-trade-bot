const { fetchChartData } = require("../lib/solanaTrackerAPI");
const { calculateIndicators, evaluateSell } = require("../lib/indicators");
const logger = require("../utils/logger");

module.exports = {
    start(bot) {
        monitorPositions(bot);
    },
};

async function monitorPositions(bot) {
    const { CoinStore, config } = bot;

    while (true) {
        try {
            const openPositions = CoinStore.filterByStatus("open");

            const positionChecks = openPositions.map(async (entry) => {
                const mint = entry.token.mint;

                try {
                    const position = entry.position;
                    if (!position || bot.sellingPositions.has(mint)) return;

                    const chart = await fetchChartData(entry.token.mint);
                    entry.chartData = chart;

                    const indicators = calculateIndicators(chart?.oclhv);
                    entry.indicators = indicators;

                    const shouldSell = evaluateSell(entry, position, config);
                    if (!shouldSell) return;

                    bot.sellingPositions.add(mint);

                    const txid = await bot.performSwap({ token: entry.token }, false, bot.overwatch);

                    if (txid) {
                        entry.status = "sold";
                        entry.sold = {
                            exitPrice: chart.oclhv?.at(-1)?.close || 0,
                            pnl: calculatePnL(entry),
                            pnlPercentage: calculatePnL(entry, true),
                            closeTime: Date.now(),
                            closeTxid: txid,
                        };
                        delete entry.position;
                        await CoinStore.save();
                        logger.info(`💸 [SELL] ${entry.token?.symbol || "UNKNOWN"} sold at ${entry.sold.exitPrice}`);
                    }

                    bot.sellingPositions.delete(mint);
                } catch (err) {
                    logger.error(`❌ [SellOps] Error evaluating ${entry.token?.symbol || "UNKNOWN"}`, {
                        message: err.message,
                        stack: err.stack,
                    });
                    bot.sellingPositions.delete(mint);
                }
            });

            await Promise.allSettled(positionChecks);
        } catch (err) {
            logger.error("🔥 [SellOps] Main loop error", { error: err });
        }

        await sleep(config.monitorInterval);
    }
}

function calculatePnL(entry, percentage = false) {
    const entryPrice = entry?.position?.entryPrice || 0;
    const amount = entry?.position?.amount || 0;
    const exitPrice = entry?.sold?.exitPrice || 0;

    const pnl = (exitPrice - entryPrice) * amount;
    if (percentage) {
        return entryPrice > 0 ? (pnl / (entryPrice * amount)) * 100 : 0;
    }
    return pnl;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}