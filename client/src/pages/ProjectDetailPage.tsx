import React, { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  Star,
  Download,
  FolderGit2,
  Sparkles,
  CheckCircle2,
  RefreshCw,
  FileQuestion,
  AlertCircle,
  Lock,
  ChevronRight,
  Info,
  Layers,
  BarChart2,
  ShoppingCart,
  Loader2,
} from 'lucide-react';
import { projectService, ProjectApiError } from '../services/project.service';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import { Project, ProjectDifficulty } from '../types/project';
import { ProjectCard } from '../components/projects/ProjectCard';

type TabType = 'overview' | 'specs';

export const ProjectDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated } = useAuth();
  const { addToCart } = useCart();
  const navigate = useNavigate();
  const location = useLocation();

  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [is404, setIs404] = useState<boolean>(false);
  const [imageError, setImageError] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  // Cart action state
  const [isAddingToCart, setIsAddingToCart] = useState<boolean>(false);
  const [cartFeedback, setCartFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Related projects state
  const [relatedProjects, setRelatedProjects] = useState<Project[]>([]);
  const [isLoadingRelated, setIsLoadingRelated] = useState<boolean>(false);

  const handleAddToCart = async () => {
    if (!project) return;

    // Unauthenticated users are redirected to login with current location as return path
    if (!isAuthenticated) {
      navigate('/login', { state: { from: location } });
      return;
    }

    if (isAddingToCart) return;

    setIsAddingToCart(true);
    setCartFeedback(null);

    const projectIdentifier = project.slug || project.id;

    try {
      await addToCart(projectIdentifier, 1);
      setCartFeedback({
        type: 'success',
        message: 'Project added to your shopping cart!',
      });
      // Clear success feedback automatically after 5 seconds
      setTimeout(() => {
        setCartFeedback((prev) => (prev?.type === 'success' ? null : prev));
      }, 5000);
    } catch (err: unknown) {
      setCartFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to add project to cart. Please try again.',
      });
    } finally {
      setIsAddingToCart(false);
    }
  };

  // Difficulty badge styling
  const getDifficultyBadge = (difficulty?: ProjectDifficulty) => {
    switch (difficulty) {
      case 'Beginner':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'Intermediate':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'Advanced':
        return 'bg-purple-50 text-purple-700 border-purple-200';
      default:
        return 'bg-slate-100 text-slate-600 border-slate-200';
    }
  };

  // Fetch project from backend API
  const fetchProjectDetails = useCallback(async () => {
    if (!id) {
      setIs404(true);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    setIs404(false);
    setImageError(false);

    try {
      const response = await projectService.getProjectById(id);
      setProject(response.data.project);
    } catch (err) {
      if (err instanceof ProjectApiError && err.statusCode === 404) {
        setIs404(true);
      } else if (err instanceof ProjectApiError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred while loading this project.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    fetchProjectDetails();
  }, [fetchProjectDetails]);

  // Fetch related category projects once main project is loaded
  useEffect(() => {
    if (!project?.category) {
      setRelatedProjects([]);
      return;
    }

    let isMounted = true;
    setIsLoadingRelated(true);

    projectService
      .getProjects({ category: project.category, limit: 6 })
      .then((res) => {
        if (!isMounted) return;
        const currentIdentifier = project.slug || project.id;
        const filtered = res.data.projects
          .filter((p) => (p.slug || p.id) !== currentIdentifier)
          .slice(0, 3);
        setRelatedProjects(filtered);
      })
      .catch(() => {
        // Non-blocking: fail gracefully if related cannot load
        if (isMounted) setRelatedProjects([]);
      })
      .finally(() => {
        if (isMounted) setIsLoadingRelated(false);
      });

    return () => {
      isMounted = false;
    };
  }, [project?.category, project?.id, project?.slug]);

  // 1. Loading Skeleton State
  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-50/50 py-8 sm:py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Breadcrumb Skeleton */}
          <div className="h-4 w-36 bg-slate-200 animate-pulse rounded mb-8" />

          {/* Main Grid Skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
            {/* Left Column Skeleton */}
            <div className="lg:col-span-7 space-y-6">
              <div className="w-full aspect-[16/10] bg-slate-200 animate-pulse rounded-2xl" />
              <div className="h-24 bg-slate-200 animate-pulse rounded-2xl" />
            </div>

            {/* Right Column Skeleton */}
            <div className="lg:col-span-5 space-y-6">
              <div className="flex gap-2">
                <div className="h-6 w-20 bg-slate-200 animate-pulse rounded-md" />
                <div className="h-6 w-24 bg-slate-200 animate-pulse rounded-md" />
              </div>
              <div className="h-10 w-4/5 bg-slate-200 animate-pulse rounded-lg" />
              <div className="h-6 w-40 bg-slate-200 animate-pulse rounded" />
              <div className="h-12 w-32 bg-slate-200 animate-pulse rounded-lg" />
              <div className="space-y-2">
                <div className="h-4 w-full bg-slate-200 animate-pulse rounded" />
                <div className="h-4 w-5/6 bg-slate-200 animate-pulse rounded" />
                <div className="h-4 w-4/6 bg-slate-200 animate-pulse rounded" />
              </div>
              <div className="h-12 w-full bg-slate-200 animate-pulse rounded-xl" />
            </div>
          </div>
        </div>
      </main>
    );
  }

  // 2. 404 Project Not Found State
  if (is404) {
    return (
      <main className="min-h-[70vh] flex items-center justify-center bg-slate-50/50 py-16 px-4">
        <div className="max-w-md w-full text-center bg-white border border-slate-200/80 rounded-3xl p-8 sm:p-10 shadow-xs">
          <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-5 border border-blue-100">
            <FileQuestion className="h-8 w-8" />
          </div>
          <span className="inline-block text-xs font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md mb-3">
            Error 404
          </span>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight mb-2">
            Project Not Found
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed mb-6">
            We couldn't find a project with the identifier{' '}
            <code className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-800 text-xs">
              {id}
            </code>
            . It may have been archived, renamed, or moved.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/shop"
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-xs"
            >
              Browse Shop Catalog
            </Link>
            <Link
              to="/"
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // 3. Network / Server Error State
  if (error || !project) {
    return (
      <main className="min-h-[70vh] flex items-center justify-center bg-slate-50/50 py-16 px-4">
        <div className="max-w-md w-full text-center bg-white border border-rose-200 rounded-3xl p-8 sm:p-10 shadow-xs">
          <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-5 border border-rose-100">
            <AlertCircle className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight mb-2">
            Unable to Load Project
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed mb-6">
            {error || 'An unexpected error occurred while communicating with the catalog service.'}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={fetchProjectDetails}
              type="button"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-xs"
            >
              <RefreshCw className="h-4 w-4" />
              <span>Try Again</span>
            </button>
            <Link
              to="/shop"
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
            >
              Return to Shop
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // 4. Success State: Render Complete Project Details
  return (
    <main className="min-h-screen bg-slate-50/50 py-8 sm:py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Navigation Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-6">
          <Link
            to="/shop"
            className="inline-flex items-center text-sm font-semibold text-slate-600 hover:text-blue-600 transition-colors group focus:outline-hidden focus:underline"
          >
            <ArrowLeft className="h-4 w-4 mr-1.5 transition-transform group-hover:-translate-x-1" />
            <span>Back to Projects</span>
          </Link>
        </nav>

        {/* Hero Section: Media + Key Details */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start mb-16">
          {/* Left Column: Media Presentation & Verified Database Metrics */}
          <div className="lg:col-span-7 space-y-6">
            {/* Project Image Frame */}
            <div className="relative w-full aspect-[16/10] bg-slate-100 rounded-3xl overflow-hidden border border-slate-200/80 shadow-sm">
              {imageError ? (
                <div
                  className="w-full h-full flex flex-col items-center justify-center text-slate-400 bg-slate-100 p-6 text-center"
                  aria-label="Image placeholder"
                >
                  <FolderGit2 className="h-16 w-16 text-slate-300 mb-3" />
                  <span className="text-sm font-semibold text-slate-500">
                    {project.category} Project
                  </span>
                  <span className="text-xs text-slate-400 mt-1">
                    Visual preview unavailable
                  </span>
                </div>
              ) : (
                <img
                  src={project.image}
                  alt={project.title}
                  onError={() => setImageError(true)}
                  className="w-full h-full object-cover"
                />
              )}

              {/* Featured Badge */}
              {project.featured && (
                <div className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-full bg-blue-600/95 backdrop-blur-xs px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>Featured Project</span>
                </div>
              )}
            </div>

            {/* Verified Catalog Highlights (strictly from database fields) */}
            <div className="grid grid-cols-3 gap-3 p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs text-center">
              <div className="p-2">
                <div className="flex items-center justify-center text-blue-600 mb-1">
                  <Layers className="h-4 w-4" />
                </div>
                <div className="text-[11px] font-semibold text-slate-500">Category</div>
                <div className="text-xs font-bold text-slate-900 mt-0.5 truncate">
                  {project.category}
                </div>
              </div>

              <div className="p-2 border-x border-slate-100">
                <div className="flex items-center justify-center text-emerald-600 mb-1">
                  <BarChart2 className="h-4 w-4" />
                </div>
                <div className="text-[11px] font-semibold text-slate-500">Difficulty</div>
                <div className="text-xs font-bold text-slate-900 mt-0.5">
                  {project.difficulty || 'Beginner'}
                </div>
              </div>

              <div className="p-2">
                <div className="flex items-center justify-center text-amber-500 mb-1">
                  <Star className="h-4 w-4 fill-amber-400" />
                </div>
                <div className="text-[11px] font-semibold text-slate-500">Rating</div>
                <div className="text-xs font-bold text-slate-900 mt-0.5">
                  {project.rating > 0 ? `${project.rating.toFixed(1)} / 5.0` : 'New'}
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Title, Metadata, Price & Purchasing State */}
          <div className="lg:col-span-5 flex flex-col space-y-6">
            {/* Categories & Difficulty Badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to={`/shop?category=${encodeURIComponent(project.category)}`}
                className="text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200/80 hover:bg-blue-100 px-3 py-1 rounded-lg transition-colors"
              >
                {project.category}
              </Link>
              <span className="text-xs font-medium text-slate-600 bg-slate-100 border border-slate-200/80 px-2.5 py-1 rounded-lg">
                {project.subcategory}
              </span>
              {project.difficulty && (
                <span
                  className={`text-xs font-semibold px-2.5 py-1 rounded-lg border ${getDifficultyBadge(
                    project.difficulty
                  )}`}
                >
                  {project.difficulty}
                </span>
              )}
            </div>

            {/* Title */}
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight leading-tight">
              {project.title}
            </h1>

            {/* Rating and Downloads Statistics */}
            <div className="flex items-center gap-4 text-xs font-medium text-slate-500 pb-2 border-b border-slate-200/60">
              {project.rating > 0 ? (
                <div className="flex items-center gap-1.5 text-amber-600">
                  <div className="flex items-center">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star
                        key={i}
                        className={`h-4 w-4 ${
                          i < Math.floor(project.rating)
                            ? 'fill-amber-400 text-amber-400'
                            : 'text-slate-200 fill-slate-200'
                        }`}
                      />
                    ))}
                  </div>
                  <span className="font-bold text-slate-900">
                    {project.rating.toFixed(1)}
                  </span>
                  <span className="text-slate-400">/ 5.0</span>
                </div>
              ) : (
                <span className="text-slate-400">Not yet rated</span>
              )}

              <span className="text-slate-300">•</span>

              <div className="flex items-center gap-1.5 text-slate-600">
                <Download className="h-4 w-4 text-slate-400" />
                <span>{project.downloads.toLocaleString()} downloads</span>
              </div>
            </div>

            {/* Price Card */}
            <div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Catalog Price
                </span>
                <span className="text-xs text-slate-600 font-medium bg-slate-100 px-2.5 py-0.5 rounded-md border border-slate-200/60">
                  INR (₹)
                </span>
              </div>
              <div className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
                ₹{Math.round(project.price).toLocaleString('en-IN')}
              </div>
              <p className="text-xs text-slate-500 mt-1.5">
                Official price listed in the ProjectWorld catalog.
              </p>

              {/* Action Buttons: Add to Cart & Checkout Indicator */}
              <div className="mt-5 space-y-3">
                {/* Primary Add to Cart Action */}
                <button
                  type="button"
                  onClick={handleAddToCart}
                  disabled={isAddingToCart}
                  className="w-full py-3.5 px-6 rounded-xl font-bold text-sm bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-500/20 flex items-center justify-center gap-2 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  {isAddingToCart ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                      <span>Adding to Cart...</span>
                    </>
                  ) : (
                    <>
                      <ShoppingCart className="h-4 w-4 text-white" />
                      <span>Add to Cart</span>
                    </>
                  )}
                </button>

                {/* Direct Checkout Indicator (Disabled) */}
                <button
                  type="button"
                  disabled
                  className="w-full py-3 px-6 rounded-xl font-semibold text-xs bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200/80 flex items-center justify-center gap-2 shadow-none select-none"
                  aria-disabled="true"
                >
                  <Lock className="h-3.5 w-3.5 text-slate-400" />
                  <span>Checkout — Coming Soon</span>
                </button>

                {/* Feedback Notification Banners */}
                {cartFeedback && (
                  <div
                    className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-2.5 transition-all animate-in fade-in duration-200 ${
                      cartFeedback.type === 'success'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : 'bg-red-50 border-red-200 text-red-700'
                    }`}
                    role="alert"
                  >
                    <div className="flex items-center gap-2">
                      {cartFeedback.type === 'success' ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                      )}
                      <span className="font-medium">{cartFeedback.message}</span>
                    </div>

                    {cartFeedback.type === 'success' && (
                      <Link
                        to="/cart"
                        className="text-xs font-bold text-emerald-700 hover:text-emerald-900 underline shrink-0 focus:outline-none"
                      >
                        View Cart &rarr;
                      </Link>
                    )}
                  </div>
                )}

                <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3 text-[11px] text-slate-500 flex items-start gap-2 leading-relaxed">
                  <Info className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />
                  <span>
                    Items added to cart are automatically synchronized with your account in real-time. Direct payments will be enabled in upcoming project phases.
                  </span>
                </div>
              </div>
            </div>

            {/* Description */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                About this Project
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                {project.description}
              </p>
            </div>

            {/* Key Features (strictly from database features array) */}
            {project.features && project.features.length > 0 && (
              <div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
                <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-blue-600" />
                  <span>Key Features Included</span>
                </h3>
                <ul className="space-y-2.5">
                  {project.features.map((feature, idx) => (
                    <li key={idx} className="flex items-start text-xs sm:text-sm text-slate-700">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 mr-2.5 shrink-0 mt-0.5" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* Tabbed In-Depth Information Section (Only confirmed database fields) */}
        <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs p-6 sm:p-8 mb-16">
          {/* Tab Navigation */}
          <div className="flex border-b border-slate-200 space-x-6 sm:space-x-8 mb-6">
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`pb-3 text-sm font-bold transition-colors border-b-2 ${
                activeTab === 'overview'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Catalog Summary
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('specs')}
              className={`pb-3 text-sm font-bold transition-colors border-b-2 ${
                activeTab === 'specs'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Technical Specifications
            </button>
          </div>

          {/* Tab Content: Catalog Summary */}
          {activeTab === 'overview' && (
            <div className="space-y-4 max-w-4xl text-sm text-slate-600 leading-relaxed">
              <h3 className="text-base font-bold text-slate-900">
                Project Overview
              </h3>
              <p>
                {project.description}
              </p>
              {project.features && project.features.length > 0 && (
                <div className="pt-2">
                  <h4 className="font-semibold text-slate-800 mb-2">Verified Feature Checklist:</h4>
                  <ul className="list-disc pl-5 space-y-1.5 text-slate-700">
                    {project.features.map((feature, idx) => (
                      <li key={idx}>{feature}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Tab Content: Specifications (Only strictly confirmed model data) */}
          {activeTab === 'specs' && (
            <div className="max-w-2xl">
              <h3 className="text-base font-bold text-slate-900 mb-4">
                Catalog Specifications
              </h3>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-2xl overflow-hidden text-xs sm:text-sm">
                <div className="grid grid-cols-2 p-3.5 bg-slate-50/70">
                  <span className="font-semibold text-slate-600">Canonical Slug / ID</span>
                  <span className="font-mono text-slate-900">{project.slug || project.id}</span>
                </div>
                <div className="grid grid-cols-2 p-3.5 bg-white">
                  <span className="font-semibold text-slate-600">Category</span>
                  <span className="text-slate-900">{project.category}</span>
                </div>
                <div className="grid grid-cols-2 p-3.5 bg-slate-50/70">
                  <span className="font-semibold text-slate-600">Subcategory</span>
                  <span className="text-slate-900">{project.subcategory}</span>
                </div>
                <div className="grid grid-cols-2 p-3.5 bg-white">
                  <span className="font-semibold text-slate-600">Difficulty Level</span>
                  <span className="text-slate-900">{project.difficulty || 'Beginner'}</span>
                </div>
                <div className="grid grid-cols-2 p-3.5 bg-slate-50/70">
                  <span className="font-semibold text-slate-600">Community Rating</span>
                  <span className="text-slate-900">{project.rating > 0 ? `${project.rating.toFixed(1)} / 5.0` : 'Unrated'}</span>
                </div>
                <div className="grid grid-cols-2 p-3.5 bg-white">
                  <span className="font-semibold text-slate-600">Total Downloads</span>
                  <span className="text-slate-900">{project.downloads.toLocaleString()}</span>
                </div>
                {project.createdAt && (
                  <div className="grid grid-cols-2 p-3.5 bg-slate-50/70">
                    <span className="font-semibold text-slate-600">Catalog Entry Date</span>
                    <span className="text-slate-900">
                      {new Date(project.createdAt).toLocaleDateString('en-IN', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Dynamic Related Projects Section */}
        {(isLoadingRelated || relatedProjects.length > 0) && (
          <section className="pt-8">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                  Related {project.category} Projects
                </h2>
                <p className="text-xs sm:text-sm text-slate-500 mt-1">
                  Explore other vetted projects in {project.category}.
                </p>
              </div>
              <Link
                to={`/shop?category=${encodeURIComponent(project.category)}`}
                className="inline-flex items-center text-xs sm:text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors"
              >
                <span>View All</span>
                <ChevronRight className="h-4 w-4 ml-0.5" />
              </Link>
            </div>

            {isLoadingRelated ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
                {Array.from({ length: 3 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="h-80 rounded-2xl bg-slate-200/70 animate-pulse"
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
                {relatedProjects.map((relProject) => (
                  <ProjectCard key={relProject.id} project={relProject} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
};

export default ProjectDetailPage;
