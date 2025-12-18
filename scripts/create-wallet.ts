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
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as readline from 'readline';

const GATEWAY_URL = process.argv.includes('--gateway')
  ? process.argv[process.argv.indexOf('--gateway') + 1]
  : 'http://localhost:15888';

const NO_ADD = process.argv.includes('--no-add');

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

async function main() {
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
  console.log('  WARNING: BACK UP YOUR PRIVATE KEY NOW!');
  console.log('!'.repeat(60));
  console.log(`
  1. Write down the private key above on paper
  2. Store it in a secure location (safe, safety deposit box)
  3. Consider using a hardware wallet for large amounts
  4. NEVER share your private key with anyone
  5. NEVER store it in plain text on your computer
`);

  if (NO_ADD) {
    console.log('Wallet generated. Use --no-add was specified, not adding to Gateway.');
    console.log('\nTo add this wallet to Gateway later, run:');
    console.log(`  curl -X POST ${GATEWAY_URL}/wallet/add \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"chain": "solana", "privateKey": "<your-private-key>", "setDefault": true}'`);
    process.exit(0);
  }

  const rl = createReadlineInterface();

  try {
    // Confirm backup
    const backupConfirm = await prompt(
      rl,
      'Have you securely backed up your private key? (yes/no): '
    );

    if (backupConfirm.toLowerCase() !== 'yes') {
      console.log('\nPlease back up your private key before proceeding.');
      console.log('Your wallet details are shown above. Run this script again when ready.');
      process.exit(0);
    }

    // Ask about adding to Gateway
    const addToGateway = await prompt(
      rl,
      `\nAdd this wallet to Gateway at ${GATEWAY_URL}? (yes/no): `
    );

    if (addToGateway.toLowerCase() !== 'yes') {
      console.log('\nWallet NOT added to Gateway.');
      console.log('To add it later, use the /wallet/add endpoint with your private key.');
      process.exit(0);
    }

    // Ask about setting as default
    const setDefault = await prompt(
      rl,
      'Set as default Solana wallet? (yes/no): '
    );

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
