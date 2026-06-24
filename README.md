# Soroban RentWatch Backend 🛡️

An off-chain, multi-tenant Soroban smart contract Time-To-Live (TTL) monitoring and automated rent-bumping system.

## 📖 Overview

In the Soroban smart contract ecosystem, state entries require "rent" to be paid (via TTL extensions) to prevent them from being archived. **Soroban RentWatch** acts as an automated relayer infrastructure that constantly monitors the TTL of registered Soroban contract keys. When a key approaches its expiration threshold, the backend automatically constructs, signs, and submits an `ExtendFootprintTTL` transaction to the Stellar network using a pool of rotating relayer keys.

## ⚡ Core Architecture

1. **Indexer Worker:** A cron-based job that queries the Soroban RPC for the current TTL of monitored keys. It evaluates keys against user-defined thresholds (e.g., extend if `< 15,000` ledgers remaining).
2. **Relayer Engine:** An asynchronous queue system (backed by Redis) that safely signs and broadcasts Stellar transactions. It manages a pool of funded relayer wallets to prevent sequence number collisions.
3. **Deposit Watcher:** Listens to the Horizon network stream for incoming XLM deposits to the main operational account. It routes these deposits into virtual "Balance Pools" for users, which fund the network fees required to bump their contracts.
4. **Webhook Notifications:** Sends real-time POST requests to developers when their contracts are successfully extended, when they fall below critical thresholds, or when their XLM balance is running low.

## 🛠 Tech Stack

* **Runtime:** Node.js v22+, TypeScript
* **Database:** PostgreSQL (via Prisma ORM)
* **Queueing & Caching:** Redis (via `ioredis`)
* **Blockchain:** `@stellar/stellar-sdk`
* **Logging:** `pino` for structured JSON logs

## ⚙️ Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/rentwatch?schema=public"
REDIS_URL="redis://localhost:6379"

# Stellar Network
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org:443"
HORIZON_URL="https://horizon-testnet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Security (AES-256-GCM encryption for relayer secrets)
KEY_ENCRYPTION_SECRET="32-byte-hex-string-for-encryption"

# Deposits
DEPOSIT_ACCOUNT_PUBLIC="G..."

# Engine Tuning
INDEXER_INTERVAL_MS=30000
INDEXER_BATCH_SIZE=200
RELAY_QUEUE_CONCURRENCY=1
MIN_BALANCE_XLM=1.0
LOG_LEVEL="info"
```

## 🚀 How to Run Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Setup the Database
Ensure your local PostgreSQL and Redis instances are running, then push the schema:
```bash
npm run db:push
npm run db:generate
```

### 3. Add a Relayer Key
The system requires at least one funded Stellar account to pay transaction fees. We use a built-in CLI to securely encrypt and store this key in the database:
```bash
npm run cli -- add-relayer-key --secret S...
```

### 4. Start the Engine
```bash
npm run dev
```

## 🚢 Deployment (Render / Railway / Heroku)

This backend is designed as a long-running background worker.
* **Build Command:** `npm install && npm run build`
* **Start Command:** `npm run start`
* Ensure you provision a managed PostgreSQL database and a managed Redis instance, attaching their connection URLs to the environment variables.
