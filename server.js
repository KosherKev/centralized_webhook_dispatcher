import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ==============================================
// 🎫 TICKETING SYSTEMS REGISTRY
// ==============================================
const TICKETING_SYSTEMS = [
    {
        name: 'CBS Ticketing',
        baseUrl: 'https://api.cbs.eticketzgh.com/',
        webhookPath: '/api/webhooks/paystack',
        healthCheck: '/health',
        enabled: true
    },
    {
        name: 'MMV Ticketing',
        baseUrl: 'https://api.cuministrymmv.org',
        webhookPath: '/api/webhooks/paystack',
        healthCheck: '/health',
        enabled: true
    }
    // 🚀 Add new systems here easily!
];

// ==============================================
// 📥 MAIN WEBHOOK RECEIVER
// ==============================================
app.post('/webhooks/paystack', async (req, res) => {
    try {
        console.log('🔔 Webhook received from Paystack');
        
        // Verify Paystack signature
        const hash = crypto
            .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            console.log('❌ Invalid Paystack signature');
            return res.status(400).json({ error: 'Invalid signature' });
        }

        const { event, data } = req.body;
        const paymentReference = data?.reference;

        if (!paymentReference) {
            console.log('❌ No payment reference in webhook');
            return res.status(400).json({ error: 'No payment reference' });
        }

        console.log(`🔍 Processing ${event} for reference: ${paymentReference}`);

        // Find which ticketing system has this payment reference
        const targetSystem = await findTargetSystem(paymentReference);

        if (!targetSystem) {
            console.log(`❌ No system found for reference: ${paymentReference}`);
            return res.status(404).json({ 
                error: 'Payment reference not found in any system' 
            });
        }

        // Forward webhook to the target system
        const forwardResult = await forwardWebhook(targetSystem, req.body, req.headers);

        if (forwardResult.success) {
            console.log(`✅ Webhook forwarded successfully to ${targetSystem.name}`);
            res.status(200).json({ 
                success: true,
                forwardedTo: targetSystem.name,
                response: forwardResult.data
            });
        } else {
            console.log(`❌ Failed to forward webhook to ${targetSystem.name}`);
            res.status(500).json({ 
                error: 'Failed to forward webhook',
                details: forwardResult.error
            });
        }

    } catch (error) {
        console.error('❌ Webhook dispatcher error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ==============================================
// 🔍 FIND TARGET SYSTEM
// ==============================================
async function findTargetSystem(paymentReference) {
    console.log(`🔍 Searching for payment reference: ${paymentReference}`);
    
    // Check each system concurrently for faster response
    const searchPromises = TICKETING_SYSTEMS
        .filter(system => system.enabled)
        .map(async (system) => {
            try {
                console.log(`🔍 Checking ${system.name}...`);
                
                // Query the system to see if it has this payment reference
                const response = await axios.get(
                    `${system.baseUrl}/api/tickets/verify/${paymentReference}`,
                    { 
                        timeout: 5000,
                        validateStatus: (status) => status < 500 // Accept 404 as valid response
                    }
                );

                // If found (200) or payment exists but not verified yet (400)
                if (response.status === 200 || 
                    (response.status === 400 && response.data?.data?.ticket)) {
                    console.log(`✅ Found in ${system.name}`);
                    return system;
                }

                return null;
            } catch (error) {
                // System might be down or reference doesn't exist there
                console.log(`⚠️ ${system.name} check failed:`, error.message);
                return null;
            }
        });

    const results = await Promise.all(searchPromises);
    return results.find(system => system !== null);
}

// ==============================================
// 📤 FORWARD WEBHOOK
// ==============================================
async function forwardWebhook(targetSystem, webhookBody, originalHeaders) {
    try {
        const webhookUrl = `${targetSystem.baseUrl}${targetSystem.webhookPath}`;
        
        console.log(`📤 Forwarding webhook to: ${webhookUrl}`);

        const response = await axios.post(webhookUrl, webhookBody, {
            headers: {
                'Content-Type': 'application/json',
                'X-Paystack-Signature': originalHeaders['x-paystack-signature'],
                'User-Agent': 'Paystack-Webhook-Dispatcher/1.0'
            },
            timeout: 30000
        });

        return {
            success: true,
            data: response.data
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            status: error.response?.status
        };
    }
}

// ==============================================
// 🏥 HEALTH CHECK & SYSTEM STATUS
// ==============================================
app.get('/health', async (req, res) => {
    const systemStatuses = await Promise.all(
        TICKETING_SYSTEMS.map(async (system) => {
            try {
                const response = await axios.get(
                    `${system.baseUrl}${system.healthCheck}`,
                    { timeout: 5000 }
                );
                return {
                    name: system.name,
                    status: 'healthy',
                    responseTime: response.headers['x-response-time'] || 'unknown'
                };
            } catch (error) {
                return {
                    name: system.name,
                    status: 'unhealthy',
                    error: error.message
                };
            }
        })
    );

    res.json({
        dispatcher: 'healthy',
        timestamp: new Date().toISOString(),
        systems: systemStatuses
    });
});

// ==============================================
// 📊 ADMIN ENDPOINTS
// ==============================================

// Get all registered systems
app.get('/admin/systems', (req, res) => {
    res.json({
        success: true,
        systems: TICKETING_SYSTEMS.map(system => ({
            name: system.name,
            baseUrl: system.baseUrl,
            enabled: system.enabled
        }))
    });
});

// Add new system (for easy expansion)
app.post('/admin/systems', (req, res) => {
    const { name, baseUrl, webhookPath = '/api/webhooks/paystack', enabled = true } = req.body;
    
    if (!name || !baseUrl) {
        return res.status(400).json({ error: 'Name and baseUrl required' });
    }

    const newSystem = {
        name,
        baseUrl,
        webhookPath,
        healthCheck: '/health',
        enabled
    };

    TICKETING_SYSTEMS.push(newSystem);
    
    res.json({
        success: true,
        message: 'System added successfully',
        system: newSystem
    });
});

// Test webhook forwarding
app.post('/admin/test-webhook/:systemName', async (req, res) => {
    const { systemName } = req.params;
    const system = TICKETING_SYSTEMS.find(s => s.name === systemName);
    
    if (!system) {
        return res.status(404).json({ error: 'System not found' });
    }

    const testWebhook = {
        event: 'charge.success',
        data: {
            reference: 'TEST-' + Date.now(),
            amount: 10000,
            status: 'success'
        }
    };

    const result = await forwardWebhook(system, testWebhook, {
        'x-paystack-signature': 'test-signature'
    });

    res.json(result);
});

// ==============================================
// 🚀 START SERVER
// ==============================================
app.listen(PORT, () => {
    console.log(`🚀 Webhook Dispatcher running on port ${PORT}`);
    console.log(`📥 Paystack webhook URL: http://centralized-webhook-dispatcher.onrender.com/webhooks/paystack`);
    console.log(`🎫 Managing ${TICKETING_SYSTEMS.length} ticketing systems`);
});

export default app;