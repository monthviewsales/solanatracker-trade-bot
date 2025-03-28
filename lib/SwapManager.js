const chalk = require("chalk");
const logger = require("../utils/logger");

class SwapManager {
    constructor(connection, config, keypair, solanaTracker, SOL_ADDRESS) {
        this.connection = connection;
        this.config = config;
        this.keypair = keypair;
        this.solanaTracker = solanaTracker;
        this.SOL_ADDRESS = SOL_ADDRESS;
    }

    buildSwapOptions() {
        return {
            sendOptions: { skipPreflight: true },
            confirmationRetries: 30,
            confirmationRetryTimeout: 1000,
            lastValidBlockHeightBuffer: 150,
            resendInterval: 1000,
            confirmationCheckInterval: 1000,
            commitment: "processed",
            jito: this.config.useJito ? { enabled: true, tip: 0.0001 } : undefined,
        };
    }

    logTransaction(txid, isBuy, token) {
        logger.info(
            `${isBuy ? chalk.green("✅ [BOUGHT]") : chalk.red("💀 [SOLD]")} ${token.token.symbol} [${txid}]`
        );
    }

    async performSwap(bot, token, isBuy, overwatch) {
        const tokenInfo = token.token || token;
        logger.debug(`[SwapManager] performSwap() called for ${tokenInfo?.symbol || "UNKNOWN"} (${tokenInfo?.mint || "no mint"})`);
        const requiredFields = ['mint', 'symbol'];
        const missingFields = requiredFields.filter(f => !tokenInfo?.[f]);
        const isValid = missingFields.length === 0;

        if (!isValid) {
            logger.error("🔥 [SwapManager] Invalid tokenInfo passed to performSwap", {
                rawInput: token,
                extractedTokenInfo: tokenInfo,
                missingFields,
                debugNote: 'Set API_DEBUG=1 to see full raw token info in future if hidden'
            });
            logger.warn(`[SwapManager] Swap aborted — missing required fields: ${missingFields.join(", ")}`, {
                symbol: tokenInfo?.symbol,
                mint: tokenInfo?.mint,
                rawToken: token
            });
            return false;
        }

        logger.info(
            `${isBuy ? "🟢 [BUYING]" : "🔻 [SELLING]"} [${this.keypair.publicKey.toBase58()}] [${tokenInfo.symbol}] [${tokenInfo.mint}]`
        );

        const { amount, slippage, priorityFee } = this.config;
        const [fromToken, toToken] = isBuy
            ? [this.SOL_ADDRESS, tokenInfo.mint]
            : [tokenInfo.mint, this.SOL_ADDRESS];
        const poolData = token.pools ? token.pools[0] : null;

        try {
            let swapAmount = isBuy
                ? amount
                : bot.positions.get(tokenInfo.mint)?.amount || 0;

            if (!swapAmount) {
                logger.error(`⚠️ [Swap] No amount available for ${tokenInfo.symbol} when trying to swap`);
                return false;
            }

            logger.debug(`[SwapManager] Requesting swap instructions for ${tokenInfo.symbol}, amount: ${swapAmount}`);
            const swapResponse = await this.solanaTracker.getSwapInstructions(
                fromToken,
                toToken,
                swapAmount,
                slippage,
                this.keypair.publicKey.toBase58(),
                priorityFee
            );

            const swapOptions = this.buildSwapOptions();
            const txid = await this.solanaTracker.performSwap(swapResponse, swapOptions);
            logger.info(`💸 [SwapManager] Swap executed! TXID: ${txid}`);
            this.logTransaction(txid, isBuy, { token: tokenInfo });
            if (isBuy) {
                overwatch.tagBuy({
                    mint: tokenInfo.mint,
                    qty: swapAmount,
                    entryPrice: swapResponse?.swapMeta?.price || 0,
                    txid
                });
                logger.debug(`[SwapManager] Buy tagged — coin status set to "open" for ${tokenInfo.symbol}`);
            } else {
                overwatch.tagSell({
                    mint: tokenInfo.mint,
                    qty: swapAmount,
                    exitPrice: swapResponse?.swapMeta?.price || 0,
                    txid
                });
                logger.debug(`[SwapManager] Sell tagged — coin status set to "closed" for ${tokenInfo.symbol}`);
            }

            return txid;
        } catch (error) {
            logger.error(`❌ [Swap] Failed for ${isBuy ? "buy" : "sell"} [${tokenInfo.symbol}] [${tokenInfo.mint}]`, {
                message: error.message,
                response: error.response?.data,
                stack: error.stack,
                poolData: poolData || "No pool data",
            });
            logger.debug(`🧵 [Swap] Token data dump: ${JSON.stringify(token, null, 2)}`);
            logger.warn(`[SwapManager] Swap failed — no TXID returned for ${tokenInfo.symbol}`);
            return false;
        }
    }
}

module.exports = SwapManager;
