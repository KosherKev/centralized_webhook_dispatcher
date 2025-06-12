import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import morgan from 'morgan';
import logger from './logger.js'; // Custom logger module
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Request ID middleware for tracking
app.use((req, res, next) => {
    req.id = uuidv4().substring(0, 8);
    res.setHeader('X-Request-ID', req.id);
    next();
});

app.use(cors());

// Enhanced Morgan logging
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" :response-time ms', {
    stream: {
        write: (message) => logger.info('HTTP Request', { 
            type: 'http_request',
            message: message.trim()
        })
    }
}));

app.use(express.json());

// ==============================================
// 🎫 TICKETING SYSTEMS REGISTRY WITH LOGGING
// ==============================================
const TICKETING_SYSTEMS = [
    {
        id: 'cbs-ticketing',
        name: 'CBS Ticketing',
        baseUrl: process.env.CBS_BASE_URL || 'https://cbs-ticketing.com',
        webhookPath: '/api/webhooks/paystack',
        healthCheck: '/health',
        enabled: true,
        timeout: 30000
    },
    {
        name: 'MMV Ticketing',
        baseUrl: 'https://api.cuministrymmv.org',
        webhookPath: '/api/webhooks/paystack',
        healthCheck: '/health',
        enabled: true
    }
];

logger.info('Webhook Dispatcher initialized', {
    type: 'system_startup',
    systems_count: TICKETING_SYSTEMS.length,
    systems: TICKETING_SYSTEMS.map(s => ({ id: s.id, name: s.name, enabled: s.enabled }))
});

// ==============================================
// 📥 ENHANCED MAIN WEBHOOK RECEIVER
// ==============================================
app.post('/webhooks/paystack', async (req, res) => {
    const requestId = req.id;
    const startTime = Date.now();
    
    try {
        logger.info('Webhook received from Paystack', {
            type: 'webhook_received',
            requestId,
            headers: {
                'user-agent': req.get('User-Agent'),
                'x-paystack-signature': req.get('x-paystack-signature') ? 'present' : 'missing',
                'content-type': req.get('Content-Type')
            },
            body_size: JSON.stringify(req.body).length
        });
        
        // Verify Paystack signature
        const signature = req.headers['x-paystack-signature'];
        if (!signature) {
            logger.warn('Missing Paystack signature', {
                type: 'webhook_security_error',
                requestId,
                ip: req.ip
            });
            return res.status(400).json({ error: 'Missing signature' });
        }

        const hash = crypto
            .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== signature) {
            logger.error('Invalid Paystack signature', {
                type: 'webhook_security_error',
                requestId,
                ip: req.ip,
                expected_hash: hash.substring(0, 10) + '...',
                received_signature: signature.substring(0, 10) + '...'
            });
            return res.status(400).json({ error: 'Invalid signature' });
        }

        logger.info('Paystack signature verified successfully', {
            type: 'webhook_security_success',
            requestId
        });

        const { event, data } = req.body;
        const paymentReference = data?.reference;
        const amount = data?.amount;
        const currency = data?.currency;

        if (!paymentReference) {
            logger.error('No payment reference in webhook', {
                type: 'webhook_validation_error',
                requestId,
                event,
                data_keys: Object.keys(data || {})
            });
            return res.status(400).json({ error: 'No payment reference' });
        }

        logger.info('Processing webhook', {
            type: 'webhook_processing',
            requestId,
            event,
            reference: paymentReference,
            amount,
            currency,
            customer_email: data?.customer?.email,
            channel: data?.channel
        });

        // Find which ticketing system has this payment reference
        const targetSystem = await findTargetSystem(paymentReference, requestId);

        if (!targetSystem) {
            logger.warn('No system found for payment reference', {
                type: 'webhook_system_not_found',
                requestId,
                reference: paymentReference,
                event,
                searched_systems: TICKETING_SYSTEMS.filter(s => s.enabled).map(s => s.id)
            });
            return res.status(404).json({ 
                error: 'Payment reference not found in any system',
                reference: paymentReference
            });
        }

        logger.info('Target system identified', {
            type: 'webhook_system_found',
            requestId,
            target_system: targetSystem.id,
            system_name: targetSystem.name,
            reference: paymentReference
        });

        // Forward webhook to the target system
        const forwardResult = await forwardWebhook(targetSystem, req.body, req.headers, requestId);
        const processingTime = Date.now() - startTime;

        if (forwardResult.success) {
            logger.info('Webhook forwarded successfully', {
                type: 'webhook_forward_success',
                requestId,
                target_system: targetSystem.id,
                system_name: targetSystem.name,
                reference: paymentReference,
                response_status: forwardResult.status,
                processing_time_ms: processingTime,
                total_time_ms: Date.now() - startTime
            });

            res.status(200).json({ 
                success: true,
                requestId,
                forwardedTo: targetSystem.name,
                processingTime: processingTime,
                response: forwardResult.data
            });
        } else {
            logger.error('Failed to forward webhook', {
                type: 'webhook_forward_error',
                requestId,
                target_system: targetSystem.id,
                system_name: targetSystem.name,
                reference: paymentReference,
                error: forwardResult.error,
                status: forwardResult.status,
                processing_time_ms: processingTime
            });

            res.status(500).json({ 
                error: 'Failed to forward webhook',
                requestId,
                details: forwardResult.error
            });
        }

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        logger.error('Webhook dispatcher error', {
            type: 'webhook_dispatcher_error',
            requestId,
            error: error.message,
            stack: error.stack,
            processing_time_ms: processingTime
        });

        res.status(500).json({ 
            error: 'Webhook processing failed',
            requestId
        });
    }
});

