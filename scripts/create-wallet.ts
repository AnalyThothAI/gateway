#!/usr/bin/env npx ts-node
/**
 * ============================================================================
 * SOLANA WALLET GENERATOR FOR HUMMINGBOT GATEWAY
 * ============================================================================
 *
 * This script generates Solana keypairs LOCALLY on your machine for use with
 * Hummingbot Gateway. Private keys are never sent to any server until you
 * explicitly choose to add them to Gateway.
 *
 * ============================================================================
 * COMMANDS
 * ============================================================================
 *
 * CREATE A NEW WALLET (interactive):
 *   pnpm wallet:create
 *
 *   This will:
 *   1. Generate a new Solana keypair locally
 *   2. Display the address and private key
 *   3. Prompt you to save your private key (THIS IS THE ONLY TIME IT'S SHOWN)
 *   4. Ask if you want to add the wallet to Gateway
 *
 * CREATE WITHOUT ADDING TO GATEWAY:
 *   pnpm wallet:create -- --no-add
 *
 *   Use this to generate and save your key before adding to Gateway.
 *   You can add it later using the /wallet/add API.
 *
 * VERIFY A SAVED PRIVATE KEY:
 *   pnpm wallet:create -- --verify
 *
 *   Use this to:
 *   - Confirm your saved private key is valid
 *   - See the wallet address derived from the key
 *   - Verify you saved the key correctly before funding the wallet
 *
 * SPECIFY CUSTOM GATEWAY URL:
 *   pnpm wallet:create -- --gateway http://localhost:15888
 *
 * ============================================================================
 * SECURITY NOTES
 * ============================================================================
 *
 * - Private keys are generated using @solana/web3.js (cryptographically secure)
 * - Keys are generated locally - nothing is sent over the network during creation
 * - The private key is displayed ONLY ONCE - if you lose it, funds are lost forever
 * - Store your private key in a secure password manager
 * - Never share your private key with anyone
 * - Never store private keys in plain text files
 *
 * ============================================================================
 * ADDING WALLET TO GATEWAY MANUALLY
 * ============================================================================
 *
 * If you chose not to add the wallet during creation, you can add it later:
 *
 *   curl -X POST http://localhost:15888/wallet/add \
 *     -H "Content-Type: application/json" \
 *     -d '{"chain": "solana", "privateKey": "<your-key>", "setDefault": true}'
 *
 * ============================================================================
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as readline from 'readline';

const GATEWAY_URL = process.argv.includes('--gateway')
  ? process.argv[process.argv.indexOf('--gateway') + 1]
  : 'http://localhost:15888';

const NO_ADD = process.argv.includes('--no-add');
const VERIFY_MODE = process.argv.includes('--verify');

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function addWalletToGateway(privateKey: string, setDefault: boolean): Promise<{ address: string }> {
  const response = await fetch(`${GATEWAY_URL}/wallet/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chain: 'solana',
      privateKey,
      setDefault,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gateway error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Verify a private key is valid and show its derived address
 */
