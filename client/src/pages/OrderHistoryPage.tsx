import React, { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Package,
  ArrowRight,
  AlertCircle,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Layers,
} from 'lucide-react';
import { CustomerOrder, PaginationMetadata, CustomerFacingPaymentStatus } from '../types/order';
import { orderService, OrderApiError } from '../services/order.service';
import { PaymentStatusBadge, OrderStatusBadge } from '../components/orders/StatusBadge';

export const OrderHistoryPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const currentPage = parseInt(searchParams.get('page') || '1', 10);
  const currentPaymentStatus = (searchParams.get('paymentStatus') as CustomerFacingPaymentStatus) || undefined;

  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [pagination, setPagination] = useState<PaginationMetadata>({
    total: 0,
    page: currentPage,
    limit: 10,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOrders = useCallback(async (page: number, paymentStatus?: CustomerFacingPaymentStatus) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await orderService.getOrders({
        page,
        limit: 10,
        paymentStatus,
      });

      if (response.success) {
        setOrders(response.orders);
        setPagination(response.pagination);
      } else {
        throw new Error('Failed to retrieve orders.');
      }
    } catch (err: unknown) {
      const msg =
        err instanceof OrderApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'Unable to load your order history. Please try again.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders(currentPage, currentPaymentStatus);
  }, [fetchOrders, currentPage, currentPaymentStatus]);

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('page', String(newPage));
    setSearchParams(params);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleStatusFilterChange = (status?: CustomerFacingPaymentStatus) => {
    const params = new URLSearchParams();
    params.set('page', '1');
    if (status) {
      params.set('paymentStatus', status);
    }
    setSearchParams(params);
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-IN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <main className="min-h-screen bg-slate-50/50 py-8 sm:py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
            Order History
          </h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Track and view official receipts and details for all your ProjectWorld project kit purchases.
          </p>
        </div>

        {/* Status Filter Chips */}
        <div className="flex items-center gap-2 overflow-x-auto pb-3 mb-6 scrollbar-none">
          <button
            type="button"
            onClick={() => handleStatusFilterChange(undefined)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
              !currentPaymentStatus
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200/80'
            }`}
          >
            All Orders
          </button>
          <button
            type="button"
            onClick={() => handleStatusFilterChange('captured')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
              currentPaymentStatus === 'captured'
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200/80'
            }`}
          >
            Paid / Captured
          </button>
          <button
            type="button"
            onClick={() => handleStatusFilterChange('pending')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
              currentPaymentStatus === 'pending'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200/80'
            }`}
          >
            Pending
          </button>
          <button
            type="button"
            onClick={() => handleStatusFilterChange('refunded')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
              currentPaymentStatus === 'refunded'
                ? 'bg-purple-600 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200/80'
            }`}
          >
            Refunded
          </button>
        </div>

        {/* Error Notification with Retry */}
        {error && (
          <div
            className="mb-8 p-4 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm flex items-start justify-between gap-3"
            role="alert"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Unable to load orders</p>
                <p className="text-xs text-red-600 mt-0.5">{error}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => fetchOrders(currentPage, currentPaymentStatus)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-100 hover:bg-red-200 rounded-lg transition-colors focus:outline-none"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        )}

        {/* Loading Skeletons */}
        {isLoading ? (
          <div className="space-y-4" role="status" aria-label="Loading order history">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xs animate-pulse space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="h-4 w-40 bg-slate-200 rounded" />
                  <div className="h-5 w-24 bg-slate-200 rounded-full" />
                </div>
                <div className="h-12 bg-slate-100 rounded-xl" />
                <div className="flex justify-between items-center pt-2 border-t border-slate-100">
                  <div className="h-4 w-28 bg-slate-200 rounded" />
                  <div className="h-4 w-20 bg-slate-200 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : !orders.length ? (
          /* Empty State */
          <div className="max-w-xl mx-auto my-12 text-center bg-white border border-slate-200/80 rounded-3xl p-8 sm:p-12 shadow-xs">
            <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-5 border border-blue-100">
              <Package className="h-8 w-8 text-blue-600" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight mb-2">
              No Orders Found
            </h2>
            <p className="text-sm text-slate-500 leading-relaxed mb-6 max-w-sm mx-auto">
              {currentPaymentStatus
                ? `You don't have any orders with status "${currentPaymentStatus}".`
                : "You haven't placed any orders yet. Browse our verified projects and hardware kits to get started."}
            </p>
            <Link
              to="/shop"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 shadow-sm shadow-blue-500/20 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              <span>Explore Projects</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        ) : (
          /* Order History List */
          <div className="space-y-4">
            {orders.map((order) => {
              const detailId = order.id || order._id;
              const hasRefund =
                order.refundSummary?.isRefunded ||
                order.refundSummary?.isPartiallyRefunded ||
                (order.refundSummary?.refundedAmount || 0) > 0;

              return (
                <article
                  key={order.orderId}
                  className="bg-white border border-slate-200/80 hover:border-slate-300 rounded-2xl p-5 sm:p-6 shadow-xs transition-colors"
                  aria-label={`Order ${order.orderId}`}
                >
                  {/* Top Bar: Order ID, Date, Badges */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-slate-400 font-medium">Order Ref:</span>
                        <span className="text-sm font-mono font-bold text-slate-900">
                          {order.orderId}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-slate-500 mt-1">
                        <Calendar className="h-3.5 w-3.5 text-slate-400" />
                        <span>{formatDate(order.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <OrderStatusBadge status={order.status} size="sm" />
                      <PaymentStatusBadge status={order.paymentStatus} size="sm" />
                    </div>
                  </div>

                  {/* Purchased Items List */}
                  <div className="py-4 space-y-2.5">
                    {order.items.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex flex-wrap items-center justify-between text-xs sm:text-sm gap-2"
                      >
                        <div className="flex items-center gap-2 max-w-[70%]">
                          <Layers className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span className="font-medium text-slate-800 truncate">
                            {item.title}
                          </span>
                          <span className="text-slate-400 font-semibold shrink-0">
                            &times; {item.quantity}
                          </span>
                        </div>
                        <span className="font-semibold text-slate-700">
                          ₹{Math.round(item.price * item.quantity).toLocaleString('en-IN')}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Bottom Bar: Total, Refund Info & View Details Button */}
                  <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-100">
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs text-slate-500 font-medium">Total Amount:</span>
                        <span className="text-base sm:text-lg font-extrabold text-slate-900">
                          ₹{Math.round(order.totalAmount).toLocaleString('en-IN')}
                        </span>
                      </div>
                      {hasRefund && (
                        <p className="text-[11px] font-semibold text-purple-600 mt-0.5">
                          Refunded ₹{Math.round(order.refundSummary.refundedAmount).toLocaleString('en-IN')}
                        </p>
                      )}
                    </div>

                    <Link
                      to={`/orders/${detailId}`}
                      className="inline-flex items-center gap-1 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold bg-slate-50 hover:bg-blue-50 text-blue-600 hover:text-blue-700 border border-slate-200/80 hover:border-blue-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <span>View Order</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </article>
              );
            })}

            {/* Pagination Controls */}
            {pagination.totalPages > 1 && (
              <div
                className="flex flex-wrap items-center justify-between gap-4 pt-6 pb-2"
                role="navigation"
                aria-label="Order pagination"
              >
                <p className="text-xs text-slate-500">
                  Showing page <span className="font-semibold text-slate-900">{pagination.page}</span> of{' '}
                  <span className="font-semibold text-slate-900">{pagination.totalPages}</span> ({pagination.total}{' '}
                  total orders)
                </p>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handlePageChange(pagination.page - 1)}
                    disabled={!pagination.hasPrevPage}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span>Previous</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePageChange(pagination.page + 1)}
                    disabled={!pagination.hasNextPage}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
};

export default OrderHistoryPage;
