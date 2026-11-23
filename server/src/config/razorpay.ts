import Razorpay from 'razorpay';
import '../config/env.js';

let razorpayClientInstance: Razorpay | null = null;

/**
 * Retrieves the public Razorpay Key ID from environment variables.
 * Fails safely if missing or empty without falling back to insecure defaults.
 */
export function getRazorpayKeyId(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  if (!keyId || !keyId.trim()) {
    throw new Error('Razorpay configuration error: RAZORPAY_KEY_ID is missing or empty.');
  }
  return keyId.trim();
}

/**
 * Retrieves the secret Razorpay Key Secret from environment variables.
 * Fails safely if missing or empty without falling back to insecure defaults.
 * Never exposed to client code or API responses.
 */
export function getRazorpayKeySecret(): string {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret || !keySecret.trim()) {
    throw new Error('Razorpay configuration error: RAZORPAY_KEY_SECRET is missing or empty.');
  }
  return keySecret.trim();
}

/**
 * Retrieves the Razorpay Webhook Secret from environment variables.
 * Fails safely if missing or empty without falling back to insecure defaults.
 * Used exclusively for validating incoming Razorpay webhook payloads.
 */
export function getRazorpayWebhookSecret(): string {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret || !webhookSecret.trim()) {
    throw new Error('Razorpay configuration error: RAZORPAY_WEBHOOK_SECRET is missing or empty.');
  }
  return webhookSecret.trim();
}

/**
 * Returns a reusable singleton instance of the Razorpay SDK client.
 * Credentials are read dynamically on first invocation, ensuring tests can
 * run without initializing the SDK if credentials are not configured.
 */
export function getRazorpayClient(): Razorpay {
  if (!razorpayClientInstance) {
    const keyId = getRazorpayKeyId();
    const keySecret = getRazorpayKeySecret();

    razorpayClientInstance = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
  }
  return razorpayClientInstance;
}

/**
 * Allows injecting or resetting the Razorpay client (e.g. for unit and integration tests).
 */
export function setRazorpayClient(client: Razorpay | null): void {
  razorpayClientInstance = client;
}

export default getRazorpayClient;
