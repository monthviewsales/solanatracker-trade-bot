const MIN_LIQUIDITY_USD = 20000;
const MIN_TX_COUNT = 1000;
const MIN_PRICE_USD = 0.00001;
const EXCLUDED_SYMBOLS = ["SCAM", "USDC", "SOL", "BONK", "RUG", "FAKE"];

function isRugged(token) {
    return token?.risk?.rugged === true || token?.risk?.score >= 8;
}

function isDuplicateOrBlacklisted(token, coinStore) {
    const mint = token.token?.mint;
    const existing = coinStore.findByMint(mint);
    return (
        existing &&
        (["open", "closed", "blacklist", "hold", "target"].includes(existing.status))
    );
}

function hasBadSymbol(symbol) {
    return EXCLUDED_SYMBOLS.some((ex) => symbol.toUpperCase().includes(ex));
}

function envNum(key, fallback = 0) {
  return parseFloat(process.env[key]) || fallback;
}

function filterTokens(rawTokens, coinStore) {
  const minLiquidity = envNum("MIN_LIQUIDITY", 20000);
  const maxLiquidity = envNum("MAX_LIQUIDITY", Infinity);
  const minMarketCap = envNum("MIN_MARKET_CAP", 50000);
  const maxMarketCap = envNum("MAX_MARKET_CAP", Infinity);
  const minRisk = envNum("MIN_RISK_SCORE", 0);
  const maxRisk = envNum("MAX_RISK_SCORE", 5);
  const requireSocial = process.env.REQUIRE_SOCIAL_DATA === "true";

  return rawTokens.filter((entry) => {
    const token = entry.token;
    const pool = entry.pools?.[0];
    const riskScore = entry?.risk?.score ?? 10;

    if (!token?.mint || !token?.symbol || !pool) return false;

    const liquidity = pool.liquidity?.usd || 0;
    const marketCap = pool.marketCap?.usd || 0;

    if (entry.risk?.rugged) return false;
    if (riskScore < minRisk || riskScore > maxRisk) return false;
    if (liquidity < minLiquidity || liquidity > maxLiquidity) return false;
    if (marketCap < minMarketCap || marketCap > maxMarketCap) return false;

    if (requireSocial) {
      const hasX = token.attributes?.xAccount;
      const hasTG = token.attributes?.telegram;
      if (!hasX && !hasTG) return false;
    }

    // Skip duplicates or already-traded coins
    const existing = coinStore.findByMint(token.mint);
    if (existing && ["open", "closed", "blacklist", "target"].includes(existing.status)) return false;

    return true;
  });
}

module.exports = {
    filterTokens,
};