import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory
import fs from 'fs';
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Custom log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
        let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
        
        // Add metadata if present
        if (Object.keys(meta).length > 0) {
            log += `\n${JSON.stringify(meta, null, 2)}`;
        }
        
        return log;
    })
);

// Create logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { 
        service: 'webhook-dispatcher',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
    },
    transports: [
        // Error logs
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 10
        }),
        
        // Combined logs
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 10
        }),
        
        // Webhook-specific logs
        new winston.transports.File({
            filename: path.join(logsDir, 'webhooks.log'),
            level: 'info',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        }),
        
        // Console output (exclude health checks)
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
            level: process.env.LOG_LEVEL || 'info',
            silent: false,
            handleExceptions: true,
            filter: (info) => info.type !== 'system_health_check' // Exclude health check logs
        })
    ]
});

export default logger;