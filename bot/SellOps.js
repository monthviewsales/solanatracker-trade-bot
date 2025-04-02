const { fetchChartData } = require("../lib/solanaTrackerAPI");
const { calculateIndicators, evaluateSell } = require("../lib/indicators");
const logger = require("../utils/logger");

module.exports = {
    async start(bot) {
        await monitorPositions(bot);
    },
};

async function monitorPositions(bot) {
    const { CoinStore, config } = bot;

    while (true) {
        try {
            const openPositions = CoinStore.filterByStatus("open");

            const positionChecks = openPositions.map(async (entry) => {
                try {
                    const mint = entry.token.mint;
                    logger.debug(`[SellOps] Processing entry for ${entry.token.symbol || 'UNKNOWN'}: position exists = ${Boolean(entry.position)}, sellingPositions contains ${mint} = ${bot.sellingPositions.has(mint)}`);
                    if (entry.status !== "open" || bot.sellingPositions.has(mint)) return;

                    const rawChartData = await fetchChartData(entry.token.mint);

                    const chartData = rawChartData.oclhv || [];

                    if (!Array.isArray(chartData) || chartData.length === 0) {
                        logger.warn(`[SellOps] Empty chart data for ${entry.token.symbol || 'UNKNOWN'} — skipping sell`);
                        return;
                    }

                    // Trim to the last 50 candles
                    const trimmedChart = chartData.slice(-50);
                    entry.chartData = { oclhv: trimmedChart };

                    if (chartData.length < 20) {
                        logger.warn(`[SellOps] Chart data too short for ${entry.token.symbol || 'UNKNOWN'} (got ${chartData.length} data points, require at least 20) — skipping sell`);
                        return;
                    }

                    const indicators = calculateIndicators(trimmedChart);
                    if (!indicators || Object.keys(indicators).length === 0) {
                        logger.warn(`[SellOps] Unable to calculate indicators for ${entry.token.symbol || 'UNKNOWN'} — skipping sell`);
                        return;
                    }

                    entry.indicators = indicators;

                    const shouldSell = evaluateSell(entry, entry.position, config);
                    if (!shouldSell) {
                        logger.debug(`🟡 [SellOps] Hold signal for ${entry.token.symbol} — sell conditions not met`);
                        return;
                    }

                    const live = await bot.api.fetchLivePriceData(entry.token.mint);
                    if (!live || live.liquidity < config.MIN_LIQUIDITY) {
                        logger.warn(`⛔ [SellOps] Live check blocked sell for ${entry.token.symbol} — liquidity: ${live?.liquidity ?? 'N/A'}`);
                        return;
                    }

                    const token = entry.token;
                    const requiredFields = ['mint', 'symbol', 'market'];
                    const missing = requiredFields.filter(f => !token?.[f]);

                    if (missing.length > 0) {
                        logger.warn(`⚠️ [SellOps] Incomplete token data for ${token?.symbol || "UNKNOWN"} — missing: ${missing.join(", ")}`);
                        bot.sellingPositions.delete(mint);
                        return;
                    }

                    bot.sellingPositions.add(mint);

                    const txid = await bot.swapManager.performSwap(bot, entry, false, bot.overwatch);

                    if (txid) {
                        entry.status = "hold";
                        entry.sold = {
                            exitPrice: chartData.at(-1)?.close || 0,
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
                    logger.error(`❌ [SellOps] Error processing ${entry.token?.symbol || "UNKNOWN"}`, {
                        message: err.message,
                        stack: err.stack,
                    });
                    bot.sellingPositions.delete(mint);
                }
            });

            await Promise.allSettled(positionChecks);
        } catch (err) {
            logger.error("🔥 [SellOps] Main loop error", { error: err });
            await sleep(config.errorRetryDelay || 5000); // Graceful retry after an error
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