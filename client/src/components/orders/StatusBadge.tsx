import React from 'react';
import {
  CheckCircle2,
  Clock,
  XCircle,
  RotateCcw,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import {
  CustomerFacingOrderStatus,
  CustomerFacingPaymentStatus,
} from '../../types/order';

interface PaymentStatusBadgeProps {
  status: CustomerFacingPaymentStatus | string;
  size?: 'sm' | 'md';
}

export const PaymentStatusBadge: React.FC<PaymentStatusBadgeProps> = ({
  status,
  size = 'md',
}) => {
  const sizeClasses =
    size === 'sm'
      ? 'px-2 py-0.5 text-[11px] gap-1'
      : 'px-2.5 py-1 text-xs gap-1.5';

  switch (status) {
    case 'captured':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/80 ${sizeClasses}`}
        >
          <CheckCircle2 className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Paid</span>
        </span>
      );

    case 'pending':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200/80 ${sizeClasses}`}
        >
          <Clock className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Payment Pending</span>
        </span>
      );

    case 'failed':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-red-50 text-red-700 border border-red-200/80 ${sizeClasses}`}
        >
          <XCircle className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Payment Failed</span>
        </span>
      );

    case 'refunded':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-purple-50 text-purple-700 border border-purple-200/80 ${sizeClasses}`}
        >
          <RotateCcw className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Refunded</span>
        </span>
      );

    case 'partially_refunded':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200/80 ${sizeClasses}`}
        >
          <RotateCcw className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Partially Refunded</span>
        </span>
      );

    case 'refund_pending':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/80 ${sizeClasses}`}
        >
          <Clock className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Refund Pending</span>
        </span>
      );

    default:
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-slate-100 text-slate-700 border border-slate-200 ${sizeClasses}`}
        >
          <HelpCircle className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span className="capitalize">{status || 'Unknown'}</span>
        </span>
      );
  }
};

interface OrderStatusBadgeProps {
  status: CustomerFacingOrderStatus | string;
  size?: 'sm' | 'md';
}

export const OrderStatusBadge: React.FC<OrderStatusBadgeProps> = ({
  status,
  size = 'md',
}) => {
  const sizeClasses =
    size === 'sm'
      ? 'px-2 py-0.5 text-[11px] gap-1'
      : 'px-2.5 py-1 text-xs gap-1.5';

  switch (status) {
    case 'completed':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/80 ${sizeClasses}`}
        >
          <CheckCircle2 className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Completed</span>
        </span>
      );

    case 'processing':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/80 ${sizeClasses}`}
        >
          <Clock className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Processing</span>
        </span>
      );

    case 'pending':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200/80 ${sizeClasses}`}
        >
          <Clock className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Pending</span>
        </span>
      );

    case 'refunded':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-purple-50 text-purple-700 border border-purple-200/80 ${sizeClasses}`}
        >
          <RotateCcw className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Refunded</span>
        </span>
      );

    case 'cancelled':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-slate-100 text-slate-700 border border-slate-200 ${sizeClasses}`}
        >
          <AlertCircle className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Cancelled</span>
        </span>
      );

    case 'failed':
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-red-50 text-red-700 border border-red-200/80 ${sizeClasses}`}
        >
          <XCircle className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span>Failed</span>
        </span>
      );

    default:
      return (
        <span
          className={`inline-flex items-center font-semibold rounded-full bg-slate-100 text-slate-700 border border-slate-200 ${sizeClasses}`}
        >
          <HelpCircle className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          <span className="capitalize">{status || 'Unknown'}</span>
        </span>
      );
  }
};
