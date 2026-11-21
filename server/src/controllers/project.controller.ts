import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Project, IProject } from '../models/Project.js';
import {
  ProjectQueryInput,
  FeaturedQueryInput,
  ProjectIdParamInput,
} from '../validators/project.validator.js';

/**
 * Format a Mongoose project document into a sanitized, predictable API object.
 */
export function formatProject(doc: Partial<IProject> & { _id?: mongoose.Types.ObjectId | string }) {
  return {
    id: doc.slug || doc._id?.toString(),
    slug: doc.slug,
    _id: doc._id?.toString(),
    title: doc.title,
    description: doc.description,
    features: doc.features || [],
    category: doc.category,
    subcategory: doc.subcategory,
    price: doc.price,
    image: doc.image,
    rating: doc.rating ?? 0,
    downloads: doc.downloads ?? 0,
    featured: Boolean(doc.featured),
    difficulty: doc.difficulty || 'Beginner',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * GET /api/projects
 * Paginated list of catalog projects with safe filtering and sorting.
 */
export async function getProjects(req: Request, res: Response): Promise<void> {
  try {
    const {
      page,
      limit,
      search,
      category,
      subcategory,
      difficulty,
      featured,
      sort,
    } = req.query as unknown as ProjectQueryInput;

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 12;
    const skip = (pageNum - 1) * limitNum;

    // Safely construct MongoDB filter without accepting user-crafted objects
    const filter: Record<string, unknown> = {};

    if (category) {
      filter.category = category;
    }

    if (subcategory) {
      filter.subcategory = subcategory;
    }

    if (difficulty) {
      filter.difficulty = difficulty;
    }

    if (typeof featured === 'boolean') {
      filter.featured = featured;
    }

    if (search) {
      // Escape regex special characters to prevent ReDoS / syntax injection
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escapedSearch, 'i');
      filter.$or = [
        { title: { $regex: searchRegex } },
        { description: { $regex: searchRegex } },
        { category: { $regex: searchRegex } },
        { subcategory: { $regex: searchRegex } },
      ];
    }

    // Mapping sort keys to deterministic Mongoose sort specifications
    const sortMap: Record<string, Record<string, 1 | -1>> = {
      newest: { createdAt: -1 },
      price_asc: { price: 1, createdAt: -1 },
      price_desc: { price: -1, createdAt: -1 },
      rating: { rating: -1, downloads: -1, createdAt: -1 },
      downloads: { downloads: -1, rating: -1, createdAt: -1 },
    };

    const sortOptions = sortMap[sort] || sortMap.newest;

    // Execute query and count concurrently
    const [projects, total] = await Promise.all([
      Project.find(filter)
        .sort(sortOptions)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Project.countDocuments(filter),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1 && totalPages > 0;

    res.status(200).json({
      success: true,
      data: {
        projects: projects.map(formatProject),
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages,
          hasNextPage,
          hasPrevPage,
        },
      },
    });
  } catch (error) {
    console.error('[Project Controller] Error in getProjects:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve projects. Please try again later.',
    });
  }
}

/**
 * GET /api/projects/featured
 * Returns featured projects with validated limit and clean sorting.
 */
export async function getFeaturedProjects(req: Request, res: Response): Promise<void> {
  try {
    const { limit } = req.query as unknown as FeaturedQueryInput;
    const limitNum = Number(limit) || 12;

    const projects = await Project.find({ featured: true })
      .sort({ rating: -1, downloads: -1, createdAt: -1 })
      .limit(limitNum)
      .lean();

    res.status(200).json({
      success: true,
      data: {
        projects: projects.map(formatProject),
      },
    });
  } catch (error) {
    console.error('[Project Controller] Error in getFeaturedProjects:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve featured projects. Please try again later.',
    });
  }
}

/**
 * GET /api/projects/:id
 * Fetches a single project by slug or MongoDB ObjectId.
 */
export async function getProjectById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as ProjectIdParamInput;

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ slug: id }, { _id: id }] }
      : { slug: id };

    const project = await Project.findOne(query).lean();

    if (!project) {
      res.status(404).json({
        success: false,
        message: `Project not found with identifier: ${id}`,
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        project: formatProject(project),
      },
    });
  } catch (error) {
    console.error('[Project Controller] Error in getProjectById:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve project. Please try again later.',
    });
  }
}
