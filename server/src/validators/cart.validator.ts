import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

/**
 * Validation schema for adding an item to the shopping cart.
 * Rejects unexpected client fields (price, total, user, etc.) with strict mode.
 */
export const addItemSchema = z
  .object({
    projectId: z
      .string()
      .trim()
      .min(1, 'Project identifier cannot be empty')
      .max(100, 'Project identifier cannot exceed 100 characters')
      .refine((val) => !/[${}]/.test(val), {
        message: 'Project identifier contains invalid characters',
      }),
    quantity: z
      .number()
      .int('Quantity must be an integer')
      .min(1, 'Quantity must be at least 1')
      .max(10, 'Quantity cannot exceed 10')
      .optional()
      .default(1),
    customization: z
      .string()
      .trim()
      .max(500, 'Customization notes cannot exceed 500 characters')
      .optional(),
  })
  .strict();

/**
 * Validation schema for updating a cart item's quantity or customization notes.
 * Requires at least one field and strictly disallows client-injected fields.
 */
export const updateItemSchema = z
  .object({
    quantity: z
      .number()
      .int('Quantity must be an integer')
      .min(1, 'Quantity must be at least 1')
      .max(10, 'Quantity cannot exceed 10')
      .optional(),
    customization: z
      .string()
      .trim()
      .max(500, 'Customization notes cannot exceed 500 characters')
      .optional(),
  })
  .strict()
  .refine(
    (data) => data.quantity !== undefined || data.customization !== undefined,
    {
      message: 'At least one of quantity or customization must be provided for update',
    }
  );

/**
 * Validation schema for URL parameter :itemId.
 */
export const cartItemIdParamSchema = z
  .object({
    itemId: z
      .string()
      .trim()
      .min(1, 'Cart item identifier cannot be empty')
      .max(100, 'Cart item identifier cannot exceed 100 characters')
      .refine((val) => !/[${}]/.test(val), {
        message: 'Cart item identifier contains invalid characters',
      }),
  })
  .strict();

export type AddItemInput = z.infer<typeof addItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type CartItemIdParamInput = z.infer<typeof cartItemIdParamSchema>;

/**
 * Express middleware to validate request body using a Zod schema.
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync(req.body);
      req.body = parsed;
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
      res.status(400).json({ success: false, message: 'Invalid request payload' });
    }
  };
}

/**
 * Express middleware to validate request parameters using a Zod schema.
 */
export function validateParams<T extends z.ZodTypeAny>(schema: T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync(req.params);
      req.params = parsed as unknown as Request['params'];
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
