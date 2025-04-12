import {
  conditions,
  decrypt,
  Domain,
  encrypt,
  initialize,
  ThresholdMessageKit,
} from '@nucypher/taco';
import {
  EIP4361AuthProvider,
  USER_ADDRESS_PARAM_DEFAULT,
} from '@nucypher/taco-auth';
import { ethers } from 'ethers';
import { useCallback, useEffect, useState } from 'react';

const RPC_PROVIDER_URL = process.env.NEXT_PUBLIC_RPC_PROVIDER_URL || 'https://rpc-amoy.polygon.technology';
const ENCRYPTOR_PRIVATE_KEY = process.env.NEXT_PUBLIC_ENCRYPTOR_PRIVATE_KEY;
const CONSUMER_PRIVATE_KEY = process.env.NEXT_PUBLIC_CONSUMER_PRIVATE_KEY;

export default function useTaco({
  ritualId,
  domain,
}: {
  ritualId: number;
  domain: Domain;
}) {
  const [isInit, setIsInit] = useState(false);
  const [provider, setProvider] = useState<ethers.providers.JsonRpcProvider>();

  useEffect(() => {
    const init = async () => {
      if (!ENCRYPTOR_PRIVATE_KEY || !CONSUMER_PRIVATE_KEY) {
        console.error('Private keys are not set in environment variables');
        return;
      }

      const rpcProvider = new ethers.providers.JsonRpcProvider(RPC_PROVIDER_URL);
      setProvider(rpcProvider);
      await initialize();
      setIsInit(true);
    };

    init();
  }, []);

  const decryptDataFromBytes = useCallback(
    async (encryptedBytes: Uint8Array) => {
      if (!isInit || !provider || !CONSUMER_PRIVATE_KEY) {
        return;
      }

      const consumerSigner = new ethers.Wallet(CONSUMER_PRIVATE_KEY, provider);
      const messageKit = ThresholdMessageKit.fromBytes(encryptedBytes);
      const conditionContext = conditions.context.ConditionContext.fromMessageKit(messageKit);

      if (conditionContext.requestedContextParameters.has(USER_ADDRESS_PARAM_DEFAULT)) {
        const authProvider = new EIP4361AuthProvider(provider, consumerSigner);
        conditionContext.addAuthProvider(USER_ADDRESS_PARAM_DEFAULT, authProvider);
      }

      return decrypt(provider, domain, messageKit, conditionContext);
    },
    [isInit, provider, domain],
  );

  const encryptDataToBytes = useCallback(
    async (message: string, condition: conditions.condition.Condition) => {
      if (!isInit || !provider || !ENCRYPTOR_PRIVATE_KEY) return;

      const encryptorSigner = new ethers.Wallet(ENCRYPTOR_PRIVATE_KEY, provider);
      const messageKit = await encrypt(
        provider,
        domain,
        message,
        condition,
        ritualId,
        encryptorSigner,
      );
      return messageKit.toBytes();
    },
    [isInit, provider, domain, ritualId],
  );

  return {
    isInit,
    decryptDataFromBytes,
    encryptDataToBytes,
  };
}
