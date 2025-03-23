import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

const BOT_TOKEN = process.env.NEXT_PUBLIC_TELEGRAM_BOT_TOKEN!; 

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end(); 

  const { initData } = req.body;
  if (!initData) return res.status(400).json({ success: false, error: "Missing initData" });

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return res.status(400).json({ success: false, error: "Missing hash" });

    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (calculatedHash !== hash) {
      return res.status(403).json({ success: false, error: "Invalid authentication" });
    }

    const user = JSON.parse(params.get("user") || "{}");
    return res.json({ success: true, user });
  } catch {
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
