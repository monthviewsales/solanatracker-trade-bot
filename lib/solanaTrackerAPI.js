const axios = require("axios");
const logger = require("../utils/logger");

const session = axios.create({
    baseURL: "https://data.solanatracker.io/",
    timeout: 20000,
    headers: { "x-api-key": process.env.API_KEY },
});

const MAX_RETRIES = 3;

async function fetchWithRetry(endpoint, description = "API call") {
    const maxRetries = 5;
    let retryDelay = 500;
    let attempt = 0;

    while (attempt <= maxRetries) {
        try {
            const startTime = Date.now();
            const response = await session.get(endpoint);
            const elapsedTime = Date.now() - startTime;
            logger.info(`🌐 [API] ${description} → ${endpoint} [${response.status}] (${elapsedTime}ms)`);

            if (process.env.API_DEBUG === "1") {
                logger.debug(`📦 [API DEBUG] ${description} raw response:\n${JSON.stringify(response.data, null, 2)}`);
            }

            if (Array.isArray(response.data)) {
                logger.info(`📊 [API] ${description} → received ${response.data.length} items`);
            }

            return response.data;

        } catch (error) {
            attempt++;
            const jitter = Math.random() * 1000;
            retryDelay = Math.min(1000 * 2 ** attempt + jitter, 10000); // Exponential backoff with jitter

            if (error.response?.status === 429) {
                logger.warn(`[API] Rate limit hit during ${description} (Attempt ${attempt}). Retrying after ${Math.round(retryDelay)}ms`);
            } else if (error.message.includes("Too Many Requests")) {
                logger.warn(`[API] API rate limit error during ${description} (Attempt ${attempt}). Retrying after ${Math.round(retryDelay)}ms`);
            } else if (error.message.includes("rate limit exceeded")) {
                logger.warn(`[API] RPC rate limit error during ${description} (Attempt ${attempt}). Retrying after ${Math.round(retryDelay)}ms`);
            } else {
                logger.error(`[ERROR] ${description} failed on attempt ${attempt}`, {
                    message: error.message,
                    response: error.response?.data,
                    stack: error.stack,
                });
            }

            if (attempt >= maxRetries) {
                logger.error(`[FAILED] ${description} exceeded ${maxRetries} retries.`);
                return null;
            }

            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

async function fetchLivePriceData(mintAddress) {
    const endpoint = `/token/live/${mintAddress}`;
    const data = await fetchWithRetry(endpoint, `fetchLivePriceData for ${mintAddress}`);
    logger.info(`🚀 [API] Fetched live price data for ${mintAddress}`);
    return data;
}

async function fetchTrendingTokens(timeframe = "15m") {
    const data = await fetchWithRetry(`/tokens/trending/${timeframe}`, "fetchTrendingTokens from SolanaTracker.io");
    logger.info(`🚀 [API] Fetched trending tokens for timeframe: ${timeframe}`);
    return data;
}

async function fetchTokenDetails(tokenId) {
    logger.info(`🔍 [API] Fetching token details: ${tokenId}`);
    return await fetchWithRetry(`/tokens/${tokenId}`, `fetchTokenDetails for ${tokenId}`);
}

async function fetchChartData(tokenId, interval = "1m") {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 40 * 60;

    logger.info(`📈 [API] Fetching chart data for ${tokenId} from ${from} to ${now}`);
    const endpoint = `/chart/${tokenId}/${interval}`;
    const data = await fetchWithRetry(endpoint, `fetchChartData for ${tokenId}`);

    return data;
}

async function fetchWalletBasic(publicKey) {
    const endpoint = `/wallet/${publicKey}/basic`;
    const data = await fetchWithRetry(endpoint, `fetchWalletBasic for ${publicKey}`);
    logger.info(`🚀 [API] Fetched wallet basic info for ${publicKey}`);
    return data;
}

module.exports = {
    fetchTrendingTokens,
    fetchTokenDetails,
    fetchChartData,
    fetchLivePriceData,
    fetchWalletBasic,
};