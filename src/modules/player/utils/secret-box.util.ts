/**
 * The secret box moved to @core/crypto/secret-box.util: tenant secrets (bot token, webhook secret,
 * Ichancy password) are sealed with it too, and core may not import a module. This re-export keeps
 * the player module's imports stable; new code imports from core.
 */
export {
  SecretBoxError,
  deriveKey,
  openSecret,
  sealSecret,
  secretsEqual,
} from '@core/crypto/secret-box.util';
