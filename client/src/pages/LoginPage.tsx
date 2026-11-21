import React, { useState } from 'react';
import { Link, useNavigate, useLocation, Location } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, Loader2, ArrowRight, AlertCircle, Layers } from 'lucide-react';
import { useAuth, AuthError } from '../contexts/AuthContext';

interface FormErrors {
  email?: string;
  password?: string;
}

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [generalError, setGeneralError] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Validate inputs on client before sending request
  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    const trimmedEmail = formData.email.trim();
    if (!trimmedEmail) {
      newErrors.email = 'Email address is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      newErrors.email = 'Please provide a valid email address.';
    }

    if (!formData.password) {
      newErrors.password = 'Password is required.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    // Clear field-level error as user edits
    if (errors[name as keyof FormErrors]) {
      setErrors((prev) => ({
        ...prev,
        [name]: undefined,
      }));
    }

    // Clear general error when typing
    if (generalError) {
      setGeneralError('');
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setGeneralError('');

    if (!validateForm() || isSubmitting) {
      return;
    }

    setIsSubmitting(true);

    try {
      await login({
        email: formData.email.trim().toLowerCase(),
        password: formData.password,
      });

      // Navigate to originally requested page or default to /profile
      const locationState = location.state as { from?: Location } | null;
      const requestedPath = locationState?.from?.pathname;
      const destination =
        requestedPath && requestedPath !== '/login' && requestedPath !== '/signup'
          ? requestedPath
          : '/profile';

      navigate(destination, { replace: true });
    } catch (err) {
      if (err instanceof AuthError) {
        // Map backend field errors if present
        if (err.errors && err.errors.length > 0) {
          const fieldErrors: FormErrors = {};
          err.errors.forEach((issue) => {
            if (issue.field === 'email' || issue.field === 'password') {
              fieldErrors[issue.field] = issue.message;
            }
          });
          setErrors(fieldErrors);
        }

        // Map general status errors (401 credentials, 429 rate limit, 500 server)
        if (err.statusCode === 401) {
          setGeneralError('Invalid email or password. Please verify your credentials.');
        } else if (err.statusCode === 429) {
          setGeneralError('Too many login attempts. Please wait 15 minutes before trying again.');
        } else {
          setGeneralError(err.message || 'Login failed. Please try again.');
        }
      } else if (err instanceof Error) {
        setGeneralError(err.message);
      } else {
        setGeneralError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50/50 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        {/* Branding & Header */}
        <div className="text-center">
          <Link
            to="/"
            className="inline-flex items-center space-x-2 text-blue-600 transition hover:opacity-90"
            title="Back to home"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md shadow-blue-500/20">
              <Layers className="h-6 w-6" />
            </div>
            <span className="text-2xl font-black tracking-tight text-slate-900">
              Project<span className="text-blue-600">World</span>
            </span>
          </Link>
          <h1 className="mt-6 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Sign in to access your projects, orders, and customized workspaces.
          </p>
        </div>

        {/* Card Container */}
        <div className="mt-8 rounded-2xl border border-slate-200/80 bg-white p-7 shadow-xl shadow-slate-900/5 sm:p-9">
          {/* General Error Banner */}
          {generalError && (
            <div
              role="alert"
              aria-live="assertive"
              className="mb-6 flex items-start space-x-3 rounded-lg border border-red-200 bg-red-50/90 p-4 text-sm text-red-800"
            >
              <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" />
              <div className="flex-1 font-medium leading-relaxed">{generalError}</div>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            {/* Email Field */}
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-semibold text-slate-700"
              >
                Email Address
              </label>
              <div className="relative mt-1.5">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
                  <Mail className="h-4 w-4" />
                </div>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  disabled={isSubmitting}
                  value={formData.email}
                  onChange={handleChange}
                  placeholder="name@example.com"
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? 'email-error' : undefined}
                  className={`block w-full rounded-lg border bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 transition focus:outline-none focus:ring-2 disabled:bg-slate-50 disabled:text-slate-400 ${
                    errors.email
                      ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
                      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-500/20'
                  }`}
                />
              </div>
              {errors.email && (
                <p id="email-error" className="mt-1.5 text-xs font-medium text-red-600">
                  {errors.email}
                </p>
              )}
            </div>

            {/* Password Field */}
            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="block text-sm font-semibold text-slate-700"
                >
                  Password
                </label>
              </div>
              <div className="relative mt-1.5">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
                  <Lock className="h-4 w-4" />
                </div>
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  disabled={isSubmitting}
                  value={formData.password}
                  onChange={handleChange}
                  placeholder="••••••••"
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? 'password-error' : undefined}
                  className={`block w-full rounded-lg border bg-white py-2.5 pl-10 pr-10 text-sm text-slate-900 placeholder:text-slate-400 transition focus:outline-none focus:ring-2 disabled:bg-slate-50 disabled:text-slate-400 ${
                    errors.password
                      ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
                      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-500/20'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  disabled={isSubmitting}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-400 hover:text-slate-600 focus:outline-none"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {errors.password && (
                <p id="password-error" className="mt-1.5 text-xs font-medium text-red-600">
                  {errors.password}
                </p>
              )}
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="group relative flex w-full items-center justify-center rounded-lg bg-blue-600 py-2.5 px-4 text-sm font-semibold text-white shadow-md shadow-blue-500/20 transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin text-white" />
                    Signing in...
                  </>
                ) : (
                  <>
                    Sign In
                    <ArrowRight className="ml-2 h-4 w-4 transition group-hover:translate-x-0.5" />
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Footer Navigation */}
          <div className="mt-6 border-t border-slate-100 pt-5 text-center text-sm text-slate-600">
            Don't have an account?{' '}
            <Link
              to="/signup"
              className="font-semibold text-blue-600 hover:text-blue-500 hover:underline"
            >
              Create an account
            </Link>
          </div>
        </div>

        {/* Home Navigation Link */}
        <div className="mt-6 text-center">
          <Link
            to="/"
            className="inline-flex items-center text-xs font-medium text-slate-500 hover:text-slate-800 transition"
          >
            ← Back to marketplace
          </Link>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
