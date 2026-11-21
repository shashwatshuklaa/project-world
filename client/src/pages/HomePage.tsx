import React from 'react';
import { getFeaturedProjects } from '../data/projects';
import { HeroSection } from '../components/home/HeroSection';
import { CategorySection } from '../components/home/CategorySection';
import { ProjectGrid } from '../components/projects/ProjectGrid';
import { HowItWorksSection } from '../components/home/HowItWorksSection';
import { TestimonialsSection } from '../components/home/TestimonialsSection';
import { CtaSection } from '../components/home/CtaSection';
import { FaqSection } from '../components/home/FaqSection';

export const HomePage: React.FC = () => {
  const featuredProjects = getFeaturedProjects();

  return (
    <div className="flex flex-col min-h-screen">
      {/* 1. Hero Section */}
      <HeroSection />

      {/* 2. Categories Section */}
      <CategorySection />

      {/* 3. Featured Projects Section */}
      <section
        id="featured-projects"
        className="py-16 sm:py-20"
        aria-labelledby="featured-projects-heading"
      >
        <div className="content-container">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-10 pb-4 border-b border-slate-200/80 gap-4">
            <div>
              <span className="inline-block px-3 py-1 mb-2.5 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
                Handpicked Selection
              </span>
              <h2
                id="featured-projects-heading"
                className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl"
              >
                Featured Projects
              </h2>
              <p className="mt-1.5 text-xs text-slate-500 sm:text-sm">
                Our hand-picked selection of quality projects across engineering, computer science, and business.
              </p>
            </div>

            <div className="flex items-center gap-3 self-start sm:self-end shrink-0">
              <span className="text-xs font-medium text-slate-500 hidden md:inline">
                Showing {featuredProjects.length} featured projects
              </span>

              {/* View All Projects - Honest Coming Soon */}
              <button
                type="button"
                disabled
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 bg-slate-100 border border-slate-200 cursor-not-allowed select-none"
                title="Full catalog shop will be available in the next phase"
                aria-label="View all projects (coming soon)"
              >
                <span>View All Projects</span>
                <span className="text-[10px] font-normal text-slate-400">(Coming soon)</span>
              </button>
            </div>
          </div>

          <ProjectGrid projects={featuredProjects} />
        </div>
      </section>

      {/* 4. How It Works Section */}
      <HowItWorksSection />

      {/* 5. Testimonials Section */}
      <TestimonialsSection />

      {/* 6. Call to Action Section */}
      <CtaSection />

      {/* 7. Frequently Asked Questions Section */}
      <FaqSection />
    </div>
  );
};

export default HomePage;
