import React from 'react';
import { ArrowRight, UserPlus, UserCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export const CtaSection: React.FC = () => {
  const { isAuthenticated } = useAuth();

  return (
    <section className="py-16" aria-labelledby="cta-heading">
      <div className="content-container">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 text-white p-8 sm:p-12 lg:p-16 shadow-xl shadow-blue-900/10 text-center">
          {/* Subtle Ambient Decorative Circles */}
          <div
            className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-white/10 blur-2xl pointer-events-none"
            aria-hidden="true"
          />
          <div
            className="absolute -bottom-24 -left-24 w-72 h-72 rounded-full bg-blue-400/20 blur-2xl pointer-events-none"
            aria-hidden="true"
          />

          <div className="relative z-10 max-w-2xl mx-auto">
            <h2
              id="cta-heading"
              className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight mb-4"
            >
              Ready to Get Started?
            </h2>

            <p className="text-blue-100 text-base sm:text-lg mb-8 leading-relaxed">
              Browse our collection of projects and find the perfect one for your
              needs today.
            </p>

            <div className="flex flex-wrap gap-4 justify-center items-center">
              {/* Primary Action: Scrolls to Featured Projects on page */}
              <a
                href="#featured-projects"
                className="inline-flex items-center justify-center px-7 py-3.5 text-sm font-bold text-blue-700 bg-white rounded-xl hover:bg-blue-50 active:bg-blue-100 shadow-md transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-blue-600"
              >
                <span>Explore Featured Projects</span>
                <ArrowRight className="ml-2 h-4 w-4" />
              </a>

              {/* Secondary Action: Working Auth Link */}
              {isAuthenticated ? (
                <Link
                  to="/profile"
                  className="inline-flex items-center justify-center px-6 py-3.5 text-sm font-semibold text-white bg-blue-500/30 hover:bg-blue-500/40 border border-white/20 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-blue-600"
                >
                  <UserCheck className="mr-2 h-4 w-4" />
                  <span>View Account Profile</span>
                </Link>
              ) : (
                <Link
                  to="/signup"
                  className="inline-flex items-center justify-center px-6 py-3.5 text-sm font-semibold text-white bg-blue-500/30 hover:bg-blue-500/40 border border-white/20 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-blue-600"
                >
                  <UserPlus className="mr-2 h-4 w-4" />
                  <span>Create Free Account</span>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CtaSection;
