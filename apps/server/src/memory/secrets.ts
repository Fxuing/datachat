/** Conservative patterns from the memory spec §6.4. Never log the matched text. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:password|passwd|pwd)\s*[:=]/i,
  /\b(?:token|api[_-]?key|secret)\s*[:=]/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /(?<!\d)\d{17}[\dXx](?!\d)/,
];

export function hasSensitiveMemory(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
