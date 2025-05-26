import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { runScan } from './utils/scanRunner.js';
import { saveReport, canScanToday, getAllReports, getReportById } from './utils/db.js';
import { authMiddleware } from './utils/clerk.js';
import { generatePDF } from './utils/pdf.js';

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.post('/api/public-scan', async (req, res) => {
  const { url, email } = req.body;
  if (!url || !email) return res.status(400).json({ error: 'Missing URL or email' });

  const allowed = await canScanToday(email);
  if (!allowed) return res.status(429).json({ error: 'Scan limit reached for today' });

  const result = await runScan(url);
  const report = await saveReport({ url, email, result, type: 'public' });
  res.json(report);
});

app.get('/api/reports', authMiddleware, async (req, res) => {
  const reports = await getAllReports();
  res.json(reports);
});

app.get('/api/report/:id/pdf', authMiddleware, async (req, res) => {
  const report = await getReportById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const pdfBuffer = await generatePDF(report);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=report.pdf');
  res.send(pdfBuffer);
});

app.listen(5000, () => console.log('Backend running on port 5000'));
