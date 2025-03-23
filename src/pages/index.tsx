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
        tg.showAlert("❌ لا يوجد بيانات Telegram WebApp!");
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
            tg.showAlert("❌ فشل التحقق من المستخدم!");
          }
        })
        .catch(() => {
          tg.showAlert("❌ حدث خطأ في التحقق من المستخدم!");
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
      setTimeout(() => {
        window.Telegram?.WebApp?.showAlert("❌ Telegram WebApp غير مدعوم!");
      }, 500);
    }
  }, []);

  return (
    <div>
      <h1>Welcome To Telegram Mini App2</h1>
      {loading ? (
        <p>Loading ...</p>
      ) : username ? (
        <p>User Name: {username}</p>
      ) : (
        <p>Authentication failed</p>
      )}
    </div>
  );
}
