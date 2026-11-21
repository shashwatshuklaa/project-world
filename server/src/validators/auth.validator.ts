import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

export const registerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Name must be at least 2 characters long')
      .max(100, 'Name cannot exceed 100 characters'),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('Please provide a valid email address'),
    password: z
      .string()
      .min(6, 'Password must be at least 6 characters long')
      .max(128, 'Password cannot exceed 128 characters'),
  })
  .strict(); // Rejects unallowed properties like 'role'

export const loginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('Please provide a valid email address'),
    password: z
      .string()
      .min(1, 'Password is required'),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync(req.body);
      req.body = parsed;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = (error.issues || []).map((issue: any) => ({
          field: Array.isArray(issue.path) ? issue.path.join('.') : '',
          message: issue.message,
        }));
        res.status(400).json({
          message: 'Validation failed',
          errors: issues,
        });
        return;
      }
      res.status(400).json({ message: 'Invalid request payload' });
    }
  };
}
