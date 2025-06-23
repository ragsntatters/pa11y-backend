import puppeteer from 'puppeteer';

export const generatePDF = async (report) => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions'
    ],
    executablePath: process.env.CHROME_BIN || null
  });

  try {
    const page = await browser.newPage();
    await page.setContent(`
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
    `);

    const pdf = await page.pdf({ 
      format: 'A4',
      printBackground: true,
      margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
    });

    return pdf;
  } finally {
    await browser.close();
  }
};
