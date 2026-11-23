import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  ShoppingCart,
  Trash2,
  Plus,
  Minus,
  ArrowLeft,
  ArrowRight,
  FolderGit2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Lock,
  Layers,
  BarChart2,
  RefreshCw,
  CreditCard,
  AlertTriangle,
} from 'lucide-react';
import { useCart } from '../contexts/CartContext';
import { useCheckout } from '../hooks/useCheckout';
import { CartItem } from '../types/cart';

/**
 * Individual Cart Item Row / Card.
 * Manages item quantity, customization notes with character counts and on-blur saving,
 * and individual item deletion with accessible loading states.
 */
interface CartItemCardProps {
  item: CartItem;
  onUpdateQuantity: (itemId: string, newQuantity: number) => Promise<void>;
  onUpdateCustomization: (itemId: string, notes: string) => Promise<void>;
  onRemove: (itemId: string) => Promise<void>;
  isBusy: boolean;
}

const CartItemCard: React.FC<CartItemCardProps> = ({
  item,
  onUpdateQuantity,
  onUpdateCustomization,
  onRemove,
  isBusy,
}) => {
  const [imageError, setImageError] = useState(false);
  const [notes, setNotes] = useState(item.customization || '');
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSuccess, setNoteSuccess] = useState(false);

  const itemId = item.id || item._id;
  const project = item.project;
  const projectIdentifier = project.slug || project.id || project._id;
  const detailUrl = `/projects/${encodeURIComponent(projectIdentifier)}`;

  // Synchronize local notes only when server state changes and user has not typed unsaved edits
  const isDirty = notes !== (item.customization || '');
  useEffect(() => {
    if (!isDirty) {
      setNotes(item.customization || '');
    }
  }, [item.customization, isDirty]);

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    if (val.length <= 500) {
      setNotes(val);
      if (noteError) setNoteError(null);
      if (noteSuccess) setNoteSuccess(false);
    }
  };

  const handleSaveNotes = async () => {
    if (!isDirty || isSavingNotes) return;
    setIsSavingNotes(true);
    setNoteError(null);
    try {
      await onUpdateCustomization(itemId, notes.trim());
      setNoteSuccess(true);
      setTimeout(() => setNoteSuccess(false), 2500);
    } catch (err: unknown) {
      // Preserve local notes so the user's text is not lost
      const msg = err instanceof Error ? err.message : 'Failed to save notes. Your text has been preserved.';
      setNoteError(msg);
    } finally {
      setIsSavingNotes(false);
    }
  };

  const handleDecrease = () => {
    if (item.quantity <= 1 || isBusy) return;
    onUpdateQuantity(itemId, item.quantity - 1);
  };

  const handleIncrease = () => {
    if (item.quantity >= 10 || isBusy) return;
    onUpdateQuantity(itemId, item.quantity + 1);
  };

  const handleRemove = () => {
    if (isBusy) return;
    onRemove(itemId);
  };

  const getDifficultyBadge = (difficulty?: string) => {
    switch (difficulty) {
      case 'Beginner':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'Intermediate':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'Advanced':
        return 'bg-purple-50 text-purple-700 border-purple-200';
      default:
        return 'bg-slate-100 text-slate-600 border-slate-200';
    }
  };

  return (
    <article
      className="p-5 sm:p-6 rounded-2xl bg-white border border-slate-200/80 shadow-xs hover:border-slate-300 transition-colors flex flex-col md:flex-row gap-5 items-start"
      aria-label={`Cart item: ${project.title}`}
    >
      {/* Project Thumbnail Image */}
      <Link
        to={detailUrl}
        className="w-full md:w-36 h-36 shrink-0 rounded-xl bg-slate-100 overflow-hidden border border-slate-200/60 block relative group focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label={`View project details for ${project.title}`}
      >
        {imageError ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 p-2 text-center">
            <FolderGit2 className="h-8 w-8 text-slate-300 mb-1" />
            <span className="text-[10px] font-medium text-slate-400">
              {project.category || 'Project'}
            </span>
          </div>
        ) : (
          <img
            src={project.image}
            alt={project.title}
            onError={() => setImageError(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        )}
      </Link>

      {/* Main Content Details */}
      <div className="flex-1 w-full flex flex-col justify-between space-y-4">
        {/* Top Header: Title, Category Badges & Unit Price */}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              {project.category && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200/60 px-2.5 py-0.5 rounded-md">
                  <Layers className="h-3 w-3" />
                  {project.category}
                </span>
              )}
              {project.difficulty && (
                <span
                  className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-md border ${getDifficultyBadge(
                    project.difficulty
                  )}`}
                >
                  <BarChart2 className="h-3 w-3" />
                  {project.difficulty}
                </span>
              )}
            </div>

            {/* Canonical Server Unit Price */}
            <div className="text-right">
              <span className="text-xs text-slate-400 font-medium block">Unit Price</span>
              <span className="text-sm font-bold text-slate-900">
                ₹{Math.round(item.unitPrice).toLocaleString('en-IN')}
              </span>
            </div>
          </div>

          <h3 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight leading-snug line-clamp-2">
            <Link
              to={detailUrl}
              className="hover:text-blue-600 transition-colors focus:outline-none focus:underline"
            >
              {project.title}
            </Link>
          </h3>
        </div>

        {/* Customization Notes Section */}
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between">
            <label
              htmlFor={`notes-${itemId}`}
              className="text-xs font-semibold text-slate-700 flex items-center gap-1"
            >
              Customization Notes
              <span className="text-[11px] font-normal text-slate-400">(optional)</span>
            </label>
            <div className="flex items-center gap-2">
              {isSavingNotes && (
                <span className="text-[11px] font-medium text-blue-600 flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Saving...
                </span>
              )}
              {noteSuccess && (
                <span className="text-[11px] font-medium text-emerald-600 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Saved
                </span>
              )}
              <span
                className={`text-[11px] font-medium ${
                  notes.length >= 500 ? 'text-red-600 font-bold' : 'text-slate-400'
                }`}
              >
                {notes.length} / 500
              </span>
            </div>
          </div>

          <div className="relative">
            <textarea
              id={`notes-${itemId}`}
              rows={2}
              value={notes}
              onChange={handleNotesChange}
              onBlur={handleSaveNotes}
              disabled={isBusy}
              placeholder="Add kit customization requirements, preferences, or component requests (max 500 characters)..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50/50 p-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all resize-none disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          {isDirty && !isSavingNotes && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveNotes}
                disabled={isBusy}
                className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 hover:underline px-1 py-0.5 focus:outline-none"
              >
                Save note changes
              </button>
            </div>
          )}

          {noteError && (
            <p className="text-[11px] font-medium text-red-600 flex items-center gap-1 mt-1">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span>{noteError}</span>
            </p>
          )}
        </div>

        {/* Bottom Action Row: Quantity Controls, Subtotal & Remove Button */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-slate-100">
          {/* Quantity Controls */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-slate-600">Qty:</span>
            <div className="inline-flex items-center rounded-xl border border-slate-200 bg-slate-50 p-0.5 shadow-2xs">
              <button
                type="button"
                onClick={handleDecrease}
                disabled={item.quantity <= 1 || isBusy}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-600 hover:bg-white hover:text-slate-900 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500"
                aria-label={`Decrease quantity of ${project.title}`}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span
                className="flex h-7 min-w-[32px] items-center justify-center px-2 text-xs font-bold text-slate-900 select-none"
                aria-live="polite"
              >
                {item.quantity}
              </span>
              <button
                type="button"
                onClick={handleIncrease}
                disabled={item.quantity >= 10 || isBusy}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-600 hover:bg-white hover:text-slate-900 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500"
                aria-label={`Increase quantity of ${project.title}`}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {item.quantity >= 10 && (
              <span className="text-[11px] text-amber-600 font-medium">Max 10</span>
            )}
          </div>

          {/* Item Subtotal & Remove Button */}
          <div className="flex items-center gap-4 ml-auto">
            <div className="text-right">
              <span className="text-[11px] text-slate-400 block font-medium">Item Subtotal</span>
              <span className="text-sm sm:text-base font-extrabold text-slate-900">
                ₹{Math.round(item.itemTotal).toLocaleString('en-IN')}
              </span>
            </div>

            <button
              type="button"
              onClick={handleRemove}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 rounded-xl text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/20"
              aria-label={`Remove ${project.title} from cart`}
            >
              <Trash2 className="h-4 w-4" />
              <span className="hidden sm:inline">Remove</span>
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};

/**
 * CartPage Component
 * Provides complete shopping cart browsing, quantity manipulation, customization note editing,
 * server-side price totals, and disabled checkout indicator.
 */
export const CartPage: React.FC = () => {
  const {
    cart,
    cartCount,
    cartTotal,
    isLoading,
    error: contextError,
    refreshCart,
    updateItem,
    removeItem,
    clearCart,
  } = useCart();

  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const checkout = useCheckout();

  const handleUpdateQuantity = async (itemId: string, newQuantity: number) => {
    setActiveItemId(itemId);
    setActionError(null);
    try {
      await updateItem(itemId, { quantity: newQuantity });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to update item quantity.');
    } finally {
      setActiveItemId(null);
    }
  };

  const handleUpdateCustomization = async (itemId: string, customization: string) => {
    setActiveItemId(itemId);
    setActionError(null);
    try {
      await updateItem(itemId, { customization });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to update customization notes.');
      throw err; // Re-throw to allow CartItemCard to maintain text state
    } finally {
      setActiveItemId(null);
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    setActiveItemId(itemId);
    setActionError(null);
    try {
      await removeItem(itemId);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove item from cart.');
    } finally {
      setActiveItemId(null);
    }
  };

  const handleClearCart = async () => {
    if (isClearing || !cart || cart.items.length === 0) return;
    if (!window.confirm('Are you sure you want to remove all items from your shopping cart?')) {
      return;
    }
    setIsClearing(true);
    setActionError(null);
    try {
      await clearCart();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to clear shopping cart.');
    } finally {
      setIsClearing(false);
    }
  };

  // 1. Initial Loading Skeleton
  if (isLoading && !cart) {
    return (
      <main className="min-h-screen bg-slate-50/50 py-8 sm:py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="h-8 w-48 bg-slate-200 animate-pulse rounded-lg mb-8" />
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <div className="lg:col-span-8 space-y-4">
              <div className="h-44 bg-slate-200 animate-pulse rounded-2xl" />
              <div className="h-44 bg-slate-200 animate-pulse rounded-2xl" />
            </div>
            <div className="lg:col-span-4 h-64 bg-slate-200 animate-pulse rounded-2xl" />
          </div>
        </div>
      </main>
    );
  }

  const items = cart?.items || [];
  const hasItems = items.length > 0;

  return (
    <main className="min-h-screen bg-slate-50/50 py-8 sm:py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Navigation Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-6">
          <Link
            to="/shop"
            className="inline-flex items-center text-sm font-semibold text-slate-600 hover:text-blue-600 transition-colors group focus:outline-none focus:underline"
          >
            <ArrowLeft className="h-4 w-4 mr-1.5 transition-transform group-hover:-translate-x-1" />
            <span>Continue Shopping</span>
          </Link>
        </nav>

        {/* Page Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 mb-8 pb-4 border-b border-slate-200/60">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
              <span>Shopping Cart</span>
              {hasItems && (
                <span className="text-xs sm:text-sm font-semibold px-3 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
                  {cartCount} {cartCount === 1 ? 'item' : 'items'}
                </span>
              )}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Review your selected engineering projects, customize kits, and prepare for ordering.
            </p>
          </div>

          {hasItems && (
            <button
              type="button"
              onClick={handleClearCart}
              disabled={isClearing || activeItemId !== null}
              className="text-xs font-semibold text-slate-500 hover:text-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:underline py-1"
            >
              {isClearing ? 'Clearing cart...' : 'Clear all items'}
            </button>
          )}
        </div>

        {/* Error Notification Banners */}
        {(actionError || contextError) && (
          <div
            className="mb-6 p-4 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm flex items-start justify-between gap-3"
            role="alert"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Cart Update Notice</p>
                <p className="text-xs text-red-600 mt-0.5">{actionError || contextError}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                refreshCart();
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-red-700 bg-red-100 hover:bg-red-200 rounded-lg transition-colors focus:outline-none"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        )}

        {/* Checkout Error / Notification Banner */}
        {checkout.errorMessage && (
          <div
            className={`mb-6 p-4 rounded-2xl border text-sm flex items-start justify-between gap-3 ${
              checkout.uncertainVerification
                ? 'bg-amber-50 border-amber-200 text-amber-800'
                : checkout.status === 'cancelled'
                ? 'bg-slate-100 border-slate-200 text-slate-700'
                : 'bg-red-50 border-red-200 text-red-700'
            }`}
            role="alert"
          >
            <div className="flex items-start gap-2.5">
              {checkout.uncertainVerification ? (
                <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              ) : checkout.status === 'cancelled' ? (
                <AlertCircle className="h-5 w-5 text-slate-500 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
              )}
              <div>
                <p className="font-semibold">
                  {checkout.uncertainVerification
                    ? 'Payment Verification Pending'
                    : checkout.status === 'cancelled'
                    ? 'Checkout Cancelled'
                    : 'Payment Notice'}
                </p>
                <p className="text-xs mt-0.5 leading-relaxed">{checkout.errorMessage}</p>
                {checkout.uncertainVerification && (
                  <div className="mt-2">
                    <Link
                      to="/orders"
                      className="text-xs font-semibold text-amber-900 underline hover:text-amber-700"
                    >
                      Check Order History &rarr;
                    </Link>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {checkout.status !== 'cancelled' && !checkout.uncertainVerification && (
                <button
                  type="button"
                  onClick={checkout.retryCheckout}
                  disabled={checkout.isProcessing}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-red-700 bg-red-100 hover:bg-red-200 rounded-lg transition-colors focus:outline-none"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </button>
              )}
              <button
                type="button"
                onClick={checkout.resetCheckout}
                className="text-xs font-semibold opacity-60 hover:opacity-100 px-2 py-1 rounded"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* 1.5. Payment Success View */}
        {checkout.status === 'success' && checkout.verifiedOrder ? (
          <div className="max-w-2xl mx-auto my-12 p-8 sm:p-12 rounded-3xl bg-white border border-emerald-200/90 shadow-xs text-center">
            <div className="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-5 border border-emerald-100">
              <CheckCircle2 className="h-9 w-9 text-emerald-600" />
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
              Payment Successful!
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed max-w-md mx-auto mb-6">
              Thank you for your purchase. Your payment was verified authoritatively and your order has been placed successfully.
            </p>

            {/* Order Details Summary Box */}
            <div className="bg-slate-50 border border-slate-200/70 rounded-2xl p-5 mb-8 text-left space-y-3">
              <div className="flex items-center justify-between text-xs sm:text-sm">
                <span className="text-slate-500 font-medium">Order Reference:</span>
                <span className="font-mono font-bold text-slate-900">{checkout.verifiedOrder.orderId}</span>
              </div>
              <div className="flex items-center justify-between text-xs sm:text-sm">
                <span className="text-slate-500 font-medium">Payment ID:</span>
                <span className="font-mono text-slate-700">{checkout.verifiedOrder.razorpayPaymentId}</span>
              </div>
              <div className="flex items-center justify-between text-xs sm:text-sm">
                <span className="text-slate-500 font-medium">Amount Paid:</span>
                <span className="font-bold text-slate-900">
                  ₹{Math.round(checkout.verifiedOrder.totalAmount).toLocaleString('en-IN')}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs sm:text-sm">
                <span className="text-slate-500 font-medium">Payment Status:</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                  Captured & Confirmed
                </span>
              </div>
            </div>

            {/* Navigation Actions */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                to={
                  checkout.verifiedOrder.id || checkout.verifiedOrder._id
                    ? `/orders/${checkout.verifiedOrder.id || checkout.verifiedOrder._id}`
                    : '/orders'
                }
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 shadow-sm shadow-blue-500/20 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <span>View Order Details</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/orders"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-slate-100 text-slate-700 font-semibold text-sm hover:bg-slate-200 transition-all focus:outline-none"
              >
                <span>Order History</span>
              </Link>
              <Link
                to="/shop"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl border border-slate-200 text-slate-600 font-semibold text-sm hover:bg-slate-50 transition-all focus:outline-none"
              >
                <span>Continue Shopping</span>
              </Link>
            </div>
          </div>
        ) : !hasItems ? (
          /* 2. Empty Cart State */
          <div className="max-w-xl mx-auto my-12 text-center bg-white border border-slate-200/80 rounded-3xl p-8 sm:p-12 shadow-xs">
            <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-5 border border-blue-100">
              <ShoppingCart className="h-8 w-8 text-blue-600" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight mb-2">
              Your Cart is Empty
            </h2>
            <p className="text-sm text-slate-500 leading-relaxed mb-6 max-w-sm mx-auto">
              You haven't added any project kits or components to your cart yet. Explore our verified project catalog to find your next build.
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
          /* 3. Filled Cart Layout: Item List + Order Summary */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left: Cart Items List */}
            <div className="lg:col-span-8 space-y-4" role="region" aria-label="Cart Items">
              {items.map((item) => (
                <CartItemCard
                  key={item.id || item._id}
                  item={item}
                  onUpdateQuantity={handleUpdateQuantity}
                  onUpdateCustomization={handleUpdateCustomization}
                  onRemove={handleRemoveItem}
                  isBusy={activeItemId === (item.id || item._id) || isClearing || checkout.isProcessing}
                />
              ))}
            </div>

            {/* Right: Order Summary Card */}
            <aside
              className="lg:col-span-4 sticky top-24 rounded-3xl bg-white border border-slate-200/80 p-6 shadow-xs space-y-6"
              aria-label="Order Summary"
            >
              <h2 className="text-lg font-bold text-slate-900 tracking-tight pb-3 border-b border-slate-100">
                Order Summary
              </h2>

              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between text-slate-600">
                  <span>Total Items</span>
                  <span className="font-semibold text-slate-900">{cartCount}</span>
                </div>

                <div className="flex items-center justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span className="font-semibold text-slate-900">
                    ₹{Math.round(cart?.subtotal ?? cartTotal).toLocaleString('en-IN')}
                  </span>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-baseline justify-between">
                  <div>
                    <span className="text-base font-bold text-slate-900 block">Total Amount</span>
                    <span className="text-[11px] text-slate-400">Canonical server-calculated prices</span>
                  </div>
                  <span className="text-2xl font-extrabold text-slate-900 tracking-tight">
                    ₹{Math.round(cart?.total ?? cartTotal).toLocaleString('en-IN')}
                  </span>
                </div>
              </div>

              {/* Checkout Button: Active Razorpay Integration */}
              <div className="space-y-3 pt-2">
                <button
                  type="button"
                  onClick={checkout.initiateCheckout}
                  disabled={
                    checkout.isProcessing ||
                    !hasItems ||
                    isClearing ||
                    activeItemId !== null
                  }
                  className="w-full py-3.5 px-6 rounded-xl font-semibold text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-blue-500/20 transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  {checkout.status === 'creating_order' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Initiating Order...</span>
                    </>
                  ) : checkout.status === 'awaiting_payment' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Opening Payment Gateway...</span>
                    </>
                  ) : checkout.status === 'verifying_payment' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Verifying Payment...</span>
                    </>
                  ) : (
                    <>
                      <CreditCard className="h-4 w-4" />
                      <span>Pay with Razorpay</span>
                    </>
                  )}
                </button>

                <p className="text-[11px] text-slate-500 text-center leading-relaxed bg-slate-50 rounded-xl p-3 border border-slate-100">
                  Payments are processed securely via Razorpay with 256-bit encryption. Your cart is preserved until payment is authoritatively confirmed.
                </p>
              </div>

              {/* Verified Security Notice */}
              <div className="pt-2 border-t border-slate-100 flex items-center justify-center gap-2 text-xs text-slate-400">
                <Lock className="h-3.5 w-3.5 text-slate-400" />
                <span>Encrypted MongoDB Cart & Razorpay Checkout</span>
              </div>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
};

export default CartPage;
