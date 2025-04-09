"use client";
import useTelegramAuth from "@/hooks/useTelegramAuth";
import useTelegramSearch from "@/hooks/useTelegramSearch";
import Image from "next/image";

export default function Home() {
  const { data, loading, error } = useTelegramAuth();
  const { setInputSearch, search, profileImage } = useTelegramSearch();

  return (
    <>
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
        ) : data.user.username ? (
          <div>
            <p>Welcome back,</p>
            <p>{data.user.username}</p>
          </div>
        ) : (
          <p>Authentication failed</p>
        )}
      </div>
      <input type="text" onChange={(e) => setInputSearch(e.target.value)} placeholder="enter username"/>
      <button onClick={search}>search</button>
      {profileImage && <Image src={profileImage!} alt="" width={100} height={100}/>}
    </>
  );
}
