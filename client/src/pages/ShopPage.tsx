import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search,
  SlidersHorizontal,
  X,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  RefreshCw,
  Sparkles,
  PackageSearch,
} from 'lucide-react';
import {
  Project,
  PaginationMetadata,
  ProjectDifficulty,
} from '../types/project';
import { categories } from '../data/projects';
import { projectService, ProjectApiError } from '../services/project.service';
import { ProjectCard } from '../components/projects/ProjectCard';

type SortOption = 'newest' | 'price_asc' | 'price_desc' | 'rating' | 'downloads';

export const ShopPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Initialize state from URL search params
  const initialCategory = searchParams.get('category') || '';
  const initialSubcategory = searchParams.get('subcategory') || '';
  const initialSearch = searchParams.get('search') || '';
  const initialDifficulty = (searchParams.get('difficulty') as ProjectDifficulty) || '';
  const initialFeatured = searchParams.get('featured') === 'true';
  const initialSort = (searchParams.get('sort') as SortOption) || 'newest';
  const initialPage = parseInt(searchParams.get('page') || '1', 10);

  // Filter & Search states
  const [searchInput, setSearchInput] = useState<string>(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState<string>(initialSearch);
  const [selectedCategory, setSelectedCategory] = useState<string>(initialCategory);
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>(initialSubcategory);
  const [selectedDifficulty, setSelectedDifficulty] = useState<ProjectDifficulty | ''>(initialDifficulty);
  const [featuredOnly, setFeaturedOnly] = useState<boolean>(initialFeatured);
  const [sortBy, setSortBy] = useState<SortOption>(initialSort);
  const [currentPage, setCurrentPage] = useState<number>(initialPage > 0 ? initialPage : 1);

  // Mobile filters drawer open state
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState<boolean>(false);

  // Stale request guard ref
  const activeRequestRef = useRef<number>(0);

  // Data states
  const [projects, setProjects] = useState<Project[]>([]);
  const [pagination, setPagination] = useState<PaginationMetadata | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce search input by 350ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 350);

    return () => clearTimeout(timer);
  }, [searchInput]);

  // Available subcategories based on current category
  const availableSubcategories = useMemo(() => {
    if (!selectedCategory) return [];
    const found = categories.find(
      (c) => c.name.toLowerCase() === selectedCategory.toLowerCase()
    );
    return found ? found.subcategories : [];
  }, [selectedCategory]);

  // Sync state back to URL query parameters
  useEffect(() => {
    const params = new URLSearchParams();

    if (debouncedSearch) params.set('search', debouncedSearch);
    if (selectedCategory) params.set('category', selectedCategory);
    if (selectedSubcategory) params.set('subcategory', selectedSubcategory);
    if (selectedDifficulty) params.set('difficulty', selectedDifficulty);
    if (featuredOnly) params.set('featured', 'true');
    if (sortBy && sortBy !== 'newest') params.set('sort', sortBy);
    if (currentPage > 1) params.set('page', String(currentPage));

    setSearchParams(params, { replace: true });
  }, [
    debouncedSearch,
    selectedCategory,
    selectedSubcategory,
    selectedDifficulty,
    featuredOnly,
    sortBy,
    currentPage,
    setSearchParams,
  ]);

  // Fetch projects from the backend API
  const fetchProjects = useCallback(async (isMountedCheck?: () => boolean) => {
    const requestId = ++activeRequestRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const response = await projectService.getProjects({
        page: currentPage,
        limit: 12,
        search: debouncedSearch || undefined,
        category: selectedCategory || undefined,
        subcategory: selectedSubcategory || undefined,
        difficulty: selectedDifficulty || undefined,
        featured: featuredOnly ? true : undefined,
        sort: sortBy,
      });

      if ((!isMountedCheck || isMountedCheck()) && requestId === activeRequestRef.current) {
        setProjects(response.data.projects);
        setPagination(response.data.pagination);
      }
    } catch (err) {
      if ((!isMountedCheck || isMountedCheck()) && requestId === activeRequestRef.current) {
        const message =
          err instanceof ProjectApiError
            ? err.message
            : 'Failed to load projects from the server.';
        setError(message);
      }
    } finally {
      if ((!isMountedCheck || isMountedCheck()) && requestId === activeRequestRef.current) {
        setIsLoading(false);
      }
    }
  }, [
    currentPage,
    debouncedSearch,
    selectedCategory,
    selectedSubcategory,
    selectedDifficulty,
    featuredOnly,
    sortBy,
  ]);

  useEffect(() => {
    let isMounted = true;
    fetchProjects(() => isMounted);

    return () => {
      isMounted = false;
    };
  }, [fetchProjects]);

  // Reset page to 1 when filters or search change
  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category);
    setSelectedSubcategory('');
    setCurrentPage(1);
  };

  const handleSubcategoryChange = (subcategory: string) => {
    setSelectedSubcategory(subcategory);
    setCurrentPage(1);
  };

  const handleDifficultyChange = (difficulty: ProjectDifficulty | '') => {
    setSelectedDifficulty(difficulty);
    setCurrentPage(1);
  };

  const handleFeaturedToggle = () => {
    setFeaturedOnly((prev) => !prev);
    setCurrentPage(1);
  };

  const handleSortChange = (newSort: SortOption) => {
    setSortBy(newSort);
    setCurrentPage(1);
  };

  const handleClearFilters = () => {
    setSearchInput('');
    setDebouncedSearch('');
    setSelectedCategory('');
    setSelectedSubcategory('');
    setSelectedDifficulty('');
    setFeaturedOnly(false);
    setSortBy('newest');
    setCurrentPage(1);
  };

  const hasActiveFilters = Boolean(
    debouncedSearch ||
      selectedCategory ||
      selectedSubcategory ||
      selectedDifficulty ||
      featuredOnly ||
      sortBy !== 'newest'
  );

  return (
    <div className="py-8 sm:py-12 bg-slate-50/50 min-h-screen">
      <div className="content-container">
        {/* Page Header */}
        <div className="mb-8">
          <span className="inline-block px-3 py-1 mb-2.5 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
            Marketplace Catalog
          </span>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            Browse Projects
          </h1>
          <p className="mt-2 text-sm sm:text-base text-slate-600 max-w-2xl">
            Explore verified engineering prototypes, full-stack software applications,
            and business research kits.
          </p>
        </div>

        {/* Layout: Sidebar Filters + Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* ================= DESKTOP & MOBILE SIDEBAR ================= */}
          <aside className="lg:col-span-1">
            {/* Mobile Filter Toggle Button */}
            <div className="lg:hidden mb-4">
              <button
                type="button"
                onClick={() => setIsMobileFiltersOpen((prev) => !prev)}
                className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white border border-slate-200 text-sm font-semibold text-slate-800 shadow-2xs hover:bg-slate-50 transition-colors"
                aria-expanded={isMobileFiltersOpen}
                aria-label="Toggle filters drawer"
              >
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-blue-600" />
                  <span>Filters & Categories</span>
                </div>
                {hasActiveFilters && (
                  <span className="text-[11px] font-semibold bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                    Active
                  </span>
                )}
              </button>
            </div>

            {/* Filter Controls Panel */}
            <div
              className={`space-y-6 bg-white p-6 rounded-2xl border border-slate-200/80 shadow-2xs ${
                isMobileFiltersOpen ? 'block' : 'hidden lg:block'
              }`}
            >
              {/* Filter Header with Reset */}
              <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-blue-600" />
                  <span>Filter Projects</span>
                </h2>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={handleClearFilters}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    Reset All
                  </button>
                )}
              </div>

              {/* 1. Category Filter */}
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2.5">
                  Category
                </label>
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => handleCategoryChange('')}
                    className={`w-full text-left px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                      !selectedCategory
                        ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    All Categories
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat.name}
                      type="button"
                      onClick={() => handleCategoryChange(cat.name)}
                      className={`w-full text-left px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                        selectedCategory.toLowerCase() === cat.name.toLowerCase()
                          ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. Subcategory Filter (Conditional) */}
              {selectedCategory && availableSubcategories.length > 0 && (
                <div className="pt-4 border-t border-slate-100">
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2.5">
                    Subcategory
                  </label>
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => handleSubcategoryChange('')}
                      className={`w-full text-left px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        !selectedSubcategory
                          ? 'bg-slate-100 text-slate-900 font-semibold'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      All Tracks
                    </button>
                    {availableSubcategories.map((sub) => (
                      <button
                        key={sub}
                        type="button"
                        onClick={() => handleSubcategoryChange(sub)}
                        className={`w-full text-left px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          selectedSubcategory.toLowerCase() === sub.toLowerCase()
                            ? 'bg-blue-50 text-blue-700 font-semibold'
                            : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {sub}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 3. Difficulty Filter */}
              <div className="pt-4 border-t border-slate-100">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2.5">
                  Difficulty Level
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  {(['', 'Beginner', 'Intermediate', 'Advanced'] as const).map(
                    (level) => (
                      <button
                        key={level || 'all'}
                        type="button"
                        onClick={() => handleDifficultyChange(level)}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium text-center border transition-colors ${
                          selectedDifficulty === level
                            ? 'bg-blue-50 text-blue-700 border-blue-300 font-semibold'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {level || 'All'}
                      </button>
                    )
                  )}
                </div>
              </div>

              {/* 4. Featured Only Toggle */}
              <div className="pt-4 border-t border-slate-100">
                <label
                  className="flex items-center justify-between cursor-pointer group"
                  htmlFor="featured-toggle"
                >
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-amber-500" />
                    <span className="text-xs font-semibold text-slate-700">
                      Featured Only
                    </span>
                  </div>
                  <input
                    id="featured-toggle"
                    type="checkbox"
                    checked={featuredOnly}
                    onChange={handleFeaturedToggle}
                    className="h-4 w-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer"
                  />
                </label>
              </div>
            </div>
          </aside>

          {/* ================= MAIN CATALOG CONTENT ================= */}
          <main className="lg:col-span-3">
            {/* Search and Sort Toolbar */}
            <div className="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200/80 shadow-2xs mb-6 space-y-4">
              <div className="flex flex-col sm:flex-row gap-3">
                {/* Search Input */}
                <div className="relative flex-1">
                  <Search
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search by title, description, or keyword..."
                    aria-label="Search projects by keyword"
                    className="w-full pl-10 pr-9 py-2.5 rounded-xl border border-slate-200 text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  />
                  {searchInput && (
                    <button
                      type="button"
                      onClick={() => setSearchInput('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-600"
                      aria-label="Clear search text"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Sort Selector */}
                <div className="flex items-center gap-2 shrink-0">
                  <label htmlFor="sort-by" className="text-xs font-semibold text-slate-600 shrink-0">
                    Sort by:
                  </label>
                  <select
                    id="sort-by"
                    value={sortBy}
                    onChange={(e) => handleSortChange(e.target.value as SortOption)}
                    className="px-3 py-2.5 rounded-xl border border-slate-200 text-xs font-medium text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                    aria-label="Sort projects"
                  >
                    <option value="newest">Newest First</option>
                    <option value="price_asc">Price: Low to High</option>
                    <option value="price_desc">Price: High to Low</option>
                    <option value="rating">Highest Rated</option>
                    <option value="downloads">Most Downloaded</option>
                  </select>
                </div>
              </div>

              {/* Active Filter Pills Bar */}
              {hasActiveFilters && (
                <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-100 text-xs">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mr-1">
                    Active:
                  </span>

                  {debouncedSearch && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-medium">
                      <span>Search: &ldquo;{debouncedSearch}&rdquo;</span>
                      <button
                        type="button"
                        onClick={() => setSearchInput('')}
                        aria-label="Remove search filter"
                        className="hover:text-slate-900"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}

                  {selectedCategory && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 font-medium border border-blue-200/60">
                      <span>{selectedCategory}</span>
                      <button
                        type="button"
                        onClick={() => handleCategoryChange('')}
                        aria-label="Remove category filter"
                        className="hover:text-blue-900"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}

                  {selectedSubcategory && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 font-medium border border-blue-200/60">
                      <span>{selectedSubcategory}</span>
                      <button
                        type="button"
                        onClick={() => handleSubcategoryChange('')}
                        aria-label="Remove subcategory filter"
                        className="hover:text-blue-900"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}

                  {selectedDifficulty && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-medium">
                      <span>{selectedDifficulty}</span>
                      <button
                        type="button"
                        onClick={() => handleDifficultyChange('')}
                        aria-label="Remove difficulty filter"
                        className="hover:text-slate-900"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}

                  {featuredOnly && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 font-medium border border-amber-200/60">
                      <Sparkles className="h-3 w-3" />
                      <span>Featured</span>
                      <button
                        type="button"
                        onClick={handleFeaturedToggle}
                        aria-label="Remove featured filter"
                        className="hover:text-amber-900"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={handleClearFilters}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-800 ml-auto"
                  >
                    Clear All
                  </button>
                </div>
              )}
            </div>

            {/* Results Header Count */}
            {!isLoading && !error && pagination && (
              <div className="flex items-center justify-between mb-6 text-xs text-slate-500 font-medium">
                <span>
                  Showing{' '}
                  <span className="font-bold text-slate-800">
                    {pagination.total === 0
                      ? 0
                      : (pagination.page - 1) * pagination.limit + 1}
                  </span>{' '}
                  to{' '}
                  <span className="font-bold text-slate-800">
                    {Math.min(pagination.page * pagination.limit, pagination.total)}
                  </span>{' '}
                  of{' '}
                  <span className="font-bold text-slate-800">{pagination.total}</span>{' '}
                  projects
                </span>

                <span className="hidden sm:inline">
                  Page {pagination.page} of {pagination.totalPages || 1}
                </span>
              </div>
            )}

            {/* ================= STATE RENDERERS ================= */}

            {/* 1. Loading Skeleton Grid */}
            {isLoading && (
              <div
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8"
                role="status"
                aria-label="Loading projects"
              >
                {Array.from({ length: 6 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="rounded-2xl border border-slate-200/80 bg-white overflow-hidden shadow-2xs animate-pulse"
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

            {/* 2. Error State */}
            {!isLoading && error && (
              <div
                className="rounded-2xl border border-red-200/80 bg-red-50/50 p-8 sm:p-12 text-center max-w-lg mx-auto shadow-2xs"
                role="alert"
                aria-live="assertive"
              >
                <div className="w-12 h-12 rounded-full bg-red-100 border border-red-200 flex items-center justify-center mx-auto mb-4 text-red-600">
                  <AlertCircle className="h-6 w-6" />
                </div>
                <h3 className="text-base font-bold text-slate-900 mb-1.5">
                  Unable to load projects
                </h3>
                <p className="text-xs text-slate-600 mb-6 leading-relaxed">
                  {error}
                </p>
                <button
                  type="button"
                  onClick={() => fetchProjects()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Retry Request</span>
                </button>
              </div>
            )}

            {/* 3. Empty State (Zero Results) */}
            {!isLoading && !error && projects.length === 0 && (
              <div
                className="text-center py-16 px-6 rounded-2xl border border-dashed border-slate-200 bg-white max-w-md mx-auto"
                role="status"
              >
                <PackageSearch className="mx-auto h-12 w-12 text-slate-300 mb-3" />
                <h3 className="text-base font-bold text-slate-900 mb-1">
                  No projects found
                </h3>
                <p className="text-xs text-slate-500 mb-6 leading-relaxed">
                  No projects match your current search and filter combination.
                </p>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={handleClearFilters}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200/60 rounded-xl transition-colors"
                  >
                    <span>Clear All Filters</span>
                  </button>
                )}
              </div>
            )}

            {/* 4. Loaded Projects Grid */}
            {!isLoading && !error && projects.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
                {projects.map((project) => (
                  <ProjectCard
                    key={project.id || project.slug}
                    project={project}
                    featured={project.featured}
                  />
                ))}
              </div>
            )}

            {/* ================= PAGINATION BAR ================= */}
            {!isLoading && !error && pagination && pagination.totalPages > 1 && (
              <nav
                className="mt-10 flex items-center justify-between border-t border-slate-200/80 pt-6"
                aria-label="Catalog pagination navigation"
              >
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
                  disabled={!pagination.hasPrevPage}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
                    pagination.hasPrevPage
                      ? 'text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 shadow-2xs'
                      : 'text-slate-300 bg-slate-100 border border-slate-100 cursor-not-allowed select-none'
                  }`}
                  aria-label="Go to previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span>Previous</span>
                </button>

                <div className="text-xs font-medium text-slate-600">
                  Page <span className="font-bold text-slate-900">{pagination.page}</span>{' '}
                  of{' '}
                  <span className="font-bold text-slate-900">
                    {pagination.totalPages}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    setCurrentPage((p) => Math.min(p + 1, pagination.totalPages))
                  }
                  disabled={!pagination.hasNextPage}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
                    pagination.hasNextPage
                      ? 'text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 shadow-2xs'
                      : 'text-slate-300 bg-slate-100 border border-slate-100 cursor-not-allowed select-none'
                  }`}
                  aria-label="Go to next page"
                >
                  <span>Next</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </nav>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};

export default ShopPage;
