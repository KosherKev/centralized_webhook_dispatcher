import express from 'express';
import { handlePaystackWebhook, testWebhook } from '../controllers/webhookController.js';

const router = express.Router();

// Paystack webhook endpoint - no authentication required (Paystack calls this)
router.post('/paystack', handlePaystackWebhook);

// Test webhook endpoint (development only)
if (process.env.NODE_ENV !== 'production') {
    router.post('/test', testWebhook);
}

export default router;