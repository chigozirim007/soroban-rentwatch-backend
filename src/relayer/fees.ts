import { rpc } from "@stellar/stellar-sdk";
import { logger } from "../utils/logger.js";

// ─── Fee Extraction ──────────────────────────────────────────
//
// Extracts the actual XLM fee charged from a confirmed Soroban
// transaction. Converts from stroops (1 XLM = 10,000,000 stroops)
// to XLM with 7-decimal precision.
// ─────────────────────────────────────────────────────────────

const STROOPS_PER_XLM = 10_000_000;

/**
 * Extract the total fee (in XLM) from a successful transaction response.
 *
 * @param txResponse - The response from server.getTransaction() after SUCCESS
 * @returns The total fee in XLM as a string with 7 decimal places
 */
export function extractFeeXlm(txResponse: rpc.Api.GetSuccessfulTransactionResponse): string {
  try {
    // The fee charged is available in the transaction result envelope
    // We parse it from the result XDR
    const feeCharged = txResponse.resultXdr.feeCharged().toString();
    const feeStroops = BigInt(feeCharged);
    const xlm = Number(feeStroops) / STROOPS_PER_XLM;
    return xlm.toFixed(7);
  } catch (err) {
    logger.warn(err, "Could not extract fee from tx result, using estimate");
    // Fallback: return a conservative estimate
    return "0.1000000";
  }
}

/**
 * Convert stroops to XLM.
 */
export function stroopsToXlm(stroops: number | bigint): string {
  return (Number(stroops) / STROOPS_PER_XLM).toFixed(7);
}

/**
 * Convert XLM to stroops.
 */
export function xlmToStroops(xlm: number): bigint {
  return BigInt(Math.round(xlm * STROOPS_PER_XLM));
}
