import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  User as UserIcon,
  Mail,
  Lock,
  ShieldCheck,
  Eye,
  EyeOff,
  Loader2,
  ArrowRight,
  AlertCircle,
  Layers,
} from 'lucide-react';
import { useAuth, AuthError } from '../contexts/AuthContext';

interface FormErrors {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
}

export const SignupPage: React.FC = () => {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [generalError, setGeneralError] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Validate inputs on client before sending request
  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    const trimmedName = formData.name.trim();
    if (!trimmedName) {
      newErrors.name = 'Full name is required.';
    } else if (trimmedName.length < 2) {
      newErrors.name = 'Name must be at least 2 characters long.';
    }

    const trimmedEmail = formData.email.trim();
    if (!trimmedEmail) {
      newErrors.email = 'Email address is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      newErrors.email = 'Please provide a valid email address.';
    }

    if (!formData.password) {
      newErrors.password = 'Password is required.';
    } else if (formData.password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters long.';
    }

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your password.';
    } else if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match.';
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

    // Also clear confirmPassword error if password changed
    if (name === 'password' && errors.confirmPassword) {
      setErrors((prev) => ({
        ...prev,
        confirmPassword: undefined,
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
      // Role is never passed from frontend; server strictly assigns default role 'user'
      await register({
        name: formData.name.trim(),
        email: formData.email.trim().toLowerCase(),
        password: formData.password,
      });

      // Navigate to /profile after successful registration
      navigate('/profile', { replace: true });
    } catch (err) {
      if (err instanceof AuthError) {
        // Map backend validation field errors if provided
        if (err.errors && err.errors.length > 0) {
          const fieldErrors: FormErrors = {};
          err.errors.forEach((issue) => {
            if (
              issue.field === 'name' ||
              issue.field === 'email' ||
              issue.field === 'password'
            ) {
              fieldErrors[issue.field] = issue.message;
            }
          });
          setErrors(fieldErrors);
        }

        // Map status-specific general messages
        if (err.statusCode === 409) {
          setGeneralError(
            'An account with this email address already exists. Please sign in or use a different email.'
          );
        } else if (err.statusCode === 429) {
          setGeneralError(
            'Too many registration attempts. Please wait 15 minutes before trying again.'
          );
        } else {
          setGeneralError(err.message || 'Registration failed. Please try again.');
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
            Create your account
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Join ProjectWorld to explore, purchase, and customize academic and engineering projects.
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

          {/* Registration Form */}
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            {/* Full Name Field */}
            <div>
              <label
                htmlFor="name"
                className="block text-sm font-semibold text-slate-700"
              >
                Full Name
              </label>
              <div className="relative mt-1.5">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
                  <UserIcon className="h-4 w-4" />
                </div>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  disabled={isSubmitting}
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="John Doe"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'name-error' : undefined}
                  className={`block w-full rounded-lg border bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 transition focus:outline-none focus:ring-2 disabled:bg-slate-50 disabled:text-slate-400 ${
                    errors.name
                      ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
                      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-500/20'
                  }`}
                />
              </div>
              {errors.name && (
                <p id="name-error" className="mt-1.5 text-xs font-medium text-red-600">
                  {errors.name}
                </p>
              )}
            </div>

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
              <label
                htmlFor="password"
                className="block text-sm font-semibold text-slate-700"
              >
                Password
              </label>
              <div className="relative mt-1.5">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
                  <Lock className="h-4 w-4" />
                </div>
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  value={formData.password}
                  onChange={handleChange}
                  placeholder="At least 6 characters"
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

            {/* Confirm Password Field */}
            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-semibold text-slate-700"
              >
                Confirm Password
              </label>
              <div className="relative mt-1.5">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  placeholder="Re-enter your password"
                  aria-invalid={Boolean(errors.confirmPassword)}
                  aria-describedby={
                    errors.confirmPassword ? 'confirmPassword-error' : undefined
                  }
                  className={`block w-full rounded-lg border bg-white py-2.5 pl-10 pr-10 text-sm text-slate-900 placeholder:text-slate-400 transition focus:outline-none focus:ring-2 disabled:bg-slate-50 disabled:text-slate-400 ${
                    errors.confirmPassword
                      ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
                      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-500/20'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((prev) => !prev)}
                  disabled={isSubmitting}
                  aria-label={
                    showConfirmPassword
                      ? 'Hide confirm password'
                      : 'Show confirm password'
                  }
                  className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-400 hover:text-slate-600 focus:outline-none"
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {errors.confirmPassword && (
                <p
                  id="confirmPassword-error"
                  className="mt-1.5 text-xs font-medium text-red-600"
                >
                  {errors.confirmPassword}
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
                    Creating account...
                  </>
                ) : (
                  <>
                    Create Account
                    <ArrowRight className="ml-2 h-4 w-4 transition group-hover:translate-x-0.5" />
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Footer Navigation */}
          <div className="mt-6 border-t border-slate-100 pt-5 text-center text-sm text-slate-600">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-semibold text-blue-600 hover:text-blue-500 hover:underline"
            >
              Sign in
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

export default SignupPage;