async function verifyPrivateKey(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('  SOLANA PRIVATE KEY VERIFICATION');
  console.log('='.repeat(60) + '\n');

  const rl = createReadlineInterface();

  try {
    const privateKeyInput = await prompt(rl, 'Enter your private key (base58): ');

    if (!privateKeyInput) {
      console.log('\nNo private key provided.');
      process.exit(1);
    }

    try {
      // Attempt to decode and create keypair
      const decoded = bs58.decode(privateKeyInput);
      const secretKey = new Uint8Array(decoded);

      if (secretKey.length !== 64) {
        console.log('\n' + '!'.repeat(60));
        console.log('  INVALID: Private key must be 64 bytes');
        console.log('!'.repeat(60));
        console.log(`\n  Your key decoded to ${secretKey.length} bytes.`);
        console.log('  A valid Solana private key is 64 bytes (88 base58 characters).\n');
        process.exit(1);
      }

      const keypair = Keypair.fromSecretKey(secretKey);
      const address = keypair.publicKey.toBase58();

      console.log('\n' + '='.repeat(60));
      console.log('  VALID PRIVATE KEY');
      console.log('='.repeat(60));
      console.log(`\n  Derived Address: ${address}`);
      console.log('\n  Your private key is valid and can be used with Gateway.');
      console.log('='.repeat(60) + '\n');
    } catch (error: any) {
      console.log('\n' + '!'.repeat(60));
      console.log('  INVALID PRIVATE KEY');
      console.log('!'.repeat(60));
      console.log(`\n  Error: ${error.message}`);
      console.log('  Make sure you entered a valid base58-encoded Solana private key.\n');
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  // Handle verify mode
  if (VERIFY_MODE) {
    await verifyPrivateKey();
    return;
  }

  console.log('\n' + '='.repeat(60));
  console.log('  SOLANA WALLET GENERATOR - Hummingbot Gateway');
  console.log('='.repeat(60) + '\n');

  // Generate keypair locally
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const privateKey = bs58.encode(keypair.secretKey);

  console.log('A new Solana wallet has been generated LOCALLY on your machine.\n');

  console.log('-'.repeat(60));
  console.log('  WALLET ADDRESS (public - safe to share):');
  console.log('-'.repeat(60));
  console.log(`  ${address}\n`);

  console.log('-'.repeat(60));
  console.log('  PRIVATE KEY (secret - NEVER share this):');
  console.log('-'.repeat(60));
  console.log(`  ${privateKey}\n`);

  console.log('!'.repeat(60));
  console.log('  CRITICAL: SAVE YOUR PRIVATE KEY NOW!');
  console.log('!'.repeat(60));
  console.log(`
  This is the ONLY time your private key will be displayed.
  If you lose it, your funds will be PERMANENTLY UNRECOVERABLE.

  1. Copy the private key to a secure password manager
  2. Store a backup in a secure offline location
  3. NEVER share your private key with anyone
  4. NEVER store it in plain text on your computer

  To verify your saved key later: pnpm wallet:create -- --verify
`);

  if (NO_ADD) {
    console.log('--no-add specified, not adding to Gateway.');
    console.log('\nTo add this wallet to Gateway later, run:');
    console.log(`  curl -X POST ${GATEWAY_URL}/wallet/add \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"chain": "solana", "privateKey": "<your-private-key>", "setDefault": true}'`);
    process.exit(0);
  }

  const rl = createReadlineInterface();

  try {
    // Confirm backup
    const backupConfirm = await prompt(rl, 'Have you securely saved your private key? (yes/no): ');

    if (backupConfirm.toLowerCase() !== 'yes') {
      console.log('\nPlease save your private key before proceeding.');
      console.log('Your wallet details are shown above. Run this script again when ready.');
      process.exit(0);
    }

    // Ask about adding to Gateway
    const addToGateway = await prompt(rl, `\nAdd this wallet to Gateway at ${GATEWAY_URL}? (yes/no): `);

    if (addToGateway.toLowerCase() !== 'yes') {
      console.log('\nWallet NOT added to Gateway.');
      console.log('To add it later, use the /wallet/add API endpoint.');
      process.exit(0);
    }

    // Ask about setting as default
    const setDefault = await prompt(rl, 'Set as default Solana wallet? (yes/no): ');

    console.log('\nAdding wallet to Gateway...');

    try {
      const result = await addWalletToGateway(privateKey, setDefault.toLowerCase() === 'yes');
      console.log('\n' + '='.repeat(60));
      console.log('  SUCCESS! Wallet added to Gateway');
      console.log('='.repeat(60));
      console.log(`  Address: ${result.address}`);
      console.log(`  Default: ${setDefault.toLowerCase() === 'yes' ? 'Yes' : 'No'}`);
      console.log('='.repeat(60) + '\n');
    } catch (error: any) {
      console.error('\nFailed to add wallet to Gateway:', error.message);
      console.log('\nYour wallet was generated successfully. You can add it manually later.');
      console.log('Make sure Gateway is running and the passphrase is configured.');
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
