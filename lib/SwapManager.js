const chalk = require("chalk");
const logger = require("../utils/logger");
const bs58 = require("bs58");
const fs = require("fs").promises;
const { SolanaTracker } = require("solana-swap");
const { Keypair, Connection } = require("@solana/web3.js");
const { fetchLivePriceData } = require("./solanaTrackerAPI");
const CoinManager = require("./CoinManager");

class SwapManager {
    constructor() {
        this.config = {
            amount: parseFloat(process.env.AMOUNT),
            delay: parseInt(process.env.DELAY),
            monitorInterval: parseInt(process.env.MONITOR_INTERVAL),
            slippage: parseInt(process.env.SLIPPAGE),
            priorityFee: parseFloat(process.env.PRIORITY_FEE),
            useJito: process.env.JITO === "true",
            rpcUrl: process.env.RPC_URL,
            minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 0,
            maxLiquidity: parseFloat(process.env.MAX_LIQUIDITY) || Infinity,
            minMarketCap: parseFloat(process.env.MIN_MARKET_CAP) || 0,
            maxMarketCap: parseFloat(process.env.MAX_MARKET_CAP) || Infinity,
            minRiskScore: parseInt(process.env.MIN_RISK_SCORE) || 0,
            maxRiskScore: parseInt(process.env.MAX_RISK_SCORE) || 10,
            requireSocialData: process.env.REQUIRE_SOCIAL_DATA === "true",
            maxNegativePnL: parseFloat(process.env.MAX_NEGATIVE_PNL) || -Infinity,
            maxPositivePnL: parseFloat(process.env.MAX_POSITIVE_PNL) || Infinity,
            markets: process.env.MARKETS?.split(",").map((m) => m.trim()) || ['raydium', 'orca', 'pumpfun', 'moonshot', 'raydium-cpmm'],
        };

        this.privateKey = process.env.PRIVATE_KEY;
        this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
        this.positions = new Map();
        this.soldPositions = [];
        this.seenTokens = new Set();
        this.buyingTokens = new Set();
        this.sellingPositions = new Set();

        this.keypair = Keypair.fromSecretKey(bs58.decode ? bs58.decode(this.privateKey) : bs58.default.decode(this.privateKey));
        this.connection = new Connection(this.config.rpcUrl);
        
        this.solanaTracker = new SolanaTracker(this.keypair, this.config.rpcUrl);
    }

    async getCurrentPrice(mint) {
        try {
            const priceData = await fetchLivePriceData(mint);
            if (priceData && priceData.price) {
                logger.debug(`[SwapManager] Fetched current price for ${mint}: ${priceData.price}`);
                return priceData.price;
            } else {
                logger.warn(`[SwapManager] Price not available for mint ${mint}`);
                return 0;
            }
        } catch (error) {
            logger.error(`[SwapManager] Failed to fetch price for mint ${mint}: ${error.message}`);
            return 0;
        }
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

    async performSwap(bot, token, isBuy) {
        const tokenInfo = token.token || token;
        if (!tokenInfo.symbol && token.price && token.price.token && token.price.token.symbol) {
            tokenInfo.symbol = token.price.token.symbol;
        }
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
            let swapOptions;

            let swapAmount = isBuy ? amount : (bot.positions.get(tokenInfo.mint)?.amount || token.position?.amount || 0);
            logger.debug(`[SwapManager] Calculated swap amount for ${tokenInfo.symbol} (${isBuy ? 'buy' : 'sell'}): ${swapAmount}`);

            if (!isBuy) {
                logger.debug(`[SwapManager] Position map before swap: ${JSON.stringify(Array.from(bot.positions.entries()))}`);
                logger.debug(`[SwapManager] Checking position data for ${tokenInfo.symbol} before attempting sell.`);
                logger.debug(`[SwapManager] Position map size: ${bot.positions.size}`);
                logger.debug(`[SwapManager] Available positions: ${Array.from(bot.positions.keys()).join(", ")}`);
                logger.debug(`[SwapManager] Retrieved amount for ${tokenInfo.symbol}: ${bot.positions.get(tokenInfo.mint)?.amount || 0}`);
            }

            if (!swapAmount) {
                logger.error(`⚠️ [Swap] No amount available for ${tokenInfo.symbol} when trying to swap. Position data might be missing or incorrect.`);
                return false;
            }

            logger.debug(`[SwapManager] Prepared swap for ${tokenInfo.symbol} | from: ${fromToken} | to: ${toToken} | amount: ${swapAmount} | slippage: ${slippage}`);
            logger.debug(`[SwapManager] Requesting swap instructions for ${tokenInfo.symbol}, amount: ${swapAmount}`);
            const swapResponse = await this.solanaTracker.getSwapInstructions(
                fromToken,
                toToken,
                swapAmount,
                slippage,
                this.keypair.publicKey.toBase58(),
                priorityFee
            );

            swapOptions = this.buildSwapOptions();
            const txid = await this.solanaTracker.performSwap(swapResponse, swapOptions);
            logger.info(`💸 [SwapManager] Swap executed! TXID: ${txid}`);
            this.logTransaction(txid, isBuy, { token: tokenInfo });
            const entryPrice = swapResponse?.swapMeta?.price || await this.getCurrentPrice(tokenInfo.mint);
            if (isBuy) {
                await CoinManager.openPosition(tokenInfo.mint, {
                    entryPrice: entryPrice,
                    qty: swapAmount,
                    txid
                });
                logger.debug(`[SwapManager] Buy tagged — coin status set to "open" for ${tokenInfo.symbol} at entry price: ${entryPrice}`);
            } else {
                const exitPrice = swapResponse?.swapMeta?.price || await this.getCurrentPrice(tokenInfo.mint);
                await CoinManager.closePosition(tokenInfo.mint, {
                    exitPrice: exitPrice,
                    qty: swapAmount,
                    txid
                });
                logger.debug(`[SwapManager] Sell tagged — coin status set to "closed" for ${tokenInfo.symbol} at exit price: ${exitPrice}`);
            }

            return txid;
        } catch (error) {
            logger.error(`❌ [Swap] Failed for ${isBuy ? "buy" : "sell"} [${tokenInfo.symbol}] [${tokenInfo.mint}]`, {
                message: error.message,
                response: error.response?.data,
                stack: error.stack,
                poolData: poolData || "No pool data",
                swapOptions,
            });
            logger.warn(`[SwapManager] Swap failed — no TXID returned for ${tokenInfo.symbol}`, {
                tokenInfo,
                swapOptions,
                poolData: poolData || "No pool data",
            });
            return false;
        }
    }
}

module.exports = SwapManager;
