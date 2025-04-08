const { fetchChartData, fetchLivePriceData } = require("../lib/solanaTrackerAPI");
const { calculateIndicators, evaluateSell } = require("../lib/indicators");
const logger = require("../utils/logger");
// Use the unified CoinManager
const CoinManager = require("../lib/CoinManager");
const { SolanaTracker } = require('solana-swap');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

module.exports = {
    async start(bot) {
        await monitorPositions(bot);
    },
};

async function getChartDataWithCache(mint, chartCache) {
    if (chartCache.has(mint)) {
        logger.debug(`[SellOps] Loaded chart data from cache for ${mint}`);
        return chartCache.get(mint);
    }
    // Try to load from CoinManager if not in cache
    const storedData = CoinManager.getCoin(mint)?.chartData;
    if (storedData) {
        chartCache.set(mint, storedData);
        logger.debug(`[SellOps] Loaded chart data from coins.json for ${mint}`);
        return storedData;
    }
    // Fetch fresh data if not found in cache or coins.json
    const rawChartData = await fetchChartDataWithRetry(mint);
    if (rawChartData) {
        chartCache.set(mint, rawChartData);
        // Update coin data with chart data
        const coin = CoinManager.getCoin(mint);
        if (coin) {
            coin.chartData = rawChartData;
            CoinManager.addOrUpdateCoin(coin);
        }
    }
    return rawChartData;
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
    let attempt = 0;
    try {
        const tokenSymbol = entry.token?.symbol || entry.price?.token?.symbol || entry.token?.name || entry.token?.address || 'UNKNOWN';
        logger.debug(`[SellOps] Resolved token symbol: ${tokenSymbol} for mint: ${entry.token?.mint}`);
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

        const rawChartData = await getChartDataWithCache(mint, chartCache);
        const chartData = rawChartData.oclhv || [];
        if (!Array.isArray(chartData) || chartData.length === 0) {
            logger.warn(`⚠️ [SellOps] Empty chart data for ${entry.token?.symbol || "UNKNOWN"}`);
        }
        const trimmedChart = chartData.slice(-50);
        entry.chartData = { oclhv: trimmedChart };
        if (chartData.length < 20) {
            logger.warn(`📉 [SellOps] Chart data too short for ${entry.token?.symbol || "UNKNOWN"} — skipping`);
            CoinManager.addOrUpdateCoin(entry);
        }

        // Calculate indicators and attach to entry
        const indicators = calculateIndicators(trimmedChart);
        if (indicators && Object.keys(indicators).length > 0) {
            entry.indicators = indicators;
            logger.debug(`[SellOps] Calculated indicators for ${tokenSymbol}`);
        } else {
            logger.warn(`[SellOps] Failed to calculate indicators for ${tokenSymbol} — skipping sell`);
            return;
        }

        logger.debug(`[SellOps] Final entry object for ${tokenSymbol}`);

        let priceNow = 0;
        if (Array.isArray(chartData)) {
            priceNow = chartData.at(-1)?.close || 0;
        } else if (chartData?.oclhv && Array.isArray(chartData.oclhv)) {
            priceNow = chartData.oclhv.at(-1)?.close || 0;
        } else {
            logger.warn(`[SellOps] Invalid chart data format for ${tokenSymbol} — skipping sell`);
            return;
        }
        logger.debug(`[SellOps] Extracted priceNow for ${tokenSymbol}: ${priceNow}`);
        logger.debug(`[SellOps] Proceeding with sell decision for ${tokenSymbol} at price: ${priceNow}`);

        const requiredFields = ['mint', 'symbol', 'amount', 'entryPrice'];
        const missingFields = requiredFields.filter(f => !(entry.token?.[f] || entry.position?.[f]));
        if (missingFields.length > 0) {
            logger.warn(`⚠️ [SellOps] Missing required fields for ${tokenSymbol} — ${missingFields.join(", ")} (checked token and position)`);
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

        if (bot.sellingPositions.has(mint)) {
            logger.warn(`[SellOps] Duplicate sell attempt detected for ${tokenSymbol} — already in progress`);
            return;
        }
        // bot.sellingPositions.add(entry.token.mint);
        bot.sellingPositions.add(mint);

        const fromToken = entry.token.mint;
        const toToken = config.SOL_ADDRESS || "So11111111111111111111111111111111111111112"; // SOL mint address
        const amount = "auto";
        const slippage = config.SLIPPAGE || 0.005;
        const priorityFee = config.priorityFee || 0.0005;

        if (!bot.keypair) {
            logger.error(`[SellOps] Missing keypair in bot configuration during swap for ${tokenSymbol}`);
            return;
        }

        const minAmountOut = Math.floor(amount * priceNow * (1 - slippage));

        logger.debug(`[SellOps] Initiating swap for ${tokenSymbol} from ${fromToken} to ${toToken} with amount: ${amount}, slippage: ${slippage}, priority fee: ${priorityFee}`);

        try {
            const swapResponse = await bot.solanaTracker.getSwapInstructions(
                fromToken, 
                toToken, 
                amount, 
                slippage, 
                bot.keypair.publicKey.toBase58(), 
                priorityFee,
                { minAmountOut }
            );

            const txid = await bot.solanaTracker.performSwap(swapResponse, {
                sendOptions: { skipPreflight: true },
                confirmationRetries: 30,
                confirmationRetryTimeout: 500,
                lastValidBlockHeightBuffer: 150,
                resendInterval: 1000,
                confirmationCheckInterval: 1000,
                commitment: 'processed',
                skipConfirmationCheck: false
            });

            const sellData = {
                exitPrice: chartData.at(-1)?.close || 0,
                txid: txid,
                qty: entry.position?.amount || 1
            };
            await CoinManager.closePosition(mint, sellData);
            logger.info(`💸 [SELL] ${tokenSymbol} sold at ${sellData.exitPrice} — TXID: ${txid}`);
            logger.debug(`[SellOps] Swap response for ${tokenSymbol}: ${JSON.stringify(swapResponse)}`);
        } catch (err) {
            logger.error(`❌ [SellOps] Swap failed for ${tokenSymbol} — ${err.message} (response: ${JSON.stringify(err.response?.data)})`);
            if (err.response?.status === 429) {
                logger.warn(`[SellOps] Rate limit hit for ${tokenSymbol} — retrying after 500ms`);
                await sleep(500);
                return await processPosition(entry, bot, config, chartCache); // Retry the same position
            }
            if (err.response?.status === 500) {
                attempt++;
                const retryDelay = Math.min(500 * Math.pow(2, attempt), 5000); // Exponential backoff
                logger.warn(`[SellOps] Server error for ${tokenSymbol} — retrying after ${retryDelay}ms (attempt ${attempt})`);
                await sleep(retryDelay);
                return await processPosition(entry, bot, config, chartCache); // Retry the same position
            }
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
    } finally {
        bot.sellingPositions.delete(mint);
        logger.debug(`[SellOps] Cleared selling flag for ${tokenSymbol}`);
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