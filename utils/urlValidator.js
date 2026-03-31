/**
 * urlValidator.js
 *
 * Validates recipe URLs before the importer fetches them.
 * Prevents Server-Side Request Forgery (SSRF) by blocking requests to
 * private networks, loopback addresses, and cloud metadata endpoints.
 */

// RFC-1918 private ranges + link-local (AWS/GCP metadata lives at 169.254.x.x).
const PRIVATE_IP_PATTERNS = [
  /^127\./,                        // Loopback
  /^10\./,                         // RFC-1918 class A
  /^172\.(1[6-9]|2\d|3[01])\./,   // RFC-1918 class B
  /^192\.168\./,                   // RFC-1918 class C
  /^169\.254\./,                   // Link-local / AWS metadata (169.254.169.254)
  /^0\./,                          // "This" network
  /^::1$/,                         // IPv6 loopback
  /^fc00:/i,                       // IPv6 unique-local
  /^fe80:/i,                       // IPv6 link-local
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  '0.0.0.0',
  'broadcasthost',
]);

/**
 * Throws an Error if `rawUrl` is not safe to fetch.
 * Allows only http:// and https:// URLs pointing at public internet hosts.
 *
 * @param {string} rawUrl
 */
export function validateRecipeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are permitted.');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('Requests to that hostname are not permitted.');
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error('Requests to private or internal IP addresses are not permitted.');
    }
  }
}
