import React from 'react';
import { Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { categories } from '../../data/projects';
import { useAuth } from '../../contexts/AuthContext';

export const Footer: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-white border-t border-slate-200/80 mt-auto text-slate-600">
      {/* Main Footer Grid */}
      <div className="content-container py-12">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* Column 1: Brand & About */}
          <div className="space-y-3">
            <Link
              to="/"
              className="inline-flex items-center gap-2 group focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
              aria-label="ProjectWorld Home"
            >
              <img
                src="/logo.png"
                alt="ProjectWorld Logo"
                className="h-7 w-7 rounded-full border border-slate-200 object-cover"
              />
              <span className="text-base font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                Project<span className="text-blue-600">World</span>
              </span>
            </Link>
            <p className="text-xs leading-relaxed text-slate-500">
              Your marketplace for high-quality tech projects and academic
              resources.
            </p>
          </div>

          {/* Column 2: Supported Categories */}
          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-900">
              Project Categories
            </h2>
            <ul className="space-y-2 text-xs text-slate-500">
              {categories.map((cat) => (
                <li key={cat.name}>
                  <Link
                    to={`/shop?category=${encodeURIComponent(cat.name)}`}
                    className="flex items-center gap-1.5 text-slate-500 hover:text-blue-600 transition-colors"
                  >
                    <span className="h-1 w-1 rounded-full bg-blue-600" aria-hidden="true" />
                    <span>{cat.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Column 3: Navigation Links */}
          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-900">
              Navigation
            </h2>
            <ul className="space-y-2 text-xs">
              <li>
                <Link
                  to="/"
                  className="text-slate-500 hover:text-blue-600 transition-colors"
                >
                  Home
                </Link>
              </li>
              <li>
                <Link
                  to="/shop"
                  className="text-slate-500 hover:text-blue-600 transition-colors"
                >
                  Browse Projects
                </Link>
              </li>
              {isAuthenticated ? (
                <li>
                  <Link
                    to="/profile"
                    className="text-slate-500 hover:text-blue-600 transition-colors"
                  >
                    My Account
                  </Link>
                </li>
              ) : (
                <>
                  <li>
                    <Link
                      to="/login"
                      className="text-slate-500 hover:text-blue-600 transition-colors"
                    >
                      Sign In
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/signup"
                      className="text-slate-500 hover:text-blue-600 transition-colors"
                    >
                      Create Account
                    </Link>
                  </li>
                </>
              )}
            </ul>
          </div>

          {/* Column 4: Newsletter & Contact */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-900">
                Stay Updated
              </h2>
              <span className="text-[10px] font-medium bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                Coming soon
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Newsletter subscriptions will be available in a future update.
            </p>

            <div className="flex gap-1.5">
              <input
                type="email"
                disabled
                placeholder="Newsletter coming soon"
                aria-label="Newsletter subscription (currently disabled)"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-400 placeholder:text-slate-400 cursor-not-allowed focus:outline-none"
              />
              <button
                type="button"
                disabled
                className="flex-shrink-0 rounded-lg bg-slate-100 border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-400 cursor-not-allowed"
              >
                Join
              </button>
            </div>

            {/* Direct Contact from original source */}
            <div className="pt-2">
              <a
                href="mailto:shashwatshukla140204@gmail.com"
                className="inline-flex items-center text-xs text-slate-500 hover:text-blue-600 transition-colors break-all"
                aria-label="Email support at shashwatshukla140204@gmail.com"
              >
                <Mail className="mr-1.5 h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
                <span>shashwatshukla140204@gmail.com</span>
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Copyright Bar */}
      <div className="border-t border-slate-100 py-5 bg-slate-50/50">
        <div className="content-container flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] text-slate-500">
          <p>© {currentYear} Project World. All rights reserved.</p>
          <p className="text-slate-400">
            Digital Marketplace for Academic & Engineering Projects
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
