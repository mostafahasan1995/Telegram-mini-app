"use client";
import useTelegramAuth from "@/hooks/useTelegramAuth";
import useTelegramSearch from "@/hooks/useTelegramSearch";
import Image from "next/image";
import { ethers } from 'ethers';
import { hexlify } from 'ethers/lib/utils';
import { fromHexString } from '@/utils/utils';
import { conditions, fromBytes, toHexString } from '@nucypher/taco';
import useTaco from '@/hooks/useTaco';
import { useEffect, useState } from "react";

declare const window: any;

const ritualId = 6; // Replace with your own ritual ID
const domain = 'tapir';

export default function Home() {
  const { data, loading, error } = useTelegramAuth();
  const { setInputSearch, search, profileImage } = useTelegramSearch();
  const [message, setMessage] = useState('this is a secret');
  const [encrypting, setEncrypting] = useState(false);
  const [encryptedText, setEncryptedText] = useState<string | undefined>('');
  const [decrypting, setDecrypting] = useState(false);
  const [decryptedMessage, setDecryptedMessage] = useState<string | undefined>('');

  const { isInit, encryptDataToBytes, decryptDataFromBytes } = useTaco({
    domain,
    ritualId,
  });

  if (!isInit) {
    return <div>Loading...</div>;
  }

  const encryptMessage = async () => {
    setEncrypting(true);
    try {
      const hasPositiveBalance = new conditions.base.rpc.RpcCondition({
        chain: 80002,
        method: 'eth_getBalance',
        parameters: [':userAddress', 'latest'],
        returnValueTest: {
          comparator: '>=',
          value: 0,
        },
      });

      console.log('Encrypting message...');
      const encryptedBytes = await encryptDataToBytes(
        message,
        hasPositiveBalance,
      );
      if (encryptedBytes) {
        setEncryptedText(toHexString(encryptedBytes));
      }
    } catch (e) {
      console.log(e);
    }
    setEncrypting(false);
  };

  const decryptMessage = async () => {
    if (!encryptedText) return;
    try {
      setDecrypting(true);
      console.log('Decrypting message...');
      const decryptedMessage = await decryptDataFromBytes(
        fromHexString(encryptedText),
      );
      if (decryptedMessage) {
        setDecryptedMessage(fromBytes(decryptedMessage));
      }
    } catch (e) {
      console.log(e);
    }
    setDecrypting(false);
  };

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
            <p>{error}</p>
          </div>
        ) : data.user.username ? (
          <div>
            <p>Welcome back,</p>
            <p>{data.user.username}</p>
          </div>
        ) : (
          <p>Authentication failed</p>
        )} 
        <input type="text" onChange={(e) => setInputSearch(e.target.value)} placeholder="enter username"/>
      <button onClick={search}>search</button>
      {profileImage && <Image src={profileImage!} alt="" width={100} height={100}/>}
      </div>
      <div>==========================</div>
      <div>
      <h2>
        Secret message:{' '}
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onClick={encryptMessage}
        />{' '}
        <button onClick={encryptMessage}>Encrypt</button>{' '}
        {encrypting && 'Encrypting...'}
      </h2>
      <h2>
        Encrypted message:{' '}
        <input
          value={encryptedText}
          onChange={(e) => setEncryptedText(e.target.value)}
        />{' '}
        <button onClick={decryptMessage}>Decrypt</button>{' '}
        {decrypting && 'Decrypting...'}
      </h2>
      {decryptedMessage && <h2>Decrypted message: {decryptedMessage}</h2>}
    </div>
    </>
  );
}
