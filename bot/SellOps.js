const { fetchChartData, fetchLivePriceData, getChartDataWithCache } = require("../lib/solanaTrackerAPI");
const { calculateIndicators, evaluateSell } = require("../lib/indicators");
const logger = require("../utils/logger");
// Use the unified CoinManager
const CoinManager = require("../lib/CoinManager");

module.exports = {
    async start(bot) {
        await monitorPositions(bot);
    },
};

async function monitorPositions(bot) {
    const { config } = bot;

    while (true) {
        try {
            const chartCache = new Map();
            const openPositions = CoinManager.getAllCoins().filter(coin => coin.status === "open");
            const positionChecks = openPositions.map((entry) => processPosition(entry, bot, config, chartCache));

            await Promise.allSettled(positionChecks);
        } catch (err) {
            logger.error("🔥 [SellOps] Main loop error", { error: err });
            await sleep(config.errorRetryDelay || 5000); // Graceful retry after an error
        }

        await sleep(config.monitorInterval);
    }
}

async function processPosition(entry, bot, config, chartCache) {
    try {
        const tokenSymbol = entry.token?.symbol || entry.price?.token?.symbol || 'UNKNOWN';
        if (!entry.token || !entry.token.mint) {
            logger.warn(`[SellOps] Skipping entry with missing token or mint for ${tokenSymbol}`);
            return;
        }
        const mint = entry.token.mint;
        logger.debug(`[SellOps] Processing entry for ${tokenSymbol}: position exists = ${Boolean(entry.position)}, sellingPositions contains ${mint} = ${bot.sellingPositions.has(mint)}`);
        if (entry.status !== "open" || bot.sellingPositions.has(mint)) {
            logger.debug(`[SellOps] Skipping position for ${tokenSymbol} — status: ${entry.status}, already selling: ${bot.sellingPositions.has(mint)}`);
            return;
        }

        const chartData = await getChartDataWithCache(mint, chartCache);
        if (!chartData) return; // Skip processing if data validation fails

        const priceNow = chartData?.at(-1)?.close || 0;
        const entryPrice = entry.position?.entryPrice || 0;
        if (Math.abs(priceNow - entryPrice) / entryPrice > config.maxAllowedPriceChange) {
            logger.warn(`[SellOps] Price difference too large for ${tokenSymbol} — skipping sell`);
            return;
        }

        const requiredFields = ['mint', 'symbol', 'amount', 'entryPrice'];
        const missingFields = requiredFields.filter(f => !entry.token?.[f]);
        if (missingFields.length > 0) {
            logger.warn(`⚠️ [SellOps] Missing required fields for ${tokenSymbol} — ${missingFields.join(", ")}`);
            bot.sellingPositions.delete(mint);
            return;
        }

        const shouldSell = evaluateSell(entry, entry.position, config);
        if (!shouldSell) {
            logger.debug(`[SellOps] Hold signal for ${tokenSymbol} — sell conditions not met`);
            return;
        }

        const live = bot.api && bot.api.fetchLivePriceData ? await bot.api.fetchLivePriceData(mint) : await fetchLivePriceData(mint);
        if (!live) {
            logger.warn(`⛔ [SellOps] Unable to fetch live price data for ${tokenSymbol} — skipping sell`);
            return;
        }
        if (live.liquidity < config.MIN_LIQUIDITY) {
            logger.warn(`⛔ [SellOps] Insufficient liquidity for ${tokenSymbol} — skipping sell`);
            return;
        }

        if (bot.sellingPositions.has(mint)) {
            logger.warn(`[SellOps] Duplicate sell attempt detected for ${tokenSymbol} — already in progress`);
            return;
        }
        bot.sellingPositions.add(mint);

        try {
            const txid = await bot.swapManager.performSwap(bot, entry, false);
            const sellData = {
                exitPrice: chartData.at(-1)?.close || 0,
                txid: txid,
                qty: entry.position?.amount || 1
            };
            await CoinManager.closePosition(mint, sellData);
            logger.info(`💸 [SELL] ${tokenSymbol} sold at ${sellData.exitPrice} — TXID: ${txid}`);
        } catch (err) {
            logger.error(`❌ [SellOps] Swap failed for ${tokenSymbol} — ${err.message}`);
            bot.sellingPositions.delete(mint);
            return;
        }
        bot.sellingPositions.delete(mint);
        if (!bot.sellingPositions.has(mint)) {
            logger.info(`[SellOps] Cleared selling position for ${tokenSymbol} after successful swap.`);
        }
    } catch (err) {
        logger.error(`❌ [SellOps] Error processing ${entry.token?.symbol || "UNKNOWN"}`, {
            message: err.message,
            stack: err.stack,
        });
        bot.sellingPositions.delete(entry.token?.mint);
    }
}

