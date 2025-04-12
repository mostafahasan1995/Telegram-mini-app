import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

const BOT_TOKEN = process.env.NEXT_PUBLIC_TELEGRAM_BOT_TOKEN!; 

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Ensure the request method is POST; otherwise, return a 405 (Method Not Allowed)
  if (req.method !== "POST") return res.status(405).end(); 

  // Extract initData from the request body
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ success: false, error: "Missing initData" });

  try {
    // Parse initData as URLSearchParams for easier manipulation
    const params = new URLSearchParams(initData);
    
    // Extract the hash value (used to verify authenticity)
    const hash = params.get("hash");
    if (!hash) return res.status(400).json({ success: false, error: "Missing hash" });

    // Remove the hash from parameters (since it should not be included in validation)
    params.delete("hash");

    // Create a data-check string by sorting parameters alphabetically and joining them with '\n'
    const dataCheckString = Array.from(params.entries())
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("\n");

    // Generate a secret key using HMAC-SHA-256 with "WebAppData" and BOT_TOKEN
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();

    // Generate the expected hash using HMAC-SHA-256 with the secret key
    const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    // Compare the calculated hash with the received hash to validate authenticity
    if (calculatedHash !== hash) {
      return res.status(403).json({ success: false, error: "Invalid authentication" });
    }

    // Extract and parse the user data from initData (Telegram sends user data as a JSON string)
    const user = JSON.parse(params.get("user") || "{}");

    // Respond with the validated user data
    return res.json({ success: true, user });
  } catch {
    // Handle unexpected errors and return a 500 (Internal Server Error)
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
