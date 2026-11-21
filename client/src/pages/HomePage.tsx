import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, RefreshCw, ArrowRight } from 'lucide-react';
import { Project } from '../types/project';
import { projectService, ProjectApiError } from '../services/project.service';
import { HeroSection } from '../components/home/HeroSection';
import { CategorySection } from '../components/home/CategorySection';
import { ProjectGrid } from '../components/projects/ProjectGrid';
import { HowItWorksSection } from '../components/home/HowItWorksSection';
import { TestimonialsSection } from '../components/home/TestimonialsSection';
import { CtaSection } from '../components/home/CtaSection';
import { FaqSection } from '../components/home/FaqSection';

export const HomePage: React.FC = () => {
  const [featuredProjects, setFeaturedProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch featured projects from the backend API
  const fetchFeaturedProjects = useCallback(async (isMountedCheck?: () => boolean) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await projectService.getFeaturedProjects(12);
      if (!isMountedCheck || isMountedCheck()) {
        setFeaturedProjects(response.data.projects);
      }
    } catch (err) {
      if (!isMountedCheck || isMountedCheck()) {
        const message =
          err instanceof ProjectApiError
            ? err.message
            : 'Failed to load featured projects from the server.';
        setError(message);
      }
    } finally {
      if (!isMountedCheck || isMountedCheck()) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    fetchFeaturedProjects(() => isMounted);

    return () => {
      isMounted = false;
    };
  }, [fetchFeaturedProjects]);

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
              {!isLoading && !error && (
                <span className="text-xs font-medium text-slate-500 hidden md:inline">
                  Showing {featuredProjects.length} featured projects
                </span>
              )}

              {/* View All Projects in Shop */}
              <Link
                to="/shop"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200/80 hover:bg-blue-100 transition-colors"
                aria-label="View all projects in the shop"
              >
                <span>View All Projects</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          {/* Loading Skeleton Grid */}
          {isLoading && (
            <div
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8"
              role="status"
              aria-label="Loading featured projects"
            >
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="rounded-2xl border border-slate-200/80 bg-white overflow-hidden shadow-xs animate-pulse"
                >
                  <div className="aspect-[4/3] bg-slate-200/70 w-full" />
                  <div className="p-5 space-y-3">
                    <div className="flex justify-between items-center">
                      <div className="h-4 bg-slate-200 rounded w-20" />
                      <div className="h-4 bg-slate-200 rounded w-12" />
                    </div>
                    <div className="h-5 bg-slate-200 rounded w-3/4" />
                    <div className="h-3.5 bg-slate-200 rounded w-full" />
                    <div className="h-3.5 bg-slate-200 rounded w-2/3" />
                    <div className="pt-3 border-t border-slate-100 flex justify-between">
                      <div className="h-3.5 bg-slate-200 rounded w-24" />
                      <div className="h-4 bg-slate-200 rounded w-16" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Error State with Retry Button */}
          {!isLoading && error && (
            <div
              className="rounded-2xl border border-red-200/80 bg-red-50/50 p-8 sm:p-10 text-center max-w-lg mx-auto shadow-xs"
              role="alert"
              aria-live="assertive"
            >
              <div className="w-12 h-12 rounded-full bg-red-100 border border-red-200 flex items-center justify-center mx-auto mb-4 text-red-600">
                <AlertCircle className="h-6 w-6" />
              </div>
              <h3 className="text-base font-bold text-slate-900 mb-1.5">
                Unable to load featured projects
              </h3>
              <p className="text-xs text-slate-600 mb-6 leading-relaxed">
                {error}
              </p>
              <button
                type="button"
                onClick={() => fetchFeaturedProjects()}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Retry Loading</span>
              </button>
            </div>
          )}

          {/* Loaded Project Grid (Handles empty state internally) */}
          {!isLoading && !error && (
            <ProjectGrid projects={featuredProjects} />
          )}
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
