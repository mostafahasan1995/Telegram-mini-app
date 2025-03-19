"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand(); 

      const user = tg.initDataUnsafe?.user;
      if (user?.username) {
        setUsername(user.username);
        console.log("تم الاتصال بـ Telegram WebApp ✅");
        console.log("اسم المستخدم:", user.username);
      } else {
        console.warn("⚠️ لم يتم العثور على اسم المستخدم!");
      }
    } else {
      console.error("❌ لم يتم تحميل Telegram WebApp API");
    }
  }, []);

  return (
    <div>
      <h1>Welcome To Telegram Mini App</h1>
      {username ? <p> User Name{username}</p> : <p>Loading ...</p>}
    </div>
  );
}
