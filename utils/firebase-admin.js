import { initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Lazy-initialise the Admin SDK once, reuse on subsequent calls.
// Credentials come from FIREBASE_SERVICE_ACCOUNT env var (Railway secret) —
// paste the full service-account JSON as a single-line string.
function getAdminApp() {
  try {
    return getApp('admin');
  } catch {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set');
    const credential = cert(JSON.parse(raw));
    return initializeApp({ credential }, 'admin');
  }
}

export const getAdminDb   = () => getFirestore(getAdminApp());
export const getAdminAuth = () => getAuth(getAdminApp());
