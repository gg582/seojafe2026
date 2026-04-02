import { refreshSessionViaPlaywright } from '../_lib/melon.js';

export default async function handler(_req, res) {
  if (_req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const result = await refreshSessionViaPlaywright();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      error: String(error.message || error),
      hint: 'Set MELON_COOKIE as fallback, or ensure Playwright package/browser is available in runtime.'
    });
  }
}