// ==============================================
// 🔍 ENHANCED FIND TARGET SYSTEM WITH LOGGING
// ==============================================
async function findTargetSystem(paymentReference, requestId) {
    logger.info('Starting system discovery', {
        type: 'system_discovery_start',
        requestId,
        reference: paymentReference,
        systems_to_check: TICKETING_SYSTEMS.filter(s => s.enabled).length
    });
    
    const searchPromises = TICKETING_SYSTEMS
        .filter(system => system.enabled)
        .map(async (system) => {
            const systemStartTime = Date.now();
            
            try {
                logger.debug('Checking system for payment reference', {
                    type: 'system_check_start',
                    requestId,
                    system_id: system.id,
                    system_name: system.name,
                    reference: paymentReference,
                    check_url: `${system.baseUrl}/api/tickets/verify/${paymentReference}`
                });
                
                const response = await axios.get(
                    `${system.baseUrl}/api/tickets/verify/${paymentReference}`,
                    { 
                        timeout: system.timeout || 5000,
                        validateStatus: (status) => status < 500
                    }
                );

                const checkTime = Date.now() - systemStartTime;

                logger.debug('System check completed', {
                    type: 'system_check_complete',
                    requestId,
                    system_id: system.id,
                    system_name: system.name,
                    reference: paymentReference,
                    response_status: response.status,
                    response_time_ms: checkTime,
                    found: response.status === 200 || (response.status === 400 && response.data?.data?.ticket)
                });

                // If found (200) or payment exists but not verified yet (400)
                if (response.status === 200 || 
                    (response.status === 400 && response.data?.data?.ticket)) {
                    
                    logger.info('Payment reference found in system', {
                        type: 'system_discovery_success',
                        requestId,
                        system_id: system.id,
                        system_name: system.name,
                        reference: paymentReference,
                        response_status: response.status,
                        response_time_ms: checkTime
                    });
                    
                    return system;
                }

                logger.debug('Payment reference not found in system', {
                    type: 'system_check_not_found',
                    requestId,
                    system_id: system.id,
                    system_name: system.name,
                    reference: paymentReference,
                    response_status: response.status
                });

                return null;
            } catch (error) {
                const checkTime = Date.now() - systemStartTime;
                
                logger.warn('System check failed', {
                    type: 'system_check_error',
                    requestId,
                    system_id: system.id,
                    system_name: system.name,
                    reference: paymentReference,
                    error: error.message,
                    error_code: error.code,
                    response_time_ms: checkTime,
                    timeout: system.timeout
                });
                
                return null;
            }
        });

    const results = await Promise.all(searchPromises);
    const foundSystem = results.find(system => system !== null);
    
    if (foundSystem) {
        logger.info('System discovery completed successfully', {
            type: 'system_discovery_complete',
            requestId,
            reference: paymentReference,
            found_system: foundSystem.id,
            checked_systems: TICKETING_SYSTEMS.filter(s => s.enabled).length
        });
    } else {
        logger.warn('System discovery failed - no system found', {
            type: 'system_discovery_failed',
            requestId,
            reference: paymentReference,
            checked_systems: TICKETING_SYSTEMS.filter(s => s.enabled).map(s => s.id)
        });
    }
    
    return foundSystem;
}

