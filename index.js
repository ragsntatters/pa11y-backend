import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import compression from 'compression';
import { runScan } from './utils/scanRunner.js';
import { saveReport, canScanToday, getAllReports, getReportById } from './utils/db.js';
import { authMiddleware } from './utils/clerk.js';
import { generatePDF } from './utils/pdf.js';
import mongoose from 'mongoose';
import { sendReportEmail } from './utils/email.js';

// Add startup logging
console.log('Starting backend service...');
console.log('Environment:', {
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  DOMAIN: process.env.DOMAIN,
  FRONTEND_URL: process.env.FRONTEND_URL,
  MONGODB_URI: process.env.MONGODB_URI ? '***exists***' : '***missing***',
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY ? '***exists***' : '***missing***'
});

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://*.clerk.accounts.dev", "https://*.wookongmarketing.com"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Configure CORS for Railway deployment with custom domain
const corsOptions = {
  origin: [
    process.env.FRONTEND_URL,
    'https://pa11y.wookongmarketing.com',
    'https://pa11y-backend.wookongmarketing.com',
    'http://localhost:3000'  // Keep for local development
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  exposedHeaders: ['Content-Disposition']
};

// Basic middleware
app.use(cors(corsOptions));
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${req.headers.origin || 'no origin'}`);
  next();
});

// Health check endpoint for Railway - must be before other routes
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    domain: process.env.DOMAIN,
    uptime: process.uptime(),
    env: process.env.NODE_ENV
  });
});

// API routes
app.post('/api/public-scan', async (req, res) => {
  try {
    const { url, email, wcagLevel } = req.body;
    if (!url || !email) {
      console.log('Missing URL or email in request');
      return res.status(400).json({ error: 'Missing URL or email' });
    }

    console.log(`Scan requested for ${url} by ${email}`);
    const allowed = await canScanToday(email);
    if (!allowed) {
      console.log(`Scan limit reached for ${email}`);
      return res.status(429).json({ error: 'Scan limit reached for today' });
    }

    // Create report with status 'pending'
    const pendingReport = await saveReport({ url, email, type: 'public', status: 'pending', wcagLevel });
    res.json({ reportId: pendingReport._id });

    // Run scan asynchronously
    runScan(url, wcagLevel)
      .then(async (result) => {
        await mongoose.model('Report').findByIdAndUpdate(pendingReport._id, {
          result,
          status: 'complete'
        });
        console.log(`Scan completed for ${url}`);
      })
      .catch(async (error) => {
        await mongoose.model('Report').findByIdAndUpdate(pendingReport._id, {
          status: 'error',
          result: { error: error.message }
        });
        console.error('Scan error:', error);
      });
  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ error: 'Failed to run scan', details: error.message });
  }
});

app.get('/api/reports', authMiddleware, async (req, res) => {
  try {
    console.log('Reports requested by user:', req.auth.userId);
    const reports = await getAllReports();
    res.json(reports);
  } catch (error) {
    console.error('Reports error:', error);
    res.status(500).json({ error: 'Failed to fetch reports', details: error.message });
  }
});

app.get('/api/report/:id/pdf', authMiddleware, async (req, res) => {
  try {
    console.log(`PDF requested for report ${req.params.id} by user:`, req.auth.userId);
    const report = await getReportById(req.params.id);
    if (!report) {
      console.log(`Report ${req.params.id} not found`);
      return res.status(404).json({ error: 'Report not found' });
    }
    const pdfBuffer = await generatePDF(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=report-${report._id}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('PDF error:', error);
    res.status(500).json({ error: 'Failed to generate PDF', details: error.message });
  }
});

// New endpoint: Get report by ID (for polling/progress/results)
app.get('/api/report/:id', async (req, res) => {
  try {
    const report = await getReportById(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch report', details: error.message });
  }
});

// Add after /api/report/:id endpoint
app.post('/api/report/:id/email', async (req, res) => {
  try {
    const report = await getReportById(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    if (!report.email) {
      return res.status(400).json({ error: 'No email associated with this report' });
    }
    const pdfBuffer = await generatePDF(report);
    await sendReportEmail({
      to: report.email,
      subject: `Your Accessibility Report for ${report.url}`,
      text: `Attached is your accessibility report for ${report.url}.`,
      pdfBuffer
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send email', details: error.message });
  }
});

// Admin scan endpoint (unlimited, requires admin auth)
app.post('/api/admin-scan', authMiddleware, async (req, res) => {
  try {
    // You can add more robust admin checks here if needed
    const { url, email, wcagLevel } = req.body;
    if (!url || !email) {
      return res.status(400).json({ error: 'Missing URL or email' });
    }
    // Create report with status 'pending', type 'admin'
    const pendingReport = await saveReport({ url, email, type: 'admin', status: 'pending', wcagLevel });
    res.json({ reportId: pendingReport._id });
    // Run scan asynchronously
    runScan(url, wcagLevel)
      .then(async (result) => {
        await mongoose.model('Report').findByIdAndUpdate(pendingReport._id, {
          result,
          status: 'complete'
        });
        console.log(`Admin scan completed for ${url}`);
      })
      .catch(async (error) => {
        await mongoose.model('Report').findByIdAndUpdate(pendingReport._id, {
          status: 'error',
          result: { error: error.message }
        });
        console.error('Admin scan error:', error);
      });
  } catch (error) {
    res.status(500).json({ error: 'Failed to run admin scan', details: error.message });
  }
});

// Delete report endpoint (admin only)
app.delete('/api/report/:id', authMiddleware, async (req, res) => {
  try {
    const report = await getReportById(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    await mongoose.model('Report').findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete report', details: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Invalid or missing authentication token' });
  }
  res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

// Start server with error handling
const startServer = async () => {
  try {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Backend running on port ${PORT}`);
      console.log('Server started successfully');
      console.log('CORS enabled for:', corsOptions.origin);
    });

    server.on('error', (error) => {
      console.error('Server error:', error);
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
      }
      process.exit(1);
    });

    // Handle shutdown gracefully
    process.on('SIGTERM', () => {
      console.log('SIGTERM received. Shutting down gracefully...');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      server.close(() => {
        console.log('Server closed due to uncaught exception');
        process.exit(1);
      });
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
