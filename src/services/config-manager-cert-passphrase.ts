import { logger } from './logger';

const argvParser = require('minimist');
const PASSPHRASE_ARGUMENT = 'passphrase';
const PASSPHRASE_ENV = 'GATEWAY_PASSPHRASE';
const WALLET_KEY_ENV = 'GATEWAY_WALLET_KEY';

export namespace ConfigManagerCertPassphrase {
  // this adds a level of indirection so we can test the code
  export const bindings = {
    _exit: process.exit,
  };

  /**
   * Read the passphrase for SSL/startup from command line or environment.
   * This is used for server initialization and SSL certificates.
   */
  export const readPassphrase = (): string | undefined => {
    const argv = argvParser(process.argv, { string: [PASSPHRASE_ARGUMENT] });
    if (argv[PASSPHRASE_ARGUMENT]) {
      return argv[PASSPHRASE_ARGUMENT];
    } else if (process.env[PASSPHRASE_ENV]) {
      return process.env[PASSPHRASE_ENV];
    }

    // the compiler does not know that bindings._exit() will end the function
    // so we need a return to satisfy the compiler checks
    logger.error(
      `The passphrase has to be provided by argument (--${PASSPHRASE_ARGUMENT}=XXX) or in an env variable (export ${PASSPHRASE_ENV}=XXX)`,
    );
    bindings._exit();
    return;
  };

  /**
   * Read the wallet encryption key from environment variable.
   * Falls back to passphrase if GATEWAY_WALLET_KEY is not set.
   *
   * Using a separate wallet key is more secure because:
   * - Environment variables are not visible in `ps aux` (unlike --passphrase)
   * - Not stored in shell history
   * - Can be set separately from the shared passphrase
   *
   * Set via: export GATEWAY_WALLET_KEY=your-secret-key
   */
  export const readWalletKey = (): string | undefined => {
    // First, check for dedicated wallet encryption key (more secure)
    if (process.env[WALLET_KEY_ENV]) {
      return process.env[WALLET_KEY_ENV];
    }

    // Fall back to passphrase for backward compatibility
    return readPassphrase();
  };
}