async function fetchChartDataWithRetry(mint, retries = 2, delayMs = 500) {
    let attempt = 0;
    while (attempt <= retries) {
        try {
            const start = Date.now();
            const data = await fetchChartData(mint);
            const duration = Date.now() - start;
            logger.debug(`[SellOps] fetchChartData for ${mint} took ${duration}ms`);
            return data;
        } catch (err) {
            attempt++;
            if (attempt > retries) throw err;
            await sleep(delayMs);
        }
    }
}

async function validateSellData(entry, bot, config, chartCache) {
    const mint = entry.token.mint;
    const chartData = await getChartDataWithCache(mint, chartCache);
    if (!chartData) return null;

    const rawChartData = chartData.oclhv || [];
    if (!Array.isArray(rawChartData) || rawChartData.length === 0) {
        logger.warn(`[SellOps] Empty chart data for ${entry.token?.symbol || entry.price?.token?.symbol || 'UNKNOWN'} — skipping sell`);
        return null;
    }

    // Trim to the last 50 candles
    const trimmedChart = rawChartData.slice(-50);
    entry.chartData = { oclhv: trimmedChart };

    if (rawChartData.length < 20) {
        logger.warn(`[SellOps] Chart data too short for ${entry.token?.symbol || entry.price?.token?.symbol || 'UNKNOWN'} (got ${rawChartData.length} data points, require at least 20) — skipping sell`);
        return null;
    }

    const indicators = calculateIndicators(trimmedChart);
    if (!indicators || Object.keys(indicators).length === 0) {
        logger.warn(`[SellOps] Unable to calculate indicators for ${entry.token?.symbol || entry.price?.token?.symbol || 'UNKNOWN'} — skipping sell`);
        return null;
    }

    entry.indicators = indicators;
    return chartData;
}

async function executeSell(entry, bot, config, chartData) {
    const mint = entry.token.mint;
    if (!entry.token.symbol && entry.price && entry.price.token && entry.price.token.symbol) {
        entry.token.symbol = entry.price.token.symbol;
    }

    // Validate required token fields using the new schema
    const token = entry.token;
    // Use token.symbol if available, otherwise fallback to entry.price.token.symbol
    const tokenSymbol = token?.symbol || entry.price?.token?.symbol || 'UNKNOWN';

    const shouldSell = evaluateSell(entry, entry.position, config);
    if (!shouldSell) {
        logger.debug(`[SellOps] Hold signal for ${tokenSymbol} — sell conditions not met`);
        return;
    }

    // Fetch live price data
    const live = bot.api && bot.api.fetchLivePriceData ? await bot.api.fetchLivePriceData(mint) : await fetchLivePriceData(mint);
    if (!live) {
        logger.warn(`⛔ [SellOps] Unable to fetch live price data for ${tokenSymbol} — skipping sell`);
        return;
    }
    if (live.liquidity < config.MIN_LIQUIDITY) {
        logger.warn(`⛔ [SellOps] Live check blocked sell for ${tokenSymbol} — liquidity: ${live?.liquidity ?? 'N/A'}`);
        return;
    }

    bot.sellingPositions.add(mint);

    try {
        const txid = await bot.swapManager.performSwap(bot, entry, false);
        const sellData = {
            exitPrice: chartData.at(-1)?.close || 0,
            txid: txid,
            qty: entry.position?.amount || 1
        };
        await CoinManager.closePosition(mint, sellData);
        logger.info(`💸 [SELL] ${tokenSymbol} sold at ${sellData.exitPrice}`);
    } catch (err) {
        logger.error(`❌ [SellOps] Failed to execute sell for ${tokenSymbol}`, { error: err.message });
        bot.sellingPositions.delete(mint);
        return;
    }
    bot.sellingPositions.delete(mint);
}

function calculatePnL(entry, percentage = false) {
    const entryPrice = Number.isFinite(entry?.position?.entryPrice) ? entry.position.entryPrice : 0;
    const amount = Number.isFinite(entry?.position?.amount) ? entry.position.amount : 1;
    const exitPrice = Number.isFinite(entry?.sold?.exitPrice) ? entry.sold.exitPrice : (entry.chartData?.oclhv?.at(-1)?.close || entry.position?.entryPrice);
    
    if (entryPrice === 0 || amount === 0) {
        return percentage ? 0 : 0;
    }

    const pnl = (exitPrice - entryPrice) * amount;
    if (percentage) {
        return (pnl / (entryPrice * amount)) * 100;
    }
    return pnl;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}