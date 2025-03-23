"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (typeof window !== "undefined" && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();

      const initData = tg.initData;
      if (!initData) {
        console.error("❌ No initData found!");
        setLoading(false);
        return;
      }

      fetch("/api/verify-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
            setUsername(data.user.username || "Unknown");
          } else {
            console.error("❌ Authentication failed!");
          }
        })
        .catch((err) => console.error("❌ Error:", err))
        .finally(() => setLoading(false));
    } else {
      console.error("❌ Telegram WebApp not found!");
      setLoading(false);
    }
  }, []);

  return (
    <div>
      <h1>Welcome To Telegram Mini App</h1>
      {loading ? <p>Loading ...</p> : username ? <p>User Name: {username}</p> : <p>Authentication failed</p>}
    </div>
  );
}