// ==============================================
// 📤 ENHANCED FORWARD WEBHOOK WITH LOGGING
// ==============================================
async function forwardWebhook(targetSystem, webhookBody, originalHeaders, requestId) {
    const forwardStartTime = Date.now();
    const webhookUrl = `${targetSystem.baseUrl}${targetSystem.webhookPath}`;
    
    try {
        logger.info('Forwarding webhook to target system', {
            type: 'webhook_forward_start',
            requestId,
            target_system: targetSystem.id,
            system_name: targetSystem.name,
            webhook_url: webhookUrl,
            event: webhookBody.event,
            reference: webhookBody.data?.reference
        });

        const response = await axios.post(webhookUrl, webhookBody, {
            headers: {
                'Content-Type': 'application/json',
                'X-Paystack-Signature': originalHeaders['x-paystack-signature'],
                'User-Agent': 'Paystack-Webhook-Dispatcher/1.0',
                'X-Forwarded-For': originalHeaders['x-forwarded-for'] || 'dispatcher',
                'X-Request-ID': requestId
            },
            timeout: targetSystem.timeout || 30000,
            validateStatus: (status) => status < 500
        });

        const forwardTime = Date.now() - forwardStartTime;

        logger.info('Webhook forwarded successfully', {
            type: 'webhook_forward_complete',
            requestId,
            target_system: targetSystem.id,
            system_name: targetSystem.name,
            response_status: response.status,
            response_time_ms: forwardTime,
            response_size: JSON.stringify(response.data).length
        });

        return {
            success: true,
            status: response.status,
            data: response.data,
            responseTime: forwardTime
        };
    } catch (error) {
        const forwardTime = Date.now() - forwardStartTime;
        
        logger.error('Webhook forwarding failed', {
            type: 'webhook_forward_error',
            requestId,
            target_system: targetSystem.id,
            system_name: targetSystem.name,
            webhook_url: webhookUrl,
            error: error.message,
            error_code: error.code,
            response_status: error.response?.status,
            response_time_ms: forwardTime,
            timeout: targetSystem.timeout
        });

        return {
            success: false,
            error: error.message,
            status: error.response?.status || 'network_error',
            responseTime: forwardTime
        };
    }
}

// ==============================================
// 🏥 ENHANCED HEALTH CHECK WITH LOGGING
// ==============================================
app.get('/health', async (req, res) => {
    const requestId = req.id;
    const healthCheckStart = Date.now();
    
    logger.info('Health check initiated', {
        type: 'health_check_start',
        requestId
    });

    const systemStatuses = await Promise.all(
        TICKETING_SYSTEMS.map(async (system) => {
            const systemHealthStart = Date.now();
            
            try {
                logger.debug('Checking system health', {
                    type: 'system_health_check'
                });

                const response = await axios.get(
                    `${system.baseUrl}${system.healthCheck}`,
                    { timeout: 5000 }
                );
                
                const responseTime = Date.now() - systemHealthStart;
                
                logger.debug('System health check completed', {
                    type: 'system_health_success'
                });

                return {
                    id: system.id,
                    name: system.name,
                    status: 'healthy',
                    responseTime: responseTime,
                    enabled: system.enabled,
                    lastChecked: new Date().toISOString()
                };
            } catch (error) {
                const responseTime = Date.now() - systemHealthStart;
                
                logger.warn('System health check failed', {
                    type: 'system_health_error'
                });

                return {
                    id: system.id,
                    name: system.name,
                    status: 'unhealthy',
                    error: error.message,
                    responseTime: responseTime,
                    enabled: system.enabled,
                    lastChecked: new Date().toISOString()
                };
            }
        })
    );

    const totalHealthCheckTime = Date.now() - healthCheckStart;
    const healthySystems = systemStatuses.filter(s => s.status === 'healthy').length;
    const enabledSystems = systemStatuses.filter(s => s.enabled).length;

    const overallHealth = {
        dispatcher: 'healthy',
        timestamp: new Date().toISOString(),
        requestId,
        systems: systemStatuses,
        summary: {
            total_systems: TICKETING_SYSTEMS.length,
            enabled_systems: enabledSystems,
            healthy_systems: healthySystems,
            unhealthy_systems: enabledSystems - healthySystems,
            health_check_time_ms: totalHealthCheckTime
        }
    };

    logger.info('Health check completed', {
        type: 'health_check_complete'
    });

    res.json(overallHealth);
});

// ==============================================
// 📊 ENHANCED ADMIN ENDPOINTS WITH LOGGING
// ==============================================

// Get all registered systems
app.get('/admin/systems', (req, res) => {
    const requestId = req.id;
    
    logger.info('Admin systems list requested', {
        type: 'admin_systems_list',
        requestId,
        admin_ip: req.ip
    });

    res.json({
        success: true,
        systems: TICKETING_SYSTEMS.map(system => ({
            id: system.id,
            name: system.name,
            baseUrl: system.baseUrl,
            enabled: system.enabled,
            timeout: system.timeout
        }))
    });
});

