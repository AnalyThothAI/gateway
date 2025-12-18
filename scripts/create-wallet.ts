#!/usr/bin/env npx ts-node
/**
 * Solana Wallet Generator for Hummingbot Gateway
 *
 * Generates a new Solana keypair locally and optionally adds it to Gateway.
 * The private key is generated on your machine and never sent to any server
 * until you explicitly choose to add it to Gateway.
 *
 * Usage:
 *   npx ts-node scripts/create-wallet.ts
 *   npx ts-node scripts/create-wallet.ts --gateway http://localhost:15888
 *   npx ts-node scripts/create-wallet.ts --no-add  # Generate only, don't add to Gateway
 *   npx ts-node scripts/create-wallet.ts --verify  # Verify a private key is valid
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
      console.log(`\n  Derived Address: ${address}\n`);

      // Ask if they want to verify against an expected address
      const checkAddress = await prompt(rl, 'Verify against an expected address? (yes/no): ');

      if (checkAddress.toLowerCase() === 'yes') {
        const expectedAddress = await prompt(rl, 'Enter expected address: ');

        if (expectedAddress === address) {
          console.log('\n' + '='.repeat(60));
          console.log('  ADDRESS MATCH CONFIRMED');
          console.log('='.repeat(60) + '\n');
        } else {
          console.log('\n' + '!'.repeat(60));
          console.log('  ADDRESS MISMATCH');
          console.log('!'.repeat(60));
          console.log(`\n  Expected: ${expectedAddress}`);
          console.log(`  Derived:  ${address}\n`);
          process.exit(1);
        }
      }

      // Ask if they want to add to Gateway
      const addToGateway = await prompt(rl, `\nAdd this wallet to Gateway at ${GATEWAY_URL}? (yes/no): `);

      if (addToGateway.toLowerCase() === 'yes') {
        const setDefault = await prompt(rl, 'Set as default Solana wallet? (yes/no): ');

        console.log('\nAdding wallet to Gateway...');

        try {
          const result = await addWalletToGateway(privateKeyInput, setDefault.toLowerCase() === 'yes');
          console.log('\n' + '='.repeat(60));
          console.log('  SUCCESS! Wallet added to Gateway');
          console.log('='.repeat(60));
          console.log(`  Address: ${result.address}`);
          console.log(`  Default: ${setDefault.toLowerCase() === 'yes' ? 'Yes' : 'No'}`);
          console.log('='.repeat(60) + '\n');
        } catch (error: any) {
          console.error('\nFailed to add wallet to Gateway:', error.message);
          process.exit(1);
        }
      }
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
    console.log('\nOr use: pnpm wallet:create -- --verify');
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
      console.log('To add it later, use: pnpm wallet:create -- --verify');
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
