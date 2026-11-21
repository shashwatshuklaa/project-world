import React, { useState, useEffect, useRef } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  Menu,
  X,
  ShoppingCart,
  User as UserIcon,
  LogOut,
  Search,
  Loader2,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

export const Navbar: React.FC = () => {
  const { user, isAuthenticated, logout } = useAuth();
  const navigate = useNavigate();

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const userMenuRef = useRef<HTMLDivElement>(null);

  // Monitor scroll for subtle shadow and height adjustment
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 15);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close user dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setIsUserMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close menus on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
        setIsUserMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await logout();
      setIsUserMenuOpen(false);
      setIsMenuOpen(false);
      navigate('/login', { replace: true });
    } catch (err) {
      console.warn('[Navbar] Logout error:', err);
      navigate('/login', { replace: true });
    } finally {
      setIsLoggingOut(false);
    }
  };

  const navLinkClasses = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-medium transition-colors ${
      isActive
        ? 'text-blue-600 font-semibold'
        : 'text-slate-600 hover:text-blue-600'
    }`;

  const mobileNavLinkClasses = ({ isActive }: { isActive: boolean }) =>
    `block py-2.5 px-3 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? 'bg-blue-50 text-blue-600 font-semibold'
        : 'text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <header
      className={`sticky top-0 z-40 transition-all duration-200 ${
        scrolled
          ? 'bg-white/95 backdrop-blur-md shadow-sm border-b border-slate-200/80 py-2.5'
          : 'bg-white border-b border-slate-100 py-3.5'
      }`}
    >
      <div className="content-container flex items-center justify-between">
        {/* Brand Logo */}
        <Link
          to="/"
          className="flex items-center gap-2.5 group focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-lg p-1"
          aria-label="ProjectWorld Home"
        >
          <img
            src="/logo.png"
            alt="ProjectWorld Logo"
            className="h-8 w-8 rounded-full border border-slate-200 object-cover shadow-xs"
          />
          <span className="text-base font-bold tracking-tight text-slate-900 group-hover:text-blue-600 transition-colors">
            Project<span className="text-blue-600">World</span>
          </span>
        </Link>

        {/* Desktop Navigation Links */}
        <nav
          className="hidden md:flex items-center space-x-8"
          aria-label="Main Navigation"
        >
          <NavLink to="/" className={navLinkClasses} end>
            Home
          </NavLink>
          {isAuthenticated && (
            <NavLink to="/profile" className={navLinkClasses}>
              Profile
            </NavLink>
          )}
        </nav>

        {/* Actions & Utilities */}
        <div className="flex items-center space-x-3">
          {/* Search Input - Desktop (Explicitly marked coming soon) */}
          <div
            className="relative hidden lg:block"
            title="Search will be activated with the project catalog"
          >
            <input
              type="text"
              disabled
              placeholder="Search (coming soon)"
              aria-label="Search projects (currently unavailable)"
              className="w-52 h-8 rounded-full border border-slate-200 bg-slate-50 px-8 text-xs text-slate-400 placeholder:text-slate-400 cursor-not-allowed focus:outline-none select-none"
            />
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-300"
              aria-hidden="true"
            />
          </div>

          {/* Cart Indicator (Non-interactive visual element) */}
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-slate-400 cursor-not-allowed select-none"
            aria-label="Shopping Cart (coming soon)"
            title="Cart is not available yet"
          >
            <ShoppingCart className="h-4 w-4 text-slate-300" aria-hidden="true" />
            <span className="hidden sm:inline-block text-[11px] font-medium text-slate-400">
              Cart coming soon
            </span>
          </div>

          {/* Authentication State Navigation */}
          {isAuthenticated && user ? (
            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setIsUserMenuOpen((prev) => !prev)}
                className="flex items-center gap-2 rounded-full p-1 border border-slate-200 hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                aria-expanded={isUserMenuOpen}
                aria-haspopup="true"
                aria-label="Open user profile menu"
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
                  {user.name ? user.name.charAt(0).toUpperCase() : 'U'}
                </div>
                <span className="hidden sm:inline-block text-xs font-medium text-slate-700 pr-1.5 max-w-[120px] truncate">
                  {user.name}
                </span>
              </button>

              {/* User Dropdown Menu */}
              {isUserMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-52 rounded-xl border border-slate-200 bg-white py-2 shadow-lg shadow-slate-900/10 focus:outline-none z-50 animate-in fade-in zoom-in-95 duration-100"
                >
                  <div className="px-4 py-2 border-b border-slate-100">
                    <p className="text-xs font-semibold text-slate-900 truncate">
                      {user.name}
                    </p>
                    <p className="text-[11px] text-slate-500 truncate">
                      {user.email}
                    </p>
                  </div>

                  <Link
                    to="/profile"
                    role="menuitem"
                    onClick={() => setIsUserMenuOpen(false)}
                    className="flex items-center px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 hover:text-blue-600 transition-colors"
                  >
                    <UserIcon className="mr-2 h-3.5 w-3.5 text-slate-400" />
                    My Profile
                  </Link>

                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleLogout}
                    disabled={isLoggingOut}
                    className="flex w-full items-center px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors text-left"
                  >
                    {isLoggingOut ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin text-red-600" />
                        Signing out...
                      </>
                    ) : (
                      <>
                        <LogOut className="mr-2 h-3.5 w-3.5 text-red-500" />
                        Sign Out
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="hidden sm:flex items-center space-x-2">
              <Link
                to="/login"
                className="text-xs font-semibold text-slate-700 hover:text-blue-600 px-3 py-1.5 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Log In
              </Link>
              <Link
                to="/signup"
                className="text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 px-3.5 py-1.5 rounded-lg shadow-xs shadow-blue-500/20 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
              >
                Sign Up
              </Link>
            </div>
          )}

          {/* Mobile Menu Toggle Button */}
          <button
            type="button"
            onClick={() => setIsMenuOpen((prev) => !prev)}
            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMenuOpen}
            className="md:hidden p-1.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {isMenuOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Menu Dropdown */}
      {isMenuOpen && (
        <div className="md:hidden border-t border-slate-100 bg-white px-4 pt-3 pb-6 space-y-4">
          <nav className="space-y-1" aria-label="Mobile Navigation">
            <NavLink
              to="/"
              className={mobileNavLinkClasses}
              onClick={() => setIsMenuOpen(false)}
              end
            >
              Home
            </NavLink>
            {isAuthenticated && (
              <NavLink
                to="/profile"
                className={mobileNavLinkClasses}
                onClick={() => setIsMenuOpen(false)}
              >
                Profile
              </NavLink>
            )}
          </nav>

          {/* Mobile Auth Actions */}
          <div className="border-t border-slate-100 pt-3">
            {isAuthenticated && user ? (
              <div className="space-y-2">
                <div className="px-3 py-1">
                  <p className="text-xs font-semibold text-slate-900">
                    {user.name}
                  </p>
                  <p className="text-[11px] text-slate-500">{user.email}</p>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={isLoggingOut}
                  className="flex w-full items-center justify-center py-2 px-3 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                >
                  {isLoggingOut ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Signing out...
                    </>
                  ) : (
                    <>
                      <LogOut className="mr-2 h-3.5 w-3.5" />
                      Sign Out
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Link
                  to="/login"
                  onClick={() => setIsMenuOpen(false)}
                  className="flex items-center justify-center py-2 px-3 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg hover:border-blue-500 transition-colors"
                >
                  Log In
                </Link>
                <Link
                  to="/signup"
                  onClick={() => setIsMenuOpen(false)}
                  className="flex items-center justify-center py-2 px-3 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Sign Up
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
};

export default Navbar;
