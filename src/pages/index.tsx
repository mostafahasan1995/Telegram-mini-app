"use client";
import useTelegramAuth from "@/hooks/useTelegramAuth";

export default function Home() {
  const { username, loading, error } = useTelegramAuth();

  return (
    <div>
      <h1>Welcome To Telegram Mini App</h1>
      
      {loading ? (
        <div>
          <p>Authenticating...</p>
        </div>
      ) : error ? (
        <div>
          <p>Authentication Error</p>
        </div>
      ) : username ? (
        <div>
          <p>Welcome back,</p>
          <p>{username}</p>
        </div>
      ) : (
        <p>Authentication failed</p>
      )}
    </div>
  );
}