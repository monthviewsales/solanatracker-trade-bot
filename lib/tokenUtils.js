/*
  Token Utilities
  ----------------
  This module provides utility functions for filtering and validating tokens received from the API.
  It includes:
    - Constants & configuration values for token filtering.
    - Helper functions to assess token risk, duplicate or blacklisted status, and symbol validity.
    - The main filterTokens function that applies a series of filtering criteria.
*/

/* ------------------------------------------------------------------------
   Constants & Configuration
   ------------------------------------------------------------------------ */
const MIN_LIQUIDITY_USD = 20000;
const MIN_TX_COUNT = 1000;
const MIN_PRICE_USD = 0.00001;
const EXCLUDED_SYMBOLS = ["SCAM", "USDC", "SOL", "BONK", "RUG", "FAKE", "SNP500", "DISTRIBUTE", "HIBER"];

const logger = require('../utils/logger');

/* ------------------------------------------------------------------------
   Helper Functions
   ------------------------------------------------------------------------ */

/**
 * Determines if a token is considered 'rugged' based on its risk metrics.
 * A token is flagged as rugged if its 'rugged' flag is true or its risk score is 8 or above.
 *
 * @param {Object} token - The token object containing risk properties.
 * @returns {Boolean} - True if the token is considered rugged.
 */
function isRugged(token) {
  return token?.risk?.rugged === true || token?.risk?.score >= 8;
}

/**
 * Checks if a token is a duplicate or has been previously traded/flagged.
 *
 * @param {Object} token - The token entry to check (including nested token properties).
 * @param {Object} coinStore - A store object used to check for duplicates using a mint.
 * @returns {Boolean} - True if the token already exists or is blacklisted.
 */
function isDuplicateOrBlacklisted(token, coinStore) {
  const mint = token.token?.mint || token.token?.address || token.token?.id;
  const existing = coinStore.findByMint(mint);
  return (
    existing &&
    (["open", "closed", "blacklist", "hold", "target"].includes(existing.status))
  );
}

/**
 * Checks if a token's symbol is considered 'bad' by comparing it against a list of excluded symbols.
 *
 * @param {string} symbol - The token's symbol.
 * @returns {Boolean} - True if the symbol contains any excluded substring.
 */
function hasBadSymbol(symbol) {
  const upperSymbol = symbol.toUpperCase();
  return EXCLUDED_SYMBOLS.some((ex) => upperSymbol.includes(ex));
}

/**
 * Retrieves a numeric value from an environment variable.
 *
 * @param {string} key - The environment variable key.
 * @param {number} fallback - A fallback value if the environment variable is not set.
 * @returns {number} - The parsed numeric value.
 */
function envNum(key, fallback = 0) {
  return parseFloat(process.env[key]) || fallback;
}

/* ------------------------------------------------------------------------
   Main Token Filtering Function
   ------------------------------------------------------------------------ */

/**
 * Filters an array of raw token entries from the API based on various criteria.
 *
 * Filtering Steps:
 *   1. Validate that each token has associated liquidity pool data.
 *   2. Ensure that essential fields (mint and symbol) exist.
 *   3. Filter out tokens with high risk (rugged) flags.
 *   4. Filter tokens outside acceptable risk score thresholds.
 *   5. Filter tokens based on liquidity thresholds.
 *   6. Filter tokens based on market cap thresholds.
 *   7. Optionally filter tokens missing required social data (if REQUIRE_SOCIAL_DATA is true).
 *   8. Exclude tokens that are duplicates or already have a trading status.
 *
 * Detailed logging is provided at each step to facilitate debugging.
 *
 * @param {Array} rawTokens - Array of token entries received from the API.
 * @param {Object} coinStore - Store of existing coins used for duplicate/blacklist checks.
 * @returns {Array} - Array of tokens that pass all filtering criteria.
 */
function filterTokens(rawTokens, coinStore) {
  logger.debug(`[TokenUtils] Raw tokens received: ${rawTokens.length}`);

  // Retrieve threshold settings from environment variables
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
    const isOpen = token.status;

    // Is it already open?
    if (!isOpen === "open")
    {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} is already open — skipping`);
      return false;
    }

    // Step 1: Ensure liquidity pool data exists.
    if (!pool) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} has no liquidity pool data — skipping`);
      return false;
    }

    // Step 2: Validate essential token fields (mint and symbol).
    if (!token?.mint || !token?.symbol) {
      logger.warn(`⚠️ [TokenUtils] Token missing essential fields: ${JSON.stringify(token)}`);
      return false;
    }

    // Step 3: Drop all the coins we flagged in hasBadSymbol()
    if (hasBadSymbol(token.symbol)) return false;


    // Step 4: Filter out tokens that are flagged as rugged.
    if (entry.risk?.rugged) return false;

    // Retrieve risk, liquidity, and market cap data for further filtering.
    const riskScore = entry?.risk?.score ?? 10;
    const liquidity = pool.liquidity?.usd || 0;
    const marketCap = pool.marketCap?.usd || 0;

    // Step 5: Filter based on acceptable risk score range.
    if (riskScore < minRisk || riskScore > maxRisk) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} filtered due to risk score: ${riskScore}`);
      return false;
    }
    // Step 6: Filter tokens not meeting liquidity criteria.
    if (liquidity < minLiquidity || liquidity > maxLiquidity) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} filtered due to liquidity: ${liquidity}`);
      return false;
    }
    // Step 7: Filter tokens that do not meet market cap requirements.
    if (marketCap < minMarketCap || marketCap > maxMarketCap) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} filtered due to market cap: ${marketCap}`);
      return false;
    }

    // Step 8: If required, filter out tokens missing social data.
    if (requireSocial) {
      const hasX = token.attributes?.xAccount;
      const hasTG = token.attributes?.telegram;
      if (!hasX && !hasTG) {
        logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} skipped due to missing social data`);
        return false;
      }
    }

    // Step 9: Exclude tokens that are duplicates or already have a trading status.
    if (isDuplicateOrBlacklisted(entry, coinStore)) {
      logger.warn(`⚠️ [TokenUtils] Token ${token.symbol} skipped due to existing status`);
      return false;
    }

    // Token passes all filters.
    return true;
  });

  logger.debug(`[TokenUtils] Tokens after filtering: ${filtered.length}`);
  filtered.forEach(token => {
    const pool = token.pools?.[0];
    logger.info(`[TokenUtils] Passed token: ${token.token.symbol} (${token.token.mint}) - Market Cap: ${pool?.marketCap?.usd}, Liquidity: ${pool?.liquidity?.usd}`);
  });

  return filtered;
}

/* ------------------------------------------------------------------------
   Module Exports
   ------------------------------------------------------------------------ */

module.exports = {
  isRugged,
  filterTokens,
};