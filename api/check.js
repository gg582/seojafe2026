import { checkSeat } from './_lib/melon.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const result = await checkSeat(payload);
    res.status(result.status).json(result.data);
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
}
