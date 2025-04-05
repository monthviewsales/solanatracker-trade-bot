const { fetchChartData } = require("../lib/solanaTrackerAPI");
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
        if (!entry.token || !entry.token.mint) {
            logger.warn(`[SellOps] Skipping entry with missing token or mint for ${entry.token?.symbol || 'UNKNOWN'}`);
            return;
        }
        const mint = entry.token.mint;
        logger.debug(`[SellOps] Processing entry for ${entry.token.symbol || 'UNKNOWN'}: position exists = ${Boolean(entry.position)}, sellingPositions contains ${mint} = ${bot.sellingPositions.has(mint)}`);
        if (entry.status !== "open" || bot.sellingPositions.has(mint)) return;

        const chartData = await validateSellData(entry, bot, config, chartCache);
        if (!chartData) return; // Skip processing if data validation fails

        await executeSell(entry, bot, config, chartData);
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
    let rawChartData;
    if (chartCache.has(mint)) {
        rawChartData = chartCache.get(mint);
    } else {
        rawChartData = await fetchChartDataWithRetry(mint);
        chartCache.set(mint, rawChartData);
    }

    const chartData = rawChartData.oclhv || [];
    if (!Array.isArray(chartData) || chartData.length === 0) {
        logger.warn(`[SellOps] Empty chart data for ${entry.token.symbol || 'UNKNOWN'} — skipping sell`);
        return null;
    }

    // Trim to the last 50 candles
    const trimmedChart = chartData.slice(-50);
    entry.chartData = { oclhv: trimmedChart };

    if (chartData.length < 20) {
        logger.warn(`[SellOps] Chart data too short for ${entry.token.symbol || 'UNKNOWN'} (got ${chartData.length} data points, require at least 20) — skipping sell`);
        return null;
    }

    const indicators = calculateIndicators(trimmedChart);
    if (!indicators || Object.keys(indicators).length === 0) {
        logger.warn(`[SellOps] Unable to calculate indicators for ${entry.token.symbol || 'UNKNOWN'} — skipping sell`);
        return null;
    }

    entry.indicators = indicators;
    return chartData;
}

async function executeSell(entry, bot, config, chartData) {
    const mint = entry.token.mint;

    // Evaluate sell decision
    const shouldSell = evaluateSell(entry, entry.position, config);
    if (!shouldSell) {
        logger.debug(`🟡 [SellOps] Hold signal for ${entry.token.symbol} — sell conditions not met`);
        return;
    }

    // Fetch live price data
    const live = bot.api?.fetchLivePriceData ? await bot.api.fetchLivePriceData(mint) : null;
    if (!live) {
        logger.warn(`⛔ [SellOps] Unable to fetch live price data for ${entry.token.symbol} — skipping sell`);
        return;
    }
    if (live.liquidity < config.MIN_LIQUIDITY) {
        logger.warn(`⛔ [SellOps] Live check blocked sell for ${entry.token.symbol} — liquidity: ${live?.liquidity ?? 'N/A'}`);
        return;
    }

    // Validate required token fields
    const token = entry.token;
    const requiredFields = ['mint', 'symbol', 'market'];
    const missing = requiredFields.filter(f => !token?.[f]);
    if (missing.length > 0) {
        logger.warn(`⚠️ [SellOps] Incomplete token data for ${token?.symbol || "UNKNOWN"} — missing: ${missing.join(", ")}`);
        bot.sellingPositions.delete(mint);
        return;
    }

    bot.sellingPositions.add(mint);

    const txid = await bot.swapManager.performSwap(bot, entry, false);

    // Prepare sell data for CoinManager
    const sellData = {
        exitPrice: chartData.at(-1)?.close || 0,
        txid: txid,
        qty: entry.position?.amount || 1
    };
    // Use CoinManager to close the position
    await CoinManager.closePosition(mint, sellData);
    logger.info(`💸 [SELL] ${entry.token?.symbol || "UNKNOWN"} sold at ${sellData.exitPrice}`);

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