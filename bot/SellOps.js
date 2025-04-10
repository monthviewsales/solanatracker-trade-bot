async function processPosition(entry, bot, config, chartCache) {
    // Declare tokenSymbol in outer scope to be available in both try and finally blocks
    let tokenSymbol = entry.token?.symbol || entry.token?.name || entry.token?.address || 'UNKNOWN';
    try {
        // Use tokenSymbol as before
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
        bot.sellingPositions.add(mint);

        const fromToken = entry.token.mint;
        const toToken = config.SOL_ADDRESS || "So11111111111111111111111111111111111111112"; // SOL mint address
        const amount = (entry.position && Number.isFinite(entry.position.amount) && entry.position.amount > 0) ? entry.position.amount : 1;
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

            // If swapResponse.raydium exists but minAmountOut is null, set it to our calculated minAmountOut
            if (swapResponse && swapResponse.raydium && swapResponse.raydium.minAmountOut == null) {
                logger.warn(`[SellOps] raydium.minAmountOut is null for ${tokenSymbol}, setting default value: ${minAmountOut}`);
                swapResponse.raydium.minAmountOut = minAmountOut;
            }

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
                return await processPosition(entry, bot, config, chartCache);
            }
            if (err.response?.status === 500) {
                attempt++;
                const retryDelay = Math.min(500 * Math.pow(2, attempt), 5000);
                logger.warn(`[SellOps] Server error for ${tokenSymbol} — retrying after ${retryDelay}ms (attempt ${attempt})`);
                await sleep(retryDelay);
                return await processPosition(entry, bot, config, chartCache);
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
        bot.sellingPositions.delete(entry.token?.mint);
        logger.debug(`[SellOps] Cleared selling flag for ${tokenSymbol}`);
    }
}