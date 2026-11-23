export type CustomerFacingOrderStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'failed';

export type CustomerFacingPaymentStatus =
  | 'pending'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'refund_pending';

export interface RefundSummary {
  isRefunded: boolean;
  isPartiallyRefunded: boolean;
  refundedAmount: number; // in INR
}

export interface CustomerOrderItem {
  projectId: string;
  projectSlug: string;
  title: string;
  price: number; // Canonical historical price in INR at purchase time
  quantity: number;
  customization?: string;
  category?: string;
  subcategory?: string;
  image?: string;
}

export interface CustomerOrder {
  _id: string;
  id: string;
  orderId: string;
  createdAt: string;
  updatedAt: string;
  status: CustomerFacingOrderStatus;
  paymentStatus: CustomerFacingPaymentStatus;
  totalAmount: number;
  currency: string;
  items: CustomerOrderItem[];
  itemCount: number;
  paidAt: string | null;
  paymentMethod: string | null;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  refundSummary: RefundSummary;
}

export interface PaginationMetadata {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface GetOrdersParams {
  page?: number;
  limit?: number;
  status?: CustomerFacingOrderStatus;
  paymentStatus?: CustomerFacingPaymentStatus;
}

export interface GetOrdersResponse {
  success: boolean;
  orders: CustomerOrder[];
  pagination: PaginationMetadata;
}

export interface GetOrderByIdResponse {
  success: boolean;
  order: CustomerOrder;
}

export interface CreateOrderResponse {
  success: boolean;
  id?: string;
  _id?: string;
  orderId: string;
  razorpayOrderId: string;
  amount: number; // in paise (integer)
  currency: string;
  keyId?: string;
  message?: string;
  inProgress?: boolean;
  resolutionNeeded?: boolean;
}

export interface VerifyPaymentInput {
  orderId: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface VerifiedOrderItem {
  projectId: string;
  title: string;
  price: number;
  quantity: number;
  customization?: string;
  category?: string;
  subcategory?: string;
  image?: string;
}

export interface VerifiedOrder {
  id?: string;
  _id?: string;
  orderId: string;
  status: string;
  paymentStatus: string;
  totalAmount: number;
  currency: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  paidAt?: string | Date;
  items?: VerifiedOrderItem[];
}

export interface VerifyPaymentResponse {
  success: boolean;
  message: string;
  order?: VerifiedOrder;
  resolutionNeeded?: boolean;
}

export type CheckoutStatus =
  | 'idle'
  | 'creating_order'
  | 'awaiting_payment'
  | 'verifying_payment'
  | 'success'
  | 'error'
  | 'cancelled';

export interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
  error?: {
    code: string;
    description: string;
    source?: string;
    step?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface RazorpayOptions {
  key: string | undefined;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayResponse) => void;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: {
    color?: string;
  };
  modal?: {
    ondismiss?: () => void;
    escape?: boolean;
    backdropclose?: boolean;
  };
}

export interface RazorpayInstance {
  on(event: 'payment.failed', callback: (response: RazorpayResponse) => void): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  open(): void;
  close?(): void;
}

export interface RazorpayConstructor {
  new (options: RazorpayOptions): RazorpayInstance;
}

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}
