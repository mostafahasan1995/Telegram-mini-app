"use client";
import { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { api } from "@/utils/api";

export default function useTelegramAuth() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const authenticateUser = async () => {
      try {
        // Wait for Telegram WebApp to be available
        if (typeof window === "undefined") {
          throw new Error("Window is not defined");
        }

        // Wait for Telegram WebApp to initialize
        await new Promise((resolve) => {
          const checkTelegram = () => {
            if (window.Telegram?.WebApp) {
              resolve(true);
            } else {
              setTimeout(checkTelegram, 100);
            }
          };
          checkTelegram();
        });

        const tg = window.Telegram.WebApp;
        
        // Initialize the WebApp
        tg.ready();
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

        // Call the backend signup API
        const userData = {
          telegramId: data.user.id.toString(),
          firstName: data.user.first_name,
          lastName: data.user.last_name,
          username: data.user.username,
          photoUrl: data.user.photo_url,
          authDate: new Date(),
          hash: initData,
        };

        const signupResponse = await api.signup(userData);
        setData({ ...data, backendUser: signupResponse });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Authentication failed";
        setError(errorMessage);
        Swal.fire({
          icon: "error",
          title: "Error",
          text: errorMessage,
        });
      } finally {
        setLoading(false);
      }
    };

    authenticateUser();
  }, []);

  return { data, loading, error };
}
