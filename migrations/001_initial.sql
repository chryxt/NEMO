-- ============================================================
-- NEMO — Market Microstructure Engine: Database Schema
-- Migration: 001_initial
-- All tables use IF NOT EXISTS — safe to run multiple times.
-- TimescaleDB features are applied inside DO blocks and silently
-- skipped when TimescaleDB is not installed.
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TimescaleDB not available — all tables will use standard PostgreSQL';
END $$;

-- ── oracle_ticks ─────────────────────────────────────────────────────────────
-- One row per oracle price update (Chainlink LWBA or Binance spot)

CREATE TABLE IF NOT EXISTS oracle_ticks (
  ts      TIMESTAMPTZ    NOT NULL,
  symbol  TEXT           NOT NULL,   -- 'BTC' | 'ETH' | 'SOL'
  price   NUMERIC(18, 8) NOT NULL,
  source  TEXT           NOT NULL    -- 'chainlink' | 'binance'
);

CREATE INDEX IF NOT EXISTS oracle_ticks_symbol_ts ON oracle_ticks (symbol, ts DESC);

-- ── clob_quotes ──────────────────────────────────────────────────────────────
-- One row per best-bid-ask update on any token

CREATE TABLE IF NOT EXISTS clob_quotes (
  ts       TIMESTAMPTZ    NOT NULL,
  token_id TEXT           NOT NULL,
  symbol   TEXT           NOT NULL,
  outcome  TEXT           NOT NULL,   -- 'up' | 'down'
  bid      NUMERIC(10, 6) NOT NULL,
  ask      NUMERIC(10, 6) NOT NULL,
  spread   NUMERIC(10, 6) NOT NULL
);

CREATE INDEX IF NOT EXISTS clob_quotes_token_ts  ON clob_quotes (token_id, ts DESC);
CREATE INDEX IF NOT EXISTS clob_quotes_symbol_ts ON clob_quotes (symbol, ts DESC);

-- ── clob_trades ──────────────────────────────────────────────────────────────
-- One row per CLOB trade (last_trade_price or price_change event)

CREATE TABLE IF NOT EXISTS clob_trades (
  ts       TIMESTAMPTZ    NOT NULL,
  token_id TEXT           NOT NULL,
  symbol   TEXT           NOT NULL,
  outcome  TEXT           NOT NULL,
  price    NUMERIC(10, 6) NOT NULL,
  size     NUMERIC(18, 6) NOT NULL,
  side     TEXT           NOT NULL    -- 'BUY' | 'SELL'
);

CREATE INDEX IF NOT EXISTS clob_trades_token_ts  ON clob_trades (token_id, ts DESC);
CREATE INDEX IF NOT EXISTS clob_trades_symbol_ts ON clob_trades (symbol, ts DESC);

-- ── trade_activity ────────────────────────────────────────────────────────────
-- Raw RTDS on-chain activity feed

CREATE TABLE IF NOT EXISTS trade_activity (
  ts           TIMESTAMPTZ    NOT NULL,
  condition_id TEXT           NOT NULL,
  event_slug   TEXT           NOT NULL,
  outcome      TEXT           NOT NULL,
  side         TEXT           NOT NULL,   -- 'BUY' | 'SELL'
  size_shares  NUMERIC(18, 6) NOT NULL,
  price        NUMERIC(10, 6) NOT NULL,
  wallet       TEXT           NOT NULL,
  pseudonym    TEXT,
  tx_hash      TEXT           NOT NULL
);

-- tx_hash + ts satisfies TimescaleDB unique-constraint rules (must include partition column)
CREATE UNIQUE INDEX IF NOT EXISTS trade_activity_tx_hash ON trade_activity (tx_hash, ts);
CREATE        INDEX IF NOT EXISTS trade_activity_ts      ON trade_activity (ts DESC);
CREATE        INDEX IF NOT EXISTS trade_activity_slug_ts ON trade_activity (event_slug, ts DESC);
CREATE        INDEX IF NOT EXISTS trade_activity_wallet  ON trade_activity (wallet, ts DESC);

-- ── whale_events ──────────────────────────────────────────────────────────────
-- Trades exceeding the configured whale threshold

CREATE TABLE IF NOT EXISTS whale_events (
  ts        TIMESTAMPTZ    NOT NULL,
  symbol    TEXT           NOT NULL,
  outcome   TEXT           NOT NULL,
  side      TEXT           NOT NULL,
  size_usd  NUMERIC(18, 2) NOT NULL,
  price     NUMERIC(10, 6) NOT NULL,
  wallet    TEXT           NOT NULL
);

CREATE INDEX IF NOT EXISTS whale_events_symbol_ts ON whale_events (symbol, ts DESC);
CREATE INDEX IF NOT EXISTS whale_events_wallet_ts ON whale_events (wallet, ts DESC);

-- ── market_windows ────────────────────────────────────────────────────────────
-- One row per 5-minute window per symbol (written at window open)

CREATE TABLE IF NOT EXISTS market_windows (
  window_ts      BIGINT         NOT NULL,   -- Unix seconds, window start
  close_ts       BIGINT         NOT NULL,   -- Unix seconds, window end
  symbol         TEXT           NOT NULL,
  token_id_up    TEXT,
  token_id_down  TEXT,
  open_price     NUMERIC(18, 8),            -- oracle price at window open (NULL if not yet available)
  window_hash    TEXT,                      -- state hash at window open
  mutation_count INTEGER,
  PRIMARY KEY (window_ts, symbol)
);

CREATE INDEX IF NOT EXISTS market_windows_symbol ON market_windows (symbol, window_ts DESC);

