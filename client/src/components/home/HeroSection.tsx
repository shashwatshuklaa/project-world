import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles, Code2, RefreshCw } from 'lucide-react';

export const HeroSection: React.FC = () => {
  const categoryChips = [
    'AI Projects',
    'Web Development',
    'Mobile Apps',
    'Electronics',
    'Data Science',
  ];

  return (
    <section className="pt-10 pb-16 sm:pt-14 sm:pb-20 overflow-hidden">
      <div className="content-container relative">
        {/* Subtle background ambient blur blobs */}
        <div
          className="absolute -top-12 -right-12 w-72 h-72 rounded-full bg-blue-100/60 blur-3xl -z-10 pointer-events-none"
          aria-hidden="true"
        />
        <div
          className="absolute bottom-0 -left-12 w-80 h-80 rounded-full bg-indigo-50/70 blur-3xl -z-10 pointer-events-none"
          aria-hidden="true"
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Text Content Column */}
          <div className="text-center lg:text-left">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 mb-6 text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200/60 rounded-full shadow-2xs">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Tech Projects Marketplace</span>
            </span>

            <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-900 tracking-tight mb-6 leading-tight">
              Find the Perfect Tech Projects For Your Portfolio
            </h1>

            <p className="text-slate-600 text-base sm:text-lg mb-8 max-w-xl mx-auto lg:mx-0 leading-relaxed">
              Browse our collection of high-quality tech projects designed to enhance
              your portfolio and showcase your skills to potential employers.
            </p>

            {/* CTAs */}
            <div className="flex flex-wrap gap-4 justify-center lg:justify-start items-center">
              <Link
                to="/shop"
                className="inline-flex items-center justify-center px-6 py-3 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 active:bg-blue-800 shadow-sm hover:shadow transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                Browse Projects
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>

              <button
                type="button"
                disabled
                className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium text-slate-400 bg-slate-100 border border-slate-200 rounded-xl cursor-not-allowed select-none"
                title="Custom project requests are coming soon"
                aria-label="Request custom project (currently coming soon)"
              >
                <span>Request Custom Project</span>
                <span className="ml-2 text-[11px] font-medium text-slate-500 bg-slate-200/80 px-1.5 py-0.5 rounded">
                  Coming soon
                </span>
              </button>
            </div>

            {/* Category Chips / Badges */}
            <div className="mt-8 pt-6 border-t border-slate-200/70">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">
                Popular Specializations
              </p>
              <div className="flex flex-wrap gap-2 justify-center lg:justify-start">
                {categoryChips.map((chip) => (
                  <Link
                    key={chip}
                    to={`/shop?search=${encodeURIComponent(chip)}`}
                    className="text-xs px-3 py-1 rounded-full bg-white border border-slate-200 text-slate-600 hover:text-blue-600 hover:border-blue-300 shadow-2xs font-medium transition-colors"
                    title={`Browse ${chip}`}
                  >
                    {chip}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {/* Showcase Media Column */}
          <div className="lg:pl-6">
            <div className="relative mx-auto max-w-md lg:max-w-none">
              {/* Main Showcase Card */}
              <div className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xl shadow-slate-900/5 group">
                <img
                  src="/project.png"
                  alt="Tech Project Showcase - AI-Powered Image Recognition System"
                  className="w-full h-auto object-cover transition-transform duration-500 group-hover:scale-102"
                />

                {/* Overlaid Badges */}
                <div className="absolute top-3 left-3 bg-white/95 backdrop-blur-xs px-2.5 py-1 rounded-lg text-xs font-semibold text-blue-700 border border-slate-200/80 shadow-xs flex items-center gap-1">
                  <Sparkles className="h-3 w-3" />
                  <span>Featured Project</span>
                </div>

                <div className="absolute top-3 right-3 bg-slate-900/90 backdrop-blur-xs px-2.5 py-1 rounded-lg text-xs font-bold text-white shadow-xs">
                  ₹1,299
                </div>

                {/* Bottom Card Descriptor */}
                <div className="absolute bottom-0 inset-x-0 bg-white/95 backdrop-blur-md border-t border-slate-200/80 p-4">
                  <h3 className="text-sm font-bold text-slate-900 mb-0.5">
                    AI-Powered Image Recognition System
                  </h3>
                  <p className="text-xs text-slate-500">
                    Complete with source code and documentation
                  </p>
                </div>
              </div>

              {/* Floating feature pills (hidden on extra small screens to prevent layout overflow) */}
              <div className="hidden sm:flex items-center gap-1.5 absolute -right-4 top-1/4 bg-white/95 backdrop-blur-xs px-3 py-2 rounded-xl text-xs font-semibold text-slate-800 border border-slate-200 shadow-lg shadow-slate-900/5">
                <Code2 className="h-4 w-4 text-blue-600" />
                <span>Source Code Included</span>
              </div>

              <div className="hidden sm:flex items-center gap-1.5 absolute -left-4 bottom-1/4 bg-white/95 backdrop-blur-xs px-3 py-2 rounded-xl text-xs font-semibold text-slate-800 border border-slate-200 shadow-lg shadow-slate-900/5">
                <RefreshCw className="h-4 w-4 text-emerald-600" />
                <span>Lifetime Updates</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
