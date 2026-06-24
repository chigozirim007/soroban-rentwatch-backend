import { rpc, Horizon } from "@stellar/stellar-sdk";
import { config } from "./index.js";

// ─── Soroban RPC Server (for getLedgerEntries, simulateTransaction, etc.) ──

let _rpcServer: rpc.Server | null = null;

export function getRpcServer(): rpc.Server {
  if (!_rpcServer) {
    _rpcServer = new rpc.Server(config.stellar.rpcUrl, {
      allowHttp: config.stellar.rpcUrl.startsWith("http://"),
    });
  }
  return _rpcServer;
}

// ─── Horizon Server (for payment streaming / deposit watching) ─────────────

let _horizonServer: Horizon.Server | null = null;

export function getHorizonServer(): Horizon.Server {
  if (!_horizonServer) {
    _horizonServer = new Horizon.Server(config.stellar.horizonUrl, {
      allowHttp: config.stellar.horizonUrl.startsWith("http://"),
    });
  }
  return _horizonServer;
}

// ─── Network Passphrase ────────────────────────────────────────────────────

export function getNetworkPassphrase(): string {
  return config.stellar.networkPassphrase;
}
