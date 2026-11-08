// Money stays in integer minor units, including while it travels through MySQL.
export function parseAmount(
  value: string,
  decimals: number,
  pad = false,
): bigint {
  const pattern = pad
    ? /^\d{1,30}(?:\.\d{1,3})?$/
    : new RegExp(`^\\d{1,30}\\.\\d{${decimals}}$`);
  if (!pattern.test(value)) throw new Error("INVALID_AMOUNT");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("INVALID_AMOUNT");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"))
  );
}
export function formatAmount(units: bigint, decimals: number): string {
  const sign = units < 0n ? "-" : "";
  const digits = (units < 0n ? -units : units)
    .toString()
    .padStart(decimals + 1, "0");
  return `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
export function callbackReply(
  units: bigint,
  decimals: number,
  transactionId?: string,
) {
  // API-MATIC requires a JSON number. Emit the exact decimal literal without converting money to float.
  return `{"balance":${formatAmount(units, decimals)}${transactionId ? `,"transaction_id":${JSON.stringify(transactionId)}` : ""}}`;
}
