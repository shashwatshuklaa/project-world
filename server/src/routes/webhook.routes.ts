import { Router } from 'express';
import { handleRazorpayWebhook } from '../controllers/webhook.controller.js';

const router = Router();

/**
 * POST /api/webhooks/razorpay
 * Receives and processes Razorpay payment lifecycle webhook notifications.
 * Validates HMAC SHA-256 signature against exact raw HTTP request body.
 */
router.post('/razorpay', handleRazorpayWebhook);

export default router;
