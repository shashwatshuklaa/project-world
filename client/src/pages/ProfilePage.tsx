import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  User as UserIcon,
  Mail,
  Shield,
  ShieldCheck,
  LogOut,
  Loader2,
  Layers,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export const ProfilePage: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const handleLogout = async () => {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    setLogoutError(null);

    try {
      // Calls existing logout method from AuthContext (clears server cookie and resets user state)
      await logout();
      // Redirect to /login using React Router replace navigation
      navigate('/login', { replace: true });
    } catch (err: unknown) {
      console.error('[ProfilePage] Unexpected error during logout:', err);
      setLogoutError(
        err instanceof Error
          ? err.message
          : 'Failed to complete logout. Redirecting to login...'
      );
      // Guarantee redirect even on failure so user does not remain on protected page
      navigate('/login', { replace: true });
    } finally {
      setIsLoggingOut(false);
    }
  };

  // If user is null (e.g. right after logout state reset), render minimal fallback
  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center space-x-3 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          <span className="text-sm font-medium">Redirecting...</span>
        </div>
      </div>
    );
  }

  // Generate initials for the avatar badge
  const initials = user.name
    ? user.name
        .split(' ')
        .map((part) => part[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'U';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50/40 text-slate-900">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <Link
            to="/"
            className="flex items-center space-x-2.5 text-blue-600 transition hover:opacity-90"
            title="ProjectWorld Marketplace"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-500/20">
              <Layers className="h-5 w-5" />
            </div>
            <span className="text-xl font-black tracking-tight text-slate-900">
              Project<span className="text-blue-600">World</span>
            </span>
          </Link>

          <Link
            to="/"
            className="inline-flex items-center space-x-1.5 text-xs font-semibold text-slate-600 transition hover:text-blue-600 sm:text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Marketplace</span>
          </Link>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Account Profile
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            View your personal credentials, account role, and active session status.
          </p>
        </div>

        {/* Error Alert Banner */}
        {logoutError && (
          <div
            role="alert"
            className="mb-6 flex items-start space-x-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" />
            <div className="flex-1 font-medium">{logoutError}</div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left Column: User Summary Card */}
          <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8 lg:col-span-1">
            <div className="flex flex-col items-center text-center">
              {/* User Avatar Circle */}
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-blue-600 text-2xl font-bold text-white shadow-md shadow-blue-500/25">
                {initials}
              </div>

              {/* Name & Role */}
              <h2 className="mt-4 text-lg font-bold text-slate-900">{user.name}</h2>
              <p className="text-xs text-slate-500 break-all">{user.email}</p>

              {/* Role Badge */}
              <div className="mt-3">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    user.role === 'admin'
                      ? 'bg-purple-100 text-purple-800 border border-purple-200'
                      : 'bg-blue-50 text-blue-700 border border-blue-200'
                  }`}
                >
                  <Shield className="mr-1 h-3 w-3" />
                  {user.role === 'admin' ? 'Administrator' : 'Verified Member'}
                </span>
              </div>

              {/* Session Status Pill */}
              <div className="mt-6 flex items-center space-x-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                <span>Active Session</span>
              </div>
            </div>

            {/* Logout Action in Summary */}
            <div className="mt-8 border-t border-slate-100 pt-6">
              <button
                type="button"
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="group flex w-full items-center justify-center rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-red-500/20 transition hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 active:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoggingOut ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin text-white" />
                    <span>Signing out...</span>
                  </>
                ) : (
                  <>
                    <LogOut className="mr-2 h-4 w-4 transition group-hover:-translate-x-0.5" />
                    <span>Sign Out</span>
                  </>
                )}
              </button>
              <p className="mt-2 text-center text-[11px] text-slate-400">
                Ends your current session and clears your secure cookie.
              </p>
            </div>
          </div>

          {/* Right Column: Account Details and Security */}
          <div className="space-y-6 lg:col-span-2">
            {/* Account Details Card */}
            <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <h3 className="text-base font-bold text-slate-900">Profile Information</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Personal details linked to your ProjectWorld account.
              </p>

              <dl className="mt-6 divide-y divide-slate-100 text-sm">
                {/* Full Name */}
                <div className="py-3.5 sm:grid sm:grid-cols-3 sm:gap-4 sm:items-center">
                  <dt className="flex items-center text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <UserIcon className="mr-2 h-4 w-4 text-slate-400" />
                    Full Name
                  </dt>
                  <dd className="mt-1 font-medium text-slate-900 sm:col-span-2 sm:mt-0">
                    {user.name}
                  </dd>
                </div>

                {/* Email Address */}
                <div className="py-3.5 sm:grid sm:grid-cols-3 sm:gap-4 sm:items-center">
                  <dt className="flex items-center text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <Mail className="mr-2 h-4 w-4 text-slate-400" />
                    Email Address
                  </dt>
                  <dd className="mt-1 flex items-center font-medium text-slate-900 sm:col-span-2 sm:mt-0">
                    <span className="break-all">{user.email}</span>
                  </dd>
                </div>

                {/* Account Role */}
                <div className="py-3.5 sm:grid sm:grid-cols-3 sm:gap-4 sm:items-center">
                  <dt className="flex items-center text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <Shield className="mr-2 h-4 w-4 text-slate-400" />
                    Account Role
                  </dt>
                  <dd className="mt-1 font-medium text-slate-900 capitalize sm:col-span-2 sm:mt-0">
                    {user.role}
                  </dd>
                </div>

                {/* Account ID */}
                <div className="py-3.5 sm:grid sm:grid-cols-3 sm:gap-4 sm:items-center">
                  <dt className="flex items-center text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <Layers className="mr-2 h-4 w-4 text-slate-400" />
                    Account ID
                  </dt>
                  <dd className="mt-1 font-mono text-xs text-slate-600 sm:col-span-2 sm:mt-0 break-all">
                    {user.id}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Session & Security Info Card */}
            <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <div className="flex items-start space-x-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Security Architecture</h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">
                    ProjectWorld uses secure, HTTP-only cookie sessions. Your credentials and authentication tokens are never stored in localStorage or sessionStorage, protecting your account against cross-site scripting (XSS) extraction.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ProfilePage;
