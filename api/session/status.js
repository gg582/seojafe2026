import { getSessionStatus } from '../_lib/melon.js';

export default function handler(_req, res) {
  res.status(200).json(getSessionStatus());
}
