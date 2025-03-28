const { EMA, RSI, BollingerBands } = require("technicalindicators");
const logger = require("../utils/logger");

function calculateIndicators(chart) {
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

module.exports = {
    calculateIndicators,
    evaluateTrade(entry, config) {
        const ind = entry.indicators;
        const trendBiasRequired = process.env.TRADING_MODE !== 'DEGEN';
        if (!ind) return false;

        const rsiThreshold = getThreshold("RSI_BUY_THRESHOLD") || 35;
        const margin = getThreshold("BUY_MARGIN_PERCENT") || 0;
        const logicMode = process.env.BUY_LOGIC_MODE || "loose";

        const bbTarget = ind.bb.lower * (1 + margin);
        const rsiTarget = rsiThreshold * (1 + margin);

        let decision;
        if (logicMode === "strict") {
            decision = (!trendBiasRequired || ind.trendBias) &&
                ind.price <= bbTarget &&
                ind.rsi <= rsiThreshold;
        } else {
            decision = (!trendBiasRequired || ind.trendBias) &&
                (ind.price <= bbTarget || ind.rsi <= rsiTarget);
        }

        logger.debug(`📈 [Indicators] Evaluating ${entry.token?.symbol || "UNKNOWN"}:
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
  Trend Bias Required: ${trendBiasRequired} / Current: ${ind.trendBias}
  Strict Condition -> TrendBias && Price <= BB Target: ${ind.price <= bbTarget} AND RSI <= RSI Threshold: ${ind.rsi <= rsiThreshold}
  Loose Condition  -> TrendBias && (Price <= BB Target OR RSI <= RSI Target): ${ind.price <= bbTarget || ind.rsi <= rsiTarget}
---------------------------------
Final Buy Decision: ${decision}`);

        return decision;
    },

    evaluateSell(entry, position, config) {
        const ind = entry.indicators;
        if (!ind) return false;

        const rsiSellThreshold = getThreshold("RSI_SELL_THRESHOLD") || 70;
        const margin = getThreshold("SELL_MARGIN_PERCENT") || 0;
        const trailingStopPercent = getThreshold("TRAILING_STOP_PERCENT") || 0.05;

        const emaSellTarget = ind.emaMedium * (1 + margin);
        const rsiTarget = rsiSellThreshold * (1 - margin);

        const priceBelowStop = position?.sl && ind.price <= position.sl;
        const trailingStop = position?.highestPrice && ind.price < position.highestPrice * (1 - trailingStopPercent);
        const upperBandExit = ind.price > ind.bb.upper;
        const emaReversal = ind.emaShort < emaSellTarget;
        const rsiOverbought = ind.rsi >= rsiTarget;

        const shouldSell =
            priceBelowStop ||
            trailingStop ||
            (emaReversal && rsiOverbought) ||
            (upperBandExit && rsiOverbought);

        return shouldSell;
    }
};