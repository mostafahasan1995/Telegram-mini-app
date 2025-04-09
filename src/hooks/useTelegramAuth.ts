"use client";
import { useEffect, useState } from "react";
import Swal from "sweetalert2";

export default function useTelegramAuth() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const authenticateUser = async () => {
      try {
        if (typeof window === "undefined" || !window.Telegram?.WebApp) {
          throw new Error("Telegram WebApp is not supported");
        }

        const tg = window.Telegram.WebApp;
        tg.expand();

        const initData = tg.initData;
        if (!initData) {
          throw new Error("Telegram WebApp data not found");
        }

        const response = await fetch("/api/verify-user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        });

        const data = await response.json();

        if (!data.success) {
          throw new Error("User verification failed");
        }

        setData(data);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Authentication failed";
        setError(errorMessage);
        Swal.fire({
          icon: "error",
          title: "Error",
          text: "Not Loaded Telegram WebApp API",
        });
      } finally {
        setLoading(false);
      }
    };

    authenticateUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  

  return { data, loading, error };
}
