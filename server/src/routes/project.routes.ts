import { Router } from 'express';
import {
  getProjects,
  getFeaturedProjects,
  getProjectById,
} from '../controllers/project.controller.js';
import {
  validateQuery,
  validateParams,
  projectQuerySchema,
  featuredQuerySchema,
  projectIdParamSchema,
} from '../validators/project.validator.js';

const router = Router();

// 1. GET /api/projects - Paginated list of catalog projects with safe filtering & sorting
router.get('/', validateQuery(projectQuerySchema), getProjects);

// 2. GET /api/projects/featured - Curated featured projects (MUST BE DEFINED BEFORE /:id)
router.get('/featured', validateQuery(featuredQuerySchema), getFeaturedProjects);

// 3. GET /api/projects/:id - Fetch single project by slug or MongoDB ObjectId
router.get('/:id', validateParams(projectIdParamSchema), getProjectById);

export default router;
