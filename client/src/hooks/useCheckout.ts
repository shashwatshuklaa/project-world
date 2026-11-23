import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import {
  CheckoutStatus,
  VerifiedOrder,
  RazorpayResponse,
  RazorpayOptions,
} from '../types/order';
import { orderService, OrderApiError, generateIdempotencyKey } from '../services/order.service';
import { loadRazorpayScript } from '../services/razorpay.service';

export interface UseCheckoutReturn {
  status: CheckoutStatus;
  isProcessing: boolean;
  errorMessage: string | null;
  uncertainVerification: boolean;
  verifiedOrder: VerifiedOrder | null;
  idempotencyKey: string | null;
  initiateCheckout: () => Promise<void>;
  retryCheckout: () => Promise<void>;
  resetCheckout: () => void;
}

export function useCheckout(): UseCheckoutReturn {
  const { user, isAuthenticated } = useAuth();
  const { cart, refreshCart } = useCart();

  const [status, setStatus] = useState<CheckoutStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uncertainVerification, setUncertainVerification] = useState<boolean>(false);
  const [verifiedOrder, setVerifiedOrder] = useState<VerifiedOrder | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  // References to prevent stale closure issues in async callbacks
  const statusRef = useRef<CheckoutStatus>('idle');
  const idempotencyKeyRef = useRef<string | null>(null);
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const updateStatus = useCallback((newStatus: CheckoutStatus) => {
    statusRef.current = newStatus;
    if (isMountedRef.current) {
      setStatus(newStatus);
    }
  }, []);

  const isProcessing =
    status === 'creating_order' ||
    status === 'awaiting_payment' ||
    status === 'verifying_payment';

  const resetCheckout = useCallback(() => {
    updateStatus('idle');
    setErrorMessage(null);
    setUncertainVerification(false);
    setVerifiedOrder(null);
  }, [updateStatus]);

  const initiateCheckout = useCallback(async (): Promise<void> => {
    // 1. Prevent duplicate checkout submissions while an attempt is already active
    if (
      statusRef.current === 'creating_order' ||
      statusRef.current === 'awaiting_payment' ||
      statusRef.current === 'verifying_payment'
    ) {
      return;
    }

    // 2. Validate authentication
    if (!isAuthenticated) {
      setErrorMessage('Please log in to proceed with checkout.');
      updateStatus('error');
      return;
    }

    // 3. Validate that cart is not empty
    if (!cart || !cart.items || cart.items.length === 0) {
      setErrorMessage('Your shopping cart is empty. Please add projects before checking out.');
      updateStatus('error');
      return;
    }

    // 4. Manage idempotency key:
    // Reuse existing key if retrying the same uncompleted attempt; otherwise generate a fresh key.
    let activeKey = idempotencyKeyRef.current;
    if (!activeKey || statusRef.current === 'success') {
      activeKey = generateIdempotencyKey();
      idempotencyKeyRef.current = activeKey;
      if (isMountedRef.current) {
        setIdempotencyKey(activeKey);
      }
    }

    // Reset error states before starting attempt
    if (isMountedRef.current) {
      setErrorMessage(null);
      setUncertainVerification(false);
    }
    updateStatus('creating_order');

    // 5. Safely load the Razorpay SDK script
    const scriptLoaded = await loadRazorpayScript();
    if (!scriptLoaded) {
      setErrorMessage(
        'Failed to load Razorpay payment gateway. Please check your internet connection and try again.'
      );
      updateStatus('error');
      return;
    }

    // 6. Initiate order creation on backend
    let orderResponse;
    try {
      orderResponse = await orderService.createOrder(activeKey);
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : 'Failed to initiate order checkout. Please try again.';
      const isUncertain = err instanceof OrderApiError && Boolean(err.resolutionNeeded);

      setErrorMessage(errorMsg);
      setUncertainVerification(isUncertain);
      updateStatus('error');
      return;
    }

    // 7. Handle in-progress or non-created response
    if (orderResponse.inProgress) {
      setErrorMessage(
        orderResponse.message ||
          'Checkout is currently being processed. Please retry in a moment.'
      );
      updateStatus('error');
      return;
    }

    const { orderId, razorpayOrderId, amount, currency, keyId: serverKeyId } = orderResponse;
    const resolvedKeyId = serverKeyId || (import.meta.env.VITE_RAZORPAY_KEY_ID as string);

    if (!resolvedKeyId) {
      setErrorMessage('Payment gateway configuration is missing. Please contact support.');
      updateStatus('error');
      return;
    }

    // 8. Configure Razorpay Checkout options
    const options: RazorpayOptions = {
      key: resolvedKeyId,
      amount, // Canonical integer paise returned by backend
      currency: currency || 'INR',
      name: 'ProjectWorld',
      description: `Order #${orderId}`,
      order_id: razorpayOrderId,
      prefill: {
        name: user?.name || '',
        email: user?.email || '',
        contact: '',
      },
      theme: {
        color: '#2563EB',
      },
      modal: {
        ondismiss: () => {
          // If modal dismissed without payment callback, revert to cancelled
          if (
            statusRef.current !== 'verifying_payment' &&
            statusRef.current !== 'success'
          ) {
            updateStatus('cancelled');
            setErrorMessage('Payment was cancelled. Your cart items are still saved.');
          }
        },
      },
      handler: async (paymentResponse: RazorpayResponse) => {
        // 9. Payment completed on gateway — initiate authoritative backend verification
        updateStatus('verifying_payment');

        try {
          const verifyResponse = await orderService.verifyPayment({
            orderId,
            razorpay_order_id: paymentResponse.razorpay_order_id,
            razorpay_payment_id: paymentResponse.razorpay_payment_id,
            razorpay_signature: paymentResponse.razorpay_signature,
          });

          if (!verifyResponse.success) {
            throw new OrderApiError(
              verifyResponse.message || 'Payment verification failed.',
              400,
              { resolutionNeeded: verifyResponse.resolutionNeeded }
            );
          }

          // Authoritative verification confirmed by backend!
          updateStatus('success');
          setErrorMessage(null);
          setUncertainVerification(false);

          // Clear idempotency key so subsequent orders generate a new one
          idempotencyKeyRef.current = null;
          if (isMountedRef.current) {
            setIdempotencyKey(null);
          }

          // Format verified order data for confirmation view
          const completedOrder: VerifiedOrder = verifyResponse.order || {
            id: orderResponse.id || orderResponse._id,
            _id: orderResponse.id || orderResponse._id,
            orderId,
            status: 'completed',
            paymentStatus: 'captured',
            totalAmount: Math.round((amount / 100) * 100) / 100,
            currency: currency || 'INR',
            razorpayOrderId: paymentResponse.razorpay_order_id,
            razorpayPaymentId: paymentResponse.razorpay_payment_id,
            paidAt: new Date().toISOString(),
          };

          if (isMountedRef.current) {
            setVerifiedOrder(completedOrder);
          }

          // Refresh the user's shopping cart state from the backend
          try {
            await refreshCart();
          } catch (refreshErr) {
            console.warn('[useCheckout] Post-payment cart refresh error:', refreshErr);
          }
        } catch (verifyErr: unknown) {
          const isUncertain =
            verifyErr instanceof OrderApiError && Boolean(verifyErr.resolutionNeeded);
          const rawMessage =
            verifyErr instanceof Error
              ? verifyErr.message
              : 'Payment verification failed. Please contact customer support.';

          // Do NOT claim success if verification fails or is uncertain
          updateStatus('error');
          setUncertainVerification(isUncertain);

          if (isUncertain) {
            setErrorMessage(
              'Your payment was processed by the gateway, but server verification is pending or timed out. Please check your order history before attempting payment again.'
            );
          } else {
            setErrorMessage(rawMessage);
          }
        }
      },
    };

    // 10. Open the Razorpay Modal
    try {
      if (typeof window.Razorpay === 'undefined') {
        throw new Error('Razorpay SDK is not available in the browser.');
      }

      const razorpayInstance = new window.Razorpay(options);

      razorpayInstance.on('payment.failed', (response: RazorpayResponse) => {
        const desc =
          response.error?.description ||
          'Your payment was declined or failed. Please try again with another payment method.';
        setErrorMessage(desc);
        updateStatus('error');
      });

      updateStatus('awaiting_payment');
      razorpayInstance.open();
    } catch (sdkError: unknown) {
      const msg =
        sdkError instanceof Error ? sdkError.message : 'Failed to launch Razorpay checkout modal.';
      setErrorMessage(msg);
      updateStatus('error');
    }
  }, [
    isAuthenticated,
    cart,
    user?.name,
    user?.email,
    refreshCart,
    updateStatus,
  ]);

  const retryCheckout = useCallback(async (): Promise<void> => {
    return initiateCheckout();
  }, [initiateCheckout]);

  return {
    status,
    isProcessing,
    errorMessage,
    uncertainVerification,
    verifiedOrder,
    idempotencyKey,
    initiateCheckout,
    retryCheckout,
    resetCheckout,
  };
}
