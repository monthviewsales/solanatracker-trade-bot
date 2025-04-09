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
    evaluateBuy(entry, config) {
        const ind = entry.indicators;
        const tokenSymbol = entry.token?.symbol || entry.price?.token?.symbol || 'UNKNOWN';
        logger.debug(`[Indicators] Evaluating buy for ${tokenSymbol}`);
        const trendBiasRequired = process.env.TRADING_MODE !== 'DEGEN';
        const logicMode = process.env.BUY_LOGIC_MODE || "loose";
        const margin = getThreshold("BUY_MARGIN") || 0;
        const bbTarget = calculateThreshold("BB_BUY_THRESHOLD", margin);
        const rsiThreshold = getThreshold("RSI_BUY_THRESHOLD") || 35;
        const rsiTarget = calculateThreshold("BUY_MARGIN", margin);
        logger.info(`[Indicators] Buy Logic Mode: ${logicMode}`);
        logger.info(`[Indicators] Calculated Buy Logic Mode: ${logicMode} | Margin: ${margin}`);
        if (!ind) return false;

        let decision;
        if (logicMode === "strict") {
            decision = (!trendBiasRequired || ind.trendBias) &&
                ind.price <= bbTarget &&
                ind.rsi <= rsiThreshold;
        } else {
            decision = (ind.price <= bbTarget || ind.rsi <= rsiTarget);
        }

        logger.info(`📈 [Indicators] Evaluating ${tokenSymbol}:
---------------------------------
Price: ${ind.price}
EMA Short: ${ind.emaShort}
EMA Medium: ${ind.emaMedium}
Upper BB: ${ind.bb.upper}
Lower BB: ${ind.bb.lower}
RSI: ${ind.rsi}
RSI Threshold: ${rsiThreshold}
BB Target: ${bbTarget}
RSI Target: ${rsiTarget}
Trend Bias Required: ${trendBiasRequired} / Current: ${ind.trendBias}
Buy Logic Mode: ${logicMode}

Buy Conditions:
  - Logic Mode: ${logicMode}
  - Strict Mode: Trend Bias Required (${trendBiasRequired}) AND Price <= BB Target (${ind.price <= bbTarget}) AND RSI <= RSI Threshold (${ind.rsi <= rsiThreshold})
  - Loose Mode: Price <= BB Target (${ind.price <= bbTarget}) OR RSI <= RSI Target (${ind.rsi <= rsiTarget})
---------------------------------
Final Buy Decision: ${decision}`);

        return decision;
    },

    evaluateSell(entry, position, config) {
        const ind = entry.indicators;
        const tokenSymbol = entry.token?.symbol || entry.price?.token?.symbol || 'UNKNOWN';
        logger.debug(`[Indicators] Evaluating sell for ${tokenSymbol}`);
        if (!ind) {
            logger.warn(`[Indicators] Missing indicators data for ${tokenSymbol} during sell evaluation.`);
            return false;
        }

        const mode = process.env.TRADING_MODE || "retail";
        const rsiSellThreshold = getThreshold(mode === 'degen' ? "DEGEN_RSI_SELL_THRESHOLD" : "RSI_SELL_THRESHOLD") || 70;
        const margin = getThreshold(mode === 'degen' ? "DEGEN_SELL_MARGIN" : "SELL_MARGIN") || 0;
        const trailingStopPercent = getThreshold(mode === 'degen' ? "DEGEN_TRAILING_STOP_PERCENT" : "TRAILING_STOP_PERCENT") || 0.05;

        // Adaptive trailing stop: Adjust trailing stop percentage based on volatility measured by Bollinger Band width
        const baselineVolatility = parseFloat(process.env.BASELINE_VOLATILITY) || 0.05;
        const currentVolatility = (ind.bb.upper - ind.bb.lower) / ind.price;
        const adaptiveTrailingStopPercent = currentVolatility > baselineVolatility ? trailingStopPercent * (currentVolatility / baselineVolatility) : trailingStopPercent;

        const trailingTakeProfit = (position?.highestPrice !== undefined && position?.highestPrice !== null) ? (ind.price >= position.highestPrice * (1 + trailingStopPercent)) : false;

        const emaSellTarget = calculateThreshold("EMA_SELL_THRESHOLD", -margin);
        const rsiTarget = calculateThreshold("SELL_MARGIN", -margin);

        const priceBelowStop = (position?.sl !== undefined && position?.sl !== null) ? (ind.price <= position.sl) : false;
        const trailingStop = (position?.highestPrice !== undefined && position?.highestPrice !== null) ? (ind.price < position.highestPrice * (1 - adaptiveTrailingStopPercent)) : false;
        const upperBandExit = ind.price > ind.bb.upper;
        const emaReversal = ind.emaShort < emaSellTarget;
        const rsiOverbought = ind.rsi >= rsiTarget;

        const maxNegativePnl = parseFloat(process.env.MAX_NEGATIVE_PNL) || -10;
        const maxPositivePnl = parseFloat(process.env.MAX_POSITIVE_PNL) || 19;
        const pnl = (ind.price - position.entryPrice) / position.entryPrice * 100;
        const hitPnlThreshold = pnl <= maxNegativePnl || pnl >= maxPositivePnl;

        let signalScore = 0;
        const isProfitable = pnl >= 2.8; // Require at least 2.8% profit to be considered profitable

        // Adjust signal weights based on PnL
        const trailingStopWeight = isProfitable ? 3 : 4;
        const rsiOverboughtWeight = isProfitable ? 1 : 2;
        const emaReversalWeight = isProfitable ? 0.5 : 1;
        const upperBandExitWeight = isProfitable ? 0.5 : 1;

        signalScore += trailingStop ? trailingStopWeight : 0;
        signalScore += emaReversal ? emaReversalWeight : 0;
        signalScore += rsiOverbought ? rsiOverboughtWeight : 0;
        signalScore += upperBandExit ? upperBandExitWeight : 0;

        // Set dynamic minimum score based on mode and PnL
        const minSellScore = (mode === 'degen') ? (isProfitable ? 3 : 4) : (isProfitable ? 2 : 3);

        let standardSell = (signalScore >= minSellScore) && (hitPnlThreshold || isProfitable);
        logger.info(`[Indicators] Calculated Sell Signal Score: ${signalScore} (Minimum Required: ${minSellScore}) | PnL: ${pnl.toFixed(2)}% | Mode: ${mode.toUpperCase()} | Profitable: ${isProfitable}`);

        let shouldSell = false;
        let criticalSell = priceBelowStop || pnl <= maxNegativePnl;

        if (criticalSell) {
            logger.warn(`[Indicators] Critical sell condition met for ${tokenSymbol}: Stop-loss or negative PnL threshold hit.`);
            shouldSell = true;
        } else if (standardSell || trailingTakeProfit) {
            if (trailingTakeProfit) {
                logger.info(`[Indicators] Trailing take profit condition met for ${tokenSymbol}.`);
            } else {
                logger.info(`[Indicators] Standard sell signal met for ${tokenSymbol}: Combination of weighted signals & PnL targets.`);
            }
            shouldSell = true;
        } else {
            logger.info(`[Indicators] No sell decision for ${tokenSymbol}. Conditions checked:
            - Price Below Stop: ${priceBelowStop}
            - Trailing Stop: ${trailingStop}
            - EMA Reversal: ${emaReversal}
            - RSI Overbought: ${rsiOverbought}
            - Upper Band Exit: ${upperBandExit}`);
        }

        logger.info(`📉 [Indicators] Evaluating ${tokenSymbol}:
---------------------------------
Price: ${ind.price}
EMA Short: ${ind.emaShort}
EMA Medium: ${ind.emaMedium}
Upper BB: ${ind.bb.upper}
Lower BB: ${ind.bb.lower}
RSI: ${ind.rsi}
RSI Sell Threshold: ${rsiSellThreshold}
EMA Sell Target: ${emaSellTarget}
RSI Target: ${rsiTarget}

Sell Conditions:
  - Price Below Stop: ${priceBelowStop}
  - Trailing Stop: ${trailingStop} (Weight: ${trailingStopWeight})
  - EMA Reversal: ${emaReversal} (Weight: ${emaReversalWeight})
  - RSI Overbought: ${rsiOverbought} (Weight: ${rsiOverboughtWeight})
  - Upper Band Exit: ${upperBandExit} (Weight: ${upperBandExitWeight})
  - Calculated Sell Signal Score: ${signalScore} (Min Required: ${minSellScore})
  - Final Sell Decision: ${shouldSell}`);
        
        return shouldSell;
    }
};