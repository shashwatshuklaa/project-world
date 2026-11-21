import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Download, FolderGit2, Sparkles, ArrowRight } from 'lucide-react';
import { Project, ProjectDifficulty } from '../../types/project';

export interface ProjectCardProps {
  project: Project;
  featured?: boolean;
}

export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  featured = false,
}) => {
  const [imageError, setImageError] = useState(false);

  // Helper for difficulty badge styling
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

  const isFeatured = featured || project.featured;
  const projectIdentifier = project.slug || project.id;
  const detailUrl = `/projects/${encodeURIComponent(projectIdentifier)}`;

  return (
    <article
      className="group flex flex-col h-full rounded-2xl border border-slate-200/80 bg-white overflow-hidden shadow-xs hover:shadow-lg hover:-translate-y-1 transition-all duration-300"
      aria-label={project.title}
    >
      {/* Media Container with Navigation Link */}
      <Link
        to={detailUrl}
        className="relative w-full aspect-[4/3] bg-slate-100 overflow-hidden block focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-inset"
        aria-label={`View ${project.title} details`}
      >
        {imageError ? (
          <div
            className="w-full h-full flex flex-col items-center justify-center text-slate-400 bg-slate-100 p-4 text-center"
            aria-label="Image placeholder"
          >
            <FolderGit2 className="h-10 w-10 text-slate-300 mb-2" />
            <span className="text-xs font-medium text-slate-400">
              {project.category} Project
            </span>
          </div>
        ) : (
          <img
            src={project.image}
            alt={project.title}
            loading="lazy"
            onError={() => setImageError(true)}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        )}

        {/* Featured Badge */}
        {isFeatured && (
          <div className="absolute top-3 left-3 inline-flex items-center gap-1 rounded-full bg-blue-600/95 backdrop-blur-xs px-2.5 py-1 text-[11px] font-semibold text-white shadow-xs">
            <Sparkles className="h-3 w-3" />
            <span>Featured</span>
          </div>
        )}

        {/* Price Tag in INR */}
        <div className="absolute top-3 right-3 rounded-lg bg-white/95 backdrop-blur-xs px-2.5 py-1 text-xs font-bold text-slate-900 border border-slate-200/60 shadow-xs">
          ₹{Math.round(project.price).toLocaleString('en-IN')}
        </div>
      </Link>

      {/* Content Body */}
      <div className="p-5 flex flex-col flex-1">
        {/* Category & Rating Row */}
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-block text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200/60 px-2 py-0.5 rounded-md">
              {project.category}
            </span>
            <span className="text-[11px] text-slate-500 font-medium">
              • {project.subcategory}
            </span>
          </div>

          {project.rating > 0 && (
            <div
              className="flex items-center text-amber-500 text-xs font-semibold shrink-0"
              title={`Rated ${project.rating} out of 5 stars`}
              aria-label={`Rated ${project.rating} out of 5 stars`}
            >
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400 mr-1" />
              <span>{project.rating.toFixed(1)}</span>
            </div>
          )}
        </div>

        {/* Title */}
        <h3
          className="text-base font-bold text-slate-900 tracking-tight group-hover:text-blue-600 transition-colors line-clamp-1 mb-2"
          title={project.title}
        >
          <Link
            to={detailUrl}
            className="focus:outline-hidden focus:underline"
          >
            {project.title}
          </Link>
        </h3>

        {/* Description */}
        <p className="text-xs text-slate-600 leading-relaxed line-clamp-2 mb-4 flex-grow">
          {project.description}
        </p>

        {/* Metadata Footer: Downloads & Difficulty */}
        <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 mt-auto">
          <div
            className="flex items-center gap-1 text-slate-500"
            title={`${project.downloads.toLocaleString()} downloads`}
          >
            <Download className="h-3.5 w-3.5 text-slate-400" />
            <span>{project.downloads.toLocaleString()} downloads</span>
          </div>

          {project.difficulty && (
            <span
              className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${getDifficultyBadge(
                project.difficulty
              )}`}
            >
              {project.difficulty}
            </span>
          )}
        </div>

        {/* View Details Action Button */}
        <div className="mt-3 pt-3 border-t border-slate-100">
          <Link
            to={detailUrl}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold text-slate-700 bg-slate-50 hover:bg-blue-50 hover:text-blue-700 border border-slate-200/60 transition-all focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          >
            <span>View Details</span>
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </article>
  );
};

export default ProjectCard;
