import React from 'react';
import { PackageSearch } from 'lucide-react';
import { Project } from '../../types/project';
import { ProjectCard } from './ProjectCard';

export interface ProjectGridProps {
  projects: Project[];
  featuredOnly?: boolean;
}

export const ProjectGrid: React.FC<ProjectGridProps> = ({
  projects,
  featuredOnly = false,
}) => {
  const displayProjects = featuredOnly
    ? projects.filter((p) => p.featured)
    : projects;

  // Empty state handling
  if (!displayProjects || displayProjects.length === 0) {
    return (
      <div
        className="text-center py-12 px-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 max-w-md mx-auto"
        role="status"
      >
        <PackageSearch className="mx-auto h-10 w-10 text-slate-300 mb-3" />
        <h3 className="text-sm font-bold text-slate-900">No projects found</h3>
        <p className="mt-1 text-xs text-slate-500">
          There are currently no projects matching this selection.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
      {displayProjects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          featured={project.featured}
        />
      ))}
    </div>
  );
};

export default ProjectGrid;