-- ── system_metrics ────────────────────────────────────────────────────────────
-- Engine metric snapshots, sampled once per minute

CREATE TABLE IF NOT EXISTS system_metrics (
  ts               TIMESTAMPTZ    NOT NULL,
  oracle_msg_rate  NUMERIC(10, 4),
  trade_msg_rate   NUMERIC(10, 4),
  clob_msg_rate    NUMERIC(10, 4),
  heap_mb          NUMERIC(10, 2),
  rss_mb           NUMERIC(10, 2),
  uptime_secs      INTEGER,
  oracle_total     BIGINT,
  trade_total      BIGINT,
  clob_total       BIGINT,
  rtds_reconnects  INTEGER,
  clob_reconnects  INTEGER
);

CREATE INDEX IF NOT EXISTS system_metrics_ts ON system_metrics (ts DESC);

-- ── connection_events ─────────────────────────────────────────────────────────
-- Connection lifecycle transitions

CREATE TABLE IF NOT EXISTS connection_events (
  ts      TIMESTAMPTZ NOT NULL,
  service TEXT        NOT NULL,   -- 'rtds' | 'clob'
  status  TEXT        NOT NULL,   -- 'connecting' | 'connected' | 'reconnecting' | 'dead'
  attempt INTEGER
);

CREATE INDEX IF NOT EXISTS connection_events_service_ts ON connection_events (service, ts DESC);

-- ── replay_events ─────────────────────────────────────────────────────────────
-- Deterministic append-only event journal for DB-based replay.
-- seq is a global monotonic sequence. Filter by ts_wall for time ranges.
-- Excludes: state.snapshot (derived/large), market.tick (high-frequency/derived).

CREATE TABLE IF NOT EXISTS replay_events (
  seq        BIGSERIAL    PRIMARY KEY,
  ts_wall    BIGINT       NOT NULL,   -- Unix ms: wall-clock time the event was emitted
  event_type TEXT         NOT NULL,
  payload    JSONB        NOT NULL,
  version    SMALLINT     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS replay_events_ts_wall ON replay_events (ts_wall);
CREATE INDEX IF NOT EXISTS replay_events_type    ON replay_events (event_type, seq);

-- ── TimescaleDB: Hypertables ──────────────────────────────────────────────────
-- Converts time-series tables to hypertables (7-day chunks by default).
-- Silently skipped when TimescaleDB is not installed.

DO $$ BEGIN
  PERFORM create_hypertable('oracle_ticks',      'ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('clob_quotes',       'ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('clob_trades',       'ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('trade_activity',    'ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('whale_events',      'ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('system_metrics',    'ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('connection_events', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TimescaleDB hypertables skipped: %', SQLERRM;
END $$;

-- ── TimescaleDB: Compression ──────────────────────────────────────────────────
-- Compresses chunks older than N days using columnar storage.

DO $$ BEGIN
  ALTER TABLE oracle_ticks SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'symbol',
    timescaledb.compress_orderby   = 'ts DESC'
  );
  ALTER TABLE clob_quotes SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'symbol,outcome',
    timescaledb.compress_orderby   = 'ts DESC'
  );
  ALTER TABLE clob_trades SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'symbol,outcome',
    timescaledb.compress_orderby   = 'ts DESC'
  );
  ALTER TABLE trade_activity SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'event_slug',
    timescaledb.compress_orderby   = 'ts DESC'
  );
  ALTER TABLE whale_events SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'symbol',
    timescaledb.compress_orderby   = 'ts DESC'
  );
  ALTER TABLE system_metrics    SET (timescaledb.compress, timescaledb.compress_orderby = 'ts DESC');
  ALTER TABLE connection_events SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'service',
    timescaledb.compress_orderby   = 'ts DESC'
  );

  PERFORM add_compression_policy('oracle_ticks',     INTERVAL '7 days',  if_not_exists => TRUE);
  PERFORM add_compression_policy('clob_quotes',      INTERVAL '7 days',  if_not_exists => TRUE);
  PERFORM add_compression_policy('clob_trades',      INTERVAL '7 days',  if_not_exists => TRUE);
  PERFORM add_compression_policy('trade_activity',   INTERVAL '7 days',  if_not_exists => TRUE);
  PERFORM add_compression_policy('whale_events',     INTERVAL '30 days', if_not_exists => TRUE);
  PERFORM add_compression_policy('system_metrics',   INTERVAL '7 days',  if_not_exists => TRUE);
  PERFORM add_compression_policy('connection_events',INTERVAL '7 days',  if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TimescaleDB compression skipped: %', SQLERRM;
END $$;

-- ── TimescaleDB: Retention Policies ──────────────────────────────────────────

DO $$ BEGIN
  PERFORM add_retention_policy('oracle_ticks',     INTERVAL '90 days',  if_not_exists => TRUE);
  PERFORM add_retention_policy('clob_quotes',      INTERVAL '90 days',  if_not_exists => TRUE);
  PERFORM add_retention_policy('clob_trades',      INTERVAL '90 days',  if_not_exists => TRUE);
  PERFORM add_retention_policy('trade_activity',   INTERVAL '180 days', if_not_exists => TRUE);
  PERFORM add_retention_policy('whale_events',     INTERVAL '365 days', if_not_exists => TRUE);
  PERFORM add_retention_policy('system_metrics',   INTERVAL '30 days',  if_not_exists => TRUE);
  PERFORM add_retention_policy('connection_events',INTERVAL '30 days',  if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TimescaleDB retention policies skipped: %', SQLERRM;
END $$;
