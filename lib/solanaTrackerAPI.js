const axios = require("axios");
const logger = require("../utils/logger");

const session = axios.create({
    baseURL: "https://data.solanatracker.io/",
    timeout: 20000,
    headers: { "x-api-key": process.env.API_KEY },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RETRIES = 3;
const BASE_BACKOFF = 5000; // in ms

async function fetchWithRetry(endpoint, description = "API call") {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const startTime = Date.now();
            const response = await session.get(endpoint);
            const elapsedTime = Date.now() - startTime;
            console.log(`[API LOG] URL: ${endpoint}, Status: ${response.status}, Response time: ${elapsedTime}ms`);

            if (process.env.API_DEBUG === "1") {
                console.log(`🔍 [DEBUG] ${description} response:`, JSON.stringify(response.data, null, 2));
            }

            return response.data;

        } catch (error) {
            const status = error.response?.status;
            const isRateLimited = status === 429;
            const backoff = BASE_BACKOFF * Math.pow(2, attempt); // Exponential

            if (isRateLimited) {
                logger.warn(`[RATE LIMIT] ${description} — attempt ${attempt + 1}. Retrying in ${backoff}ms.`);
                await sleep(backoff);
            } else {
                logger.error(`[ERROR] ${description} failed`, {
                    message: error.message,
                    response: error.response?.data,
                    stack: error.stack,
                });
                return null;
            }
        }
    }

    logger.error(`[FAILED] ${description} exceeded ${MAX_RETRIES} retries.`);
    return null;
}

async function fetchTrendingTokens(timeframe = "15m") {
    return await fetchWithRetry(`/tokens/trending/${timeframe}`, "fetchTrendingTokens");
}

async function fetchTokenDetails(tokenId) {
    return await fetchWithRetry(`/tokens/${tokenId}`, `fetchTokenDetails for ${tokenId}`);
}

async function fetchChartData(tokenId, interval = "1m") {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 40 * 60;

    const endpoint = `/chart/${tokenId}/${interval}`;
    const data = await fetchWithRetry(endpoint, `fetchChartData for ${tokenId}`);

/*     if (!Array.isArray(data) || data.length < 20) {
        logger.warn(`[ChartAPI] Not enough chart data for ${tokenId} — skipping`);
        return [];
    } */

    return data;
}

module.exports = {
    fetchTrendingTokens,
    fetchTokenDetails,
    fetchChartData,
};


/* Example usage in BuyOps or SellOps
const {
    fetchTrendingTokens,
    fetchTokenDetails,
    fetchChartData,
} = require("../lib/solanaTrackerAPI");

const tokens = await fetchTrendingTokens("15m");
const details = await fetchTokenDetails("ABC123");
const chart = await fetchChartData("ABC123"); 
*/