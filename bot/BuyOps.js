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
                if (entry.status !== "hold") continue;

                if (!entry.token || !entry.token.mint) {
                    logger.warn(`⚠️ [BuyOps] Skipping entry with missing token or mint during evaluation`);
                    continue;
                }

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
                    const decision = evaluateTrade(entry, config);
                    if (!decision) {
                        logger.debug(`⛔ [BuyOps] No buy for ${entry.token?.symbol || "UNKNOWN"} — evaluation returned false`);
                    } else {
                        logger.info(`✅ [BuyOps] Buy signal confirmed for ${entry.token?.symbol || "UNKNOWN"} — passing strategy check`);
                        logger.debug(`[BuyOps] Preparing to swap ${entry.token.symbol} (${entry.token.mint})`);
                        entry.status = "target";
                    }
                }

                CoinStore.addOrUpdate(entry);
            }

            await CoinStore.save();

            // Execute buys
            let buys = 0;

            for (const entry of CoinStore.getAll()) {
                logger.debug(`[BuyOps] Checking buy eligibility for ${entry.token.symbol}`);
                if (buys >= openSlots) break;
                
                if (!entry.token || !entry.token.mint) {
                    logger.warn(`⚠️ [BuyOps] Skipping invalid entry with missing token or mint`);
                    continue;
                }

                const liveData = await fetchChartData(entry.token.mint);
                const priceNow = liveData?.oclhv?.at(-1)?.close;

                if (!priceNow) {
                    logger.warn(`⚠️ [BuyOps] No live price for ${entry.token.symbol}, skipping swap.`);
                    continue;
                }

                const analysisPrice = entry.chartData?.oclhv?.at(-1)?.close;
                const diff = Math.abs(priceNow - analysisPrice) / analysisPrice;

                if (diff > config.maxAllowedPriceChange) {
                    logger.warn(`📉 [BuyOps] Live price moved too much for ${entry.token.symbol} (${(diff * 100).toFixed(2)}%) — skipping swap`);
                    continue;
                }

                const token = entry.token;
                // const requiredFields = ['mint', 'symbol', 'market'];
                const requiredFields = ['mint', 'symbol'];
                const missing = requiredFields.filter(f => !token?.[f]);

                if (missing.length > 0) {
                    logger.warn(`⚠️ [BuyOps] Incomplete token data for ${token?.symbol || "UNKNOWN"} — missing: ${missing.join(", ")}`);
                    continue;
                }

                if (
                    !bot.overwatch.positions.has(entry.token.mint) &&
                    !bot.buyingTokens.has(entry.token.mint)
                ) {
                    logger.debug(`[BuyOps] Attempting swap for ${entry.token.symbol}`);
                    // Log the state of buyingTokens before adding the token
                    logger.debug(`[BuyOps] buyingTokens before swap: ${[...bot.buyingTokens]}`);
                    
                    // Log the arguments being passed to performSwap
                    logger.debug(`[BuyOps] performSwap args: token = { mint: ${entry.token.mint}, symbol: ${entry.token.symbol} }, isBuy: true, overwatch keys: ${Object.keys(bot.overwatch).join(", ")}`);
                    
                    bot.buyingTokens.add(entry.token.mint);
                    
                    bot.swapManager.performSwap(bot, { token: entry.token }, true, bot.overwatch)
                        .then(() => {
                            logger.info(`💸 [BuyOps] Swap executed for ${entry.token.symbol}`);
                        })
                        .catch((err) => {
                            logger.error("❌ [BuyOps] Swap failed", { token: entry.token?.symbol || "UNKNOWN", error: err });
                        })
                        .finally(() => {
                            bot.buyingTokens.delete(entry.token.mint);
                            logger.debug(`[BuyOps] Removed ${entry.token.mint} from buyingTokens.`);
                            logger.debug(`[BuyOps] buyingTokens after swap: ${[...bot.buyingTokens]}`);
                        });
                    buys++;
                }
            }
        } catch (err) {
            logger.error(`🔥 [BuyOps] Unhandled error: ${err.message}`, {
                stack: err.stack,
                error: err
            });
        }

        await sleep(config.delay);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}