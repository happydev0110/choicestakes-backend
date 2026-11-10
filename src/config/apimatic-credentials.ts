// API keys are opaque credentials. The sandbox host authenticates their environment.
// Reject empty values and characters that cannot safely form an API-key header.
export const validApiMaticKey = (value: string) => /^[\x21-\x7e]+$/.test(value);
export const validApiMaticSecret = (value: string) => /^[a-fA-F0-9]{64}$/.test(value);
