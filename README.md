# SolanaTracker Trade Bot — Scooby Fork

A fully overhauled and modular Solana memcoin trading bot built from the foundation of the excellent [YZYLAB/solana-trading-bot](https://github.com/YZYLAB/solana-trading-bot). This version retains almost none of the original code structure but credits the inspiration, naming, and API usage from the original project.

Also, The team at SolanaTracker.io (https://www.solanatracker.io/solana-rpc?via=scoobycarolan) are absolute legends.  Their entire platform is amazing if you want to build on Solana.

![Bot Screenshot](https://i.gyazo.com/afb12f6c358385f133fa4b95dba3c095.png)

---

## 📌 Overview

This bot automates the discovery, evaluation, purchase, monitoring, and sale of high-potential memecoins on the Solana blockchain, using the [Solana Tracker API](https://docs.solanatracker.io). It leverages live chart data, technical indicators, and configurable trade logic to manage positions and maximize profitability.

---

## 🧠 Architecture Summary

- **Language**: JavaScript (Node.js)
- **Data Source & RPC**: SolanaTracker.io
- **Trading Targets**: Memecoins on Raydium, Orca, Pump.fun, Moonshot, and more
- **Swap Execution**: Solana Tracker's trade API (not on-chain code)
- **Position Storage**: JSON-based persistence for simplicity
- **Indicators**: RSI, EMA, Bollinger Bands (via `technicalindicators`)

---

## 🔄 Coin Lifecycle

Each coin tracked by the bot moves through this lifecycle:

| Status      | Description |
|-------------|-------------|
| `hold`      | Coin has been added but is not yet eligible for trading |
| `target`    | Bot is actively tracking price & indicators for a decision |
| `open`      | A buy was executed and a position is active |
| `closed`    | Position was sold |
| `blacklist` | Rejected or rugged coins |

These statuses are tracked in `coins.json` and updated by various components in the bot.

---

## 🧩 File & Module Descriptions

### `index.js`
Entry point for running the bot with HTTP polling mode.

### `BuyOps.js`
- Fetches trending tokens
- Filters for quality targets
- Enriches them with chart data + indicators
- Promotes coins from `hold` ➝ `target`
- Makes buy decisions and executes trades

### `SellOps.js`
- Monitors `"open"` positions
- Re-evaluates charts and indicators
- Executes sells if conditions are met
- Tags positions as `"closed"`

### `CoinStore.js`
- Central data store for `coins.json`
- Manages `addOrUpdate()`, merge logic, lifecycle state
- Supports filtering by `status`, lookup by `mint`

### `Overwatch.js`
- Tracks open and closed positions
- Manages `positions.json` and `sold_positions.json`
- Handles tagging logic for buy/sell
- Ensures that lifecycle transitions are reflected in the coin store

### `SwapManager.js`
- Handles actual swap logic using SolanaTracker API
- Wraps pre-trade checks and balance validation
- Reports trades back to Overwatch

### `tokenUtils.js`
- Contains all token filtering logic
- Checks LP, market cap, risk, social presence, status
- Ensures only high-potential coins enter the pipeline

### `indicators.js`
- Calculates RSI, EMA, Bollinger Bands from OHLCV data
- Signals trade entry/exit conditions via `evaluateTrade()` and `evaluateSell()`

### `solanaTrackerAPI.js`
- Wrapper around SolanaTracker REST endpoints:
  - `/tokens/trending`
  - `/tokens/chart`
  - `/price/live`
  - `/swap/instructions`

---

## ⚙️ Configuration

Bot behavior is fully controlled via `.env` variables:

```env
AMOUNT=0.1                  # SOL to trade per transaction
DELAY=15000                 # Delay between buy cycles
MONITOR_INTERVAL=60000      # Interval for sell monitoring
SLIPPAGE=0.5                # Max slippage
PRIORITY_FEE=50000          # Optional gas priority fee
API_KEY=                    # Solana Tracker API key
PRIVATE_KEY=                # Your wallet key
RPC_URL=                    # Your RPC provider
MIN_LIQUIDITY=1000
MAX_LIQUIDITY=100000
MIN_MARKET_CAP=100000
MAX_MARKET_CAP=20000000
MIN_RISK_SCORE=0
MAX_RISK_SCORE=3
REQUIRE_SOCIAL_DATA=true
MARKETS=raydium,orca
MAX_NEGATIVE_PNL=10
MAX_POSITIVE_PNL=300
```

---

## 🛠️ Usage

To run the bot with HTTP polling:

```bash
node index.js
```

To use with WebSockets (optional):

```bash
node websocket.js
```

---

## 💾 Data Files

| File | Description |
|------|-------------|
| `coins.json` | Master list of all coins and their status |
| `positions.json` | Currently held positions (map by mint) |
| `sold_positions.json` | All previously exited positions |

If these files are missing or corrupted, the bot will safely rebuild them.

---

## 🧠 Sample Coin Schema

See `sample-coins.json` for a detailed schema of what each coin object includes, including token metadata, lifecycle status, indicators, and position tracking.

---

## 📖 API Usage and Credits

This bot uses the [Solana Tracker Data API](https://docs.solanatracker.io) for:
- Trending token discovery
- Live price feeds
- Chart history
- Swap execution

**Credit** to [YZYLAB/solana-trading-bot](https://github.com/YZYLAB/solana-trading-bot) for the original concept and structure.

---

## 🧪 Disclaimer

This project is for educational use only. It interacts with real wallets and live markets. You are responsible for any financial losses. Always understand and test code before running it with real funds.

---

## ⭐ Support & Contributions

Pull requests and issues are welcome! Star the project if you find it useful or want to follow updates.

---