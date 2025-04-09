const MIN_LIQUIDITY_USD = 20000;
const MIN_TX_COUNT = 1000;
const MIN_PRICE_USD = 0.00001;
const EXCLUDED_SYMBOLS = ["SCAM", "USDC", "SOL", "BONK", "RUG", "FAKE"];
const logger = require('../utils/logger');

function isRugged(token) {
    return token?.risk?.rugged === true || token?.risk?.score >= 8;
}

function isDuplicateOrBlacklisted(token, coinStore) {
    const mint = token.token?.mint || token.token?.address || token.token?.id;
    const existing = coinStore.findByMint(mint);
    return (
        existing &&
        (["open", "closed", "blacklist", "hold", "target"].includes(existing.status))
    );
}

function hasBadSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    return EXCLUDED_SYMBOLS.some((ex) => upperSymbol.includes(ex));
}

function envNum(key, fallback = 0) {
  return parseFloat(process.env[key]) || fallback;
}

function filterTokens(rawTokens, coinStore) {
  logger.debug(`[TokenUtils] Raw tokens received: ${rawTokens.length}`);
  
  const minLiquidity = envNum("MIN_LIQUIDITY", 20000);
  const maxLiquidity = envNum("MAX_LIQUIDITY", Infinity);
  const minMarketCap = envNum("MIN_MARKET_CAP", 50000);
  const maxMarketCap = envNum("MAX_MARKET_CAP", Infinity);
  const minRisk = envNum("MIN_RISK_SCORE", 0);
  const maxRisk = envNum("MAX_RISK_SCORE", 5);
  const requireSocial = process.env.REQUIRE_SOCIAL_DATA === "true";

  const filtered = rawTokens.filter((entry) => {
    const token = entry.token;
    const pool = entry.pools?.[0];

    if (!pool) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} has no liquidity pool data — skipping`);
      return false;
    }

    const riskScore = entry?.risk?.score ?? 10;
    const liquidity = pool.liquidity?.usd || 0;
    const marketCap = pool.marketCap?.usd || 0;

    if (!token?.mint || !token?.symbol) {
      logger.warn(`⚠️ [TokenUtils] Token missing essential fields: ${JSON.stringify(token)}`);
      return false;
    }

    if (entry.risk?.rugged) return false;
    if (riskScore < minRisk || riskScore > maxRisk) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} filtered due to risk score: ${riskScore}`);
      return false;
    }
    if (liquidity < minLiquidity || liquidity > maxLiquidity) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} filtered due to liquidity: ${liquidity}`);
      return false;
    }
    if (marketCap < minMarketCap || marketCap > maxMarketCap) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} filtered due to market cap: ${marketCap}`);
      return false;
    }

    if (requireSocial) {
      const hasX = token.attributes?.xAccount;
      const hasTG = token.attributes?.telegram;
      if (!hasX && !hasTG) {
        logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} skipped due to missing social data`);
        return false;
      }
    }

    // Skip duplicates or already-traded coins
    if (isDuplicateOrBlacklisted(entry, coinStore)) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} skipped due to existing status`);
      return false;
    }

    return true;
  });

  logger.debug(`[TokenUtils] Tokens after filtering: ${filtered.length}`);
  filtered.forEach(token => {
      logger.info(`[TokenUtils] Passed token: ${token.token.symbol} (${token.token.mint}) - Market Cap: ${pool.marketCap?.usd}, Liquidity: ${pool.liquidity?.usd}`);
  });

  return filtered;
}

module.exports = {
  isRugged,  
  filterTokens,
};