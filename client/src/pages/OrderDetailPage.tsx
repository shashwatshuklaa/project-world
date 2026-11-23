import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Calendar,
  CreditCard,
  RotateCcw,
  AlertCircle,
  RefreshCw,
  FolderGit2,
  Layers,
  FileText,
} from 'lucide-react';
import { CustomerOrder } from '../types/order';
import { orderService, OrderApiError } from '../services/order.service';
import { PaymentStatusBadge, OrderStatusBadge } from '../components/orders/StatusBadge';

export const OrderDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();

  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<number | null>(null);

  const fetchOrderDetail = useCallback(async (orderIdToFetch: string) => {
    setIsLoading(true);
    setError(null);
    setErrorCode(null);

    // Format validation: must be a 24-character hexadecimal MongoDB ObjectId
    if (!/^[0-9a-fA-F]{24}$/.test(orderIdToFetch)) {
      setErrorCode(400);
      setError('Invalid order ID format. Must be a valid 24-character MongoDB ObjectId.');
      setIsLoading(false);
      return;
    }

    try {
      const response = await orderService.getOrderById(orderIdToFetch);
      if (response.success && response.order) {
        setOrder(response.order);
      } else {
        throw new Error('Order details could not be found.');
      }
    } catch (err: unknown) {
      if (err instanceof OrderApiError) {
        setErrorCode(err.statusCode);
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred while loading order details.');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (id) {
      fetchOrderDetail(id);
    } else {
      setErrorCode(400);
      setError('Missing order identifier in URL.');
      setIsLoading(false);
    }
  }, [id, fetchOrderDetail]);

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return 'N/A';
    try {
      return new Date(dateStr).toLocaleString('en-IN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <main className="min-h-screen bg-slate-50/50 py-8 sm:py-12">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Navigation Breadcrumb / Back Link */}
        <div className="mb-6">
          <Link
            to="/orders"
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-slate-600 hover:text-blue-600 transition-colors focus:outline-none focus:underline"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Order History</span>
          </Link>
        </div>

        {/* Loading Skeleton */}
        {isLoading ? (
          <div className="space-y-6" role="status" aria-label="Loading order details">
            <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs animate-pulse space-y-4">
              <div className="h-6 w-48 bg-slate-200 rounded" />
              <div className="h-4 w-32 bg-slate-100 rounded" />
            </div>
            <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs animate-pulse space-y-4">
              <div className="h-32 bg-slate-100 rounded-xl" />
              <div className="h-32 bg-slate-100 rounded-xl" />
            </div>
          </div>
        ) : error || !order ? (
          /* Error State: 400 Invalid ID, 404 Not Found, or Network Error */
          <div className="max-w-xl mx-auto my-12 text-center bg-white border border-slate-200/80 rounded-3xl p-8 sm:p-12 shadow-xs">
            <div
              className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5 border ${
                errorCode === 404
                  ? 'bg-slate-50 text-slate-500 border-slate-200'
                  : 'bg-red-50 text-red-600 border-red-100'
              }`}
            >
              <AlertCircle className="h-8 w-8" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight mb-2">
              {errorCode === 404
                ? 'Order Not Found'
                : errorCode === 400
                ? 'Invalid Order ID'
                : 'Unable to Load Order'}
            </h2>
            <p className="text-sm text-slate-500 leading-relaxed mb-6 max-w-sm mx-auto">
              {errorCode === 404
                ? 'This order does not exist or belongs to another user account.'
                : error || 'Please check the order link or try refreshing.'}
            </p>
            <div className="flex items-center justify-center gap-3">
              {id && errorCode !== 400 && errorCode !== 404 && (
                <button
                  type="button"
                  onClick={() => fetchOrderDetail(id)}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-blue-600 text-white font-semibold text-xs sm:text-sm hover:bg-blue-700 transition-colors"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span>Retry</span>
                </button>
              )}
              <Link
                to="/orders"
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-slate-100 text-slate-700 font-semibold text-xs sm:text-sm hover:bg-slate-200 transition-colors"
              >
                <span>Return to Orders</span>
              </Link>
            </div>
          </div>
        ) : (
          /* Order Details Content */
          <div className="space-y-6">
            {/* Header Card */}
            <div className="bg-white border border-slate-200/80 rounded-3xl p-6 sm:p-8 shadow-xs">
              <div className="flex flex-wrap items-start justify-between gap-4 pb-6 border-b border-slate-100">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
                      Official Receipt
                    </span>
                    <span className="text-slate-300">•</span>
                    <span className="text-base sm:text-lg font-mono font-extrabold text-slate-900">
                      {order.orderId}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1.5">
                    <Calendar className="h-3.5 w-3.5 text-slate-400" />
                    <span>Placed on {formatDate(order.createdAt)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <OrderStatusBadge status={order.status} />
                  <PaymentStatusBadge status={order.paymentStatus} />
                </div>
              </div>

              {/* Refund Notice Banner if Refunded */}
              {(order.refundSummary.isRefunded ||
                order.refundSummary.isPartiallyRefunded ||
                order.refundSummary.refundedAmount > 0) && (
                <div className="mt-6 p-4 rounded-2xl bg-purple-50 border border-purple-200/80 text-purple-900 text-xs sm:text-sm flex items-start gap-3">
                  <RotateCcw className="h-5 w-5 text-purple-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold">
                      {order.refundSummary.isRefunded
                        ? 'Full Refund Processed'
                        : 'Partial Refund Processed'}
                    </p>
                    <p className="text-purple-700 mt-0.5 leading-relaxed">
                      A total amount of{' '}
                      <span className="font-extrabold">
                        ₹{Math.round(order.refundSummary.refundedAmount).toLocaleString('en-IN')}
                      </span>{' '}
                      has been refunded to your original payment method. Depending on your bank, it may take 5–7 business days to reflect on your statement.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Purchased Items Card */}
            <div className="bg-white border border-slate-200/80 rounded-3xl p-6 sm:p-8 shadow-xs">
              <h2 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight mb-5 flex items-center gap-2">
                <Layers className="h-5 w-5 text-blue-600" />
                <span>Purchased Projects ({order.itemCount} {order.itemCount === 1 ? 'item' : 'items'})</span>
              </h2>

              <div className="divide-y divide-slate-100">
                {order.items.map((item, idx) => {
                  const projectUrl = item.projectSlug
                    ? `/projects/${encodeURIComponent(item.projectSlug)}`
                    : item.projectId
                    ? `/projects/${encodeURIComponent(item.projectId)}`
                    : '#';

                  return (
                    <div
                      key={idx}
                      className="py-5 first:pt-0 last:pb-0 flex flex-col sm:flex-row items-start justify-between gap-4"
                    >
                      <div className="flex items-start gap-4 flex-1">
                        <Link
                          to={projectUrl}
                          className="h-16 w-16 sm:h-20 sm:w-20 shrink-0 rounded-xl bg-slate-100 border border-slate-200/60 overflow-hidden flex items-center justify-center block"
                        >
                          {item.image ? (
                            <img
                              src={item.image}
                              alt={item.title}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <FolderGit2 className="h-7 w-7 text-slate-300" />
                          )}
                        </Link>

                        <div className="space-y-1">
                          <Link
                            to={projectUrl}
                            className="text-sm sm:text-base font-bold text-slate-900 hover:text-blue-600 transition-colors leading-snug block"
                          >
                            {item.title}
                          </Link>

                          {item.category && (
                            <span className="inline-block text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200/60 px-2 py-0.5 rounded-md">
                              {item.category}
                            </span>
                          )}

                          {item.customization && (
                            <div className="pt-1">
                              <p className="text-[11px] text-slate-500 font-medium flex items-start gap-1">
                                <FileText className="h-3 w-3 text-slate-400 shrink-0 mt-0.5" />
                                <span>Note: {item.customization}</span>
                              </p>
                            </div>
                          )}

                          <p className="text-xs text-slate-500 pt-1">
                            Unit Price: <span className="font-semibold text-slate-700">₹{Math.round(item.price).toLocaleString('en-IN')}</span> &times; {item.quantity}
                          </p>
                        </div>
                      </div>

                      <div className="text-right sm:self-center shrink-0">
                        <span className="text-xs text-slate-400 block font-medium">Subtotal</span>
                        <span className="text-sm sm:text-base font-extrabold text-slate-900">
                          ₹{Math.round(item.price * item.quantity).toLocaleString('en-IN')}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Order Summary & Customer-Safe Payment Details */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Payment Info Box */}
              <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-xs space-y-4">
                <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-blue-600" />
                  <span>Payment Details</span>
                </h3>

                <div className="space-y-2.5 text-xs sm:text-sm">
                  <div className="flex justify-between py-1 border-b border-slate-100">
                    <span className="text-slate-500">Payment Status:</span>
                    <PaymentStatusBadge status={order.paymentStatus} size="sm" />
                  </div>

                  {order.razorpayPaymentId && (
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span className="text-slate-500">Payment Ref:</span>
                      <span className="font-mono font-medium text-slate-800 text-xs">
                        {order.razorpayPaymentId}
                      </span>
                    </div>
                  )}

                  {order.razorpayOrderId && (
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span className="text-slate-500">Gateway Order:</span>
                      <span className="font-mono font-medium text-slate-800 text-xs">
                        {order.razorpayOrderId}
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between py-1 border-b border-slate-100">
                    <span className="text-slate-500">Paid At:</span>
                    <span className="font-medium text-slate-800">{formatDate(order.paidAt)}</span>
                  </div>

                  <div className="flex justify-between py-1">
                    <span className="text-slate-500">Currency:</span>
                    <span className="font-medium text-slate-800">{order.currency || 'INR'}</span>
                  </div>
                </div>
              </div>

              {/* Financial Totals Card */}
              <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-xs space-y-4">
                <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                  Price Breakdown
                </h3>

                <div className="space-y-2.5 text-xs sm:text-sm">
                  <div className="flex justify-between py-1 border-b border-slate-100 text-slate-600">
                    <span>Canonical Subtotal:</span>
                    <span className="font-semibold text-slate-900">
                      ₹{Math.round(order.totalAmount).toLocaleString('en-IN')}
                    </span>
                  </div>

                  <div className="flex justify-between py-1 border-b border-slate-100 text-slate-600">
                    <span>Taxes & Gateway Fees:</span>
                    <span className="font-semibold text-slate-900">₹0 (Included)</span>
                  </div>

                  <div className="pt-2 flex justify-between items-baseline">
                    <span className="text-sm font-bold text-slate-900">Total Paid:</span>
                    <span className="text-xl sm:text-2xl font-extrabold text-slate-900">
                      ₹{Math.round(order.totalAmount).toLocaleString('en-IN')}
                    </span>
                  </div>

                  {order.refundSummary.refundedAmount > 0 && (
                    <div className="pt-2 border-t border-slate-100 flex justify-between items-baseline text-purple-700">
                      <span className="text-xs font-semibold">Total Refunded:</span>
                      <span className="text-sm font-bold">
                        -₹{Math.round(order.refundSummary.refundedAmount).toLocaleString('en-IN')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
};

export default OrderDetailPage;
