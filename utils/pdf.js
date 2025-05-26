import puppeteer from 'puppeteer';

export const generatePDF = async (report) => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  const html = `
    <html>
      <head>
        <style>
          body { font-family: sans-serif; padding: 2rem; }
          pre { background: #f0f0f0; padding: 1rem; border-radius: 8px; }
        </style>
      </head>
      <body>
        <h1>Accessibility Report</h1>
        <p><strong>URL:</strong> ${report.url}</p>
        <pre>${JSON.stringify(report.result, null, 2)}</pre>
      </body>
    </html>
  `;

  await page.setContent(html);
  const pdf = await page.pdf({ format: 'A4' });
  await browser.close();
  return pdf;
};
