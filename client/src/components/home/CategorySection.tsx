import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Laptop, Cpu, Briefcase, LucideIcon } from 'lucide-react';
import { categories } from '../../data/projects';

export const CategorySection: React.FC = () => {
  // Helper to map category names to icons
  const getCategoryIcon = (categoryName: string): LucideIcon => {
    switch (categoryName.toLowerCase()) {
      case 'computer science':
        return Laptop;
      case 'engineering':
        return Cpu;
      case 'business':
        return Briefcase;
      default:
        return Laptop;
    }
  };

  return (
    <section
      className="py-16 bg-slate-50/60 border-y border-slate-200/60"
      aria-labelledby="categories-heading"
    >
      <div className="content-container">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-12">
          <span className="inline-block px-3 py-1 mb-3 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
            Explore Categories
          </span>
          <h2
            id="categories-heading"
            className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl mb-4"
          >
            Browse by Category
          </h2>
          <p className="text-slate-600 text-sm sm:text-base leading-relaxed">
            Explore our wide range of project categories to find exactly what you need
            for your next venture.
          </p>
        </div>

        {/* Categories Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
          {categories.map((category) => {
            const Icon = getCategoryIcon(category.name);

            return (
              <div
                key={category.name}
                className="flex flex-col h-full bg-white rounded-2xl border border-slate-200/80 p-6 sm:p-7 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-300"
              >
                {/* Category Header */}
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200/60 flex items-center justify-center text-blue-600 shrink-0">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">
                      {category.name}
                    </h3>
                    <span className="text-[11px] font-medium text-slate-500">
                      {category.subcategories.length} Subcategories
                    </span>
                  </div>
                </div>

                {/* Description */}
                <p className="text-xs text-slate-600 leading-relaxed mb-6">
                  {category.description}
                </p>

                {/* Subcategories List */}
                <div className="mb-6 flex-grow">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2.5">
                    Domains & Tracks
                  </p>
                  <ul className="space-y-2">
                    {category.subcategories.map((subcategory) => (
                      <li key={subcategory}>
                        <Link
                          to={`/shop?category=${encodeURIComponent(
                            category.name
                          )}&subcategory=${encodeURIComponent(subcategory)}`}
                          className="flex items-center text-xs font-medium text-slate-700 bg-slate-50/80 hover:bg-blue-50/70 border border-slate-100 hover:border-blue-200/60 rounded-lg px-3 py-2 transition-colors group"
                        >
                          <ArrowRight className="h-3.5 w-3.5 text-blue-500 mr-2 shrink-0 group-hover:translate-x-0.5 transition-transform" />
                          <span>{subcategory}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Card Action - Browse Category Projects */}
                <div className="pt-4 border-t border-slate-100 mt-auto">
                  <Link
                    to={`/shop?category=${encodeURIComponent(category.name)}`}
                    className="w-full inline-flex items-center justify-center py-2.5 px-4 text-xs font-semibold text-blue-600 bg-blue-50/60 hover:bg-blue-100/70 border border-blue-200/60 rounded-xl transition-colors"
                  >
                    <span>View All {category.name} Projects</span>
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default CategorySection;
