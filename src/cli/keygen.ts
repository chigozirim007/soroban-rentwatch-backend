import { xdr, Address } from "@stellar/stellar-sdk";
import { getRpcServer } from "../config/stellar.js";
import { logger } from "../utils/logger.js";

// ─── LedgerKey XDR Generator ─────────────────────────────────
//
// Auto-generates common LedgerKey XDR values so users don't
// have to manually construct them. Supports:
//
//   - Instance storage (contract instance entry)
//   - Persistent data (named storage key)
//   - Contract code (WASM hash from instance entry)
// ─────────────────────────────────────────────────────────────

/**
 * Generate the LedgerKey XDR for a contract's instance storage entry.
 *
 * @param contractId - Soroban contract address (C...)
 * @returns Base64 XDR string
 */
export function generateInstanceKeyXdr(contractId: string): string {
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  return ledgerKey.toXDR("base64");
}

/**
 * Generate the LedgerKey XDR for a named persistent data entry.
 *
 * @param contractId - Soroban contract address (C...)
 * @param symbolName - The storage key symbol name
 * @returns Base64 XDR string
 */
export function generatePersistentDataKeyXdr(contractId: string, symbolName: string): string {
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvSymbol(symbolName),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  return ledgerKey.toXDR("base64");
}

/**
 * Generate the LedgerKey XDR for a contract's WASM code entry.
 * Requires fetching the instance entry first to extract the WASM hash.
 *
 * @param contractId - Soroban contract address (C...)
 * @returns Base64 XDR string, or null if instance entry not found
 */
export async function generateContractCodeKeyXdr(contractId: string): Promise<string | null> {
  const rpcServer = getRpcServer();

  // First, fetch the instance entry to get the WASM hash
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const response = await rpcServer.getLedgerEntries(instanceKey);

  if (!response.entries || response.entries.length === 0) {
    logger.warn({ contractId }, "Contract instance entry not found on ledger");
    return null;
  }

  // Parse the instance entry to extract the WASM hash
  const entryData = response.entries[0].val;
  const contractData = entryData.contractData();
  const instanceVal = contractData.val();
  const instance = instanceVal.instance();
  const executable = instance.executable();

  // The executable should be a wasm reference
  const wasmHash = executable.wasmHash();

  const codeKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({
      hash: wasmHash,
    }),
  );

  return codeKey.toXDR("base64");
}
