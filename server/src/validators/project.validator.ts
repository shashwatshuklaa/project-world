import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

export const projectQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .default('1')
    .refine((val) => /^\d+$/.test(val) && parseInt(val, 10) > 0, {
      message: 'Page must be a positive integer greater than 0',
    })
    .transform((val) => parseInt(val, 10)),
  limit: z
    .string()
    .optional()
    .default('12')
    .refine((val) => /^\d+$/.test(val) && parseInt(val, 10) > 0 && parseInt(val, 10) <= 50, {
      message: 'Limit must be a positive integer between 1 and 50',
    })
    .transform((val) => parseInt(val, 10)),
  search: z
    .string()
    .trim()
    .max(100, 'Search keyword cannot exceed 100 characters')
    .optional(),
  category: z
    .string()
    .trim()
    .max(100, 'Category cannot exceed 100 characters')
    .optional(),
  subcategory: z
    .string()
    .trim()
    .max(100, 'Subcategory cannot exceed 100 characters')
    .optional(),
  difficulty: z
    .enum(['Beginner', 'Intermediate', 'Advanced'], {
      message: 'Difficulty must be Beginner, Intermediate, or Advanced',
    })
    .optional(),
  featured: z
    .string()
    .optional()
    .refine((val) => val === undefined || val === 'true' || val === 'false', {
      message: 'Featured must be true or false',
    })
    .transform((val) => (val === undefined ? undefined : val === 'true')),
  sort: z
    .enum(['newest', 'price_asc', 'price_desc', 'rating', 'downloads'], {
      message: 'Sort must be one of: newest, price_asc, price_desc, rating, downloads',
    })
    .optional()
    .default('newest'),
});

export const featuredQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .default('12')
    .refine((val) => /^\d+$/.test(val) && parseInt(val, 10) > 0 && parseInt(val, 10) <= 50, {
      message: 'Limit must be a positive integer between 1 and 50',
    })
    .transform((val) => parseInt(val, 10)),
});

export const projectIdParamSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'Project identifier is required')
    .max(100, 'Project identifier cannot exceed 100 characters')
    .refine((val) => !/[${}]/.test(val), {
      message: 'Project identifier contains invalid characters',
    }),
});

export type ProjectQueryInput = z.infer<typeof projectQuerySchema>;
export type FeaturedQueryInput = z.infer<typeof featuredQuerySchema>;
export type ProjectIdParamInput = z.infer<typeof projectIdParamSchema>;

/**
 * Express middleware to validate req.query using a Zod schema.
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync(req.query);
      req.query = parsed as any;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = (error.issues || []).map((issue: z.ZodIssue) => ({
          field: Array.isArray(issue.path) ? issue.path.join('.') : '',
          message: issue.message,
        }));
        res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: issues,
        });
        return;
      }
      res.status(400).json({ success: false, message: 'Invalid query parameters' });
    }
  };
}

/**
 * Express middleware to validate req.params using a Zod schema.
 */
export function validateParams<T extends z.ZodTypeAny>(schema: T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync(req.params);
      req.params = parsed as any;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = (error.issues || []).map((issue: z.ZodIssue) => ({
          field: Array.isArray(issue.path) ? issue.path.join('.') : '',
          message: issue.message,
        }));
        res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: issues,
        });
        return;
      }
      res.status(400).json({ success: false, message: 'Invalid URL parameters' });
    }
  };
}
