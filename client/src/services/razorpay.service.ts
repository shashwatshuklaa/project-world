export const RAZORPAY_CHECKOUT_SCRIPT_URL =
  'https://checkout.razorpay.com/v1/checkout.js';

let scriptLoadingPromise: Promise<boolean> | null = null;

/**
 * Safely loads the Razorpay Checkout JavaScript SDK.
 * - Resolves immediately if window.Razorpay already exists.
 * - Prevents multiple concurrent script tags from being appended.
 * - Handles network failure and script load errors gracefully.
 */
export function loadRazorpayScript(
  scriptUrl: string = RAZORPAY_CHECKOUT_SCRIPT_URL
): Promise<boolean> {
  if (typeof window === 'undefined') {
    return Promise.resolve(false);
  }

  if (typeof window.Razorpay !== 'undefined') {
    return Promise.resolve(true);
  }

  if (scriptLoadingPromise) {
    return scriptLoadingPromise;
  }

  scriptLoadingPromise = new Promise<boolean>((resolve) => {
    // Check if script tag is already in DOM
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${scriptUrl}"]`
    );

    if (existingScript) {
      if (typeof window.Razorpay !== 'undefined') {
        resolve(true);
        return;
      }
      existingScript.addEventListener('load', () => resolve(true), { once: true });
      existingScript.addEventListener('error', () => resolve(false), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;

    script.onload = () => {
      resolve(true);
    };

    script.onerror = () => {
      scriptLoadingPromise = null; // Allow retry on failure
      resolve(false);
    };

    document.body.appendChild(script);
  });

  return scriptLoadingPromise;
}

/**
 * Reset script loading cache (primarily for tests).
 */
export function resetScriptLoadingCache(): void {
  scriptLoadingPromise = null;
}
