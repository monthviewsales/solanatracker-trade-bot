require("dotenv").config();
const { calculateIndicators } = require("../lib/indicators");
const { fetchTrendingTokens, fetchChartData, getTRXHistory, tradeHist } = require("../lib/solanaTrackerAPI");
const { filterTokens } = require("../lib/tokenUtils");
const { evaluateBuy } = require("../lib/indicators");
const logger = require("../utils/logger");
// Assume CoinManager is now used instead of CoinStore
const CoinManager = require("../lib/CoinManager");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTrendingEntry(tokenEntry) {
    return {
        token: tokenEntry.token,
        pools: tokenEntry.pools || [],
        events: tokenEntry.events || {},
        risk: tokenEntry.risk || {},
        buysCount: tokenEntry.buysCount || 0,
        sellsCount: tokenEntry.sellsCount || 0,
        status: "hold",
        chartData: {},
        indicators: {}
    };
}

async function fetchChartDataWithRetry(mint, retries = 2, delayMs = 500) {
    let attempt = 0;
    while (attempt <= retries) {
        try {
            const start = Date.now();
            const data = await fetchChartData(mint);
            const duration = Date.now() - start;
            logger.debug(`[BuyOps] fetchChartData for ${mint} took ${duration}ms`);
            return data;
        } catch (err) {
            attempt++;
            if (attempt > retries) throw err;
            await sleep(delayMs);
        }
    }
}

async function processTrendingTokens(bot, config) {
    const trending = await fetchTrendingTokens(config.trendingtimeframe);
    const filtered = filterTokens(trending, CoinManager).filter(token => {
        const existingEntry = CoinManager.getCoin(token.token.mint);
        if (existingEntry && existingEntry.status === "blacklist") {
            logger.info(`🚫 [BuyOps] Ignoring blacklisted token: ${token.token.symbol} (${token.token.mint})`);
            return false;
        }
        return true;
    });
    for (const token of filtered) {
        const mint = token.token.mint;
        if (!CoinManager.getCoin(mint)) {
            const normalized = normalizeTrendingEntry(token);
            CoinManager.addOrUpdateCoin(normalized);
        }
    }
    CoinManager.debouncedSaveCoins();
}

async function evaluateEntries(bot, config, chartCache) {
    const allCoins = CoinManager.getAllCoins();
    for (const entry of allCoins) {
        if (entry.status === "blacklist") {
            logger.info(`🚫 [BuyOps] Skipping blacklisted token during buy evaluation: ${entry.token?.symbol || "UNKNOWN"}`);
            continue;
        }
        if (!entry.token || !entry.token.mint) {
            logger.warn(`⚠️ [BuyOps] Skipping entry with missing token or mint during evaluation`);
            continue;
        }
        let rawChartData;
        if (chartCache.has(entry.token.mint)) {
            rawChartData = chartCache.get(entry.token.mint);
        } else {
            rawChartData = await fetchChartDataWithRetry(entry.token.mint);
            chartCache.set(entry.token.mint, rawChartData);
        }
        const chartData = rawChartData.oclhv || [];
        if (!Array.isArray(chartData) || chartData.length === 0) {
            logger.warn(`⚠️ [BuyOps] Empty chart data for ${entry.token?.symbol || "UNKNOWN"}`);
            continue;
        }
        const trimmedChart = chartData.slice(-50);
        entry.chartData = { oclhv: trimmedChart };
        if (chartData.length < 20) {
            logger.warn(`📉 [BuyOps] Chart data too short for ${entry.token?.symbol || "UNKNOWN"} — skipping`);
            CoinManager.addOrUpdateCoin(entry);
            continue;
        }
        const indicators = calculateIndicators(trimmedChart);
        if (indicators && Object.keys(indicators).length > 0) {
            entry.indicators = indicators;
            if (!entry.position || !Number.isFinite(entry.position.entryPrice)) {
                const tradeHistory = await tradeHist(entry.token.mint, bot.publicKeyb58);
                if (tradeHistory && Array.isArray(tradeHistory.trades) && tradeHistory.trades.length > 0) {
                    const latestBuy = tradeHistory.trades.find(trade => trade.type === 'buy');
                    if (latestBuy) {
                        entry.position = entry.position || {};
                        entry.position.entryPrice = latestBuy.amount * latestBuy.priceUsd;
                        logger.info(`[BuyOps] Updated entryPrice for ${entry.token.symbol} using trade history: ${entry.position.entryPrice}`);
                    } else {
                        logger.warn(`[BuyOps] No buy trade found in trade history for ${entry.token.symbol}`);
                    }
                } else {
                    logger.warn(`[BuyOps] No trade history available for ${entry.token.symbol} to update entryPrice.`);
                }
            }
            const decision = evaluateBuy(entry, config);
            logger.debug(`[BuyOps] evaluateBuy for ${entry.token?.symbol || "UNKNOWN"} returned: ${decision}`);
            if (decision) {
                logger.info(`✅ [BuyOps] Buy signal confirmed for ${entry.token?.symbol || "UNKNOWN"} — marking as target`);
                entry.status = "target";
                CoinManager.addOrUpdateCoin(entry);
                CoinManager.debouncedSaveCoins();
            }
        } else {
            logger.warn(`🧮 [BuyOps] No indicators generated for ${entry.token?.symbol || "UNKNOWN"}`);
        }
        CoinManager.addOrUpdateCoin(entry);
    }
}

