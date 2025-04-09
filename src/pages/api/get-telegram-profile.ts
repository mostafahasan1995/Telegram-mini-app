import type { NextApiRequest, NextApiResponse } from 'next';
import axios from 'axios';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { username } = req.query;

  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid username' });
  }

  try {
    const response = await axios.get(`https://t.me/${username}`);

    res.status(200).send(response.data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
