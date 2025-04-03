require("dotenv").config();
const { calculateIndicators } = require("../lib/indicators");
const { fetchTrendingTokens, fetchChartData, getTRXHistory } = require("../lib/solanaTrackerAPI");
const { filterTokens } = require("../lib/tokenUtils");
const { evaluateBuy } = require("../lib/indicators");
const logger = require("../utils/logger");

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

module.exports = {
    async start(bot) {
        await buyMonitor(bot);
    },
};

async function buyMonitor(bot) {
    const { CoinStore, config } = bot;

    while (true) {
        try {
            const openPositions = CoinStore.filterByStatus("open").length;
            const maxActive = process.env.MAX_ACTIVE_POSITIONS;
            const openSlots = maxActive - openPositions;

            if (openSlots <= 0) {
                logger.warn(`Max active positions reached (${maxActive}). Open positions: ${openPositions}. Skipping buys until a slot opens.`);
                await sleep(parseInt(process.env.DELAY) || 1000);
                continue;
            }

            const trending = await fetchTrendingTokens(config.trendingtimeframe);
            const filtered = filterTokens(trending, CoinStore).filter((token) => {
                const existingEntry = CoinStore.findByMint(token.token.mint);
                if (existingEntry && existingEntry.status === "blacklist") {
                    logger.info(`🚫 [BuyOps] Ignoring blacklisted token: ${token.token.symbol} (${token.token.mint})`);
                    return false;
                }
                return true;
            });

            // Add new coins to CoinStore as "hold"
            for (const token of filtered) {
                const mint = token.token.mint;
                let entry = CoinStore.findByMint(mint);

                if (!entry) {
                    const normalized = normalizeTrendingEntry(token);
                    CoinStore.addOrUpdate(normalized);
                }
            }

            await CoinStore.save();

            // Chart data + indicators + evaluate signals
            for (const entry of CoinStore.getAll()) {
                if (entry.status === "blacklist") {
                    logger.info(`🚫 [BuyOps] Skipping blacklisted token during buy evaluation: ${entry.token?.symbol || "UNKNOWN"}`);
                    continue;
                }
                //if (entry.status !== "hold") continue;

                if (!entry.token || !entry.token.mint) {
                    logger.warn(`⚠️ [BuyOps] Skipping entry with missing token or mint during evaluation`);
                    continue;
                }

                // await sleep(50); // This can be uncommented if you're banging on a rate limiter.
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
                    const decision = evaluateBuy(entry, config);
                    logger.debug(`[BuyOps] evaluateBuy for ${entry.token?.symbol || "UNKNOWN"} returned: ${decision}`);
                    if (!decision) {
                        logger.debug(`⛔ [BuyOps] No buy for ${entry.token?.symbol || "UNKNOWN"} — evaluation returned false`);
                    } else {
                        logger.info(`✅ [BuyOps] Buy signal confirmed for ${entry.token?.symbol || "UNKNOWN"} — performing inline swap`);
                        entry.status = "target";
                        CoinStore.addOrUpdate(entry);
                        await CoinStore.save();

                        if (!bot.overwatch.positions.has(entry.token.mint) && !bot.buyingTokens.has(entry.token.mint)) {
                            // Check wallet SOL balance before attempting swap
                            const solBalance = await bot.walletManager.getWalletAmount(bot.publicKeyb58, config.SOL_ADDRESS);
                            const minSOLBalance = parseFloat(process.env.AMOUNT) || 0.1;
                            if (solBalance < minSOLBalance) {
                                logger.warn(`⚠️ [BuyOps] Insufficient SOL balance (${solBalance}). Skipping swap for ${entry.token.symbol}.`);
                            } else {
                                bot.buyingTokens.add(entry.token.mint);
                                try {
                                    logger.debug(`[BuyOps] 🔫 Inline swap trigger for ${entry.token.symbol}`);
                                    const txid = await bot.swapManager.performSwap(bot, entry, true, bot.overwatch);
                                    logger.info(`💸 [BuyOps] Inline swap executed for ${entry.token.symbol} — txid: ${txid}`);
                                    if (txid) {
                                        // Assume priceNow is the executed price and entry.qty is available or default to 1
                                        const trxData = getTRXHistory( bot.publicKeyb58, entry.token.mint )
                                        const executedPrice = priceNow;
                                        const quantity = entry.qty || 1;
                                        // Call tagBuy to record the new position with necessary details
                                        await bot.overwatch.tagBuy({
                                            mint: entry.token.mint,
                                            qty: quantity,
                                            entryPrice: executedPrice,
                                            txid: txid
                                        });
                                        
                                        entry.status = "open";
                                        CoinStore.addOrUpdate(entry);
                                        await CoinStore.save();
                                    }
                                } catch (err) {
                                    logger.error(`❌ [BuyOps] Inline swap failed for ${entry.token?.symbol || "UNKNOWN"} — ${err.message}`, err);
                                    entry.status = "failed";
                                    CoinStore.addOrUpdate(entry);
                                    await CoinStore.save();
                                } finally {
                                    bot.buyingTokens.delete(entry.token.mint);
                                    logger.debug(`[BuyOps] Removed ${entry.token.mint} from buyingTokens.`);
                                }
                            }
                        }
                    }
                }

                CoinStore.addOrUpdate(entry);
            }

            await CoinStore.save();
            logger.debug(`[BuyOps] Overwatch.positions size: ${bot.overwatch.positions.size}`);
            logger.debug(`[BuyOps] Overwatch.positions entries: ${JSON.stringify([...bot.overwatch.positions.entries()])}`);
            logger.debug(`[BuyOps] buyingTokens: ${JSON.stringify([...bot.buyingTokens])}`);
            
            // Log CoinStore contents before buy execution
            logger.debug(`[BuyOps] CoinStore contents before buy execution:`);
            for (const coin of CoinStore.getAll()) {
                logger.debug(`🧾 [BuyOps] ${coin.token?.symbol || "UNKNOWN"} — status: ${coin.status}`);
            }

            // Execute buys
            let buys = 0;

            for (const entry of CoinStore.getAll()) {
                logger.debug(`[BuyOps] Execute buys loop token: ${entry.token.symbol}, status: ${entry.status}`);
                logger.debug(`[BuyOps] Checking buy eligibility for ${entry.token.symbol}`);
                if (buys >= openSlots) break;
                
                if (!entry.token || !entry.token.mint) {
                    logger.warn(`⚠️ [BuyOps] Skipping invalid entry with missing token or mint`);
                    continue;
                }

                const liveData = await fetchChartData(entry.token.mint);
                const priceNow = liveData?.oclhv?.at(-1)?.close;
                logger.debug(`[BuyOps] ${entry.token.symbol}: fetched priceNow = ${priceNow}`);
                
                if (!priceNow) {
                    logger.warn(`⚠️ [BuyOps] No live price for ${entry.token.symbol}, skipping swap.`);
                    continue;
                }

                const analysisPrice = entry.chartData?.oclhv?.at(-1)?.close;
                const diff = Math.abs(priceNow - analysisPrice) / analysisPrice;
                logger.debug(`[BuyOps] ${entry.token.symbol}: analysisPrice = ${analysisPrice}, diff = ${diff}`);

                // If the token is not already marked as a target and the price difference is too high, skip the swap
                //if (entry.status !== "target" && diff > config.maxAllowedPriceChange) {
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

                logger.debug(`[BuyOps] Eligibility check for ${entry.token.symbol}: overwatch.positions.has(${entry.token.mint}) = ${bot.overwatch.positions.has(entry.token.mint)}, buyingTokens.has(${entry.token.mint}) = ${bot.buyingTokens.has(entry.token.mint)}`);

                if (
                    !bot.overwatch.positions.has(entry.token.mint) &&
                    !bot.buyingTokens.has(entry.token.mint)
                ) {
                    // Check wallet SOL balance before swap
                    const solBalance = await bot.walletManager.getWalletAmount(bot.publicKeyb58, config.SOL_ADDRESS);
                    const minSOLBalance = parseFloat(process.env.AMOUNT) || 0.1;
                    if (solBalance < minSOLBalance) {
                        logger.warn(`⚠️ [BuyOps] Insufficient SOL balance (${solBalance}). Skipping swap for ${entry.token.symbol}.`);
                    } else {
                        logger.debug(`[BuyOps] Attempting swap for ${entry.token.symbol}`);
                        logger.debug(`[BuyOps] buyingTokens before swap: ${[...bot.buyingTokens]}`);
                        logger.debug(`[BuyOps] performSwap args: token = { mint: ${entry.token.mint}, symbol: ${entry.token.symbol} }, isBuy: true, overwatch keys: ${Object.keys(bot.overwatch).join(",")}`);
                        
                        bot.buyingTokens.add(entry.token.mint);
                        
                        try {
                            logger.debug(`[BuyOps] 🔄 Awaiting performSwap for ${entry.token.symbol}`);
                            const txid = await bot.swapManager.performSwap(bot, { token: entry.token }, true, bot.overwatch);
                            logger.info(`💸 [BuyOps] Swap executed for ${entry.token.symbol} — txid: ${txid}`);
                            if (txid) {
                                entry.status = "open";
                                CoinStore.addOrUpdate(entry);
                                await CoinStore.save();
                            }
                        } catch (err) {
                            logger.error(`❌ [BuyOps] Swap failed for ${entry.token?.symbol || "UNKNOWN"} — ${err.message}`, err);
                            entry.status = "failed";
                            CoinStore.addOrUpdate(entry);
                            await CoinStore.save();
                        } finally {
                            bot.buyingTokens.delete(entry.token.mint);
                            logger.debug(`[BuyOps] Removed ${entry.token.mint} from buyingTokens.`);
                            logger.debug(`[BuyOps] buyingTokens after swap: ${[...bot.buyingTokens]}`);
                        }
                        buys++;
                    }
                }
            }
        } catch (err) {
            logger.error(`🔥 [BuyOps] Unhandled error: ${err.message}`, {
                stack: err.stack,
                error: err
            });
            await sleep(config.errorRetryDelay || 5000); // Graceful retry after an error
        }

        await sleep(config.delay);
    }
}