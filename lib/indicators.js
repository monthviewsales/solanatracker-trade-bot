require("dotenv").config();
const { EMA, RSI, BollingerBands } = require("technicalindicators");
const logger = require("../utils/logger");

function calculateIndicators(chart) {
    logger.info("🚀 [Indicators] Logger is successfully initialized and we're checking indicators.");
    if (!Array.isArray(chart) || chart.length < 20) {
        logger.warn(`[Indicators] Skipping calculation — not enough chart data`);
        return null;
    }

    const closes = chart.map(c => c.close);
    const price = closes[closes.length - 1];

    const emaShort = EMA.calculate({ period: 5, values: closes });
    const emaMedium = EMA.calculate({ period: 20, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    const bb = BollingerBands.calculate({ period: 14, stdDev: 2, values: closes });

    if (!emaShort.length || !emaMedium.length || !rsi.length || !bb.length) return null;

    return {
        price,
        rsi: rsi.at(-1),
        emaShort: emaShort.at(-1),
        emaMedium: emaMedium.at(-1),
        bb: bb.at(-1),
        trendBias: emaMedium.at(-1) > emaMedium.at(-2),
    };
}

function getThreshold(name) {
    const mode = process.env.TRADING_MODE || "retail";
    if (mode === "degen") {
        return parseFloat(process.env[`DEGEN_${name}`]) || parseFloat(process.env[name]) || 0;
    }
    return parseFloat(process.env[name]) || 0;
}

function calculateThreshold(name, margin) {
    const baseValue = getThreshold(name);
    return baseValue * (1 + margin);
}

module.exports = {
    calculateIndicators,
    /*
      evaluateBuy
      ------------
      This function evaluates whether a buy should be triggered for a given coin candidate.
      It applies multiple conditions that can be easily adjusted:

      1. Trend Bias Condition (Strict Mode):
         - In strict mode, if trend bias is required, the trend must be favorable.

      2. Bollinger Bands Rule:
         - Evaluate if the current price is at or below a target threshold derived from the Bollinger Bands.

      3. RSI Condition:
         - In strict mode, RSI must be below a defined threshold; in loose mode, a buy is triggered if either the price condition or the RSI condition is met.

      Detailed logs provide a complete breakdown of indicator values, thresholds, conditions, and the final decision rationale.
    */
    evaluateBuy(entry, config) {
        const ind = entry.indicators;
        const tokenSymbol = entry.token?.symbol || 'UNKNOWN';
        logger.debug(`[Indicators] Evaluating buy for ${tokenSymbol}`);

        // Ensure indicator data is available
        if (!ind) {
            logger.warn(`[Indicators] Missing indicators data for ${tokenSymbol} during buy evaluation.`);
            return false;
        }

        // Determine if a favorable trend (trend bias) is required (e.g., not in DEGEN mode)
        const trendBiasRequired = process.env.TRADING_MODE !== 'DEGEN';

        // Retrieve buy logic mode from environment variables (either 'strict' or 'loose')
        const logicMode = process.env.BUY_LOGIC_MODE || "loose";

        // Get margin setting from environment variables to adjust buy thresholds
        const margin = getThreshold("BUY_MARGIN") || 0;

        // Calculate Bollinger Bands target threshold for a buy
        const bbTarget = calculateThreshold("BB_BUY_THRESHOLD", margin);

        // Set RSI thresholds for buying
        const rsiThresholdStrict = getThreshold("RSI_BUY_THRESHOLD") || 35; // Strict RSI threshold
        const rsiThresholdLoose = calculateThreshold("BUY_MARGIN", margin);    // Loose mode uses an adjusted threshold

        // ---- Decision Logic ----
        let shouldBuy = false;
        if (logicMode === "strict") {
            // In strict mode, require:
            //   - (if required) a favorable trend bias
            //   - the current price to be at or below the Bollinger Bands target threshold
            //   - the RSI to be at or below the strict threshold
            shouldBuy = (!trendBiasRequired || ind.trendBias) &&
                        (ind.price <= bbTarget) &&
                        (ind.rsi <= rsiThresholdStrict);
        } else {
            // In loose mode, trigger a buy if either:
            //   - the current price is at or below the Bollinger Bands target threshold, OR
            //   - the RSI is at or below the loose threshold
            shouldBuy = (ind.price <= bbTarget) || (ind.rsi <= rsiThresholdLoose);
        }

        // ---- Detailed Logging ----
        logger.info(`📈 [Indicators] Buy Evaluation for ${tokenSymbol}:
---------------------------------------------
Current Price: ${ind.price}
EMA Short: ${ind.emaShort}
EMA Medium: ${ind.emaMedium}
Upper Bollinger Band: ${ind.bb.upper}
Lower Bollinger Band: ${ind.bb.lower}
RSI: ${ind.rsi}
Bollinger Bands Target (BB Target): ${bbTarget}
RSI Threshold (Strict): ${rsiThresholdStrict}
RSI Threshold (Loose): ${rsiThresholdLoose}
Trend Bias Required: ${trendBiasRequired} | Current Trend Bias: ${ind.trendBias}
Buy Logic Mode: ${logicMode}

Buy Conditions:
  - Strict Mode: (!trendBiasRequired || trend bias is met) AND (Price <= BB Target: ${ind.price <= bbTarget}) AND (RSI <= RSI Threshold: ${ind.rsi <= rsiThresholdStrict})
  - Loose Mode: (Price <= BB Target: ${ind.price <= bbTarget}) OR (RSI <= RSI Threshold: ${ind.rsi <= rsiThresholdLoose})

Final Buy Decision: ${shouldBuy}
---------------------------------------------`);

        return shouldBuy;
    },

    /*
      evaluateSell
      -------------
      This function evaluates whether a sell should be triggered for a given coin position.
      It applies multiple rules that can be easily adjusted:

      1. Stop Loss Rule:
         - Sell immediately if the current price is at or below the stop-loss level set for the position.

      2. Trailing Stop Rule:
         - Sell if the current price falls below a certain percentage of the highest price attained since the position was opened.

      3. Trailing Take Profit Rule:
         - Sell if the current price exceeds a profit target based on the highest price (to secure gains).

      4. RSI Overbought & EMA Reversal Rule:
         - Sell if the RSI indicates an overbought condition and the short-term EMA drops below a defined threshold.

      Detailed logs provide a complete picture of indicator values, thresholds, and which rules were triggered.
    */
    evaluateSell(entry, position, config) {
        const ind = entry.indicators;
        const tokenSymbol = entry.token?.symbol || 'UNKNOWN';
        if (!ind) {
            logger.warn(`[Indicators] Missing indicators data for ${tokenSymbol} during sell evaluation.`);
            return false;
        }

        const mode = process.env.TRADING_MODE || "retail";

        // Retrieve thresholds from environment variables using helper functions.
        const rsiSellThreshold = getThreshold(mode === 'degen' ? "DEGEN_RSI_SELL_THRESHOLD" : "RSI_SELL_THRESHOLD") || 70;
        const trailingStopPercentEnv = getThreshold(mode === 'degen' ? "DEGEN_TRAILING_STOP_PERCENT" : "TRAILING_STOP_PERCENT") || 0.05;

        // Adaptive trailing stop: Adjust the trailing stop percentage based on volatility measured by Bollinger Bands.
        const baselineVolatility = parseFloat(process.env.BASELINE_VOLATILITY) || 0.05;
        const currentVolatility = (ind.bb.upper - ind.bb.lower) / ind.price;
        const adaptiveTrailingStopPercent = currentVolatility > baselineVolatility ? trailingStopPercentEnv * (currentVolatility / baselineVolatility) : trailingStopPercentEnv;

        // ---- Rule Calculations ----
        
        // Setup PnL Logging
        const pnl = ((ind.price - position.entryPrice) / position.entryPrice) * 100;
        const pnlColor = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";
        const pnlReset = "\x1b[0m";


        // Rule 1: Stop Loss
        // Sell if the current price is at or below the stop-loss level (position.sl) set when the position was opened.
        const priceBelowStopLoss = (position?.sl !== undefined && position?.sl !== null) ? (ind.price <= position.sl) : false;

        // Rule 2: Trailing Stop
        // Sell if current price has dropped below a percentage of the highest price achieved since the position was opened.
        const trailingStopTriggered = (position?.highestPrice !== undefined && position?.highestPrice !== null) ? 
            (ind.price < position.highestPrice * (1 - adaptiveTrailingStopPercent)) : false;

        // Rule 3: Trailing Take Profit
        // Sell if the current price exceeds a profit target based on the highest price.
        const trailingTakeProfitTriggered = (position?.highestPrice !== undefined && position?.highestPrice !== null) ? 
            (ind.price >= position.highestPrice * (1 + trailingStopPercentEnv)) : false;

        // Rule 4: RSI Overbought & EMA Reversal
        // Sell if RSI is overbought and short-term EMA is below a set threshold. 
        const emaSellThreshold = calculateThreshold("EMA_SELL_THRESHOLD", 0); // Adjust the margin if needed.
        const rsiOverbought = ind.rsi >= rsiSellThreshold;
        const emaReversal = ind.emaShort < emaSellThreshold;

        // ---- Collecting Triggered Rules for Logging ----
        const triggeredRules = [];
        if (priceBelowStopLoss) {
            triggeredRules.push("Stop Loss");
        }
        if (trailingStopTriggered) {
            triggeredRules.push("Trailing Stop");
        }
        if (trailingTakeProfitTriggered) {
            triggeredRules.push("Trailing Take Profit");
        }
        if (rsiOverbought && emaReversal) {
            triggeredRules.push("RSI Overbought & EMA Reversal");
        }

        // ---- Final Decision Logic ----
        // Prioritize: Stop Loss > Trailing Stop > Trailing Take Profit > RSI & EMA conditions.
        let shouldSell = false;
        if (priceBelowStopLoss) {
            logger.warn(`[Indicators] Critical Sell: Current Price (${ind.price}) is at or below Stop Loss (${position.sl}).`);
            shouldSell = true;
        } else if (trailingStopTriggered) {
            logger.info(`[Indicators] Sell Trigger: Trailing Stop activated. Current Price: ${ind.price} is below threshold (${(position.highestPrice * (1 - adaptiveTrailingStopPercent)).toFixed(12)}) based on Highest Price: ${position.highestPrice}.`);
            shouldSell = true;
        } else if (trailingTakeProfitTriggered) {
            logger.info(`[Indicators] Sell Trigger: Trailing Take Profit activated. Current Price: ${ind.price} is above profit threshold (${(position.highestPrice * (1 + trailingStopPercentEnv)).toFixed(12)}) based on Highest Price: ${position.highestPrice}.`);
            shouldSell = true;
        } else if (rsiOverbought && emaReversal) {
            logger.info(`[Indicators] Sell Trigger: Combined RSI & EMA conditions met. RSI: ${ind.rsi} (Threshold: ${rsiSellThreshold}), EMA Short: ${ind.emaShort} (Threshold: ${emaSellThreshold}).`);
            shouldSell = true;
        }

        // ---- Detailed Logging of Indicator Values and Final Decision ----
        logger.info(`📉 [Indicators] Sell Evaluation for ${tokenSymbol}:
---------------------------------------------
Entry Price: ${position.entryPrice}
PnL: ${pnlColor}${pnl.toFixed(2)}%${pnlReset}
Current Price: ${ind.price}
Highest Price: ${position.highestPrice || 'N/A'}
Stop Loss: ${position.sl || 'N/A'} (Triggered: ${priceBelowStopLoss})
Adaptive Trailing Stop Percent: ${adaptiveTrailingStopPercent.toFixed(4)}
Trailing Stop Threshold: ${position.highestPrice ? (position.highestPrice * (1 - adaptiveTrailingStopPercent)).toFixed(12) : 'N/A'} (Triggered: ${trailingStopTriggered})
Trailing Take Profit Threshold: ${position.highestPrice ? (position.highestPrice * (1 + trailingStopPercentEnv)).toFixed(12) : 'N/A'} (Triggered: ${trailingTakeProfitTriggered})
RSI: ${ind.rsi} (Sell Threshold: ${rsiSellThreshold}) (Overbought: ${rsiOverbought})
EMA Short: ${ind.emaShort} (EMA Sell Threshold: ${emaSellThreshold}) (Reversal: ${emaReversal})
Triggered Rules: ${triggeredRules.join(', ') || 'None'}
Final Sell Decision: ${shouldSell}
---------------------------------------------`);
        
        return shouldSell;
    }
};