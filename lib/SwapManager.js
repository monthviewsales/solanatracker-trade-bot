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
        if (!tokenInfo?.symbol || !tokenInfo?.mint) {
            logger.error("Invalid tokenInfo passed to performSwap", { token });
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
            this.logTransaction(txid, isBuy, { token: tokenInfo });
            if (isBuy) {
                overwatch.tagBuy({
                    mint: tokenInfo.mint,
                    qty: swapAmount,
                    entryPrice: swapResponse?.swapMeta?.price || 0,
                    txid
                });
            } else {
                overwatch.tagSell({
                    mint: tokenInfo.mint,
                    qty: swapAmount,
                    exitPrice: swapResponse?.swapMeta?.price || 0,
                    txid
                });
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
            return false;
        }
    }
}

module.exports = SwapManager;
