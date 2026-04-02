import { createHash, randomBytes } from 'crypto';
import { getAdminDb } from './firebase-admin.js';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const COLLECTION   = 'passwordResetTokens';

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

// Use a hash of the email as the document ID so we can look up quickly and
// never store plaintext email in a predictable path.
function docId(email) {
  return sha256(email.toLowerCase().trim());
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Creates a one-time reset token for `email` and persists its hash to Firestore.
 * Returns the raw (un-hashed) token to be embedded in the email link.
 */
export async function generateResetToken(email, uid) {
  const rawToken  = randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);

  await getAdminDb()
    .collection(COLLECTION)
    .doc(docId(email))
    .set({
      tokenHash,
      uid,
      email: email.toLowerCase().trim(),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      used: false,
      createdAt: new Date(),
    });

  return rawToken;
}

/**
 * Returns `{ valid: true, uid }` if the token is correct, unexpired and unused.
 * Returns `{ valid: false, reason }` otherwise.
 */
export async function verifyResetToken(email, token) {
  const snap = await getAdminDb()
    .collection(COLLECTION)
    .doc(docId(email))
    .get();

  if (!snap.exists) return { valid: false, reason: 'not_found' };

  const data = snap.data();

  if (data.used)                              return { valid: false, reason: 'used' };
  if (new Date() > data.expiresAt.toDate())   return { valid: false, reason: 'expired' };
  if (sha256(token) !== data.tokenHash)       return { valid: false, reason: 'invalid' };

  return { valid: true, uid: data.uid };
}

/**
 * Marks the token for `email` as consumed so it cannot be reused.
 */
export async function consumeResetToken(email) {
  await getAdminDb()
    .collection(COLLECTION)
    .doc(docId(email))
    .update({ used: true });
}