async function executeBuys(bot, config, chartCache, openSlots) {
    const allCoins = CoinManager.getAllCoins();
    let buys = 0;
    for (const entry of allCoins) {
        if (buys >= openSlots) break;
        if (!entry.token || !entry.token.mint) {
            logger.warn(`⚠️ [BuyOps] Skipping invalid entry with missing token or mint`);
            continue;
        }
        let rawChartData;
        if (chartCache.has(entry.token.mint)) {
            rawChartData = chartCache.get(entry.token.mint);
        } else {
            rawChartData = await fetchChartDataWithRetry(entry.token.mint);
            chartCache.set(entry.token.mint, rawChartData);
        }
        const liveData = rawChartData;
        const priceNow = liveData?.oclhv?.at(-1)?.close;
        logger.debug(`[BuyOps] ${entry.token.symbol}: fetched priceNow = ${priceNow}`);
        if (!priceNow) {
            logger.warn(`⚠️ [BuyOps] No live price for ${entry.token.symbol}, skipping swap.`);
            continue;
        }
        const analysisPrice = entry.chartData?.oclhv?.at(-1)?.close;
        const diff = Math.abs(priceNow - analysisPrice) / analysisPrice;
        logger.debug(`[BuyOps] ${entry.token.symbol}: analysisPrice = ${analysisPrice}, diff = ${diff}`);
        if (diff > config.maxAllowedPriceChange) {
            logger.warn(`📉 [BuyOps] Live price moved too much for ${entry.token.symbol} (${(diff * 100).toFixed(2)}%) — skipping swap`);
            continue;
        }
        const token = entry.token;
        const requiredFields = ['mint', 'symbol'];
        const missing = requiredFields.filter(f => !token?.[f]);
        if (missing.length > 0) {
            logger.warn(`⚠️ [BuyOps] Incomplete token data for ${token?.symbol || "UNKNOWN"} — missing: ${missing.join(", ")}`);
            continue;
        }
        logger.debug(`[BuyOps] Eligibility check for ${entry.token.symbol}: buyingTokens.has(${entry.token.mint}) = ${bot.buyingTokens.has(entry.token.mint)}`);
        if (!bot.buyingTokens.has(entry.token.mint)) {
            const solBalance = await bot.walletManager.getWalletAmount(bot.publicKeyb58, config.SOL_ADDRESS);
            const minSOLBalance = parseFloat(process.env.AMOUNT) || 0.1;
            if (solBalance < minSOLBalance) {
                logger.warn(`⚠️ [BuyOps] Insufficient SOL balance (${solBalance}). Skipping swap for ${entry.token.symbol}.`);
            } else {
                logger.debug(`[BuyOps] Attempting swap for ${entry.token.symbol}`);
                bot.buyingTokens.add(entry.token.mint);
                try {
                    logger.debug(`[BuyOps] 🔄 Awaiting performSwap for ${entry.token.symbol}`);
                    const txid = await bot.swapManager.performSwap(bot, { token: entry.token }, true);
                    logger.info(`💸 [BuyOps] Swap executed for ${entry.token.symbol} — txid: ${txid}`);
                    if (txid) {
                        entry.status = "open";
                        CoinManager.addOrUpdateCoin(entry);
                        CoinManager.debouncedSaveCoins();
                    }
                } catch (err) {
                    logger.error(`❌ [BuyOps] Swap failed for ${entry.token?.symbol || "UNKNOWN"} — ${err.message}`, err);
                    entry.status = "failed";
                    CoinManager.addOrUpdateCoin(entry);
                    CoinManager.debouncedSaveCoins();
                } finally {
                    bot.buyingTokens.delete(entry.token.mint);
                    logger.debug(`[BuyOps] Removed ${entry.token.mint} from buyingTokens.`);
                }
                buys++;
            }
        }
    }
}

async function buyMonitor(bot) {
    const { config } = bot;
    try {
        const allCoins = CoinManager.getAllCoins();
        const openPositions = allCoins.filter(coin => coin.status === 'open').length;
        const maxActive = parseInt(process.env.MAX_ACTIVE_POSITIONS, 10);
        const openSlots = maxActive - openPositions;
        if (openSlots <= 0) {
            logger.warn(`Max active positions reached (${maxActive}). Open positions: ${openPositions}. Skipping buys until a slot opens.`);
            await sleep(parseInt(process.env.DELAY) || 1000);
            return;
        }
        await processTrendingTokens(bot, config);
        const chartCache = new Map();
        await evaluateEntries(bot, config, chartCache);
        await executeBuys(bot, config, chartCache, openSlots);
        CoinManager.debouncedSaveCoins();
        logger.debug(`[BuyOps] buyingTokens: ${JSON.stringify([...bot.buyingTokens])}`);
        logger.debug(`[BuyOps] CoinManager contents before buy execution:`);
        const updatedAllCoins = CoinManager.getAllCoins();
        for (const entry of updatedAllCoins) {
            logger.debug(`🧾 [BuyOps] ${entry.token?.symbol || "UNKNOWN"} — status: ${entry.status}`);
        }
    } catch (err) {
        logger.error(`🔥 [BuyOps] Unhandled error: ${err.message}`, {
            stack: err.stack,
            error: err
        });
        await sleep(config.errorRetryDelay || 5000);
    }
    await sleep(config.delay);
}

module.exports = {
    async start(bot) {
        await buyMonitor(bot);
    },
};