// Add new system
app.post('/admin/systems', (req, res) => {
    const requestId = req.id;
    const { id, name, baseUrl, webhookPath = '/api/webhooks/paystack', enabled = true, timeout = 30000 } = req.body;
    
    logger.info('Admin adding new system', {
        type: 'admin_system_add',
        requestId,
        admin_ip: req.ip,
        system_data: { id, name, baseUrl, enabled }
    });
    
    if (!id || !name || !baseUrl) {
        logger.warn('Admin system add failed - missing required fields', {
            type: 'admin_system_add_error',
            requestId,
            provided_fields: Object.keys(req.body)
        });
        return res.status(400).json({ error: 'ID, name and baseUrl required' });
    }

    const newSystem = {
        id,
        name,
        baseUrl,
        webhookPath,
        healthCheck: '/health',
        enabled,
        timeout
    };

    TICKETING_SYSTEMS.push(newSystem);
    
    logger.info('New system added successfully', {
        type: 'admin_system_added',
        requestId,
        system_id: id,
        system_name: name,
        total_systems: TICKETING_SYSTEMS.length
    });
    
    res.json({
        success: true,
        message: 'System added successfully',
        system: newSystem
    });
});

// Get webhook logs
app.get('/admin/logs/webhooks', (req, res) => {
    const requestId = req.id;
    const { limit = 50, level = 'info' } = req.query;
    
    logger.info('Admin webhook logs requested', {
        type: 'admin_logs_request',
        requestId,
        admin_ip: req.ip,
        limit,
        level
    });

    // In a real implementation, you'd read from log files or database
    // For now, return a sample response
    res.json({
        success: true,
        logs: [],
        message: 'Check logs/webhooks.log file for detailed webhook logs'
    });
});

// Test webhook forwarding
app.post('/admin/test-webhook/:systemId', async (req, res) => {
    const requestId = req.id;
    const { systemId } = req.params;
    const system = TICKETING_SYSTEMS.find(s => s.id === systemId);
    
    logger.info('Admin webhook test initiated', {
        type: 'admin_webhook_test',
        requestId,
        admin_ip: req.ip,
        target_system: systemId
    });
    
    if (!system) {
        logger.warn('Admin webhook test failed - system not found', {
            type: 'admin_webhook_test_error',
            requestId,
            system_id: systemId,
            available_systems: TICKETING_SYSTEMS.map(s => s.id)
        });
        return res.status(404).json({ error: 'System not found' });
    }

    const testWebhook = {
        event: 'charge.success',
        data: {
            reference: 'TEST-' + Date.now(),
            amount: 10000,
            status: 'success',
            currency: 'GHS',
            customer: {
                email: 'test@example.com'
            }
        }
    };

    const result = await forwardWebhook(system, testWebhook, {
        'x-paystack-signature': 'test-signature'
    }, requestId);

    logger.info('Admin webhook test completed', {
        type: 'admin_webhook_test_complete',
        requestId,
        target_system: systemId,
        test_success: result.success
    });

    res.json(result);
});

// ==============================================
// 📈 METRICS & MONITORING ENDPOINTS
// ==============================================

app.get('/admin/metrics', (req, res) => {
    const requestId = req.id;
    
    logger.info('Admin metrics requested', {
        type: 'admin_metrics_request',
        requestId,
        admin_ip: req.ip
    });

    // Basic metrics - in production, you'd use a proper metrics store
    const metrics = {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
        systems: {
            total: TICKETING_SYSTEMS.length,
            enabled: TICKETING_SYSTEMS.filter(s => s.enabled).length
        }
    };

    res.json({
        success: true,
        metrics
    });
});

// ==============================================
// 🚀 ENHANCED SERVER STARTUP WITH LOGGING
// ==============================================
app.listen(PORT, () => {
    logger.info('Webhook Dispatcher started successfully', {
        type: 'server_startup',
        port: PORT,
        environment: process.env.NODE_ENV,
        systems_count: TICKETING_SYSTEMS.length,
        log_level: process.env.LOG_LEVEL || 'info'
    });
    
    console.log(`🚀 Webhook Dispatcher running on port ${PORT}`);
    console.log(`🎫 Managing ${TICKETING_SYSTEMS.length} ticketing systems`);
});

// ==============================================
// 🔄 GRACEFUL SHUTDOWN WITH LOGGING
// ==============================================
const gracefulShutdown = (signal) => {
    logger.info('Graceful shutdown initiated', {
        type: 'server_shutdown',
        signal,
        uptime: process.uptime()
    });
    
    console.log(`${signal} received. Shutting down gracefully...`);
    
    // Close server and cleanup
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;