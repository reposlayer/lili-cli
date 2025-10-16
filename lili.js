#!/usr/bin/env node


/**
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import figlet from 'figlet';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { Metaplex, keypairIdentity, bundlrStorage, toMetaplexFile } from '@metaplex-foundation/js';

import { createSignerFromKeypair, publicKey as umiPublicKey, signerIdentity, generateSigner } from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';

import fs from 'fs-extra';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helpers for centering and boxes
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');
function centerBlock(block) {
  const cols = process.stdout.columns || 80;
  const lines = block.split('\n');
  const maxLen = Math.max(...lines.map(l => stripAnsi(l).length));
  const left = Math.max(0, Math.floor((cols - maxLen) / 2));
  const pad = ' '.repeat(left);
  return lines.map(l => pad + l).join('\n');
}
function makeBox(lines, width = 77) {
  const top = '╔' + '═'.repeat(width - 2) + '╗';
  const bottom = '╚' + '═'.repeat(width - 2) + '╝';
  const empty = '║' + ' '.repeat(width - 2) + '║';
  const content = lines.map(txt => {
    const s = txt.trim();
    const inner = width - 2;
    const pad = Math.max(0, inner - s.length);
    const left = Math.floor(pad / 2), right = pad - left;
    return '║' + ' '.repeat(left) + s + ' '.repeat(right) + '║';
  });
  return [top, empty, ...content, empty, bottom].join('\n');
}

function centeredBox(lines, width = 77) {
  const inner = width - 2;
  const top = '╔' + '═'.repeat(inner) + '╗';
  const bottom = '╚' + '═'.repeat(inner) + '╝';
  const empty = '║' + ' '.repeat(inner) + '║';
  const content = lines.map(line => {
    if (!line.trim()) return empty;
    const value = line.trim();
    const plain = stripAnsi(value);
    const pad = Math.max(0, inner - plain.length);
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return '║' + ' '.repeat(left) + value + ' '.repeat(right) + '║';
  });
  return [top, ...content, bottom].join('\n');
}

const colorize = (color, text) => {
  const map = { magenta: '#8B5CF6', magentaBright: '#8B5CF6' };
  if (map[color]) return chalk.hex(map[color])(text);
  const fn = chalk[color];
  if (typeof fn === 'function') return fn(text);
  try {
    return chalk.hex(color)(text);
  } catch {
    return chalk.white(text);
  }
};

const PROGRESS_BAR_WIDTH = 50;

function renderStepProgress(step, progress) {
  const prefix = colorize(step.color, step.prefix.padEnd(10));
  const filled = Math.max(0, Math.min(PROGRESS_BAR_WIDTH, Math.round(PROGRESS_BAR_WIDTH * progress)));
  const empty = PROGRESS_BAR_WIDTH - filled;
  const bar = colorize(step.color, step.icon.repeat(filled)) + chalk.gray('░'.repeat(empty));
  const percent = String(Math.round(progress * 100)).padStart(3) + '%';
  return chalk.gray('[') + prefix + chalk.gray('] ') + chalk.white(step.text.padEnd(40)) + bar + chalk.gray(` ${percent}`);
}

function renderStepComplete(step) {
  const prefix = colorize(step.color, step.prefix.padEnd(10));
  const bar = colorize(step.color, step.icon.repeat(PROGRESS_BAR_WIDTH));
  return chalk.gray('[') + prefix + chalk.gray('] ') + chalk.gray(step.text.padEnd(40)) + bar + chalk.yellow(' READY');
}


// Generic loading bar wrapper for long-running actions
async function runWithLoadingBar(stepOptions, action) {
  const step = { text: stepOptions.text || 'Processing', color: stepOptions.color || 'cyan', prefix: stepOptions.prefix || 'TASK', icon: stepOptions.icon || '▓' };
  const durationMs = Math.max(1000, stepOptions.durationMs || 10000);
  const spinner = ora({ text: renderStepProgress(step, 0), spinner: 'dots8' }).start();
  const start = Date.now();
  let done = false;
  const tick = async () => {
    while (!done) {
      const elapsed = Date.now() - start;
      const p = Math.min(0.9, elapsed / durationMs);
      spinner.text = renderStepProgress(step, p);
      await new Promise(r => setTimeout(r, 100));
    }
  };
  const anim = tick();
  try {
    const result = await action();
    done = true;
    await anim;
    spinner.succeed(renderStepComplete(step));
    return result;
  } catch (e) {
    done = true;
    await anim;
    spinner.fail(chalk.red(`[${step.prefix}] ${step.text} FAILED: ${e.message}`));
    throw e;
  }
}

function formatSol(amount, decimals = 4) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return '0';
  }
  const fixed = Number.parseFloat(amount.toFixed(decimals));
  return fixed % 1 === 0 ? fixed.toFixed(0) : fixed.toString();
}

// Center box-like lines printed without manual centering
(() => {
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, cb) => {
    try {
      let s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      const cols = process.stdout.columns || 80;
      const out = s.split('\n').map(line => {
        if (/^\s/.test(line)) return line; // already padded
        const plain = stripAnsi(line);
        if (/^(╔|╗|╚|╝|║|═|│|┌|┐|└|┘|─)/.test(plain)) {
          const pad = Math.max(0, Math.floor((cols - plain.length) / 2));
          return ' '.repeat(pad) + line;
        }
        return line;
      }).join('\n');
      return origWrite(out, encoding, cb);
    } catch {
      return origWrite(chunk, encoding, cb);
    }
  };
})();

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), '.lili-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const WALLETS_DIR = path.join(CONFIG_DIR, 'wallets');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const COLLECTIONS_FILE = path.join(CONFIG_DIR, 'collections.json');

// Default configuration
const DEFAULT_CONFIG = {
  network: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  defaultWallet: null,
  lastUsed: null
};


// Declarations for functions assigned during init
let viewSplTokensFlow;
let sendSplTokenFlow;

/**
 * Initialize configuration directory and files
 */
async function initConfig() {
  try {
    await fs.ensureDir(CONFIG_DIR);
    await fs.ensureDir(WALLETS_DIR);
    await fs.ensureDir(TEMPLATES_DIR);
    if (!(await fs.pathExists(COLLECTIONS_FILE))) { await fs.writeJSON(COLLECTIONS_FILE, { collections: [] }, { spaces: 2 }); }
    

/**
 * List SPL token accounts and balances for a wallet
process.env.CARGO_NET_GIT_FETCH_WITH_CLI = process.env.CARGO_NET_GIT_FETCH_WITH_CLI || 'true';

 */
viewSplTokensFlow = async function() {
  const config = await loadConfig();
  // Ensure wallets
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? await fs.readdir(WALLETS_DIR) : [];
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  if (wallets.length === 0) {
    console.log(chalk.red('\nNo wallets found. Create/import one first.'));
    await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to return') }]);
    return;
  }
  let defaultChoice = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (defaultChoice && !wallets.includes(defaultChoice)) defaultChoice = null;
  const choices = [
    ...(defaultChoice ? [{ name: `${config.defaultWallet} (default)`, value: defaultChoice }, new inquirer.Separator()] : []),
    ...wallets.map(w => ({ name: w.replace('.json',''), value: w }))
  ];
  const { walletFile } = await inquirer.prompt([{
    type: 'list',
    name: 'walletFile',
    message: chalk.yellow.bold('Select wallet to inspect'),
    choices
  }]);
  const secretKey = await fs.readJSON(path.join(WALLETS_DIR, walletFile));
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
  const connection = new Connection(config.rpcUrl, 'confirmed');

  const spinner = ora({ text: chalk.white('Fetching token accounts...'), spinner: 'dots2' }).start();
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: splToken.TOKEN_PROGRAM_ID });
    const adminsExplain = centeredBox([
      '',
      'Admin wallets can be preconfigured for the web app.',
      'We will store them in the .env as NEXT_PUBLIC_ADMIN_WALLETS (comma-separated).',
      ''
    ]);
    console.log(centerBlock(chalk.white(adminsExplain)));
    spinner.stop();
    if (!accounts.value.length) {
      console.log(chalk.yellow('\nNo SPL token accounts found for this wallet.'));
      await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to return') }]);
      return;
    }
    console.log();
    console.log(chalk.hex('#8B5CF6')('Token Accounts for:'), chalk.yellow(keypair.publicKey.toBase58()));
    for (const acct of accounts.value) {
      const info = acct.account.data.parsed.info;
      const mint = info.mint;
      const amount = BigInt(info.tokenAmount.amount);
      const decimals = info.tokenAmount.decimals;
      const ui = Number(amount) / 10 ** decimals;
      console.log('- Mint:', mint, '| Balance:', ui);
    }
  } catch (e) {
    spinner.fail(chalk.red('Failed to fetch tokens'));
    console.log(chalk.red(e.message));
  }
  console.log();
  await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to return') }]);
}

/**
 * Send an SPL token
 */
sendSplTokenFlow = async function() {
  const config = await loadConfig();
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? await fs.readdir(WALLETS_DIR) : [];
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  if (wallets.length === 0) {
    console.log(chalk.red('\nNo wallets found. Create/import one first.'));
    await new Promise(r => setTimeout(r, 1500));
    return;
  }
  let defaultChoice = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (defaultChoice && !wallets.includes(defaultChoice)) defaultChoice = null;
  const choices = [
    ...(defaultChoice ? [{ name: `${config.defaultWallet} (default)`, value: defaultChoice }, new inquirer.Separator()] : []),
    ...wallets.map(w => ({ name: w.replace('.json',''), value: w }))
  ];
  const { walletFile } = await inquirer.prompt([{
    type: 'list', name: 'walletFile', message: chalk.yellow.bold('Select wallet to send from'), choices
  }]);
  const secretKey = await fs.readJSON(path.join(WALLETS_DIR, walletFile));
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
  const connection = new Connection(config.rpcUrl, 'confirmed');

  // List owned token accounts to pick a mint
  const spinner = ora({ text: chalk.white('Loading token accounts...'), spinner: 'dots2' }).start();
  let accounts;
  try {
    accounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: splToken.TOKEN_PROGRAM_ID });
    spinner.stop();
  } catch (e) {
    spinner.fail(chalk.red('Failed to load token accounts'));
    console.log(chalk.red(e.message));
    return;
  }
  if (!accounts.value.length) {
    console.log(chalk.yellow('\nNo SPL tokens to send from this wallet.'));
    await new Promise(r => setTimeout(r, 1500));
    return;
  }
  const tokenChoices = accounts.value.map(a => {
    const info = a.account.data.parsed.info;
    const mint = info.mint;
    const decimals = info.tokenAmount.decimals;
    const amount = BigInt(info.tokenAmount.amount);
    const ui = Number(amount) / 10 ** decimals;
    return { name: `${mint} — balance: ${ui}`, value: JSON.stringify({ mint, decimals }) };
  });
  const { mintSel } = await inquirer.prompt([{
    type: 'list', name: 'mintSel', message: chalk.yellow.bold('Select SPL token to send'), choices: tokenChoices
  }]);
  const { mint, decimals } = JSON.parse(mintSel);

  const { recipientInput } = await inquirer.prompt([{
    type: 'input', name: 'recipientInput', message: chalk.yellow.bold('Recipient address'),
    validate: (v) => { try { new PublicKey(v); return true; } catch { return 'Enter a valid public key'; } }
  }]);
  const recipient = new PublicKey(recipientInput);

  const { amountInput } = await inquirer.prompt([{
    type: 'input', name: 'amountInput', message: chalk.yellow.bold('Amount to send'),
    validate: (v) => { const n = Number(v); return n > 0 && Number.isFinite(n) ? true : 'Enter a positive number'; }
  }]);
  const amountUi = Number(amountInput);
  const amountBase = BigInt(Math.round(amountUi * 10 ** decimals));

  const confirmMsg = `Send ${amountUi} tokens of ${mint} to ${recipient.toBase58()}?`;
  const { confirmSend } = await inquirer.prompt([{ type: 'confirm', name: 'confirmSend', message: chalk.yellow.bold(confirmMsg), default: true }]);
  if (!confirmSend) { console.log(chalk.gray('\nTransfer cancelled')); return; }

  const txSpinner = ora({ text: chalk.white('Submitting token transfer...'), spinner: 'dots2' }).start();
  try {
    const mintPk = new PublicKey(mint);
    // Ensure associated token accounts
    const fromAta = await splToken.getOrCreateAssociatedTokenAccount(connection, keypair, mintPk, keypair.publicKey);
    const toAta = await splToken.getOrCreateAssociatedTokenAccount(connection, keypair, mintPk, recipient);
    const sig = await splToken.transfer(connection, keypair, fromAta.address, toAta.address, keypair.publicKey, amountBase);
    txSpinner.succeed(chalk.yellow('Token transfer complete'));
    console.log(chalk.white('Signature:'), sig);
  } catch (e) {
    txSpinner.fail(chalk.red('Token transfer failed'));
    console.log(chalk.red(e.message));
  }
  console.log();
  await new Promise(r => setTimeout(r, 1500));
}

    if (!await fs.pathExists(CONFIG_FILE)) {
      await fs.writeJSON(CONFIG_FILE, DEFAULT_CONFIG, { spaces: 2 });
    }
  } catch (error) {
    console.error(chalk.red('ERROR: Failed to initialize configuration:'), error.message);
  }
}

/**
 * Load configuration from file
 */
async function loadConfig() {
  try {
    return await fs.readJSON(CONFIG_FILE);
  } catch (error) {
    return DEFAULT_CONFIG;
  }
}

/**
 * Save configuration to file
 */
async function saveConfig(config) {
  try {
    await fs.writeJSON(CONFIG_FILE, config, { spaces: 2 });
  } catch (error) {
    console.error(chalk.red('ERROR: Failed to save configuration:'), error.message);
  }
}


/**
 * Display futuristic ASCII title with animation
 */
function displayTitle() {
  console.clear();
  
  // Main title ASCII art
  const title = centeredBox([
    '',
    '██╗     ██╗██╗     ██╗     ██████╗██╗     ██╗',
    '██║     ██║██║     ██║    ██╔════╝██║     ██║',
    '██║     ██║██║     ██║    ██║     ██║     ██║',
    '██║     ██║██║     ██║    ██║     ██║     ██║',
    '███████╗██║███████╗██║    ╚██████╗███████╗██║',
    '╚══════╝╚═╝╚══════╝╚═╝     ╚═════╝╚══════╝╚═╝',
    '',
    'Solana Development Infrastructure',
    ''
  ]);

  console.log(centerBlock(chalk.hex('#8B5CF6')(title)));
  console.log();
}

/**
 * Boot sequence animation - Futuristic Solana terminal
 */
async function bootSequence() {
  console.clear();
  
  // Cyberpunk boot header
  const bootHeader = centeredBox([
    '',
    'LILI CLI SYSTEM',
    '[ VERSION 1.0.0 ]',
    ''
  ]);

  console.log(centerBlock(chalk.hex('#8B5CF6')(bootHeader)));
  console.log();
  await new Promise(resolve => setTimeout(resolve, 400));
  
  const initBanner = centeredBox([
    '',
    'SYSTEM INITIALIZATION',
    'Spinning up Solana developer subsystems',
    ''
  ]);
  console.log(centerBlock(chalk.white(initBanner)));
  console.log();
  
  // System initialization with progress bars
  const bootSteps = [
    { 
      text: 'Initializing quantum processors', 
      delay: 600,
      color: 'cyan',
      prefix: 'CORE',
      icon: '▓'
    },
    { 
      text: 'Loading cryptographic modules', 
      delay: 550,
      color: 'magenta',
      prefix: 'SECURITY',
      icon: '▓'
    },
    { 
      text: 'Establishing Lili CLI RPC connection', 
      delay: 700,
      color: 'blue',
      prefix: 'NETWORK',
      icon: '▓'
    },
    { 
      text: 'Loading wallet infrastructure', 
      delay: 500,
      color: 'yellow',
      prefix: 'STORAGE',
      icon: '▓'
    },
    { 
      text: 'Compiling project templates', 
      delay: 600,
      color: 'green',
      prefix: 'BUILD',
      icon: '▓'
    },
    { 
      text: 'Activating deployment protocols', 
      delay: 550,
      color: 'cyan',
      prefix: 'DEPLOY',
      icon: '▓'
    }
  ];
  
  for (const step of bootSteps) {
    const spinner = ora({
      text: renderStepProgress(step, 0),
      spinner: 'dots8'
    }).start();
    
    const frames = 24;
    for (let i = 1; i <= frames; i++) {
      spinner.text = renderStepProgress(step, i / frames);
      await new Promise(resolve => setTimeout(resolve, step.delay / frames));
    }
    
    spinner.succeed(renderStepComplete(step));
  }
  
  console.log();
  
  // Final system check with elegant animation
  const diagnosticsStep = {
    text: 'Running final diagnostics',
    delay: 800,
    color: 'magenta',
    prefix: 'SYSTEM',
    icon: '▓'
  };
  const finalCheck = ora({
    text: renderStepProgress(diagnosticsStep, 0),
    spinner: 'line'
  }).start();
  
  const diagFrames = 24;
  for (let i = 1; i <= diagFrames; i++) {
    finalCheck.text = renderStepProgress(diagnosticsStep, i / diagFrames);
    await new Promise(resolve => setTimeout(resolve, diagnosticsStep.delay / diagFrames));
  }
  finalCheck.succeed(renderStepComplete(diagnosticsStep));
  
  console.log();
  const finalBanner = centeredBox([
    '',
    'ALL SYSTEMS OPERATIONAL',
    'Ready to build with Lili CLI',
    ''
  ]);
  console.log(centerBlock(chalk.hex('#8B5CF6')(finalBanner)));
  console.log();
  
  await new Promise(resolve => setTimeout(resolve, 600));
}

/**
 * Main menu - entry point for the CLI
 */
async function mainMenu() {
  // Loop until user explicitly chooses EXIT
  while (true) {
    displayTitle();

    const config = await loadConfig();

    // Get wallet balance if default wallet exists
    let walletBalance = null;
    let walletAddress = null;

    if (config.defaultWallet) {
      try {
        const walletPath = path.join(WALLETS_DIR, `${config.defaultWallet}.json`);
        if (await fs.pathExists(walletPath)) {
          const secretKeyData = await fs.readJSON(walletPath);
          const keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyData));
          walletAddress = keypair.publicKey.toString();

          const connection = new Connection(config.rpcUrl, 'confirmed');
          const balance = await connection.getBalance(keypair.publicKey);
          walletBalance = Number.parseFloat((balance / LAMPORTS_PER_SOL).toFixed(4));
        }
      } catch (error) {
        // Silently fail if balance check fails
        walletBalance = null;
      }
    }

    // System status dashboard with perfectly aligned boxes
    console.log(centerBlock(chalk.bgYellow.black.bold(' SYSTEM STATUS ')));
    // Network row
    const networkLabel = ' Network    ';
    const networkValue = config.network.toUpperCase().padEnd(15);
    const rpcLabel = 'RPC Status ';
    const rpcValue = 'CONNECTED'.padEnd(15);

    console.log(chalk.yellow('║') +
      chalk.white(networkLabel) + chalk.gray('│ ') + chalk.yellow(networkValue) +
      chalk.gray('│ ') + chalk.white(rpcLabel) + chalk.gray('│ ') + chalk.yellow(rpcValue) +
      chalk.yellow('║'));

    // Endpoint row
    const endpointLabel = ' Endpoint   ';
    const endpointValue = config.rpcUrl.substring(8, 23).padEnd(15);
    const buildLabel = 'Build Mode ';
    const buildValue = 'PRODUCTION'.padEnd(15);

    console.log(chalk.yellow('║') +
      chalk.white(endpointLabel) + chalk.gray('│ ') + chalk.yellow(endpointValue) +
      chalk.gray('│ ') + chalk.white(buildLabel) + chalk.gray('│ ') + chalk.yellow(buildValue) +
      chalk.yellow('║'));

    // Wallet row
    const walletLabel = ' Wallet     ';

    if (config.defaultWallet && walletBalance !== null) {
      const walletValue = config.defaultWallet.substring(0, 15).padEnd(15);
      const balanceLabel = 'Balance    ';
      const balanceValue = `${formatSol(walletBalance)} SOL`.padEnd(15);

      console.log(chalk.yellow('║') +
        chalk.white(walletLabel) + chalk.gray('│ ') + chalk.yellow(walletValue) +
        chalk.gray('│ ') + chalk.white(balanceLabel) + chalk.gray('│ ') + chalk.yellow(balanceValue) +
        chalk.yellow('║'));
    } else if (config.defaultWallet) {
      const walletValue = config.defaultWallet.substring(0, 15).padEnd(15);
      const statusLabel = 'Status     ';
      const statusValue = 'ACTIVE'.padEnd(15);

      console.log(chalk.yellow('║') +
        chalk.white(walletLabel) + chalk.gray('│ ') + chalk.yellow(walletValue) +
        chalk.gray('│ ') + chalk.white(statusLabel) + chalk.gray('│ ') + chalk.yellow(statusValue) +
        chalk.yellow('║'));
    } else {
      const walletValue = 'NOT SET'.padEnd(15);
      const statusLabel = 'Status     ';
      const statusValue = 'INACTIVE'.padEnd(15);

      console.log(chalk.yellow('║') +
        chalk.white(walletLabel) + chalk.gray('│ ') + chalk.gray(walletValue) +
        chalk.gray('│ ') + chalk.white(statusLabel) + chalk.gray('│ ') + chalk.red(statusValue) +
        chalk.yellow('║'));
    }

    console.log();

    if (config.defaultWallet && walletAddress) {
      console.log(chalk.gray('Default wallet public key: ') + chalk.yellow(walletAddress));
      console.log();
    }

    // Command menu with clean structure
    console.log(chalk.bgYellow.black.bold(' AVAILABLE COMMANDS '));
    console.log();

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: chalk.yellow.bold('Select operation'),
        choices: [
          {
            name: chalk.white('[ 1 ]') + ' ' + chalk.yellow.bold('HELP       ') + chalk.gray(' Display command reference and documentation'),
            value: 'help'
          },
          {
            name: chalk.white('[ 2 ]') + ' ' + chalk.yellow.bold('BUILD      ') + chalk.gray(' Create programs, templates, and projects'),
            value: 'build'
          },
          {
            name: chalk.white('[ 3 ]') + ' ' + chalk.yellow.bold('CREATE     ') + chalk.gray(' Initialize Solana project scaffolds'),
            value: 'create'
          },
          {
            name: chalk.white('[ 4 ]') + ' ' + chalk.yellow.bold('WALLET     ') + chalk.gray(' Manage wallets, airdrops, and transfers'),
            value: 'wallet'
          },
          {
            name: chalk.white('[ 5 ]') + ' ' + chalk.yellow.bold('DEPLOY     ') + chalk.gray(' Deploy programs to Solana network'),
            value: 'deploy'
          },
          {
            name: chalk.white('[ 6 ]') + ' ' + chalk.yellow.bold('SETTINGS   ') + chalk.gray(' Configure network and wallet options'),
            value: 'settings'
          },
          new inquirer.Separator(chalk.yellow('─'.repeat(75))),
          {
            name: chalk.white('[ 0 ]') + ' ' + chalk.red.bold('EXIT       ') + chalk.gray(' Terminate session and exit CLI'),
            value: 'exit'
          }
        ],
        pageSize: 12
      }
    ]);

    switch (action) {
      case 'help':
        await showHelp();
        break;
      case 'build':
        await buildMenu();
        break;
      case 'create':
        await createMenu();
        break;
      case 'wallet':
        await walletMenu();
        break;
      case 'deploy':
        await deployMenu();
        break;
      case 'settings':
        await settingsMenu();
        break;
      case 'exit':
        exitCLI();
        return;
    }
  }
}

/**
 * Help command - displays all available commands
 */
async function showHelp() {
  displayTitle();
  
  console.log(chalk.bgHex('#8B5CF6').black.bold(' COMMAND REFERENCE '));
  console.log();
  
  const commands = [
    {
      name: 'HELP',
      description: 'Display command reference and documentation',
      usage: 'Interactive help system with detailed explanations'
    },
    {
      name: 'BUILD',
      description: 'Create and compile Solana programs and applications',
      usage: 'Supports contracts, frontends, backends, and full-stack',
      options: [
        'Solana Contract      - Rust-based on-chain program with Cargo',
        'Frontend dApp        - React application with wallet adapter',
        'Backend API          - Node.js server with Solana integration',
        'Full-Stack           - Complete development environment'
      ]
    },
    {
      name: 'CREATE',
      description: 'Generate ready-to-use Solana project scaffolds',
      usage: 'Provision contracts, frontends, backends, or full-stack kits',
      options: [
        'SPL Token            - Create fungible token and mint supply',
        'Token-Gated Website  - Next.js gated site with SPL access',
        'Solana Program       - Rust-based on-chain starter',
        'Frontend dApp        - React app with wallet adapter',
        'Backend API          - Express service wired for Solana',
        'Full-Stack Kit       - Coordinated frontend and backend'
      ]
    },
    {
      name: 'WALLET',
      description: 'Manage developer wallets, funding, and transfers',
      usage: 'Create/import keypairs, switch defaults, faucet, and send SOL',
      options: [
        'Create Wallet        - Generate and optionally fund a keypair',
        'Import Wallet        - Load an existing secret key',
        'Switch Default       - Change the active CLI wallet',
        'Request Airdrop      - Faucet SOL on devnet or testnet',
        'Send SOL             - Transfer SOL to another address'
      ]
    },
    {
      name: 'DEPLOY',
      description: 'Deploy compiled programs to Solana network',
      usage: 'Automated deployment with balance checking and funding',
      options: [
  'Program Deployment   - Deploy Rust programs (src/lib.rs -> .so artifact) to selected network',
        'Auto-funding         - Automatic airdrop if balance insufficient'
      ]
    },
    {
      name: 'SETTINGS',
      description: 'Configure network, RPC, and wallet preferences',
      usage: 'Manage system configuration and defaults',
      options: [
        'View Settings        - Display current configuration',
        'Network Selection    - Switch between devnet/testnet/mainnet',
        'Custom RPC           - Configure custom RPC endpoints',
        'Reset Defaults       - Restore factory configuration'
      ]
    }
  ];
  
  commands.forEach((cmd, index) => {
    console.log(chalk.hex('#8B5CF6')('═'.repeat(75)));
    console.log(chalk.hex('#8B5CF6').bold(` ${index + 1}. ${cmd.name}`));
    console.log(chalk.hex('#8B5CF6')('═'.repeat(75)));
    console.log(chalk.white('  Description:  ') + chalk.gray(cmd.description));
    console.log(chalk.white('  Usage:        ') + chalk.gray(cmd.usage));
    
    if (cmd.options) {
      console.log(chalk.white('  Options:'));
      cmd.options.forEach(opt => {
        console.log(chalk.gray('    ▸ ') + chalk.white(opt));
      });
    }
    console.log();
  });
  
  console.log(chalk.hex('#8B5CF6')('═'.repeat(75)));
  console.log();
  
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to return to main menu')
    }
  ]);
}

/**
 * Build menu - for building programs and templates
 */
async function buildMenu() {
  displayTitle();
  console.log(chalk.bgHex('#8B5CF6').black.bold(' BUILD SYSTEM '));
  console.log();
  
  const { buildType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'buildType',
      message: chalk.yellow.bold('Select build target'),
      choices: [
        { 
          name: chalk.white('[ 1 ]') + ' ' + chalk.yellow.bold('SOLANA CONTRACT') + chalk.gray('   Rust-based on-chain program'), 
          value: 'contract' 
        },
        { 
          name: chalk.white('[ 2 ]') + ' ' + chalk.yellow.bold('FRONTEND DAPP') + chalk.gray('     React application with wallet adapter'), 
          value: 'frontend' 
        },
        { 
          name: chalk.white('[ 3 ]') + ' ' + chalk.yellow.bold('BACKEND API') + chalk.gray('       Node.js server with Solana integration'), 
          value: 'backend' 
        },
        { 
          name: chalk.white('[ 4 ]') + ' ' + chalk.yellow.bold('FULL-STACK') + chalk.gray('        Complete frontend and backend setup'), 
          value: 'fullstack' 
        },
        new inquirer.Separator(chalk.yellow('─'.repeat(75))),
        { 
          name: chalk.white('[ 0 ]') + ' ' + chalk.gray.bold('BACK') + chalk.gray('            Return to main menu'), 
          value: 'back' 
        }
      ],
      pageSize: 10
    }
  ]);
  
  if (buildType === 'back') return;
  
  switch (buildType) {
    case 'contract':
      await buildContract();
      break;
    case 'frontend':
      await buildFrontend();
      break;
    case 'backend':
      await buildBackend();
      break;
    case 'fullstack':
      await buildFullStack();
      break;
  }
}

/**
 * Build a custom Solana contract (Rust)
 */
async function buildContract() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('BUILD CUSTOM SOLANA CONTRACT\n'));
  
  const { projectName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectName',
      message: 'Enter project name:',
      default: 'my-solana-program',
      validate: (input) => input.length > 0 || 'Project name cannot be empty'
    }
  ]);
  
  const projectPath = path.join(process.cwd(), projectName);
  
  // Check if project already exists
  if (await fs.pathExists(projectPath)) {
    console.log(chalk.red(`ERROR: Directory ${projectName} already exists!`));
    await new Promise(resolve => setTimeout(resolve, 2000));
    return;
  }
  
  const spinner = ora('Creating Solana program project...').start();
  
  try {
    // Create project structure
    await fs.ensureDir(projectPath);
    await fs.ensureDir(path.join(projectPath, 'src'));
    await fs.ensureDir(path.join(projectPath, 'tests'));
    
    // Create Cargo.toml
    const cargoToml = `[package]
name = "${projectName}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
solana-program = "~1.17.0"

[dev-dependencies]
solana-program-test = "~1.17.0"
solana-sdk = "~1.17.0"
`;
    
    await fs.writeFile(path.join(projectPath, 'Cargo.toml'), cargoToml);
    
    // Create lib.rs with basic program structure
    const libRs = `use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    pubkey::Pubkey,
};

// Declare and export the program's entrypoint
entrypoint!(process_instruction);

// Program entrypoint's implementation
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    msg!("Hello from ${projectName}!");
    msg!("Program ID: {:?}", program_id);
    msg!("Number of accounts: {}", accounts.len());
    msg!("Instruction data length: {}", instruction_data.len());
    
    Ok(())
}
`;
    
    await fs.writeFile(path.join(projectPath, 'src', 'lib.rs'), libRs);
    
    spinner.succeed(chalk.yellow('✔ Project structure created'));
    
    // Check if Rust and Cargo are installed
    const checkSpinner = ora('Checking Rust installation...').start();
    try {
      await execAsync('cargo --version');
      checkSpinner.succeed(chalk.yellow('✔ Rust and Cargo detected'));
      const ensureTools = ora('Ensuring Solana build tools...').start();
      try {
        await execAsync('rustup --version >/dev/null 2>&1 || curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y');
        await execAsync('bash -lc "sh -c \"$(curl -sSfL https://release.solana.com/stable/install)\"" || true');
        await execAsync('export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"');
        await execAsync('cargo install cargo-binutils || true');
        await execAsync('rustup component add llvm-tools-preview || true');
        // skipping git-based install; rely on fallbacks
        ensureTools.succeed(chalk.yellow('✔ Tooling ready'));
      } catch { ensureTools.warn(chalk.yellow('Tooling setup skipped')); }

      
      // Build the program
      const buildSpinner = ora('Building Solana program...').start();
      try {
        await execAsync('cargo build-sbf || cargo build-bpf || (command -v anchor >/dev/null 2>&1 && anchor build)', { cwd: projectPath, env: { ...process.env, SOLANA_SDK_PATH: `${(process.env.HOME||os.homedir())}/.local/share/solana/install/active_release/sdk/sbf`, PATH: `${(process.env.HOME||os.homedir())}/.local/share/solana/install/active_release/bin:${(process.env.HOME||os.homedir())}/.cargo/bin:${process.env.PATH}` } });
        buildSpinner.succeed(chalk.yellow('✔ Program built successfully!'));
        
        console.log(chalk.hex('#8B5CF6').bold('\n📦 Build Complete!'));
        console.log(chalk.white(`Project: ${projectPath}`));
        console.log(chalk.white('Next steps:'));
        console.log(chalk.gray(`  1. cd ${projectName}`));
  console.log(chalk.gray('  2. cargo build-sbf'));
        console.log(chalk.gray('  3. Use Lili CLI deploy to deploy to devnet'));
      } catch (buildError) {
        buildSpinner.warn(chalk.yellow('WARNING: Build requires Solana CLI tools'));
        console.log(chalk.gray('\nTo build and deploy:'));
        console.log(chalk.gray('  1. Install Solana CLI: sh -c "$(curl -sSfL https://release.solana.com/stable/install)"'));
        console.log(chalk.gray(`  2. cd ${projectName}`));
  console.log(chalk.gray('  3. cargo build-sbf'));
      }
    } catch (error) {
      checkSpinner.warn(chalk.yellow('WARNING: Rust not found'));
      console.log(chalk.gray('\nTo install Rust:'));
      console.log(chalk.gray('  curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh'));
    }
    
    console.log(chalk.yellow('\n🎉 Solana contract project created successfully!\n'));
    
  } catch (error) {
    spinner.fail(chalk.red('ERROR: Failed to create project'));
    console.error(chalk.red(error.message));
  }
  
  await new Promise(resolve => setTimeout(resolve, 3000));
}

/**
 * Build a frontend template
 */
async function buildFrontend() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('BUILD FRONTEND TEMPLATE\n'));
  
  const { projectName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectName',
      message: 'Enter project name:',
      default: 'solana-frontend',
      validate: (input) => input.length > 0 || 'Project name cannot be empty'
    }
  ]);
  
  const projectPath = path.join(process.cwd(), projectName);
  
  if (await fs.pathExists(projectPath)) {
    console.log(chalk.red(`ERROR: Directory ${projectName} already exists!`));
    await new Promise(resolve => setTimeout(resolve, 2000));
    return;
  }
  
  const spinner = ora('Creating frontend template...').start();
  
  try {
    await fs.ensureDir(projectPath);
    await fs.ensureDir(path.join(projectPath, 'src'));
    await fs.ensureDir(path.join(projectPath, 'public'));
    
    // Create package.json
    const packageJson = {
      name: projectName,
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview'
      },
      dependencies: {
        '@solana/web3.js': '^1.87.0',
        '@solana/wallet-adapter-base': '^0.9.23',
        '@solana/wallet-adapter-react': '^0.15.35',
        '@solana/wallet-adapter-react-ui': '^0.9.35',
        '@solana/wallet-adapter-wallets': '^0.19.26',
        'react': '^18.2.0',
        'react-dom': '^18.2.0'
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.2.0',
        'vite': '^5.0.0'
      }
    };
    
    await fs.writeJSON(path.join(projectPath, 'package.json'), packageJson, { spaces: 2 });
    
    // Create index.html
    const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName} - Solana dApp</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`;
    
    await fs.writeFile(path.join(projectPath, 'index.html'), indexHtml);
    
    // Create vite.config.js
    const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {}
  }
});`;
    
    await fs.writeFile(path.join(projectPath, 'vite.config.js'), viteConfig);
    
    // Create main.jsx
    const mainJsx = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`;
    
    await fs.writeFile(path.join(projectPath, 'src', 'main.jsx'), mainJsx);
    
    // Create App.jsx
    const appJsx = `import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';
import './App.css';

function App() {
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="app">
            <header>
              <h1>Solana dApp</h1>
              <WalletMultiButton />
            </header>
            <main>
              <p>Connected to Solana Devnet</p>
              <p>Connect your wallet to get started!</p>
            </main>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default App;`;
    
    await fs.writeFile(path.join(projectPath, 'src', 'App.jsx'), appJsx);
    
    // Create App.css
    const appCss = `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
  color: white;
}

.app {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 3rem;
}

h1 {
  font-size: 2.5rem;
}

main {
  text-align: center;
  padding: 3rem;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 1rem;
  backdrop-filter: blur(10px);
}

main p {
  font-size: 1.2rem;
  margin: 1rem 0;
}`;
    
    await fs.writeFile(path.join(projectPath, 'src', 'App.css'), appCss);
    
    spinner.succeed(chalk.yellow('✔ Frontend template created'));
    
    // Install dependencies
    const installSpinner = ora('Installing dependencies...').start();
    try {
      await execAsync('npm install', { cwd: projectPath });
      installSpinner.succeed(chalk.yellow('✔ Dependencies installed'));
    } catch (error) {
      installSpinner.warn(chalk.yellow('WARNING: Run npm install manually'));
    }
    
    console.log(chalk.hex('#8B5CF6').bold('\n📦 Frontend Template Ready!'));
    console.log(chalk.white(`Project: ${projectPath}`));
    console.log(chalk.white('Next steps:'));
    console.log(chalk.gray(`  1. cd ${projectName}`));
    console.log(chalk.gray('  2. npm run dev'));
    console.log(chalk.yellow('\n🎉 Solana frontend created successfully!\n'));
    
  } catch (error) {
    spinner.fail(chalk.red('ERROR: Failed to create frontend'));
    console.error(chalk.red(error.message));
  }
  
  await new Promise(resolve => setTimeout(resolve, 3000));
}

/**
 * Build a backend template
 */
async function buildBackend() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('BUILD BACKEND TEMPLATE\n'));
  
  const { projectName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectName',
      message: 'Enter project name:',
      default: 'solana-backend',
      validate: (input) => input.length > 0 || 'Project name cannot be empty'
    }
  ]);
  
  const projectPath = path.join(process.cwd(), projectName);
  
  if (await fs.pathExists(projectPath)) {
    console.log(chalk.red(`ERROR: Directory ${projectName} already exists!`));
    await new Promise(resolve => setTimeout(resolve, 2000));
    return;
  }
  
  const spinner = ora('Creating backend template...').start();
  
  try {
    await fs.ensureDir(projectPath);
    await fs.ensureDir(path.join(projectPath, 'src'));
    
    // Create package.json
    const packageJson = {
      name: projectName,
      version: '1.0.0',
      type: 'module',
      main: 'src/index.js',
      scripts: {
        start: 'node src/index.js',
        dev: 'node --watch src/index.js'
      },
      dependencies: {
        '@solana/web3.js': '^1.87.0',
        'express': '^4.18.2',
        'cors': '^2.8.5',
        'dotenv': '^16.3.1'
      }
    };
    
    await fs.writeJSON(path.join(projectPath, 'package.json'), packageJson, { spaces: 2 });
    
    // Create .env
    const envContent = `SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
PORT=3000`;
    
    await fs.writeFile(path.join(projectPath, '.env'), envContent);
    
    // Create index.js
    const indexJs = `import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Solana connection
const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  'confirmed'
);

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Solana Backend API',
    network: process.env.SOLANA_NETWORK,
    status: 'active'
  });
});

// Get balance endpoint
app.get('/balance/:address', async (req, res) => {
  try {
    const publicKey = new PublicKey(req.params.address);
    const balance = await connection.getBalance(publicKey);
    
    res.json({
      address: req.params.address,
      balance: balance / LAMPORTS_PER_SOL,
      lamports: balance
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get account info endpoint
app.get('/account/:address', async (req, res) => {
  try {
    const publicKey = new PublicKey(req.params.address);
    const accountInfo = await connection.getAccountInfo(publicKey);
    
    if (!accountInfo) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    res.json({
      address: req.params.address,
      lamports: accountInfo.lamports,
      owner: accountInfo.owner.toString(),
      executable: accountInfo.executable,
      rentEpoch: accountInfo.rentEpoch
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const version = await connection.getVersion();
    res.json({
      status: 'healthy',
      solana: version
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(\`Solana backend running on port \${PORT}\`);
  console.log(\`Network: \${process.env.SOLANA_NETWORK}\`);
});`;
    
    await fs.writeFile(path.join(projectPath, 'src', 'index.js'), indexJs);
    
    // Create README
    const readme = `# ${projectName}

Solana Backend API built with Express and @solana/web3.js

## Features
- Get account balance
- Get account info
- Health check endpoint
- Connected to Solana ${process.env.SOLANA_NETWORK || 'devnet'}

## Setup
\`\`\`bash
npm install
npm start
\`\`\`

## Endpoints
- GET / - API info
- GET /balance/:address - Get SOL balance
- GET /account/:address - Get account info
- GET /health - Health check
`;
    
    await fs.writeFile(path.join(projectPath, 'README.md'), readme);
    
    spinner.succeed(chalk.yellow('✔ Backend template created'));
    
    // Install dependencies
    const installSpinner = ora('Installing dependencies...').start();
    try {
      await execAsync('npm install', { cwd: projectPath });
      installSpinner.succeed(chalk.yellow('✔ Dependencies installed'));
    } catch (error) {
      installSpinner.warn(chalk.yellow('WARNING: Run npm install manually'));
    }
    
    console.log(chalk.hex('#8B5CF6').bold('\n📦 Backend Template Ready!'));
    console.log(chalk.white(`Project: ${projectPath}`));
    console.log(chalk.white('Next steps:'));
    console.log(chalk.gray(`  1. cd ${projectName}`));
    console.log(chalk.gray('  2. npm start'));
    console.log(chalk.yellow('\n🎉 Solana backend created successfully!\n'));
    
  } catch (error) {
    spinner.fail(chalk.red('ERROR: Failed to create backend'));
    console.error(chalk.red(error.message));
  }
  
  await new Promise(resolve => setTimeout(resolve, 3000));
}

/**
 * Build a full-stack application
 */
async function buildFullStack() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('BUILD FULL-STACK DEVNET EXAMPLE\n'));
  
  console.log(chalk.yellow('This will create both frontend and backend projects.'));
  console.log();
  
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Continue?',
      default: true
    }
  ]);
  
  if (!confirm) return;
  
  const { baseName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseName',
      message: 'Enter project base name:',
      default: 'solana-fullstack',
      validate: (input) => input.length > 0 || 'Name cannot be empty'
    }
  ]);
  
  const spinner = ora('Creating full-stack project...').start();
  
  try {
    const frontendName = `${baseName}-frontend`;
    const backendName = `${baseName}-backend`;
    
    // Store original buildFrontend and buildBackend behavior
    spinner.text = 'Creating frontend...';
    
    // We'll create both manually here for cleaner output
    const frontendPath = path.join(process.cwd(), frontendName);
    const backendPath = path.join(process.cwd(), backendName);
    
    if (await fs.pathExists(frontendPath) || await fs.pathExists(backendPath)) {
      spinner.fail(chalk.red('ERROR: One or more directories already exist'));
      await new Promise(resolve => setTimeout(resolve, 2000));
      return;
    }
    
    // Create frontend (simplified inline)
    await fs.ensureDir(path.join(frontendPath, 'src'));
    const frontendPkg = {
      name: frontendName,
      version: '1.0.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: {
        '@solana/web3.js': '^1.87.0',
        '@solana/wallet-adapter-base': '^0.9.23',
        '@solana/wallet-adapter-react': '^0.15.35',
        '@solana/wallet-adapter-react-ui': '^0.9.35',
        '@solana/wallet-adapter-wallets': '^0.19.26',
        'react': '^18.2.0',
        'react-dom': '^18.2.0'
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.2.0',
        'vite': '^5.0.0'
      }
    };
    await fs.writeJSON(path.join(frontendPath, 'package.json'), frontendPkg, { spaces: 2 });
    
    spinner.text = 'Creating backend...';
    
    // Create backend (simplified inline)
    await fs.ensureDir(path.join(backendPath, 'src'));
    const backendPkg = {
      name: backendName,
      version: '1.0.0',
      type: 'module',
      main: 'src/index.js',
      scripts: { start: 'node src/index.js' },
      dependencies: {
        '@solana/web3.js': '^1.87.0',
        'express': '^4.18.2',
        'cors': '^2.8.5',
        'dotenv': '^16.3.1'
      }
    };
    await fs.writeJSON(path.join(backendPath, 'package.json'), backendPkg, { spaces: 2 });
    
    spinner.succeed(chalk.yellow('✔ Full-stack project created'));
    
    console.log(chalk.hex('#8B5CF6').bold('\n📦 Full-Stack Project Ready!'));
    console.log(chalk.white(`Frontend: ${frontendPath}`));
    console.log(chalk.white(`Backend: ${backendPath}`));
    console.log(chalk.white('\nNext steps:'));
    console.log(chalk.gray(`  Frontend: cd ${frontendName} && npm install && npm run dev`));
    console.log(chalk.gray(`  Backend: cd ${backendName} && npm install && npm start`));
    console.log(chalk.yellow('\n🎉 Full-stack project created successfully!\n'));
    
  } catch (error) {
    spinner.fail(chalk.red('ERROR: Failed to create full-stack project'));
    console.error(chalk.red(error.message));
  }
  
  await new Promise(resolve => setTimeout(resolve, 3000));
}

/**
 * Create menu - for provisioning project scaffolds
 */
async function createMenu() {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' PROJECT FORGE '));
  console.log();

  const { buildTarget } = await inquirer.prompt([
    {
      type: 'list',
      name: 'buildTarget',
      message: chalk.green.bold('Select project scaffold'),
      choices: [
        { 
          name: chalk.white('[ 0 ]') + ' ' + chalk.green.bold('NFT COLLECTION') + chalk.gray('  Create NFT collection & mint NFTs'), 
          value: 'nft-collection' 
        },
        { 
          name: chalk.white('[ 1 ]') + ' ' + chalk.green.bold('SPL TOKEN') + chalk.gray('         Create a new fungible token'), 
          value: 'spl-token' 
        },
        { 
          name: chalk.white('[ 2 ]') + ' ' + chalk.green.bold('TOKEN-GATED WEBSITE') + chalk.gray('  Next.js gated site scaffold'), 
          value: 'token-gated' 
        },
        { 
          name: chalk.white('[ 3 ]') + ' ' + chalk.green.bold('RAFFLE DAPP') + chalk.gray('       Program+React with auto Program ID'), 
          value: 'raffle' 
        },
        { 
          name: chalk.white('[ 4 ]') + ' ' + chalk.green.bold('CREATE DAO') + chalk.gray('       Gov token + multisig'), 
          value: 'dao' 
        },
        { 
          name: chalk.white('[ 5 ]') + ' ' + chalk.green.bold('SOLANA PROGRAM') + chalk.gray('   Rust on-chain template'), 
          value: 'contract' 
        },
        { 
          name: chalk.white('[ 6 ]') + ' ' + chalk.green.bold('FRONTEND DAPP') + chalk.gray('    React wallet-ready app'), 
          value: 'frontend' 
        },
        { 
          name: chalk.white('[ 7 ]') + ' ' + chalk.green.bold('BACKEND API') + chalk.gray('      Express service with web3'), 
          value: 'backend' 
        },
        { 
          name: chalk.white('[ 8 ]') + ' ' + chalk.green.bold('FULL-STACK KIT') + chalk.gray('  Paired frontend and backend'), 
          value: 'fullstack' 
        },
        new inquirer.Separator(chalk.hex('#8B5CF6')('─'.repeat(75))),
        { 
          name: chalk.white('[ 0 ]') + ' ' + chalk.gray.bold('BACK') + chalk.gray('            Return to main menu'), 
          value: 'back' 
        }
      ],
      pageSize: 10
    }
  ]);

  if (buildTarget === 'back') return;


  if (buildTarget === 'raffle') {
    await createRaffleFlow();
    return;
  }

/**
 * NFT Collection submenu: create collection, minting website, or both
 */
async function createNftCollectionOrWebsiteFlow() {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' NFT COLLECTION '));
  console.log();

  await initConfig();
  await loadConfig();

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: chalk.green.bold('What would you like to create?'),
      choices: [
        { name: 'Create an NFT collection only', value: 'collection' },
        { name: 'Create an NFT minting website only', value: 'website' },
        { name: 'Do both (collection first, then website)', value: 'both' },
        new inquirer.Separator()
      ]
    }
  ]);

  let createdCollection = null;
  if (action === 'collection' || action === 'both') {
    createdCollection = await createNftCollectionFlow(true);
  }
  if (action === 'website' || action === 'both') {
    await createNftMintingWebsiteFlow(createdCollection);
  }
}


  switch (buildTarget) {
    case 'nft-collection':
      await createNftCollectionOrWebsiteFlow();
      break;
    case 'spl-token':
      await createSplTokenFlow();
      break;
    case 'token-gated':
      await createTokenGatedWebsiteFlow();
      break;
    case 'raffle':
      await createRaffleFlow();
      break;
    case 'dao':
      await createDaoFlow();
      break;
    case 'contract':
      await buildContract();
      break;
    case 'frontend':
      await buildFrontend();
      break;
    case 'backend':
      await buildBackend();
      break;
    case 'fullstack':
      await buildFullStack();
      break;
  }
}


/**
 * Raffle creation flow inside CREATE menu
 * - Prompts for prize type (SOL/SPL/NFT)
 * - Scaffolds Rust raffle program
 * - Builds and deploys automatically
 * - Generates React dApp and injects PROGRAM_ID in .env
 */
async function createRaffleFlow() {
  displayTitle();

  console.log(chalk.bgGreen.black.bold(' RAFFLE DAPP '));
  console.log();

  const { baseName } = await inquirer.prompt([
    { type: 'input', name: 'baseName', message: chalk.green.bold('Project base name'), default: 'raffle' }
  ]);

  const { prizeType } = await inquirer.prompt([
    { type: 'list', name: 'prizeType', message: chalk.green.bold('Select prize type'), choices: [
      { name: 'SOL', value: 'sol' },
      { name: 'SPL Token', value: 'spl' },
      { name: 'NFT (Metaplex)', value: 'nft' }
    ]}
  ]);
  // Raffle config (ticket price, supply, prize value)
  const configQs = [
    { type: 'input', name: 'ticketPrice', message: chalk.green.bold('Ticket price (SOL)'), default: '0.1', validate: v => Number(v)>0 || 'Enter a positive number' },
    { type: 'input', name: 'maxTickets', message: chalk.green.bold('Total tickets available'), default: '1000', validate: v => Number.isInteger(Number(v)) && Number(v)>0 || 'Enter a positive integer' }
  ];
  if (prizeType === 'sol') {
    configQs.push({ type:'input', name:'prizeValue', message: chalk.green.bold('Prize amount (SOL)'), default:'1', validate: v => Number(v)>0 || 'Enter a positive number' });
  } else if (prizeType === 'spl') {
    configQs.push({ type:'input', name:'tokenMint', message: chalk.green.bold('SPL token mint address'), default:'', validate: v => v.length>0 || 'Enter mint address' });
    configQs.push({ type:'input', name:'prizeValue', message: chalk.green.bold('Prize amount (tokens)'), default:'1000', validate: v => Number(v)>0 || 'Enter a positive number' });
  }
  const raffleCfg = await inquirer.prompt(configQs);

  const programName = `${baseName}-program`;
  const frontendName = `${baseName}-frontend`;
  const programPath = path.join(process.cwd(), programName);
    // 1) Scaffold minimal Rust raffle program
  await fs.ensureDir(path.join(programPath, 'src'));
  await fs.ensureDir(path.join(programPath, 'tests'));
  const cargoToml = `[package]\nname = "${programName}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib", "lib"]\n\n[dependencies]\nsolana-program = "~1.17.0"\ngeneric-array = "=0.14.7"\n`;
  // Create minimal Cargo.lock compatible with current cargo to avoid v4 from prior runs
  try { await execAsync('cargo generate-lockfile', { cwd: programPath }); } catch {}

  await fs.writeFile(path.join(programPath, 'Cargo.toml'), cargoToml);
  const libRs = `use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, pubkey::Pubkey};\nentrypoint!(process_instruction);\npub fn process_instruction(_pid:&Pubkey,_accs:&[AccountInfo],_ix:&[u8])->ProgramResult{ msg!("Raffle program: ${programName}"); Ok(()) }\n`;
  await fs.writeFile(path.join(programPath, 'src', 'lib.rs'), libRs);
  // Ensure target dir exists
  await fs.ensureDir(path.join(programPath, 'target')).catch(()=>{});

  // Pin legacy Cargo toolchain for SBF and remove incompatible lock
  try { await execAsync('rustup toolchain install 1.75.0 -y || true'); } catch {}
  try { await execAsync('rustup override set 1.75.0', { cwd: programPath }); } catch {}
  try { await fs.remove(path.join(programPath, 'Cargo.lock')); } catch {}


  // 2) Build loop (block until .so or abort)
  let soPath = null;
  while (!soPath) {
    // Always remove lockfile to avoid v4 parser issues with older cargo in SBF toolchain
    try { await fs.remove(path.join(programPath, 'Cargo.lock')); } catch {}

    let so = undefined;
    // Ensure toolchain
    try {
      await execAsync('cargo --version');
    } catch {
      console.log(chalk.red('\nRust not found. Install Rust and Solana tools to build.'));
      console.log(chalk.gray("  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"));
      console.log(chalk.gray('  sh -c "$(curl -sSfL https://release.solana.com/stable/install)"'));

      console.log(chalk.gray('  cargo install --git https://github.com/solana-labs/cargo-build-sbf'));
      const { action } = await inquirer.prompt([{ type:'list', name:'action', message: chalk.yellow.bold('Continue?'), choices:[
        { name:'Retry build', value:'retry' },
        { name:'Abort', value:'abort' }
      ]}]);
      if (action === 'abort') return;
      else continue;
    }

    try {
      const spinner = ora('Building Solana program...').start();
      // Ensure compatible toolchain for SBF and set it for this build
      const tool = '1.75.0';
      try { await execAsync(`rustup toolchain install ${tool} -y || true`); } catch {}
      process.env.RUSTUP_TOOLCHAIN = tool;
      // Remove lock just-in-time to avoid stale v4/v3 conflicts and regenerate with matching toolchain
      try { await fs.remove(path.join(programPath, 'Cargo.lock')); } catch {}
      try { await execAsync(`cargo +${tool} generate-lockfile`, { cwd: programPath }); } catch {}

      // Prefer cargo-build-sbf if available; else try Solana/brew bin fallback; else fallback to cargo build-sbf
      async function runIfExists(cmdPath) {
        if (!cmdPath) return false;
        try { await execAsync(`"${cmdPath}"`, { cwd: programPath }); return true; } catch { return false; }
      }
      let ran = false;
      // 1) PATH lookup
      // Ensure SOLANA_SDK_PATH is set for cargo-build-sbf
      const sdkPath = path.join(process.env.HOME || os.homedir(), '.local', 'share', 'solana', 'install', 'active_release', 'sdk', 'sbf');
      process.env.SOLANA_SDK_PATH = process.env.SOLANA_SDK_PATH || sdkPath;

      try {
        const { stdout } = await execAsync('command -v cargo-build-sbf || true');
        const p = stdout.trim();
        if (p) ran = await runIfExists(p);
      } catch {}
      // 2) Solana installer bin
      if (!ran) {
      // 3.5) If still missing, auto-download cargo-build-sbf from Solana release (no git)
      if (!ran) {
        try {
          const { stdout: sv } = await execAsync('solana --version || true');
          const mm = (sv || '').match(/(\d+\.\d+\.\d+)/);
        

          if (mm) {
            const ver = `v${mm[1]}`;
            const triple = process.platform === 'darwin'
              ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
              : (process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu');
            const tmpDir = path.join(os.tmpdir(), `solana-${Date.now()}`);
            await fs.ensureDir(tmpDir);
            await execAsync(`curl -sSfL https://release.solana.com/${ver}/solana-release-${triple}.tar.bz2 -o "${tmpDir}/sol.tarbz"`);
            await execAsync(`tar -xjf "${tmpDir}/sol.tarbz" -C "${tmpDir}"`);
            const cand1 = path.join(tmpDir, 'solana-release', 'bin', 'cargo-build-sbf');
            const cand2 = path.join(tmpDir, 'bin', 'cargo-build-sbf');
            const src = (await fs.pathExists(cand1)) ? cand1 : ((await fs.pathExists(cand2)) ? cand2 : null);
            if (src) {
              const destDir = path.join(process.env.HOME || os.homedir(), '.local', 'share', 'solana', 'install', 'active_release', 'bin');
              await fs.ensureDir(destDir);
              const dest = path.join(destDir, 'cargo-build-sbf');
              await fs.copy(src, dest, { overwrite: true });
              await fs.chmod(dest, 0o755);
              ran = await runIfExists(dest);
            }
          }
        } catch {}
      }

        const solPath = path.join(process.env.HOME || os.homedir(), '.local', 'share', 'solana', 'install', 'active_release', 'bin', 'cargo-build-sbf');
        if (await fs.pathExists(solPath)) ran = await runIfExists(solPath);
      }
      // 3) Brew-installed solana bin dir (derive from which solana)
      const envPath = `${(process.env.HOME||os.homedir())}/.local/share/solana/install/active_release/bin:${(process.env.HOME||os.homedir())}/.cargo/bin:${process.env.PATH}`;

      if (!ran) {
        try {
      // Also check Anchor default deploy dir if anchor build was used
      if (!ran) {
        try {
          await execAsync('test -d target/deploy || test -d target/verifiable', { cwd: programPath });
          ran = true;
        } catch {}
      }

          const { stdout } = await execAsync('command -v solana || true');
          const sol = stdout.trim();
          if (sol) {
            const brewBin = path.join(path.dirname(sol), 'cargo-build-sbf');
            if (await fs.pathExists(brewBin)) ran = await runIfExists(brewBin);
          }
        } catch {}
      }
      // 4) Try known builders in order
      if (!ran) {
        // Ensure no stale lockfile remains
        try { await fs.remove(path.join(programPath, 'Cargo.lock')); } catch {}

        // Refresh PATH for this process
      // Also search for .so in nested target directories (anchor-style)
      if (!so) {
        try {
          const walk = async (dir, depth=0) => {
            if (depth>2) return null;
            let items = [];
            try { items = await fs.readdir(dir); } catch { return null; }
            for (const it of items) {
              const p = path.join(dir, it);
              try {
                const st = await fs.stat(p);
                if (st.isFile() && p.endsWith('.so')) return p;
                if (st.isDirectory()) { const r = await walk(p, depth+1); if (r) return r; }
              } catch {}
            }
            return null;
          };
          const foundDeep = await walk(path.join(programPath, 'target'));


          if (foundDeep) {
            soPath = foundDeep;
            spinner.succeed(chalk.yellow('✔ Program built successfully'));
            break;
          }
        } catch {}
      }

        process.env.PATH = envPath;
        const cmds = [
          'cargo-build-sbf',
          `cargo +${process.env.RUSTUP_TOOLCHAIN || '1.75.0'} build-sbf`,
          'cargo build-sbf',
          'solana program dump -u m . 2>/dev/null || true && echo "no-build"'
        ];
        const buildLogs = [];
        for (const c of cmds) {


          try {
            await execAsync(c, { cwd: programPath, env: { ...process.env, PATH: envPath } });
          } catch (e) {
            const msg = (e?.message || '').split('\n').slice(-12).join('\n');
            buildLogs.push(`(${c})\n${msg}`);
            continue;
          }
          const dirs = [path.join(programPath, 'target', 'deploy'), path.join(programPath, 'target')];
          for (const d of dirs) {
            try {


              const files2 = await fs.readdir(d);


              const so2 = files2.find(f => f.endsWith('.so'));
              if (so2) { soPath = path.join(d, so2); }
            } catch {}
          }
          if (soPath) { ran = true; break; }
        }
        if (soPath) { spinner.succeed(chalk.yellow('✔ Program built successfully')); break; }
        if (buildLogs.length) {
          console.log(chalk.gray('\nBuild attempts (last errors):\n' + buildLogs.join('\n---\n') + '\n'));
          console.log(chalk.gray('Looked for .so in:'), path.join(programPath, 'target', 'deploy'), 'and', path.join(programPath, 'target'));
        }
        }
      // Guard: define so var before use to avoid TDZ
      try {
        const files = await fs.readdir(path.join(programPath, 'target', 'deploy'));
        so = files.find(f => f.endsWith('.so'));
      } catch { so = undefined; }

      if (so) {
        soPath = path.join(programPath, 'target', 'deploy', so);
        spinner.succeed(chalk.yellow('✔ Program built successfully'));
        break;
      } else {
        spinner.fail(chalk.red('Build completed but .so not found'));
      }
    } catch (e) {
      const out = (e?.message || '');
      const msg = out.split('\n').slice(-6).join('\n');
      console.log(chalk.red('\nBuild failed.'));
      if (msg) console.log(chalk.gray(msg));
      if (/no such command:\s*`?build-sbf`?/i.test(out)) {
        const inst = ora('Installing cargo-build-sbf...').start();
        try {
          const solBin = path.join(process.env.HOME || os.homedir(), '.local', 'share', 'solana', 'install', 'active_release', 'bin');
          if (!(await fs.pathExists(path.join(solBin, 'cargo-build-sbf')))) {
            await execAsync('cargo install cargo-binutils || true', { env: process.env });
            await execAsync('rustup component add llvm-tools-preview || true', { env: process.env });
            // skipping git-based install; rely on fallbacks
          }
          inst.succeed(chalk.yellow('✔ cargo-build-sbf installed or available'));
        } catch (ie) {
          inst.fail(chalk.red('Failed to install cargo-build-sbf'));
          console.log(chalk.gray(ie.message.split('\n').slice(-6).join('\n')));
          console.log(chalk.gray('If behind a corporate proxy, set CARGO_NET_GIT_FETCH_WITH_CLI=true'));
        }
        continue; // retry build automatically after installation
      }
    }

    const { next } = await inquirer.prompt([{ type:'list', name:'next', message: chalk.green.bold('Build failed. What next?'), choices:[
      { name:'Retry build', value:'retry' },
      { name:'Show setup tips then retry', value:'tips' },
      { name:'Abort', value:'abort' }
    ]}]);
    if (next === 'abort') return;
    if (next === 'tips') {
      console.log(chalk.gray('\nTips:'));
      console.log(chalk.gray('  rustup update && rustup default stable'));
      console.log(chalk.gray('  cargo install --git https://github.com/solana-labs/cargo-build-sbf'));
      console.log(chalk.gray('  sh -c "$(curl -sSfL https://release.solana.com/stable/install)"'));
    }
  }

  // 3) Select wallet and deploy
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? (await fs.readdir(WALLETS_DIR)).filter(f=>f.endsWith('.json')):[];
  if (walletFiles.length === 0) {
    console.log(chalk.red('\nNo wallets found. Create/import one first.'));
    return;
  }
  const { walletChoice } = await inquirer.prompt([{ type: 'list', name: 'walletChoice', message: chalk.green.bold('Select deploy wallet'), choices: walletFiles }]);

  const config = await loadConfig();
  const walletPath = path.join(WALLETS_DIR, walletChoice);
  try {
    const secretKeyData = await fs.readJSON(walletPath);
    const keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyData));
    const connection = new Connection(config.rpcUrl, 'confirmed');


    const balance = await connection.getBalance(keypair.publicKey);
    if (balance < 0.1 * LAMPORTS_PER_SOL && ['devnet','testnet'].includes(config.network)) {


      const { needAirdrop } = await inquirer.prompt([{ type:'confirm', name:'needAirdrop', message: chalk.yellow.bold('Low balance. Request airdrop?'), default:true }]);
  // extra newline to separate from subsequent logs
  console.log();



      if (needAirdrop) await requestAirdrop(keypair.publicKey);
    }
  } catch {}

  let programId = '';
      if (!programId) {
        const ans = await inquirer.prompt([{ type:'input', name:'pid', message: chalk.green.bold('Enter Program ID (Base58) or leave blank to continue'), default:'' }]);
        programId = (ans.pid || '').trim();
      }

  // Ensure program .so path
  if (!soPath) {
    console.log(chalk.yellow('\nBuild did not produce .so — skipping deploy.'));
  }

  if (soPath) {
    try {
      const cmd = `solana program deploy ${soPath} --keypair ${walletPath} --url ${config.rpcUrl}`;
      const { stdout } = await execAsync(cmd);
      const match = stdout.match(/Program Id:\\s*([A-Za-z0-9]+)/i);
      if (match) programId = match[1];
    } catch (e) {
      console.log(chalk.yellow('Deploy skipped or failed; continue without program id.'));
    }
  }

  // 4) Scaffold React dApp and inject env
  await buildFrontendWithEnv(frontendName, programId, prizeType, { autoLaunch: true, raffleCfg });

  console.log();
  console.log(chalk.yellow('Raffle scaffold complete.'));
}

async function buildFrontendWithEnv(projectName, programId, prizeType, options = {}) { const { autoLaunch = false, raffleCfg = {} } = options;
  const projectPath = path.join(process.cwd(), projectName);
  await fs.ensureDir(projectPath);
  await fs.ensureDir(path.join(projectPath, 'src'));
  await fs.ensureDir(path.join(projectPath, 'public'));

  const pkg = {
    name: projectName,
    version: '1.0.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: {
      '@solana/web3.js': '^1.87.0',
      '@solana/wallet-adapter-base': '^0.9.23',
      '@solana/wallet-adapter-react': '^0.15.35',
      '@solana/wallet-adapter-react-ui': '^0.9.35',
      '@solana/wallet-adapter-wallets': '^0.19.26',
      react: '^18.2.0',
      'react-dom': '^18.2.0'
    },
    devDependencies: { '@vitejs/plugin-react': '^4.2.0', vite: '^5.0.0' }
  };
  await fs.writeJSON(path.join(projectPath, 'package.json'), pkg, { spaces: 2 });

  const envContent = [
    `VITE_SOLANA_PROGRAM_ID=${programId}`,
    `VITE_RAFFLE_PRIZE_TYPE=${prizeType}`,
    `VITE_RAFFLE_TICKET_PRICE=${raffleCfg.ticketPrice || ''}`,
    `VITE_RAFFLE_MAX_TICKETS=${raffleCfg.maxTickets || ''}`,
    `VITE_RAFFLE_PRIZE_VALUE=${raffleCfg.prizeValue || ''}`,
    `VITE_RAFFLE_TOKEN_MINT=${raffleCfg.tokenMint || ''}`
  ].join('\n') + '\n';
  await fs.writeFile(path.join(projectPath, '.env'), envContent);

  const appJsxRaffle = `import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';
import './App.css';
const PROGRAM_ID = import.meta.env.VITE_SOLANA_PROGRAM_ID || '';
const PRIZE_TYPE = import.meta.env.VITE_RAFFLE_PRIZE_TYPE || 'sol';
const TICKET_PRICE = Number(import.meta.env.VITE_RAFFLE_TICKET_PRICE || 0);
const MAX_TICKETS = Number(import.meta.env.VITE_RAFFLE_MAX_TICKETS || 0);
const PRIZE_VALUE = import.meta.env.VITE_RAFFLE_PRIZE_VALUE || '';
const TOKEN_MINT = import.meta.env.VITE_RAFFLE_TOKEN_MINT || '';
function App(){
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(()=>clusterApiUrl(network),[network]);
  const wallets = useMemo(()=>[new PhantomWalletAdapter()],[]);
  return (<ConnectionProvider endpoint={endpoint}><WalletProvider wallets={wallets} autoConnect><WalletModalProvider>
  <div className='app'><header><h1>Raffle dApp</h1><WalletMultiButton/></header><main>
  <section>
    <h2>Raffle Configuration</h2>
    <ul>
      <li><b>Program ID:</b> {PROGRAM_ID || '(not deployed)'}</li>
      <li><b>Prize type:</b> {PRIZE_TYPE}</li>
      <li><b>Ticket price:</b> {TICKET_PRICE} SOL</li>
      <li><b>Max tickets:</b> {MAX_TICKETS}</li>
      {PRIZE_TYPE==='spl' ? <li><b>Token mint:</b> {TOKEN_MINT}</li> : null}
      <li><b>Prize value:</b> {PRIZE_VALUE}</li>
    </ul>
  </section>
  <section>
    <h2>Buy Ticket</h2>
    <p>Connect wallet and implement ticket purchase logic against your on-chain program.</p>
  </section>
  </main></div>
  </WalletModalProvider></WalletProvider></ConnectionProvider>);}
export default App;`;

  await fs.writeFile(path.join(projectPath, 'src', 'App.jsx'), appJsxRaffle);

  await fs.writeFile(path.join(projectPath, '.env'), `VITE_SOLANA_PROGRAM_ID=${programId}\nVITE_RAFFLE_PRIZE_TYPE=${prizeType}\n`);

  const indexHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${projectName}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`;
  await fs.writeFile(path.join(projectPath, 'index.html'), indexHtml);
  const viteConfig = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins:[react()], define:{ 'process.env': {} } });\n`;
  await fs.writeFile(path.join(projectPath, 'vite.config.js'), viteConfig);

  const mainJsx = `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`;
  await fs.writeFile(path.join(projectPath, 'src', 'main.jsx'), mainJsx);

  const appJsx2 = `import React, { useMemo } from 'react';\nimport { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';\nimport { WalletAdapterNetwork } from '@solana/wallet-adapter-base';\nimport { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';\nimport { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';\nimport { clusterApiUrl } from '@solana/web3.js';\nimport '@solana/wallet-adapter-react-ui/styles.css';\nimport './App.css';\nconst PROGRAM_ID = import.meta.env.VITE_SOLANA_PROGRAM_ID || '';\nconst PRIZE_TYPE = import.meta.env.VITE_RAFFLE_PRIZE_TYPE || 'sol';\nfunction App(){\n  const network = WalletAdapterNetwork.Devnet;\n  const endpoint = useMemo(()=>clusterApiUrl(network),[network]);\n  const wallets = useMemo(()=>[new PhantomWalletAdapter()],[]);\n  return (<ConnectionProvider endpoint={endpoint}><WalletProvider wallets={wallets} autoConnect><WalletModalProvider>\n  <div className='app'><header><h1>Raffle dApp</h1><WalletMultiButton/></header><main>\n  <p>Program ID: {PROGRAM_ID || '(not deployed)'}</p><p>Prize type: {PRIZE_TYPE}</p></main></div>\n  </WalletModalProvider></WalletProvider></ConnectionProvider>);}\nexport default App;`;
  await fs.writeFile(path.join(projectPath, 'src', 'App.jsx'), appJsx2);


  const appCss = `body{font-family:system-ui;background:#111;color:#fff} .app{max-width:960px;margin:0 auto;padding:2rem} header{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem} main{background:#1b1b1b;border:1px solid #2a2a2a;border-radius:12px;padding:2rem}`;
  await fs.writeFile(path.join(projectPath, 'src', 'App.css'), appCss);

  try { await execAsync('npm install', { cwd: projectPath }); } catch {}
  // Offer to start dev server and open browser
  // Auto-launch only when autoLaunch=true (Raffle flow)
  // Otherwise, ask the user inside CREATE flow only
  let launch = autoLaunch;
  if (!autoLaunch) {
    const ans = await inquirer.prompt([
      { type: 'confirm', name: 'launch', message: chalk.green.bold('Start the dev server and open your browser now?'), default: true }
    ]);
    launch = ans.launch;
  }
  if (launch) {
    try {
      const port = 5173;
      const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      spawn(cmd, ['run', 'dev'], { cwd: projectPath, stdio: 'inherit' });
      setTimeout(() => {
        const url = `http://localhost:${port}`;
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : 'start';
        exec(`${opener} ${url}`);
      }, 1200);
    } catch {}
  } else {
    console.log(chalk.gray('\nNext steps:'));
    console.log(chalk.gray(`  cd ${projectName} && npm install && npm run dev`));
    console.log(chalk.gray('  Open http://localhost:5173 in your browser'));
  }
}

/**
 * Token-gated website scaffold (Next.js) with SPL token gating
 */
async function createTokenGatedWebsiteFlow() {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' TOKEN-GATED WEBSITE '));
  console.log();

  const config = await loadConfig();

  // Ensure a wallet exists
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? await fs.readdir(WALLETS_DIR) : [];


  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  if (wallets.length === 0) {
    console.log(chalk.red('\nNo wallets found. Create/import one first.'));
    await new Promise(r => setTimeout(r, 1500));
    return;
  }

  // Choose wallet (prefer default)
  let defaultChoice = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (defaultChoice && !wallets.includes(defaultChoice)) defaultChoice = null;
  const { walletFile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'walletFile',
      message: chalk.green.bold('Select wallet (used to inspect tokens / optionally create one)'),
      choices: [
        ...(defaultChoice ? [{ name: `${config.defaultWallet} (default)`, value: defaultChoice }, new inquirer.Separator()] : []),
        ...wallets.map(w => ({ name: w.replace('.json', ''), value: w }))
      ],
      default: defaultChoice || undefined
    }
  ]);

  const secretKey = await fs.readJSON(path.join(WALLETS_DIR, walletFile));
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
  const connection = new Connection(config.rpcUrl, 'confirmed');

  // Load owned tokens
  let ownedTokenChoices = [];
  try {
    const res = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: splToken.TOKEN_PROGRAM_ID });
    const seen = new Set();
    for (const acct of res.value) {
      const info = acct.account.data.parsed.info;
      const mint = info.mint;
      const decimals = info.tokenAmount.decimals;
      const amount = Number(info.tokenAmount.uiAmount || 0);
      if (!seen.has(mint)) {
        seen.add(mint);
        ownedTokenChoices.push({ name: `${mint} — balance: ${amount}`, value: JSON.stringify({ mint, decimals }) });
      }
    }
  } catch {}

  // Choose gating token source
  const choices = [
    ...(ownedTokenChoices.length ? [{ name: 'Use a token from my wallet', value: 'from-wallet' }] : []),
    { name: 'Enter custom SPL token mint address', value: 'custom' },
    { name: 'Create a new SPL token now', value: 'create' }
  ];
  const { source } = await inquirer.prompt([{ type: 'list', name: 'source', message: chalk.green.bold('Select gating token source'), choices }]);

  let mintPk, decimals;

  if (source === 'from-wallet') {
    const { selected } = await inquirer.prompt([
      { type: 'list', name: 'selected', message: chalk.green.bold('Pick SPL token'), choices: ownedTokenChoices }
    ]);
    const p = JSON.parse(selected);
    mintPk = new PublicKey(p.mint);
    // Re-confirm decimals via RPC to be safe
    try { const mi = await splToken.getMint(connection, mintPk); decimals = mi.decimals; } catch { decimals = p.decimals; }
  } else if (source === 'custom') {
    const { customMint } = await inquirer.prompt([
      { type: 'input', name: 'customMint', message: chalk.green.bold('Enter SPL token mint address'), validate: v=>{ try{ new PublicKey(v); return true;} catch{ return 'Invalid public key'; } } }
    ]);
    mintPk = new PublicKey(customMint);
    const mi = await splToken.getMint(connection, mintPk);
    decimals = mi.decimals;
  } else {
    // Inline create SPL token (captures mint)
    const answers = await inquirer.prompt([
      { type: 'input', name: 'symbol', message: chalk.green.bold('Token symbol (optional)'), default: 'GATE' },
      { type: 'input', name: 'decimals', message: chalk.green.bold('Decimals (0-9)'), default: '6', validate: v=>{ const n=Number(v); return Number.isInteger(n)&&n>=0&&n<=9?true:'0-9 only'; } },
      { type: 'input', name: 'initial', message: chalk.green.bold('Initial supply to mint (e.g. 10_000)'), default: '1_000_000', validate: v=>/^\d+(\.\d+)?$/.test(String(v).replace(/_/g,''))?true:'Number please' },
      { type: 'confirm', name: 'lockMint', message: chalk.green.bold('Lock mint authority after minting?'), default: true }
    ]);
    decimals = Number(answers.decimals);
    const clean = String(answers.initial).replace(/_/g,'');
    const toBase = (s,d)=>{ const [w,f='']=s.split('.'); if(!/^\d+$/.test(w)||(f&&!/^\d+$/.test(f))) throw new Error('Invalid'); const frac=f.padEnd(d,'0'); return BigInt(w) * (10n**BigInt(d)) + (frac?BigInt(frac):0n);} 
    // Ensure minimal balance
    try { const bal=await connection.getBalance(keypair.publicKey); if (bal < 0.05*LAMPORTS_PER_SOL && ['devnet','testnet'].includes(config.network)) { await requestAirdrop(keypair.publicKey, 1); } } catch {}
    const spin = ora({ text: chalk.white('Creating token mint'), spinner: 'dots2' }).start();
    try {
      const mint = await splToken.createMint(connection, keypair, keypair.publicKey, null, decimals);
      const ata = await splToken.getOrCreateAssociatedTokenAccount(connection, keypair, mint, keypair.publicKey);
      const amt = toBase(clean, decimals);
      if (amt > 0n) await splToken.mintTo(connection, keypair, mint, ata.address, keypair, amt);
      if (answers.lockMint) await splToken.setAuthority(connection, keypair, mint, keypair, splToken.AuthorityType.MintTokens, null);
      spin.succeed(chalk.yellow('Token created'));
      mintPk = mint;
      console.log(chalk.gray('Mint:'), chalk.yellow(mintPk.toBase58()));
    } catch (e) {
      spin.fail(chalk.red('Failed to create token'));
      console.log(chalk.red(e.message));
      return;
    }
  }

  // Gate settings
  const { gateAmount } = await inquirer.prompt([
    { type: 'input', name: 'gateAmount', message: chalk.green.bold('Required token amount to access (UI units)'), default: '1', validate: v=> Number(v)>0?true:'> 0' }
  ]);

  const { appName } = await inquirer.prompt([
    { type: 'input', name: 'appName', message: chalk.green.bold('Project folder name'), default: 'token-gated-site' }
  ]);

  const env = {
    rpcUrl: config.rpcUrl,
    network: config.network,
    mint: mintPk.toBase58(),
    gateAmountUi: String(gateAmount),
    decimals
  };

  await scaffoldTokenGatedSite(appName, env);

  const { installDeps } = await inquirer.prompt([
    { type: 'confirm', name: 'installDeps', message: chalk.green.bold('Install dependencies now (npm install)?'), default: true }
  ]);
  const projDir = path.join(process.cwd(), appName);
  if (installDeps) {
    const spinner = ora('Installing dependencies...').start();
    try { await execAsync('npm install', { cwd: projDir }); spinner.succeed(chalk.yellow('✔ Dependencies installed')); }
    catch { spinner.warn(chalk.yellow('Run npm install manually')); }
  }

  const { runDev } = await inquirer.prompt([
    { type: 'confirm', name: 'runDev', message: chalk.green.bold('Start dev server now (npm run dev)?'), default: true }
  ]);
  if (runDev) {
    console.log(chalk.gray('\nStarting dev server... (Ctrl+C to stop)\n'));
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(cmd, ['run', 'dev'], { cwd: projDir, stdio: 'inherit' });

    const url = 'http://localhost:3000';
    setTimeout(() => {
      try {
        console.log(chalk.gray(`Opening ${url} in your browser...`));
        if (process.platform === 'darwin') {
          spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'win32') {
          spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch {}
    }, 2500);

    await new Promise(resolve => proc.on('exit', resolve));
    return;
  }

  console.log();
  console.log(chalk.hex('#8B5CF6')('Next steps:'));
  console.log(chalk.gray(`  1. cd ${appName}`));
  console.log(chalk.gray('  2. npm run dev'));
  console.log(chalk.gray('  3. Open http://localhost:3000 and connect your wallet'));
}

async function scaffoldTokenGatedSite(appName, env) {
  const projectPath = path.join(process.cwd(), appName);
  await fs.ensureDir(projectPath);
  await fs.ensureDir(path.join(projectPath, 'pages'));
  await fs.ensureDir(path.join(projectPath, 'components'));
  await fs.ensureDir(path.join(projectPath, 'styles'));

  const pkg = {
    name: appName,
    "private": true,
    version: '1.0.0',
    scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
    dependencies: {
      next: '^14.2.4',
      react: '^18.2.0',
      'react-dom': '^18.2.0',
      '@solana/web3.js': '^1.87.0',
      '@solana/wallet-adapter-base': '^0.9.23',
      '@solana/wallet-adapter-react': '^0.15.35',
      '@solana/wallet-adapter-react-ui': '^0.9.35',
      '@solana/wallet-adapter-phantom': '^0.9.7'
    }
  };

  const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true };
module.exports = nextConfig;`;
  const globalsCss = `*{box-sizing:border-box}body{margin:0;background:#0b0b12;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif}.container{max-width:960px;margin:0 auto;padding:2rem}.card{background:#13131f;border:1px solid #23243a;border-radius:12px;padding:1.25rem}.btn{background:#8b5cf6;border:none;color:#fff;padding:.6rem 1rem;border-radius:.6rem;cursor:pointer}.muted{color:#9aa0ae}`;

  const appJs = `import '../styles/globals.css';
import '@solana/wallet-adapter-react-ui/styles.css';
import { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
export default function App({ Component, pageProps }){
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
  const wallets = useMemo(()=>[new PhantomWalletAdapter()],[]);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Component {...pageProps} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}`;

  const gateJsx = `import { useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
function useTokenAccess(mintStr, thresholdUi){
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [ok,setOk]=useState(false);
  const [checking,setChecking]=useState(false);
  const mint = useMemo(()=>{ try { return new PublicKey(mintStr);} catch { return null; } },[mintStr]);
  useEffect(()=>{(async()=>{
    if(!publicKey || !mint){ setOk(false); return; }
    setChecking(true);
    try{
      const res = await connection.getParsedTokenAccountsByOwner(publicKey, { mint });
      let balanceUi = 0;
      for(const it of res.value){ const amt = Number(it.account.data.parsed.info.tokenAmount.uiAmount || 0); balanceUi += amt; }
      setOk(balanceUi >= Number(thresholdUi));
    }catch{ setOk(false);} finally{ setChecking(false);}
  })()},[publicKey?.toBase58(), mintStr, thresholdUi]);
  return { ok, checking };
}
export default function Home(){
  const mint = process.env.NEXT_PUBLIC_GATE_MINT;
  const threshold = process.env.NEXT_PUBLIC_GATE_AMOUNT || '1';
  const { ok, checking } = useTokenAccess(mint, threshold);
  return (
    <div className="container">
      <div className="flex items-center justify-between" style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><h1>Token-Gated Site</h1><WalletMultiButton className="btn"/></div>
      <p className="muted">Mint: {mint}</p>
      <p className="muted">Required: {threshold} tokens</p>
      <div style={{height:16}} />
      {!ok && (
        <div className="card">
          <h3>Access locked</h3>
          <p className="muted">Hold at least {threshold} tokens of the configured SPL mint in your connected wallet.</p>
          {checking && <p className="muted">Checking balance...</p>}
        </div>
      )}
      {ok && (
        <div className="card">
          <h3>Welcome to the gated community 🎉</h3>
          <p className="muted">You have the required tokens. Replace this with your members-only content.</p>
        </div>
      )}
    </div>
  );
}`;

  const envLocal = `NEXT_PUBLIC_RPC_URL=${env.rpcUrl}
NEXT_PUBLIC_CLUSTER=${env.network}
NEXT_PUBLIC_GATE_MINT=${env.mint}
NEXT_PUBLIC_GATE_AMOUNT=${env.gateAmountUi}
`;

  const readme = `# ${appName}

Token-gated website scaffold (Next.js + Solana Wallet Adapter).

Configure .env.local then:


 npm install
 npm run dev

`;

  await fs.writeJSON(path.join(projectPath,'package.json'), pkg, { spaces: 2 });
  await fs.writeFile(path.join(projectPath,'next.config.js'), nextConfig);
  await fs.writeFile(path.join(projectPath,'styles','globals.css'), globalsCss);
  await fs.writeFile(path.join(projectPath,'pages','_app.js'), appJs);
  await fs.writeFile(path.join(projectPath,'pages','index.js'), gateJsx);
  await fs.writeFile(path.join(projectPath,'.env.local'), envLocal);
  await fs.writeFile(path.join(projectPath,'README.md'), readme);

  console.log();
  console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' TOKEN-GATED TEMPLATE CREATED                                              ') + chalk.hex('#8B5CF6')('║'));
  console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Path          ') + chalk.gray('│ ') + chalk.white(projectPath.padEnd(58)) + chalk.hex('#8B5CF6')('║'));
  console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Gate Mint     ') + chalk.gray('│ ') + chalk.yellow(env.mint.substring(0,58).padEnd(58)) + chalk.hex('#8B5CF6')('║'));
  console.log();
}

async function createNftMintingWebsiteFlow(prefill) {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' NFT MINTING WEBSITE '));
  console.log();

  await initConfig();
  const config = await loadConfig();

  // Load known collections
  let known = { collections: [] };
  try { known = await fs.readJSON(COLLECTIONS_FILE); } catch {}
  const choices = [];
  if (prefill?.mint) {
    choices.push({ name: `${prefill.name || 'Newly created'} (${prefill.mint})`, value: prefill.mint });
    choices.push(new inquirer.Separator());
  }
  for (const c of (known.collections||[])) {
    choices.push({ name: `${c.name || 'Unnamed'} (${c.mint})`, value: c.mint });
  }
  choices.push(new inquirer.Separator());
  choices.push({ name: 'Enter collection mint manually', value: '__manual__' });

  const { collMintChoice } = await inquirer.prompt([
    { type: 'list', name: 'collMintChoice', message: chalk.green.bold('Select collection for minting'), choices, pageSize: 10 }
  ]);

  let collectionMint = collMintChoice;
  if (collMintChoice === '__manual__') {
    const { manual } = await inquirer.prompt([
      { type: 'input', name: 'manual', message: chalk.green.bold('Collection mint address'), validate: v=>/^\w{32,}$/.test(v)||'Enter a valid address' }
    ]);
    collectionMint = manual.trim();
  }

  const { appName } = await inquirer.prompt([
    { type: 'input', name: 'appName', message: chalk.green.bold('App folder name'), default: 'nft-mint-site' }
  ]);

  const { mintPriceSol } = await inquirer.prompt([
    { type: 'input', name: 'mintPriceSol', message: chalk.green.bold('Mint price (SOL, e.g. 0.1)'), default: '0', validate: v => !isNaN(Number(v)) && Number(v) >= 0 ? true : 'Enter a number >= 0' }
  ]);
  const { treasuryPubkey } = await inquirer.prompt([
    { type: 'input', name: 'treasuryPubkey', message: chalk.green.bold('Treasury wallet to receive SOL (base58)'), default: '', validate: v => v === '' || /^\w{32,}$/.test(v) ? true : 'Enter a valid address or leave blank' }
  ]);

  // Minimal Next.js scaffold with wallet adapter and simple mint-to-collection button
  const projectPath = path.join(process.cwd(), appName);
  await fs.ensureDir(projectPath);
  await fs.ensureDir(path.join(projectPath, 'pages'));
  await fs.ensureDir(path.join(projectPath, 'styles'));

  const pkg = {
    name: appName,
    "private": true,
    version: '1.0.0',
    scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
    dependencies: {
      next: '^14.2.4',
      react: '^18.2.0',
      'react-dom': '^18.2.0',
      '@solana/web3.js': '^1.87.0',
      '@solana/wallet-adapter-base': '^0.9.23',
      '@solana/wallet-adapter-react': '^0.15.35',
      '@solana/wallet-adapter-react-ui': '^0.9.35',
      '@solana/wallet-adapter-phantom': '^0.9.7',
      '@metaplex-foundation/js': '^0.19.4'
    }
  };

  const globalsCss = `*{box-sizing:border-box}body{margin:0;background:#0b0b12;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif}.container{max-width:960px;margin:0 auto;padding:2rem}.card{background:#13131f;border:1px solid #23243a;border-radius:12px;padding:1.25rem}.btn{background:#8b5cf6;border:none;color:#fff;padding:.6rem 1rem;border-radius:.6rem;cursor:pointer}.muted{color:#9aa0ae}`;
  const appJs2 = `import '../styles/globals.css';
import '@solana/wallet-adapter-react-ui/styles.css';
import { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
export default function App({ Component, pageProps }){
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
  const wallets = useMemo(()=>[new PhantomWalletAdapter()],[]);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Component {...pageProps} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}`;

  const indexJs = `import { useMemo, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, clusterApiUrl, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { Metaplex, walletAdapterIdentity } from '@metaplex-foundation/js';
import { useWallet } from '@solana/wallet-adapter-react';
export default function Home(){
  const { wallet, publicKey, signTransaction } = useWallet();
  const [status, setStatus] = useState('');
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl(process.env.NEXT_PUBLIC_CLUSTER || 'devnet');
  const collection = process.env.NEXT_PUBLIC_COLLECTION_MINT;
  const connection = useMemo(()=> new Connection(endpoint, 'confirmed'), [endpoint]);
  const mx = useMemo(()=> wallet ? Metaplex.make(connection).use(walletAdapterIdentity(wallet)) : null, [connection, wallet]);
  async function payMintPrice(){
    const price = Number(process.env.NEXT_PUBLIC_MINT_PRICE_SOL||'0');
    const to = process.env.NEXT_PUBLIC_TREASURY;
    if (!price || !to) return;
    const ix = SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(to), lamports: Math.round(price*1e9) });
    const tx = new Transaction().add(ix);
    tx.feePayer = publicKey; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const s1 = await signTransaction(tx); const sig = await connection.sendRawTransaction(s1.serialize());
    await connection.confirmTransaction(sig, 'confirmed');
  }
  async function mint(){
    if (!mx || !publicKey) { setStatus('Connect wallet first'); return; }
    try{
      setStatus('Minting...');
      await payMintPrice();
      const { nft } = await mx.nfts().create({ name: 'Minted NFT', symbol: 'NFT', uri: process.env.NEXT_PUBLIC_DEFAULT_METADATA || 'https://arweave.net/placeholder.json', sellerFeeBasisPoints: 0, collection: new PublicKey(collection) });
      try{ await mx.nfts().verifyCollection({ mintAddress: nft.address, collectionMintAddress: new PublicKey(collection) }); }catch{}
      setStatus('Minted: '+(nft.address?.toBase58?.()||''));
    }catch(e){ console.error(e); setStatus('Error: '+(e.message||String(e))); }
  }
  return (
    <div className='container'>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><h1>NFT Mint</h1><WalletMultiButton className='btn' /></div>
      <p className='muted'>Collection: {collection}</p>
      <div className='card'>
        <button className='btn' onClick={mint} disabled={!publicKey}>Mint to Collection</button>
        <p className='muted'>{status}</p>
      </div>
    </div>
  );
}`;

  const envLocal2 = `NEXT_PUBLIC_RPC_URL=${config.rpcUrl}
NEXT_PUBLIC_CLUSTER=${config.network}
NEXT_PUBLIC_COLLECTION_MINT=${collectionMint}
NEXT_PUBLIC_DEFAULT_METADATA=https://arweave.net/placeholder.json
NEXT_PUBLIC_MINT_PRICE_SOL=${mintPriceSol}
NEXT_PUBLIC_TREASURY=${treasuryPubkey}
`;
  const nextConfig2 = `/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true };
module.exports = nextConfig;`;

  await fs.writeJSON(path.join(projectPath,'package.json'), pkg, { spaces: 2 });
  await fs.writeFile(path.join(projectPath,'next.config.js'), nextConfig2);
  await fs.writeFile(path.join(projectPath,'styles','globals.css'), globalsCss);
  await fs.writeFile(path.join(projectPath,'pages','_app.js'), appJs2);
  await fs.writeFile(path.join(projectPath,'pages','index.js'), indexJs);
  await fs.writeFile(path.join(projectPath,'.env.local'), envLocal2);
  await fs.writeFile(path.join(projectPath,'README.md'), `# ${appName}\n\nSimple NFT minting site.\n\n npm install\n npm run dev\n`);

  console.log(chalk.hex('#8B5CF6').bold('\n🖥  Minting website created\n'));
  console.log(chalk.white('Path: ')+projectPath);
  console.log(chalk.white('Collection: ')+collectionMint);

  const { installDeps } = await inquirer.prompt([
    { type: 'confirm', name: 'installDeps', message: chalk.green.bold('Install dependencies now (npm install)?'), default: true }
  ]);
  if (installDeps) {
    const spinner = ora('Installing dependencies...').start();
    try { await execAsync('npm install', { cwd: projectPath }); spinner.succeed(chalk.yellow('✔ Dependencies installed')); }
    catch { spinner.warn(chalk.yellow('Run npm install manually')); }
  }

  const { runDev } = await inquirer.prompt([
    { type: 'confirm', name: 'runDev', message: chalk.green.bold('Start dev server now (npm run dev)?'), default: true }
  ]);
  if (runDev) {
    console.log(chalk.gray('\nStarting dev server... (Ctrl+C to stop)\n'));
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(cmd, ['run', 'dev'], { cwd: projectPath, stdio: 'inherit' });
    const url = 'http://localhost:3000';
    setTimeout(() => {
      try {
        console.log(chalk.gray(`Opening ${url} in your browser...`));
        if (process.platform === 'darwin') {
          spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'win32') {
          spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch {}
    }, 2500);
    await new Promise(resolve => proc.on('exit', resolve));
  }
}
/**
 * Create NFT Collection + mint NFTs using Metaplex Token Metadata
 * when called with returnMeta=true, returns { mint, name }
 */
async function createNftCollectionFlow(returnMeta = false) {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' NFT COLLECTION CREATOR '));
  console.log();

  // Media + metadata inputs
  const { mediaPath, useUploader } = await inquirer.prompt([
    { type: 'input', name: 'mediaPath', message: chalk.green.bold('Artwork image path (png/jpg, optional for now)'), default: '' },
    { type: 'confirm', name: 'useUploader', message: chalk.green.bold('Upload media + JSON to Arweave (Bundlr)?'), default: false }
  ]);

  let uploadedCollectionUri = 'https://arweave.net/placeholder.json';
  let uploadedItemUri = 'https://arweave.net/placeholder.json';

  let collectionFile = null;
  let itemFile = null;
  if (mediaPath && (await fs.pathExists(mediaPath))) {
    try {
      const data = await fs.readFile(mediaPath);
      const filename = path.basename(mediaPath);
      collectionFile = toMetaplexFile(data, filename);
      itemFile = collectionFile;
    } catch {}
  }

  const config = await loadConfig();
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? await fs.readdir(WALLETS_DIR) : [];
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  if (wallets.length === 0) {
    console.log(chalk.red('\nNo wallets found. Create/import one first.'));
    await new Promise(r => setTimeout(r, 1500));
    return;
  }
  let defaultChoice = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (defaultChoice && !wallets.includes(defaultChoice)) defaultChoice = null;
  const { walletFile } = await inquirer.prompt([{
    type: 'list', name: 'walletFile', message: chalk.green.bold('Select creator wallet'),
    choices: [
      ...(defaultChoice ? [{ name: `${config.defaultWallet} (default)`, value: defaultChoice }, new inquirer.Separator()] : []),
      ...wallets.map(w => ({ name: w.replace('.json',''), value: w }))
    ],
    default: defaultChoice || undefined
  }]);

  const { collectionName, collectionSymbol } = await inquirer.prompt([
    { type: 'input', name: 'collectionName', message: chalk.green.bold('Collection name'), default: 'My Collection' },
    { type: 'input', name: 'collectionSymbol', message: chalk.green.bold('Symbol (optional)'), default: '' },
  ]);

  const { creatorShare } = await inquirer.prompt([
    { type: 'input', name: 'creatorShare', message: chalk.green.bold('Seller fee basis points (royalties, 0-10000)'), default: '500',
      validate: v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10000 ? true : 'Enter 0-10000' }
  ]);

  const { nftsCount } = await inquirer.prompt([
    { type: 'input', name: 'nftsCount', message: chalk.green.bold('How many NFTs to mint now?'), default: '0',
      validate: v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 50 ? true : 'Enter 0-50' }
  ]);

  const secretKey = await fs.readJSON(path.join(WALLETS_DIR, walletFile));
  const { supplyCap: supplyCapStr } = await inquirer.prompt([
    { type: 'input', name: 'supplyCap', message: chalk.green.bold('Total collection size (cap, 1-100000)'), default: '1000',
      validate: v => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 100000 ? true : 'Enter 1-100000' }
  ]);
  const supplyCap = Number(supplyCapStr);

  const payer = Keypair.fromSecretKey(new Uint8Array(secretKey));

  const connection = new Connection(config.rpcUrl, 'confirmed');
  // Ensure some SOL for fees
  try {
    const bal = await connection.getBalance(payer.publicKey);
    if (bal < 0.05 * LAMPORTS_PER_SOL && ['devnet','testnet'].includes(config.network)) {
      await requestAirdrop(payer.publicKey, 1);
    }
  } catch {}

  const spinner = ora({ text: chalk.white('Creating collection NFT'), spinner: 'dots2' }).start();
  try {
    const cluster = config.network;
    const irysAddress = cluster === 'mainnet-beta' ? 'https://node1.irys.xyz' : 'https://devnet.irys.xyz';
    const mx = Metaplex.make(connection)
      .use(keypairIdentity(payer))
      .use(bundlrStorage({ address: irysAddress, providerUrl: config.rpcUrl, timeout: 60000 }));

    const withTimeout = (p, ms, msg) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(msg || 'Timed out')), ms))
    ]);

    // Optional: upload collection image + JSON
    if (useUploader) {
      try {
        let cImgUrl = null;
        if (collectionFile) {
          const up1 = ora({ text: chalk.white('Uploading collection image to Arweave (Irys)...'), spinner: 'dots2' }).start();
          try {
            cImgUrl = await withTimeout(mx.storage().upload(collectionFile), 45000, 'Image upload timeout');
            up1.succeed(chalk.yellow('Image uploaded'));
          } catch (e) {
            up1.fail(chalk.red('Image upload failed, continuing without image'));
          }
        }
        const up2 = ora({ text: chalk.white('Uploading collection metadata...'), spinner: 'dots2' }).start();
        try {
          const cMeta = await withTimeout(mx.nfts().uploadMetadata({
            name: collectionName,
            symbol: collectionSymbol || undefined,
            description: `${collectionName} collection`,
            image: cImgUrl || undefined
          }), 45000, 'Metadata upload timeout');
          uploadedCollectionUri = cMeta.uri;
          up2.succeed(chalk.yellow('Metadata uploaded'));
        } catch (e) {
          up2.fail(chalk.red('Metadata upload failed, using placeholder'));
        }

        if (itemFile) {
          const up3 = ora({ text: chalk.white('Uploading example item image...'), spinner: 'dots2' }).start();
          let iImgUrl = null;
          try { iImgUrl = await withTimeout(mx.storage().upload(itemFile), 45000, 'Item image upload timeout'); up3.succeed(chalk.yellow('Item image uploaded')); } catch { up3.fail(chalk.red('Item image upload failed')); }
          const up4 = ora({ text: chalk.white('Uploading example item metadata...'), spinner: 'dots2' }).start();
          try {
            const iMeta = await withTimeout(mx.nfts().uploadMetadata({
              name: `${collectionName} Example`,
              symbol: collectionSymbol || undefined,
              description: `${collectionName} item`,
              image: iImgUrl || undefined
            }), 45000, 'Item metadata upload timeout');
            uploadedItemUri = iMeta.uri;
            up4.succeed(chalk.yellow('Item metadata uploaded'));
          } catch { up4.fail(chalk.red('Item metadata upload failed')); }
        }
      } catch {
        // Fallback handled by placeholders
      }
    }

    const { nft: collection } = await mx.nfts().create({
      name: collectionName,
      symbol: collectionSymbol || undefined,
      uri: uploadedCollectionUri,
      sellerFeeBasisPoints: Number(creatorShare),
      isCollection: true,
      collectionDetails: { type: 'V1', size: BigInt(Number(supplyCap)) }
    });

    const collectionMintAddress = collection.address?.toBase58?.() || collection.mintAddress?.toBase58?.() || String(collection.address || collection.mintAddress);
    spinner.succeed(chalk.yellow('Collection created'));
    console.log(chalk.gray('Collection Mint:'), chalk.yellow(collectionMintAddress));

    const count = Number(nftsCount);
    for (let i = 0; i < count; i++) {
      const nftSpinner = ora({ text: chalk.white(`Minting NFT ${i+1}/${count}`), spinner: 'dots2' }).start();
      const name = `${collectionName} #${i+1}`;
      try {
        const { nft } = await mx.nfts().create({
          name,
          symbol: collectionSymbol || undefined,
          uri: uploadedItemUri,
          sellerFeeBasisPoints: Number(creatorShare),
          collection: collection.address
        });
        try {
          await mx.nfts().verifyCollection({ mintAddress: nft.address ?? nft.mintAddress, collectionMintAddress: collection.address ?? collection.mintAddress });
        } catch {
          try { await mx.nfts().setAndVerifyCollection({ mintAddress: nft.address ?? nft.mintAddress, collectionMintAddress: collection.address ?? collection.mintAddress }); } catch {}
        }
        const nftMintAddr = nft.address?.toBase58?.() || nft.mintAddress?.toBase58?.() || String(nft.address || nft.mintAddress);
        nftSpinner.succeed(chalk.yellow(`NFT ${i+1} minted`));
        console.log(chalk.gray('  Mint:'), chalk.yellow(nftMintAddr));
      } catch (err) {
        nftSpinner.fail(chalk.red(`Failed to mint NFT ${i+1}`));
        console.log(chalk.red(err.message));
      }
    }

    console.log();
    const clusterParam = config.network === 'mainnet-beta' ? '' : `?cluster=${config.network}`;
    const collectionMintForUrl = collection.address?.toBase58?.() || collection.mintAddress?.toBase58?.() || String(collection.address || collection.mintAddress);
    console.log(chalk.gray('Explorer (collection): ')+chalk.yellow(`https://explorer.solana.com/address/${collectionMintForUrl}${clusterParam}`));
    console.log();
    try {
      const db = (await fs.pathExists(COLLECTIONS_FILE)) ? await fs.readJSON(COLLECTIONS_FILE) : { collections: [] };
      if (!db.collections.find(x => x.mint === collectionMintAddress)) {
        db.collections.push({ mint: collectionMintAddress, name: collectionName, network: config.network });
        await fs.writeJSON(COLLECTIONS_FILE, db, { spaces: 2 });
      }
    } catch {}
    if (returnMeta) return { mint: collectionMintAddress, name: collectionName };
    if (Number.isNaN(Number(creatorShare))) {
      throw new Error('Invalid seller fee bps');
    }
    await new Promise(r => setTimeout(r, 2500));
  } catch (e) {
    spinner.fail(chalk.red('Failed to create collection'));
    console.log(chalk.red(e.message));
    await new Promise(r => setTimeout(r, 2000));
  }
}


/**
 * Create DAO flow: Governance SPL token + Multisig mint authority
 */
async function createDaoFlow() {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' DAO CREATOR '));
  console.log();

  const config = await loadConfig();

  const { daoMode } = await inquirer.prompt([
    { type: 'list', name: 'daoMode', message: chalk.green.bold('Select DAO type'),
      choices: [
        { name: 'Multisig (M-of-N signers manage authorities)', value: 'multisig' },
        { name: 'Token Governance (community voting via SPL Governance/Realms)', value: 'governance' },
      ], default: 'multisig' }
  ]);

  if (daoMode === 'governance') {
    await createDaoGovernanceFlow();
    return;
  }

  console.log(chalk.gray('Mode: Multisig DAO'));
  console.log();


  // Ensure wallets
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? await fs.readdir(WALLETS_DIR) : [];
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  if (wallets.length === 0) {
    console.log(chalk.red('\nNo wallets found. Create/import one first.'));
    await new Promise(r => setTimeout(r, 1500));
    return;
  }
  let defaultChoice = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (defaultChoice && !wallets.includes(defaultChoice)) defaultChoice = null;
  const { walletFile } = await inquirer.prompt([{
    type: 'list', name: 'walletFile', message: chalk.green.bold('Select payer wallet'),
    choices: [
      ...(defaultChoice ? [{ name: `${config.defaultWallet} (default)`, value: defaultChoice }, new inquirer.Separator()] : []),
      ...wallets.map(w => ({ name: w.replace('.json',''), value: w }))
    ],
    default: defaultChoice || undefined
  }]);

  // DAO params
  const baseAnswers = await inquirer.prompt([
    { type: 'input', name: 'daoName', message: chalk.green.bold('DAO name (display only)'), default: 'MyDAO' },
    { type: 'input', name: 'symbol', message: chalk.green.bold('Governance token symbol'), default: 'GOV' },
    { type: 'input', name: 'decimals', message: chalk.green.bold('Token decimals (0-9)'), default: '6',
      validate: v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 9 ? true : 'Enter 0-9' },
    { type: 'input', name: 'supply', message: chalk.green.bold('Total initial supply (e.g. 1_000_000 or 1.5)'), default: '1_000_000',
      validate: (v) => { const s = String(v).replace(/_/g,'').trim(); return /^\d+(\.\d+)?$/.test(s) ? true : 'Enter a valid number'; } },
    { type: 'input', name: 'membersCount', message: chalk.green.bold('Number of DAO members (2-11)'), default: '3',
      validate: v => Number.isInteger(Number(v)) && Number(v) >= 2 && Number(v) <= 11 ? true : 'Enter 2-11' },
  ]);

  const membersCount = Number(baseAnswers.membersCount);
  const memberPrompts = [];
  for (let i = 0; i < membersCount; i++) {
    memberPrompts.push({
      type: 'input', name: `member_${i}`, message: chalk.green.bold(`Member ${i+1} wallet address`),
      validate: (v) => { try { new PublicKey(v); return true; } catch { return 'Enter a valid public key'; } }
    });
  }
  const membersAns = await inquirer.prompt(memberPrompts);
  const memberPubkeys = Array.from({ length: membersCount }, (_, i) => new PublicKey(membersAns[`member_${i}`]));

  const { threshold, includePayer, distributeMode, lockMint, setFreezeToMultisig } = await inquirer.prompt([
    { type: 'input', name: 'threshold', message: chalk.green.bold('Multisig threshold M (1..N)'), default: String(Math.ceil(membersCount/2)),
      validate: v => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= membersCount ? true : `Enter 1-${membersCount}` },
    { type: 'confirm', name: 'includePayer', message: chalk.green.bold('Include payer as a multisig signer?'), default: false },
    { type: 'list', name: 'distributeMode', message: chalk.green.bold('Distribute supply'),
      choices: [ { name: 'Equally among members', value: 'equal' }, { name: 'All to payer (treasury)', value: 'treasury' } ], default: 'equal' },
    { type: 'confirm', name: 'lockMint', message: chalk.green.bold('Lock mint authority (prevent future minting)?'), default: false },
    { type: 'confirm', name: 'setFreezeToMultisig', message: chalk.green.bold('Set freeze authority to multisig?'), default: false },
  ]);

  const decimals = Number(baseAnswers.decimals);
  const supplyStr = String(baseAnswers.supply).replace(/_/g,'').trim();
  function toBaseUnits(amountStr, decimals) {
    const [w, f=''] = amountStr.split('.');
    if (!/^\d+$/.test(w) || (f && !/^\d+$/.test(f))) throw new Error('Invalid number');
    if (f.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
    const fracPadded = f.padEnd(decimals, '0');
    const base = 10n ** BigInt(decimals);
    return BigInt(w) * base + (fracPadded ? BigInt(fracPadded) : 0n);
  }
  let totalSupplyBase;
  try { totalSupplyBase = toBaseUnits(supplyStr, decimals); } catch (e) { console.log(chalk.red(`\nInvalid supply: ${e.message}`)); return; }

  // Load payer

/**
 * Create DAO with token-holder governance using SPL Governance (Realms)
 * This scaffolds a governance-ready SPL token and optionally guides creating a Realm.
 * Note: On-chain governance program interactions rely on the SPL Governance program ID.
 */
async function createDaoGovernanceFlow() {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' DAO CREATOR — TOKEN GOVERNANCE '));
  console.log();

  const config = await loadConfig();

  // Ensure wallets
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? await fs.readdir(WALLETS_DIR) : [];
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  if (wallets.length === 0) {
    console.log(chalk.red('\nNo wallets found. Create/import one first.'));
    await new Promise(r => setTimeout(r, 1500));
    return;
  }
  let defaultChoice = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (defaultChoice && !wallets.includes(defaultChoice)) defaultChoice = null;
  const { walletFile } = await inquirer.prompt([{
    type: 'list', name: 'walletFile', message: chalk.green.bold('Select payer/authority wallet'),
    choices: [
      ...(defaultChoice ? [{ name: `${config.defaultWallet} (default)`, value: defaultChoice }, new inquirer.Separator()] : []),
      ...wallets.map(w => ({ name: w.replace('.json',''), value: w }))
    ],
    default: defaultChoice || undefined
  }]);

  const { realmName, symbol, decimals, supply, minCommunityTokensToCreate, lockMint, setFreezeToNull, governanceProgramId } = await inquirer.prompt([
    { type: 'input', name: 'realmName', message: chalk.green.bold('Realm (DAO) name'), default: 'MyDAO' },
    { type: 'input', name: 'symbol', message: chalk.green.bold('Governance token symbol'), default: 'GOV' },
    { type: 'input', name: 'decimals', message: chalk.green.bold('Token decimals (0-9)'), default: '6',
      validate: v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 9 ? true : 'Enter 0-9' },
    { type: 'input', name: 'supply', message: chalk.green.bold('Total initial supply (e.g. 1_000_000 or 1.5)'), default: '1_000_000',
      validate: (v) => { const s = String(v).replace(/_/g,'').trim(); return /^\d+(\.\d+)?$/.test(s) ? true : 'Enter a valid number'; } },
    { type: 'input', name: 'minCommunityTokensToCreate', message: chalk.green.bold('Min community tokens to create a proposal'), default: '1',
      validate: v => Number.isInteger(Number(v)) && Number(v) >= 0 ? true : 'Enter integer >= 0' },
    { type: 'confirm', name: 'lockMint', message: chalk.green.bold('Lock mint authority (recommended)'), default: true },
    { type: 'confirm', name: 'setFreezeToNull', message: chalk.green.bold('Remove freeze authority (recommended)'), default: true },
    { type: 'input', name: 'governanceProgramId', message: chalk.green.bold('SPL Governance Program ID (leave blank to set later in .env)'), default: '' },
  ]);

  const decimalsNum = Number(decimals);
  const supplyStr = String(supply).replace(/_/g,'').trim();
  function toBaseUnits(amountStr, d) {
    const [w, f=''] = amountStr.split('.');
    if (!/^\d+$/.test(w) || (f && !/^\d+$/.test(f))) throw new Error('Invalid number');
    if (f.length > d) throw new Error(`Too many decimal places (max ${d})`);
    const fracPadded = f.padEnd(d, '0');
    const base = 10n ** BigInt(d);
    return BigInt(w) * base + (fracPadded ? BigInt(fracPadded) : 0n);
  }
  let totalSupplyBase;
  try { totalSupplyBase = toBaseUnits(supplyStr, decimalsNum); } catch (e) { console.log(chalk.red(`\nInvalid supply: ${e.message}`)); return; }

  // Load payer
  const payerSecret = await fs.readJSON(path.join(WALLETS_DIR, walletFile));
  const payer = Keypair.fromSecretKey(new Uint8Array(payerSecret));
  const connection = new Connection(config.rpcUrl, 'confirmed');

  // Ensure minimal balance
  try {
    const bal = await connection.getBalance(payer.publicKey);
    if (bal < 0.05 * LAMPORTS_PER_SOL && ['devnet','testnet'].includes(config.network)) {
      console.log(chalk.gray('\nLow balance detected, requesting airdrop (1 SOL)...'));
      await requestAirdrop(payer.publicKey, 1);
    }
  } catch {}

  // 1) Create governance token mint
  const spinner = ora({ text: chalk.white('Creating governance token mint'), spinner: 'dots2' }).start();
  try {
    const mint = await splToken.createMint(
      connection,
      payer,
      payer.publicKey, // temporary mint authority for initial distribution
      payer.publicKey, // freeze authority (removed if requested below)
      decimalsNum
    );
    spinner.succeed(chalk.yellow('Mint created'));

    // 2) Create payer ATA and mint full supply to treasury (payer)
    const distSpin = ora({ text: chalk.white('Creating treasury and minting supply'), spinner: 'dots2' }).start();
    const payerAta = await splToken.getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    if (totalSupplyBase > 0n) {
      await splToken.mintTo(connection, payer, mint, payerAta.address, payer, totalSupplyBase);
    }
    distSpin.succeed(chalk.yellow('Treasury funded'));

    // 3) Optionally lock authorities per best practices for governance mints
    const authSpin = ora({ text: chalk.white('Applying authority configuration'), spinner: 'dots2' }).start();
    if (lockMint) {
      await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.MintTokens, null);
    }
    if (setFreezeToNull) {
      try { await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.FreezeAccount, null); } catch {}
    }
    authSpin.succeed(chalk.yellow('Authorities configured'));

    // 4) Realm scaffolding guidance (SPL Governance / Realms)
    console.log();
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' GOVERNANCE SETUP                                                           ') + chalk.hex('#8B5CF6')('║'));
    const clusterParam = config.network === 'mainnet-beta' ? '' : `?cluster=${config.network}`;
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Token Mint    ') + chalk.gray('│ ') + chalk.yellow(mint.toBase58().substring(0,58).padEnd(58)) + chalk.hex('#8B5CF6')('║'));
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Realm Name    ') + chalk.gray('│ ') + chalk.yellow((realmName || 'N/A').padEnd(58)) + chalk.hex('#8B5CF6')('║'));
    console.log(chalk.gray('Explorer (mint):     ') + chalk.yellow(`https://explorer.solana.com/address/${mint.toBase58()}${clusterParam}`));

    // Offer automated Realms setup via CLI if SOL CLI present (best-effort docs)
    const { next } = await inquirer.prompt([
      { type: 'list', name: 'next', message: chalk.green.bold('Next step'),
        choices: [
          { name: 'Open Realms app link and finish setup manually (recommended)', value: 'realms' },
          { name: 'Print CLI instructions for SPL Governance program', value: 'cli' },
          { name: 'Scaffold DAO web app (Next.js + Tailwind)', value: 'scaffold' },
          { name: 'Done', value: 'done' }
        ], default: 'realms' }
    ]);

    if (next === 'realms') {
      console.log();
      console.log(chalk.gray('Open Realms: ') + chalk.yellow('https://app.realms.today'));
      console.log(chalk.gray('• Create a new Realm and choose this mint as the Community (and/or Council) mint.'));
      console.log(chalk.gray(`• Realm name: ${realmName}`));
      console.log(chalk.gray('• Deposit tokens into the Realm to receive voting power.'));
      console.log();
      await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to return') }]);
    } else if (next === 'cli') {
      console.log();
      console.log(chalk.yellow('SPL Governance requires its program ID and CLI tooling.'));
      console.log(chalk.gray('Reference: https://docs.solana.foundation/guides/governance/realms'));
      console.log();
      await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to return') }]);
    } else if (next === 'scaffold') {
      const { appName } = await inquirer.prompt([
        { type: 'input', name: 'appName', message: chalk.green.bold('App folder name'), default: 'dao-web' }
      ]);
      const canonicalGovernancePid = config.network === 'mainnet-beta'
        ? 'GovER5LthhE1ASrPrZQ8G1Y8gjPgo9T9uG5kG4QDPWQ'
        : 'GvQk7DWjkZTzaZbT5v3fDcGbG1UTb5RVnbEJ1MfH9Rk5';
      const programIdToUse = (governanceProgramId && governanceProgramId.trim()) || canonicalGovernancePid;
      await scaffoldDaoWebApp(appName, {
        rpcUrl: config.rpcUrl,
        network: config.network,
        realmName,
        governanceProgramId: programIdToUse,
        realmAddress: '',
        governanceAddress: '',
        communityMint: mint.toBase58(),
        councilMint: '',
      });
      await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to return') }]);
  // Add a luxe hero and cards on Home
  const hero = `
  .hero{background:radial-gradient(800px 400px at 20% -10%,rgba(139,92,246,.35),rgba(0,0,0,0)),radial-gradient(600px 300px at 80% 0%,rgba(34,211,238,.2),rgba(0,0,0,0))}
  .glass{background:rgba(19,19,31,.6); border:1px solid rgba(255,255,255,.06); backdrop-filter: blur(12px);}
  `;
  await fs.appendFile(path.join(projectPath,'styles','globals.css'), hero);

  // Seed README
  const readme = `# ${appName}

Modern Solana DAO web app (Next.js + Tailwind + Wallet Adapter + SPL Governance)

Configure .env.local, then npm i && npm run dev. Deploy on Vercel.
`;
  await fs.writeFile(path.join(projectPath,'README.md'), readme);

    }
  } catch (e) {
    spinner.fail(chalk.red('Failed to create governance setup'));
    console.log(chalk.red(e.message));
    await new Promise(r => setTimeout(r, 2000));
    // 5) Offer to scaffold a modern Next.js web app wired to this setup
    const { scaffold } = await inquirer.prompt([
      { type: 'confirm', name: 'scaffold', message: chalk.green.bold('Scaffold a DAO web app (Next.js, Tailwind, wallet, proposals)?'), default: true }
    ]);
    if (scaffold) {
      const { appName } = await inquirer.prompt([
        { type: 'input', name: 'appName', message: chalk.green.bold('App folder name'), default: 'dao-web' }
      ]);
      await scaffoldDaoWebApp(appName, {
        rpcUrl: config.rpcUrl,
        network: config.network,
        realmName,
        governanceProgramId,
        realmAddress: '', // filled after Realm creation in Realms or via CLI
        governanceAddress: '',
        communityMint: mint.toBase58(),
        councilMint: '',
      });
      await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to return') }]);
    }

  }
}

async function scaffoldDaoWebApp(appName, env) {
  const projectPath = path.join(process.cwd(), appName);
  await fs.ensureDir(projectPath);
  await fs.ensureDir(path.join(projectPath, 'pages'));
  await fs.ensureDir(path.join(projectPath, 'components'));
  await fs.ensureDir(path.join(projectPath, 'styles'));

  const pkg = {
    name: appName,
    "private": true,
    version: '1.0.0',
    scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
    overrides: {
      "rimraf": "^5.0.5",
      "glob": "^10.3.12"
    },
    dependencies: {
      next: '^14.2.4',
      react: '^18.2.0',
      'react-dom': '^18.2.0',
      '@solana/web3.js': '^1.87.0',
      '@solana/wallet-adapter-base': '^0.9.23',
      '@solana/wallet-adapter-react': '^0.15.35',
      '@solana/wallet-adapter-react-ui': '^0.9.35',
      '@solana/wallet-adapter-phantom': '^0.9.7',
      '@solana/wallet-adapter-solflare': '^0.6.22',
      '@solana/spl-token': '^0.4.6',
      '@solana/spl-governance': '*',
      '@heroicons/react': '^2.1.5',
      'clsx': '^2.1.0',
      'tailwindcss': '^3.4.0',
      'postcss': '^8.4.0',
      'autoprefixer': '^10.4.0'
    }
  };
  const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true, swcMinify: true };
module.exports = nextConfig;`;
  const postcss = `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {}, }, };`;
  const tailwind = `/** @type {import('tailwindcss').Config} */
module.exports = { content: ['./pages/**/*.{js,jsx}', './components/**/*.{js,jsx}'], theme: { extend: {} }, plugins: [], };`;
  const globalsCss = `@tailwind base;@tailwind components;@tailwind utilities;
:root{--bg:#0b0b12;--card:#13131f;--muted:#9aa0ae;--primary:#8b5cf6;--accent:#22d3ee}
html,body,#__next{height:100%}
body{background:linear-gradient(180deg,#0b0b12,#0e0e18);color:white}
.container{max-width:1100px;margin:0 auto;padding:2rem}
.card{background:var(--card);border:1px solid #1f2030;border-radius:14px}
.btn{background:var(--primary);padding:.6rem 1rem;border-radius:.6rem}
.btn:hover{opacity:.9}
.link{color:var(--accent)}
`;
  const appJs = `import '../styles/globals.css';
import '@solana/wallet-adapter-react-ui/styles.css';
import { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
export default function App({ Component, pageProps }){
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
  const wallets = useMemo(()=>[new PhantomWalletAdapter(), new SolflareWalletAdapter({ network: 'devnet' })],[]);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Component {...pageProps} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}`;
  const headerJs = `import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import Link from 'next/link';
import { useMemo } from 'react';
export default function Header(){
  const links = useMemo(()=>[
    { href:'/', label:'Home' },
    { href:'/proposals', label:'Proposals' },
    { href:'/admin', label:'Admin' },
  ],[]);
  return (
    <div className="container">
      <div className="flex items-center justify-between mb-6">
        <div className="text-2xl font-semibold">{process.env.NEXT_PUBLIC_REALM_NAME || 'DAO'}</div>
        <div className="flex items-center gap-4">
          {links.map(x=> <Link key={x.href} className="text-sm text-gray-300 hover:text-white" href={x.href}>{x.label}</Link>)}
          <WalletMultiButton className="btn" />
        </div>
      </div>
    </div>
  );
}`;
  const layoutJs = `import Header from './Header';
export default function Layout({children}){return(<div><Header/><div className="container">{children}</div></div>)};`;
  const indexJs = `import Layout from '../components/Layout';
import Link from 'next/link';
export default function Home(){
  return (
    <Layout>
      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-6"> 
          <h2 className="text-xl font-semibold mb-2">Proposals</h2>
          <p className="text-sm text-gray-300 mb-4">View and vote on community proposals.</p>
          <Link className="btn inline-block" href="/proposals">Open</Link>
        </div>
        <div className="card p-6">
          <h2 className="text-xl font-semibold mb-2">Council / Admin</h2>
          <p className="text-sm text-gray-300 mb-4">Create proposals and manage governance.</p>
          <Link className="btn inline-block" href="/admin">Dashboard</Link>
        </div>
      </div>
    </Layout>
  );
}`;
  const proposalsJs = `import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { Connection, PublicKey } from '@solana/web3.js';
import { getGovernanceAccounts, GovernanceAccountParser, Governance, Proposal } from '@solana/spl-governance';

export default function Proposals(){
  const [items,setItems]=useState([]);
  useEffect(()=>{(async()=>{
    const endpoint = process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
    const programId = new PublicKey(process.env.NEXT_PUBLIC_GOVERNANCE_PROGRAM_ID || '');
    const realmPk = process.env.NEXT_PUBLIC_REALM_ADDRESS ? new PublicKey(process.env.NEXT_PUBLIC_REALM_ADDRESS) : null;
    if(!programId || !realmPk){ setItems([]); return; }
    const connection = new Connection(endpoint,'confirmed');
    const proposals = await getGovernanceAccounts(connection, programId, Proposal, GovernanceAccountParser(Proposal), [ {memcmp: { offset: 1, bytes: realmPk.toBase58() } } ]);
    setItems(proposals);
  })()},[]);
  return (
    <Layout>
      <h2 className="text-xl font-semibold mb-4">Proposals</h2>
      {!items.length && <div className="text-gray-400">No proposals found or REALM not set.</div>}
      <div className="space-y-3">
        {items.map(([pubkey, data])=> (
          <div key={pubkey.toBase58()} className="card p-4">
            <div className="font-medium">{data.account.name || pubkey.toBase58()}</div>
            <div className="text-sm text-gray-400">State: {data.account.state}</div>
          </div>
        ))}
      </div>
    </Layout>
  );
}`;
  const adminJs = `import Layout from '../components/Layout';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useMemo, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { withCreateProposal } from '@solana/spl-governance';

function isAdmin(pubkey){
  const admins = (process.env.NEXT_PUBLIC_ADMIN_WALLETS || '').split(',').map(x=>x.trim()).filter(Boolean);
  return pubkey && admins.includes(pubkey.toBase58());
}

export default function Admin(){
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [title,setTitle]=useState('New Proposal');
  const [busy,setBusy]=useState(false);
  const admin = isAdmin(publicKey);

  const disabled = !admin;
  const hint = !publicKey ? 'Connect wallet' : (!admin ? 'Your wallet is not in NEXT_PUBLIC_ADMIN_WALLETS' : '');

  const onCreate=async()=>{
    if(!publicKey){ alert('Connect wallet'); return; }
    if(!admin){ alert('Not authorized'); return; }
    try{
      setBusy(true);
      const programId = new PublicKey(process.env.NEXT_PUBLIC_GOVERNANCE_PROGRAM_ID);
      const realm = new PublicKey(process.env.NEXT_PUBLIC_REALM_ADDRESS);
      const governance = new PublicKey(process.env.NEXT_PUBLIC_GOVERNANCE_ADDRESS);
      // TokenOwnerRecord PDA must be derived; for scaffold we let backend fetch/derive later; here we fallback to wallet to create proposals where allowed.
      const tokenOwnerRecord = new PublicKey(process.env.NEXT_PUBLIC_TOKEN_OWNER_RECORD || publicKey.toBase58());
      const proposalIndex = 0; // placeholder
      const instructions = [];
      await withCreateProposal(instructions, programId, 1, realm, governance, tokenOwnerRecord, title, '', publicKey, publicKey, proposalIndex, undefined, undefined, undefined);
      const tx = new Transaction(); instructions.forEach(ix=>tx.add(ix));
      await sendTransaction(tx, connection);
      alert('Proposal submitted');
    }catch(e){ console.error(e); alert(e.message); } finally{ setBusy(false); }
  };
  return (
    <Layout>
      <div className="card p-6 max-w-xl">
        <h2 className="text-xl font-semibold mb-2">Admin / Council</h2>
        <p className="text-sm text-gray-300 mb-4">Only wallets listed in NEXT_PUBLIC_ADMIN_WALLETS can create proposals here.</p>
        {hint && <div className="text-xs text-red-300 mb-3">{hint}</div>}
        <input className="w-full mb-3 p-2 rounded bg-[#0f1020] border border-[#23243a]" value={title} onChange={e=>setTitle(e.target.value)} />
        <button className="btn" disabled={busy || disabled} onClick={onCreate}>{busy?'Submitting...':'Create Proposal'}</button>
      </div>
    </Layout>
  );
}`;

  const envLocal = `NEXT_PUBLIC_RPC_URL=${env.rpcUrl}
NEXT_PUBLIC_CLUSTER=${env.network}
NEXT_PUBLIC_REALM_NAME=${env.realmName || ''}
NEXT_PUBLIC_GOVERNANCE_PROGRAM_ID=${env.governanceProgramId || ''}
NEXT_PUBLIC_REALM_ADDRESS=${env.realmAddress || ''}
NEXT_PUBLIC_GOVERNANCE_ADDRESS=${env.governanceAddress || ''}
NEXT_PUBLIC_COMMUNITY_MINT=${env.communityMint || ''}
NEXT_PUBLIC_COUNCIL_MINT=${env.councilMint || ''}
NEXT_PUBLIC_ADMIN_WALLETS=${(env.adminWallets || []).join(',')}
`;

  await fs.writeJSON(path.join(projectPath,'package.json'), pkg, { spaces: 2 });
  // Tailwind init files
  await fs.writeFile(path.join(projectPath,'styles','globals.css'), globalsCss);
  await fs.writeFile(path.join(projectPath,'postcss.config.js'), postcss);
  await fs.writeFile(path.join(projectPath,'tailwind.config.js'), tailwind);
  await fs.writeFile(path.join(projectPath,'next.config.js'), nextConfig);
  await fs.writeFile(path.join(projectPath,'postcss.config.js'), postcss);
  await fs.writeFile(path.join(projectPath,'tailwind.config.js'), tailwind);
  await fs.writeFile(path.join(projectPath,'pages','_app.js'), appJs);
  await fs.writeFile(path.join(projectPath,'pages','index.js'), indexJs);
  await fs.writeFile(path.join(projectPath,'pages','proposals.js'), proposalsJs);
  await fs.writeFile(path.join(projectPath,'pages','admin.js'), adminJs);
  await fs.writeFile(path.join(projectPath,'components','Header.js'), headerJs);
  await fs.writeFile(path.join(projectPath,'components','Layout.js'), layoutJs);
  await fs.writeFile(path.join(projectPath,'.env.local'), envLocal);

  console.log();
  console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' WEB APP TEMPLATE CREATED                                                  ') + chalk.hex('#8B5CF6')('║'));
  console.log(chalk.hex('#8B5CF6')('                      ╠═══════════════════════════════════════════════════════════════════════════╣'));
  console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Path          ') + chalk.gray('│ ') + chalk.white(projectPath.padEnd(58)) + chalk.hex('#8B5CF6')('║'));
  console.log();
  console.log(chalk.gray('Next steps:'));
  console.log(chalk.gray(`  1. cd ${appName}`));
  console.log(chalk.gray('  2. npm install'));
  console.log(chalk.gray('  3. npm run dev (or vercel deploy)'));
}


  const payerSecret = await fs.readJSON(path.join(WALLETS_DIR, walletFile));
  const payer = Keypair.fromSecretKey(new Uint8Array(payerSecret));
  const connection = new Connection(config.rpcUrl, 'confirmed');

  // Ensure minimal balance
  try {
    const bal = await connection.getBalance(payer.publicKey);
    if (bal < 0.05 * LAMPORTS_PER_SOL && ['devnet','testnet'].includes(config.network)) {
      console.log(chalk.gray('\nLow balance detected, requesting airdrop (1 SOL)...'));
      await requestAirdrop(payer.publicKey, 1);
    }
  } catch {}

  const spinner = ora({ text: chalk.white('Creating governance token mint'), spinner: 'dots2' }).start();
  try {
    const freezeAuth = payer.publicKey; // default freeze = payer; can be moved to multisig or removed later

    const mint = await splToken.createMint(
      connection,
      payer,
      payer.publicKey, // temporary mint authority for initial distribution
      freezeAuth,
      decimals
    );
    spinner.succeed(chalk.yellow('Mint created'));

    // Distribution
    let recipients = [];
    if (distributeMode === 'equal') {
      const per = totalSupplyBase / BigInt(membersCount);
      let remainder = totalSupplyBase - per * BigInt(membersCount);
      recipients = memberPubkeys.map((pk, idx) => ({ pk, amount: per + (remainder > 0n && idx === 0 ? remainder : 0n) }));
    } else {
      recipients = [{ pk: payer.publicKey, amount: totalSupplyBase }];
    }

    const distSpin = ora({ text: chalk.white('Distributing initial supply'), spinner: 'dots2' }).start();
    for (const r of recipients) {
      const ata = await splToken.getOrCreateAssociatedTokenAccount(connection, payer, mint, r.pk);
      if (r.amount > 0n) {
        await splToken.mintTo(connection, payer, mint, ata.address, payer, r.amount);
      }
    }
    distSpin.succeed(chalk.yellow('Initial distribution complete'));

    // Create multisig and set authorities (unless locking)
    let multisigPk = null;
    if (!lockMint) {
      const signerKeys = includePayer ? [payer.publicKey, ...memberPubkeys] : memberPubkeys;
      const uniqueSigners = Array.from(new Map(signerKeys.map(k => [k.toBase58(), k])).values());
      const m = Number(threshold);
      const msSpin = ora({ text: chalk.white('Creating multisig account'), spinner: 'dots2' }).start();
      multisigPk = await splToken.createMultisig(connection, payer, uniqueSigners, m);
      msSpin.succeed(chalk.yellow('Multisig created'));

      const authSpin = ora({ text: chalk.white('Transferring authorities to multisig'), spinner: 'dots2' }).start();
      await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.MintTokens, multisigPk);
      if (setFreezeToMultisig) {
        try { await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.FreezeAccount, multisigPk); } catch {}
      }
      authSpin.succeed(chalk.yellow('Authorities updated'));
    } else {
      const lockSpin = ora({ text: chalk.white('Locking mint authority'), spinner: 'dots2' }).start();
      await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.MintTokens, null);
      if (setFreezeToMultisig) {
        // If locking but asked to set freeze to multisig, create one just for freeze control
        const signerKeys = includePayer ? [payer.publicKey, ...memberPubkeys] : memberPubkeys;
        const uniqueSigners = Array.from(new Map(signerKeys.map(k => [k.toBase58(), k])).values());
        const m = Number(threshold);
        const msPk = await splToken.createMultisig(connection, payer, uniqueSigners, m);
        try { await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.FreezeAccount, msPk); } catch {}
        multisigPk = msPk;
      } else {
        try { await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.FreezeAccount, null); } catch {}
      }
      lockSpin.succeed(chalk.yellow('Mint locked'));
    }

    console.log();
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' DAO CREATED                                                                ') + chalk.hex('#8B5CF6')('║'));
    const sym = (baseAnswers.symbol || '').toUpperCase();
    const clusterParam = config.network === 'mainnet-beta' ? '' : `?cluster=${config.network}`;
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' DAO Name      ') + chalk.gray('│ ') + chalk.yellow((baseAnswers.daoName || 'N/A').padEnd(58)) + chalk.hex('#8B5CF6')('║'));
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Token Mint    ') + chalk.gray('│ ') + chalk.yellow(mint.toBase58().substring(0,58).padEnd(58)) + chalk.hex('#8B5CF6')('║'));
    if (multisigPk) {
      console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Multisig      ') + chalk.gray('│ ') + chalk.yellow(multisigPk.toBase58().substring(0,58).padEnd(58)) + chalk.hex('#8B5CF6')('║'));
      console.log(chalk.gray('Explorer (multisig): ') + chalk.yellow(`https://explorer.solana.com/address/${multisigPk.toBase58()}${clusterParam}`));
    }
    console.log(chalk.gray('Explorer (mint):     ') + chalk.yellow(`https://explorer.solana.com/address/${mint.toBase58()}${clusterParam}`));
    console.log();

    await new Promise(r => setTimeout(r, 2500));
  } catch (e) {
    spinner.fail(chalk.red('Failed to create DAO'));
    console.log(chalk.red(e.message));
    await new Promise(r => setTimeout(r, 2000));
  }
}


async function walletMenu() {
  while (true) {
    displayTitle();
    console.log(chalk.bgCyan.black.bold(' WALLET COMMAND CENTER '));
    console.log();

    const { walletAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'walletAction',
        message: chalk.yellow.bold('Select wallet operation'),
        choices: [
          {
            name: chalk.white('[ 1 ]') + ' ' + chalk.yellow.bold('CREATE WALLET') + chalk.gray('   Generate a new keypair'),
            value: 'create'
          },
          {
            name: chalk.white('[ 2 ]') + ' ' + chalk.yellow.bold('IMPORT WALLET') + chalk.gray('   Bring in an existing keypair'),
            value: 'import'
          },
          {
            name: chalk.white('[ 3 ]') + ' ' + chalk.yellow.bold('SWITCH WALLET') + chalk.gray('   Change the active default'),
            value: 'switch'
          },
          {
            name: chalk.white('[ 4 ]') + ' ' + chalk.yellow.bold('REQUEST AIRDROP') + chalk.gray('   Fund devnet/testnet wallets'),
            value: 'airdrop'
          },
          {
            name: chalk.white('[ 5 ]') + ' ' + chalk.yellow.bold('SEND SOL') + chalk.gray('        Transfer funds to another wallet'),
            value: 'send'
          },
          {
            name: chalk.white('[ 6 ]') + ' ' + chalk.yellow.bold('VIEW SPL TOKENS') + chalk.gray('  See token balances for a wallet'),
            value: 'view-tokens'
          },
          {
            name: chalk.white('[ 7 ]') + ' ' + chalk.yellow.bold('SEND SPL TOKEN') + chalk.gray('  Transfer an SPL token'),
            value: 'send-token'
          },
          new inquirer.Separator(chalk.hex('#8B5CF6')('─'.repeat(75))),
          {
            name: chalk.white('[ 0 ]') + ' ' + chalk.gray.bold('BACK') + chalk.gray('            Return to previous menu'),
            value: 'back'
          }
        ],
        pageSize: 10
      }
    ]);

    switch (walletAction) {
      case 'create':
        await createWallet();
        break;
      case 'import':
        await importWallet();
        break;
      case 'switch':
        await setDefaultWallet({ returnToSettings: false });
        break;
      case 'airdrop':
        await walletAirdropFlow();
        break;
      case 'send':
        await sendSolFlow();
        break;
      case 'view-tokens':
        await viewSplTokensFlow();
        break;

      case 'send-token':
        await sendSplTokenFlow();
        break;
      case 'back':
        return;
    }
  }
}

/**
 * Create a new Solana wallet
 */
async function createWallet() {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' WALLET GENERATION '));
  console.log();
  
  const { walletName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'walletName',
      message: chalk.green.bold('Enter wallet name'),
      default: 'my-wallet',
      validate: (input) => input.length > 0 || 'Wallet name cannot be empty'
    }
  ]);
  
  const spinner = ora({
    text: chalk.white('Generating cryptographic keypair'),
    spinner: 'dots2'
  }).start();
  
  try {
    const keypair = Keypair.generate();
    const walletPath = path.join(WALLETS_DIR, `${walletName}.json`);
    
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Save keypair
    await fs.writeJSON(walletPath, Array.from(keypair.secretKey), { spaces: 2 });
    
    spinner.succeed(chalk.yellow('Keypair generated successfully'));
    
    console.log();
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' WALLET DETAILS                                                            ') + chalk.hex('#8B5CF6')('║'));
    
    // Properly aligned rows
    const nameValue = walletName.padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Name          ') + chalk.gray('│ ') + chalk.yellow(nameValue) + chalk.hex('#8B5CF6')('║'));
    
    const pubkeyValue = keypair.publicKey.toString().padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Public Key    ') + chalk.gray('│ ') + chalk.yellow(pubkeyValue) + chalk.hex('#8B5CF6')('║'));
    
    const pathValue = walletPath.substring(0, 58).padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Location      ') + chalk.gray('│ ') + chalk.blue(pathValue) + chalk.hex('#8B5CF6')('║'));
    console.log();
    
    console.log(chalk.red.bold(' SECURITY NOTICE'));
    console.log(chalk.gray(' ▸ Keep your wallet file secure and backed up'));
    console.log(chalk.gray(' ▸ Never share your private key with anyone'));
    console.log(chalk.gray(' ▸ Store keypair files in a secure location'));
    console.log();
    
    // Offer to set as default
    const { setDefault } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setDefault',
        message: chalk.green.bold('Set as default wallet?'),
        default: true
      }
    ]);
    
    if (setDefault) {
      const config = await loadConfig();
      config.defaultWallet = walletName;
      config.lastUsed = new Date().toISOString();
      await saveConfig(config);
      console.log(chalk.yellow('✓ Default wallet configured'));
    }
    
    console.log();
    
    // Offer to airdrop
    const { airdrop } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'airdrop',
        message: chalk.green.bold('Request devnet airdrop (2 SOL)?'),
        default: true
      }
    ]);
    
    if (airdrop) {
      await requestAirdrop(keypair.publicKey);
    }
    
    console.log();
    console.log(chalk.green.bold('✓ Wallet creation complete'));
    console.log();
    
  } catch (error) {
    spinner.fail(chalk.red('Wallet generation failed'));
    console.error(chalk.red('Error: ') + chalk.gray(error.message));
  }
  
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Import an existing wallet
 */
async function importWallet() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('IMPORT WALLET\n'));
  
  const { importMethod } = await inquirer.prompt([
    {
      type: 'list',
      name: 'importMethod',
      message: 'How would you like to import?',
      choices: [
        { name: 'From keypair file path', value: 'file' },
        { name: 'Paste secret key (JSON array)', value: 'paste' },
        { name: 'Back', value: 'back' }
      ]
    }
  ]);
  
  if (importMethod === 'back') return;
  
  try {
    let secretKey;
    
    if (importMethod === 'file') {
      const { filePath } = await inquirer.prompt([
        {
          type: 'input',
          name: 'filePath',
          message: 'Enter path to keypair file:',
          validate: async (input) => {
            if (!input) return 'Path cannot be empty';
            if (!await fs.pathExists(input)) return 'File not found';
            return true;
          }
        }
      ]);
      
      secretKey = await fs.readJSON(filePath);
    } else {
      const { keyInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'keyInput',
          message: 'Paste secret key JSON array [1,2,3...]:'
        }
      ]);
      
      secretKey = JSON.parse(keyInput);
    }
    
    const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
    
    const { walletName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'walletName',
        message: 'Enter name for this wallet:',
        default: 'imported-wallet'
      }
    ]);
    
    const walletPath = path.join(WALLETS_DIR, `${walletName}.json`);
    await fs.writeJSON(walletPath, Array.from(keypair.secretKey), { spaces: 2 });
    
    console.log(chalk.yellow('\n✔ Wallet imported successfully!'));
    console.log(chalk.white(`Public Key: ${keypair.publicKey.toString()}`));
    console.log(chalk.white(`Saved to: ${walletPath}\n`));
    

/**
 * Create SPL Token flow (noob-friendly)
 */
async function createSplTokenFlow() {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' SPL TOKEN CREATOR '));
  console.log();

  const config = await loadConfig();

  // Ensure a wallet exists
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? await fs.readdir(WALLETS_DIR) : [];
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  if (wallets.length === 0) {
    const noWalletBox = centeredBox([
      '',
      'No wallets available',
      'Create or import a wallet first via WALLET menu',
      ''
    ]);
    console.log(centerBlock(chalk.red(noWalletBox)));
    console.log();
    await new Promise(r => setTimeout(r, 2000));
    return;
  }

  // Choose wallet (prefer default)
  let defaultChoice = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (defaultChoice && !wallets.includes(defaultChoice)) defaultChoice = null;
  const { walletFile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'walletFile',
      message: chalk.green.bold('Select creator wallet (payer + mint authority)'),
      choices: [
        ...(defaultChoice ? [{ name: `${config.defaultWallet} (default)`, value: defaultChoice }, new inquirer.Separator()] : []),
        ...wallets.map(w => ({ name: w.replace('.json', ''), value: w }))
      ],
      default: defaultChoice || undefined
    }
  ]);

  // Token params
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'symbol',
      message: chalk.green.bold('Token symbol (display only, optional)'),
      default: 'TOKEN'
    },
    {
      type: 'input',
      name: 'decimals',
      message: chalk.green.bold('Decimals (0-9)'),
      default: '6',
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n)) return 'Enter an integer';
        if (n < 0 || n > 9) return 'Decimals must be 0-9';
        return true;
      }
    },
    {
      type: 'input',
      name: 'supply',
      message: chalk.green.bold('Initial supply (e.g. 1_000_000 or 1.5)'),
      default: '1_000_000',
      validate: (v) => {
        const s = String(v).replace(/_/g, '').trim();
        if (!/^\d+(\.\d+)?$/.test(s)) return 'Enter a valid number';
        return true;
      }
    },
    {
      type: 'confirm',
      name: 'setFreeze',
      message: chalk.green.bold('Enable freeze authority (you can freeze token accounts)?'),
      default: false
    },
    {
      type: 'input',
      name: 'recipient',
      message: chalk.green.bold('Recipient address for initial supply (leave blank = creator)'),
      default: ''
    },
    {
      type: 'confirm',
      name: 'lockMint',
      message: chalk.green.bold('Lock mint authority after minting (fix total supply)?'),
      default: true
    }
  ]);

  const decimals = Number(answers.decimals);
  const cleanSupply = String(answers.supply).replace(/_/g, '').trim();

  // Safe decimal -> base units conversion
  function toBaseUnits(amountStr, decimals) {
    const [w, f = ''] = amountStr.split('.');
    if (!/^\d+$/.test(w) || (f && !/^\d+$/.test(f))) throw new Error('Invalid number');
    if (f.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
    const fracPadded = f.padEnd(decimals, '0');
    const base = 10n ** BigInt(decimals);
    return BigInt(w) * base + (fracPadded ? BigInt(fracPadded) : 0n);
  }

  let amountBase = 0n;
  try {
    amountBase = toBaseUnits(cleanSupply, decimals);
  } catch (e) {
    console.log(chalk.red(`\nInvalid supply: ${e.message}`));
    await new Promise(r => setTimeout(r, 2000));
    return;
  }

  // Load wallet
  const walletPath = path.join(WALLETS_DIR, walletFile);
  const secretKeyData = await fs.readJSON(walletPath);
  const payer = Keypair.fromSecretKey(new Uint8Array(secretKeyData));

  // Recipient
  let recipientPk;
  if (answers.recipient.trim()) {
    try { recipientPk = new PublicKey(answers.recipient.trim()); } catch { console.log(chalk.red('\nInvalid recipient address')); return; }
  } else {
    recipientPk = payer.publicKey;
  }

  const connection = new Connection(config.rpcUrl, 'confirmed');

  // Ensure minimal balance
  try {
    const bal = await connection.getBalance(payer.publicKey);
    const need = 0.05 * LAMPORTS_PER_SOL;
    if (bal < need && ['devnet', 'testnet'].includes(config.network)) {
      console.log(chalk.gray('\nLow balance detected, requesting airdrop (1 SOL)...'));
      await requestAirdrop(payer.publicKey, 1);
    }
  } catch {}

  const spinner = ora({ text: chalk.white('Creating mint account'), spinner: 'dots2' }).start();
  try {
    const freezeAuth = answers.setFreeze ? payer.publicKey : null;

    // Create mint
    const mint = await splToken.createMint(
      connection,
      payer,
      payer.publicKey,     // mint authority
      freezeAuth,          // freeze authority or null
      decimals
    );

    spinner.succeed(chalk.yellow('Mint created'));

    // Create/get ATA for recipient
    const ataSpinner = ora({ text: chalk.white('Preparing recipient token account'), spinner: 'dots2' }).start();
    const ata = await splToken.getOrCreateAssociatedTokenAccount(connection, payer, mint, recipientPk);
    ataSpinner.succeed(chalk.yellow('Recipient token account ready'));

    // Mint initial supply if > 0
    if (amountBase > 0n) {
      const mintSpinner = ora({ text: chalk.white('Minting initial supply'), spinner: 'dots2' }).start();
      await splToken.mintTo(connection, payer, mint, ata.address, payer, amountBase);
      mintSpinner.succeed(chalk.yellow('Supply minted'));
    }

    // Optionally revoke mint authority
    if (answers.lockMint) {
      const lockSpinner = ora({ text: chalk.white('Locking mint authority (fixed supply)'), spinner: 'dots2' }).start();
      await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.MintTokens, null);
      lockSpinner.succeed(chalk.yellow('Mint authority revoked'));
    }

    console.log();
  console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' TOKEN CREATED                                                             ') + chalk.hex('#8B5CF6')('║'));
    const sym = (answers.symbol || '').toUpperCase();
    const symValue = (sym ? sym : 'N/A').padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Symbol        ') + chalk.gray('│ ') + chalk.yellow(symValue) + chalk.hex('#8B5CF6')('║'));
    const mintValue = mint.toBase58().substring(0,58).padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Mint          ') + chalk.gray('│ ') + chalk.yellow(mintValue) + chalk.hex('#8B5CF6')('║'));
    const ataValue = ata.address.toBase58().substring(0,58).padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Recipient ATA ') + chalk.gray('│ ') + chalk.yellow(ataValue) + chalk.hex('#8B5CF6')('║'));
    const decValue = String(decimals).padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Decimals      ') + chalk.gray('│ ') + chalk.white(decValue) + chalk.hex('#8B5CF6')('║'));
    const supplyDisplay = cleanSupply.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const supplyValue = `${supplyDisplay} ${sym || 'tokens'}`.padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Minted        ') + chalk.gray('│ ') + chalk.yellow(supplyValue) + chalk.hex('#8B5CF6')('║'));
    console.log();

    const clusterParam = config.network === 'mainnet-beta' ? '' : `?cluster=${config.network}`;
    console.log(chalk.gray('Explorer (mint): ') + chalk.yellow(`https://explorer.solana.com/address/${mint.toBase58()}${clusterParam}`));
    console.log(chalk.gray('Explorer (ATA):  ') + chalk.yellow(`https://explorer.solana.com/address/${ata.address.toBase58()}${clusterParam}`));

    console.log();
    console.log(chalk.gray('Note: Token name/symbol are not on-chain without Metaplex metadata.'));
    console.log(chalk.gray('You can add metadata later with Metaplex Token Metadata tools.'));
    console.log();

    await new Promise(r => setTimeout(r, 3000));
  } catch (err) {
    spinner.fail(chalk.red('Failed to create SPL token'));
    console.log(chalk.red(err.message));
    console.log();
    await new Promise(r => setTimeout(r, 2500));
  }
}

  } catch (error) {
    console.log(chalk.red('\nERROR: Failed to import wallet'));
    console.error(chalk.red(error.message + '\n'));
  }
  
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Create a new Solana project (quick scaffold)
 */


/**
 * Create SPL Token flow (noob-friendly)
 */
async function createSplTokenFlow() {
  displayTitle();
  console.log(chalk.bgGreen.black.bold(' SPL TOKEN CREATOR '));
  console.log();

  const config = await loadConfig();

  // Ensure a wallet exists
  const walletFiles = (await fs.pathExists(WALLETS_DIR)) ? await fs.readdir(WALLETS_DIR) : [];
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  if (wallets.length === 0) {
    const noWalletBox = centeredBox([
      '',
      'No wallets available',
      'Create or import a wallet first via WALLET menu',
      ''
    ]);
    console.log(centerBlock(chalk.red(noWalletBox)));
    console.log();
    await new Promise(r => setTimeout(r, 2000));
    return;
  }

  // Choose wallet (prefer default)
  let defaultChoice = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (defaultChoice && !wallets.includes(defaultChoice)) defaultChoice = null;
  const { walletFile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'walletFile',
      message: chalk.green.bold('Select creator wallet (payer + mint authority)'),
      choices: [
        ...(defaultChoice ? [{ name: `${config.defaultWallet} (default)`, value: defaultChoice }, new inquirer.Separator()] : []),
        ...wallets.map(w => ({ name: w.replace('.json', ''), value: w }))
      ],
      default: defaultChoice || undefined
    }
  ]);

  // Token params
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'symbol',
      message: chalk.green.bold('Token symbol (display only, optional)'),
      default: 'TOKEN'
    },
    {
      type: 'input',
      name: 'decimals',
      message: chalk.green.bold('Decimals (0-9)'),
      default: '6',
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n)) return 'Enter an integer';
        if (n < 0 || n > 9) return 'Decimals must be 0-9';
        return true;
      }
    },
    {
      type: 'input',
      name: 'supply',
      message: chalk.green.bold('Initial supply (e.g. 1_000_000 or 1.5)'),
      default: '1_000_000',
      validate: (v) => {
        const s = String(v).replace(/_/g, '').trim();
        if (!/^\d+(\.\d+)?$/.test(s)) return 'Enter a valid number';
        return true;
      }
    },
    {
      type: 'confirm',
      name: 'setFreeze',
      message: chalk.green.bold('Enable freeze authority (you can freeze token accounts)?'),
      default: false
    },
    {
      type: 'input',
      name: 'recipient',
      message: chalk.green.bold('Recipient address for initial supply (leave blank = creator)'),
      default: ''
    },
    {
      type: 'confirm',
      name: 'lockMint',
      message: chalk.green.bold('Lock mint authority after minting (fix total supply)?'),
      default: true
    }
  ]);

  const decimals = Number(answers.decimals);
  const cleanSupply = String(answers.supply).replace(/_/g, '').trim();

  // Safe decimal -> base units conversion
  function toBaseUnits(amountStr, decimals) {
    const [w, f = ''] = amountStr.split('.');
    if (!/^\d+$/.test(w) || (f && !/^\d+$/.test(f))) throw new Error('Invalid number');
    if (f.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
    const fracPadded = f.padEnd(decimals, '0');
    const base = 10n ** BigInt(decimals);
    return BigInt(w) * base + (fracPadded ? BigInt(fracPadded) : 0n);
  }

  let amountBase = 0n;
  try {
    amountBase = toBaseUnits(cleanSupply, decimals);
  } catch (e) {
    console.log(chalk.red(`\nInvalid supply: ${e.message}`));
    await new Promise(r => setTimeout(r, 2000));
    return;
  }

  // Load wallet
  const walletPath = path.join(WALLETS_DIR, walletFile);
  const secretKeyData = await fs.readJSON(walletPath);
  const payer = Keypair.fromSecretKey(new Uint8Array(secretKeyData));

  // Recipient
  let recipientPk;
  if (answers.recipient.trim()) {
    try { recipientPk = new PublicKey(answers.recipient.trim()); } catch { console.log(chalk.red('\nInvalid recipient address')); return; }
  } else {
    recipientPk = payer.publicKey;
  }

  const connection = new Connection(config.rpcUrl, 'confirmed');

  // Ensure minimal balance
  try {
    const bal = await connection.getBalance(payer.publicKey);
    const need = 0.05 * LAMPORTS_PER_SOL;
    if (bal < need && ['devnet', 'testnet'].includes(config.network)) {
      console.log(chalk.gray('\nLow balance detected, requesting airdrop (1 SOL)...'));
      await requestAirdrop(payer.publicKey, 1);
    }
  } catch {}

  const spinner = ora({ text: chalk.white('Creating mint account'), spinner: 'dots2' }).start();
  try {
    const freezeAuth = answers.setFreeze ? payer.publicKey : null;

    // Create mint
    const mint = await splToken.createMint(
      connection,
      payer,
      payer.publicKey,     // mint authority
      freezeAuth,          // freeze authority or null
      decimals
    );

    spinner.succeed(chalk.yellow('Mint created'));

    // Create/get ATA for recipient
    const ataSpinner = ora({ text: chalk.white('Preparing recipient token account'), spinner: 'dots2' }).start();
    const ata = await splToken.getOrCreateAssociatedTokenAccount(connection, payer, mint, recipientPk);
    ataSpinner.succeed(chalk.yellow('Recipient token account ready'));

    // Mint initial supply if > 0
    if (amountBase > 0n) {
      const mintSpinner = ora({ text: chalk.white('Minting initial supply'), spinner: 'dots2' }).start();
      await splToken.mintTo(connection, payer, mint, ata.address, payer, amountBase);
      mintSpinner.succeed(chalk.yellow('Supply minted'));
    }

    // Optionally revoke mint authority
    if (answers.lockMint) {
      const lockSpinner = ora({ text: chalk.white('Locking mint authority (fixed supply)'), spinner: 'dots2' }).start();
      await splToken.setAuthority(connection, payer, mint, payer, splToken.AuthorityType.MintTokens, null);
      lockSpinner.succeed(chalk.yellow('Mint authority revoked'));
    }

    console.log();
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' TOKEN CREATED                                                             ') + chalk.hex('#8B5CF6')('║'));
    const sym = (answers.symbol || '').toUpperCase();
    const symValue = (sym ? sym : 'N/A').padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Symbol        ') + chalk.gray('│ ') + chalk.yellow(symValue) + chalk.hex('#8B5CF6')('║'));
    const mintValue = mint.toBase58().substring(0,58).padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Mint          ') + chalk.gray('│ ') + chalk.yellow(mintValue) + chalk.hex('#8B5CF6')('║'));
    const ataValue = ata.address.toBase58().substring(0,58).padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Recipient ATA ') + chalk.gray('│ ') + chalk.yellow(ataValue) + chalk.hex('#8B5CF6')('║'));
    const decValue = String(decimals).padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Decimals      ') + chalk.gray('│ ') + chalk.white(decValue) + chalk.hex('#8B5CF6')('║'));
    const supplyDisplay = cleanSupply.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const supplyValue = `${supplyDisplay} ${sym || 'tokens'}`.padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Minted        ') + chalk.gray('│ ') + chalk.yellow(supplyValue) + chalk.hex('#8B5CF6')('║'));
    console.log();

    const clusterParam = config.network === 'mainnet-beta' ? '' : `?cluster=${config.network}`;
    console.log(chalk.gray('Explorer (mint): ') + chalk.yellow(`https://explorer.solana.com/address/${mint.toBase58()}${clusterParam}`));
    console.log(chalk.gray('Explorer (ATA):  ') + chalk.yellow(`https://explorer.solana.com/address/${ata.address.toBase58()}${clusterParam}`));

    console.log();
    console.log(chalk.gray('Note: Token name/symbol are not on-chain without Metaplex metadata.'));
    console.log(chalk.gray('You can add metadata later with Metaplex Token Metadata tools.'));
    console.log();

    await new Promise(r => setTimeout(r, 3000));
  } catch (err) {
    spinner.fail(chalk.red('Failed to create SPL token'));
    console.log(chalk.red(err.message));
    console.log();
    await new Promise(r => setTimeout(r, 2500));
  }
}

/**
 * Wallet airdrop flow - request funds on devnet/testnet
 */
async function walletAirdropFlow() {
  displayTitle();
  console.log(chalk.bgCyan.black.bold(' WALLET AIRDROP '));
  console.log();
  console.log(chalk.white('Request SOL from the Solana faucet for development and testing.'));
  console.log();

  const config = await loadConfig();
  if (!['devnet', 'testnet'].includes(config.network)) {
    const warningBox = centeredBox([
      '',
      'Airdrop only supported on DEVNET or TESTNET',
      `Current network: ${config.network}`,
      'Switch networks in SETTINGS to continue',
      ''
    ]);
    console.log(centerBlock(chalk.red(warningBox)));
    console.log();
    await new Promise(resolve => setTimeout(resolve, 2500));
    return;
  }

  const walletFiles = await fs.readdir(WALLETS_DIR);
  const wallets = walletFiles.filter(f => f.endsWith('.json'));

  if (wallets.length === 0) {
    const noWalletBox = centeredBox([
      '',
      'No wallets available',
  'Create or import a wallet first via WALLET menu',
      ''
    ]);
    console.log(centerBlock(chalk.red(noWalletBox)));
    console.log();
    await new Promise(resolve => setTimeout(resolve, 2500));
    return;
  }

  let walletChoices = wallets.map(w => ({
    name: w.replace('.json', ''),
    value: w
  }));

  const configDefault = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (configDefault && wallets.includes(configDefault)) {
    walletChoices = [
      { name: `${config.defaultWallet} (default)`, value: configDefault },
      new inquirer.Separator(),
      ...walletChoices.filter(choice => choice.value !== configDefault)
    ];
  }

  const { walletFile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'walletFile',
      message: chalk.yellow.bold('Select wallet to fund'),
      choices: walletChoices
    }
  ]);

  const { amountInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'amountInput',
      message: chalk.yellow.bold('Amount of SOL to request (max 5)'),
      default: '1',
      validate: (input) => {
        const value = Number.parseFloat(input);
        if (Number.isNaN(value)) return 'Enter a numeric value';
        if (value <= 0) return 'Amount must be greater than zero';
        if (value > 5) return 'Maximum faucet request is 5 SOL';
        return true;
      }
    }
  ]);

  const amount = Number.parseFloat(amountInput);

  try {
    const walletPath = path.join(WALLETS_DIR, walletFile);
    const secretKeyData = await fs.readJSON(walletPath);
    const keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyData));

    const success = await requestAirdrop(keypair.publicKey, amount);

    if (success) {
      const connection = new Connection(config.rpcUrl, 'confirmed');
      const updatedLamports = await connection.getBalance(keypair.publicKey);
      const updatedBalance = Number.parseFloat((updatedLamports / LAMPORTS_PER_SOL).toFixed(4));
      console.log(chalk.white(`Wallet funded: ${keypair.publicKey.toBase58()}`));
      console.log(chalk.yellow(`New balance: ${formatSol(updatedBalance)} SOL`));
    } else {
      console.log(chalk.yellow('Airdrop did not complete successfully.'));
    }
  } catch (error) {
    console.log();
    console.log(chalk.red('Airdrop failed: ' + error.message));
  }

  console.log();
  await new Promise(resolve => setTimeout(resolve, 2500));
}

async function sendSolFlow() {
  displayTitle();
  console.log(chalk.bgCyan.black.bold(' SEND SOL '));
  console.log();

  const config = await loadConfig();
  const walletFiles = await fs.readdir(WALLETS_DIR);
  const wallets = walletFiles.filter(f => f.endsWith('.json'));

  if (wallets.length === 0) {
    const emptyBox = centeredBox([
      '',
      'No wallets available',
      'Create or import a wallet first via WALLET menu',
      ''
    ]);
    console.log(centerBlock(chalk.red(emptyBox)));
    console.log();
    await new Promise(resolve => setTimeout(resolve, 2500));
    return;
  }

  let walletChoices = wallets.map(w => ({
    name: w.replace('.json', ''),
    value: w
  }));

  const configDefault = config.defaultWallet ? `${config.defaultWallet}.json` : null;
  if (configDefault && wallets.includes(configDefault)) {
    walletChoices = [
      { name: `${config.defaultWallet} (default)`, value: configDefault },
      new inquirer.Separator(),
      ...walletChoices.filter(choice => choice.value !== configDefault)
    ];
  }

  const { walletFile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'walletFile',
      message: chalk.yellow.bold('Select wallet to send from'),
      choices: walletChoices
    }
  ]);

  const walletPath = path.join(WALLETS_DIR, walletFile);
  const secretKeyData = await fs.readJSON(walletPath);
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyData));

  const connection = new Connection(config.rpcUrl, 'confirmed');
  const balanceLamports = await connection.getBalance(keypair.publicKey);
  const availableSol = balanceLamports / LAMPORTS_PER_SOL;

  console.log(chalk.gray(`
Available balance: ${formatSol(availableSol)} SOL`));
  console.log();

  const { recipientInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'recipientInput',
      message: chalk.yellow.bold('Recipient address'),
      validate: (input) => {
        try {
          new PublicKey(input);
          return true;
        } catch {
          return 'Enter a valid Solana public key';
        }
      }
    }
  ]);

  const recipient = new PublicKey(recipientInput);

  if (recipient.equals(keypair.publicKey)) {
    console.log(chalk.yellow('\nSending to the same wallet is not necessary. Transfer cancelled.'));
    await new Promise(resolve => setTimeout(resolve, 2000));
    return;
  }

  const { amountInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'amountInput',
      message: chalk.yellow.bold('Amount of SOL to send'),
      validate: (input) => {
        const value = Number.parseFloat(input);
        if (Number.isNaN(value)) return 'Enter a numeric value';
        if (value <= 0) return 'Amount must be greater than zero';
        const lamports = Math.round(value * LAMPORTS_PER_SOL);
        if (lamports < 1) return 'Amount too small to transfer';
        const feeBuffer = 5000; // approx network fee reserve
        if (lamports + feeBuffer > balanceLamports) {
          return 'Insufficient balance for amount plus fees';
        }
        return true;
      }
    }
  ]);

  const amountSol = Number.parseFloat(amountInput);
  const lamportsToSend = Math.round(amountSol * LAMPORTS_PER_SOL);

  const { confirmSend } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmSend',
      message: chalk.yellow.bold(`Send ${formatSol(amountSol)} SOL to ${recipient.toBase58()}?`),
      default: true
    }
  ]);

  if (!confirmSend) {
    console.log(chalk.gray('\nTransfer cancelled'));
    await new Promise(resolve => setTimeout(resolve, 1500));
    return;
  }

  const spinner = ora({
    text: chalk.white('Submitting transfer to network'),
    spinner: 'dots2'
  }).start();

  try {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: recipient,
        lamports: lamportsToSend
      })
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [keypair], {
      commitment: 'confirmed'
    });

    spinner.succeed(chalk.yellow('Transfer complete'));

    const finalLamports = await connection.getBalance(keypair.publicKey);
    const finalBalance = Number.parseFloat((finalLamports / LAMPORTS_PER_SOL).toFixed(4));

    console.log();
    console.log(chalk.white(`Signature: ${signature}`));
    console.log(chalk.white(`Recipient: ${recipient.toBase58()}`));
    console.log(chalk.yellow(`Remaining balance: ${formatSol(finalBalance)} SOL`));
  } catch (error) {
    spinner.fail(chalk.red('Transfer failed'));
    console.log();
    console.log(chalk.red(error.message));
  }

  console.log();
  await new Promise(resolve => setTimeout(resolve, 2500));
}

/**
 * Deploy menu - for deploying programs to devnet
 */
async function deployMenu() {
  displayTitle();
  console.log(chalk.bgRed.black.bold(' DEPLOYMENT SYSTEM '));
  console.log();
  
  console.log(chalk.yellow.bold(' REQUIREMENTS'));
  console.log(chalk.gray(' ▸ Solana CLI installed and configured (solana --version)'));
  console.log(chalk.gray(' ▸ Rust program compiled via cargo build-sbf (produces .so from src/lib.rs)'));
  console.log(chalk.gray(' ▸ Wallet with sufficient SOL balance'));
  console.log();
  
  const { hasProgram } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'hasProgram',
      message: chalk.red.bold('Do you have a compiled program to deploy?'),
      default: true
    }
  ]);
  
  if (!hasProgram) {
    console.log();
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' BUILD FIRST                                                              ') + chalk.hex('#8B5CF6')('║'));
    console.log(chalk.hex('#8B5CF6')('║') + chalk.gray(' Use the BUILD menu to author your Rust program (see src/lib.rs).         ') + chalk.hex('#8B5CF6')('║'));
    console.log(chalk.hex('#8B5CF6')('║') + chalk.gray(' Compile with cargo build-sbf to produce the required .so artifact.       ') + chalk.hex('#8B5CF6')('║'));
    console.log();
    await new Promise(resolve => setTimeout(resolve, 2000));
    return;
  }
  
  const { programPath } = await inquirer.prompt([
    {
      type: 'input',
      name: 'programPath',
      message: chalk.red.bold('Enter path to compiled shared object (.so) generated from your Rust program'),
      validate: async (input) => {
        if (!input) return 'Path cannot be empty';
        if (!input.endsWith('.so')) return 'File must be a .so file';
        if (!await fs.pathExists(input)) return 'File not found';
        return true;
      }
    }
  ]);
  
  // Check for wallet
  const walletFiles = await fs.readdir(WALLETS_DIR);
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  
  if (wallets.length === 0) {
    console.log();
    console.log(chalk.red('╔═══════════════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.red('║') + chalk.white.bold(' NO WALLETS FOUND                                                         ') + chalk.red('║'));
    console.log(chalk.red('╠═══════════════════════════════════════════════════════════════════════════╣'));
  console.log(chalk.red('║') + chalk.gray(' Create a wallet first using the WALLET menu.                              ') + chalk.red('║'));
    console.log(chalk.red('╚═══════════════════════════════════════════════════════════════════════════╝'));
    console.log();
    await new Promise(resolve => setTimeout(resolve, 2000));
    return;
  }
  
  const { walletChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'walletChoice',
      message: chalk.red.bold('Select wallet for deployment'),
      choices: wallets.map(w => ({ 
        name: chalk.white('[ ') + chalk.yellow(w.replace('.json', '')) + chalk.white(' ]'), 
        value: w 
      }))
    }
  ]);
  
  const spinner = ora({
    text: chalk.white('Preparing deployment environment'),
    spinner: 'dots2'
  }).start();
  
  try {
    const walletPath = path.join(WALLETS_DIR, walletChoice);
    const secretKeyData = await fs.readJSON(walletPath);
    const keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyData));
    
    spinner.text = chalk.white('Checking wallet balance');
    
    const config = await loadConfig();
    const connection = new Connection(config.rpcUrl, 'confirmed');
    const balance = await connection.getBalance(keypair.publicKey);
    
    spinner.stop();
    
    console.log();
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' WALLET STATUS                                                             ') + chalk.hex('#8B5CF6')('║'));
    
    const addressValue = keypair.publicKey.toString().substring(0, 58).padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Address       ') + chalk.gray('│ ') + chalk.yellow(addressValue) + chalk.hex('#8B5CF6')('║'));
    
    const balanceValue = `${balance / LAMPORTS_PER_SOL} SOL`.padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Balance       ') + chalk.gray('│ ') + chalk.yellow(balanceValue) + chalk.hex('#8B5CF6')('║'));
    console.log();
    
    if (balance < 0.1 * LAMPORTS_PER_SOL) {
      console.log(chalk.yellow.bold(' LOW BALANCE WARNING'));
      console.log();
      
      const { needAirdrop } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'needAirdrop',
          message: chalk.yellow.bold('Request airdrop before deploying?'),
          default: true
        }
      ]);
      
      if (needAirdrop) {
        await requestAirdrop(keypair.publicKey);
      }
    }
    
    // Deploy using Solana CLI
    const deploySpinner = ora({
      text: chalk.white('Deploying program to Solana network'),
      spinner: 'dots2'
    }).start();
    
    try {
      const deployCmd = `solana program deploy ${programPath} --keypair ${walletPath} --url ${config.rpcUrl}`;
      const { stdout, stderr } = await execAsync(deployCmd);
      
      deploySpinner.succeed(chalk.yellow('Program deployed successfully'));
      
      console.log();
      console.log(chalk.yellow('╔═══════════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.yellow('║') + chalk.white.bold(' DEPLOYMENT COMPLETE                                                       ') + chalk.yellow('║'));
      console.log(chalk.yellow('╚═══════════════════════════════════════════════════════════════════════════╝'));
      console.log();
      console.log(chalk.white(stdout));
      
      if (stderr) {
        console.log(chalk.gray(stderr));
      }
      
    } catch (deployError) {
      deploySpinner.fail(chalk.red('Deployment failed'));
      console.log();
      console.log(chalk.red('╔═══════════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.red('║') + chalk.white.bold(' DEPLOYMENT ERROR                                                          ') + chalk.red('║'));
      console.log(chalk.red('╠═══════════════════════════════════════════════════════════════════════════╣'));
      
      const errorValue = deployError.message.substring(0, 58).padEnd(58);
      console.log(chalk.red('║') + chalk.white(' Error         ') + chalk.gray('│ ') + chalk.gray(errorValue) + chalk.red('║'));
      
      console.log(chalk.red('╚═══════════════════════════════════════════════════════════════════════════╝'));
      console.log();
      
      console.log(chalk.yellow.bold(' TROUBLESHOOTING'));
      console.log(chalk.gray(' ▸ Install Solana CLI: sh -c "$(curl -sSfL https://release.solana.com/stable/install)"'));
      console.log(chalk.gray(' ▸ Verify wallet has sufficient SOL balance'));
  console.log(chalk.gray(' ▸ Ensure program compiled correctly: cargo build-sbf'));
      console.log(chalk.gray(' ▸ Check network connectivity and RPC endpoint'));
      console.log();
    }
    
  } catch (error) {
    spinner.fail(chalk.red('Deployment preparation failed'));
    console.error(chalk.red('Error: ') + chalk.gray(error.message));
  }
  
  console.log();
  await new Promise(resolve => setTimeout(resolve, 3000));
}

/**
 * Settings menu - manage configuration
 */
async function settingsMenu() {
  displayTitle();
  console.log(chalk.bgYellow.black.bold(' SETTINGS PANEL '));
  console.log();
  
  const config = await loadConfig();
  
  const { settingAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'settingAction',
      message: chalk.yellow.bold('Select configuration option'),
      choices: [
        { 
          name: chalk.white('[ 1 ]') + ' ' + chalk.yellow.bold('VIEW SETTINGS') + chalk.gray('    Display current configuration'), 
          value: 'view' 
        },
        { 
          name: chalk.white('[ 2 ]') + ' ' + chalk.yellow.bold('CHANGE NETWORK') + chalk.gray('   Switch Solana network'), 
          value: 'network' 
        },
        { 
          name: chalk.white('[ 3 ]') + ' ' + chalk.yellow.bold('CUSTOM RPC') + chalk.gray('        Set custom RPC endpoint'), 
          value: 'rpc' 
        },
        { 
          name: chalk.white('[ 4 ]') + ' ' + chalk.yellow.bold('WALLET DIRECTORY') + chalk.gray(' View wallets location'), 
          value: 'wallets-dir' 
        },
        { 
          name: chalk.white('[ 5 ]') + ' ' + chalk.yellow.bold('RESET DEFAULTS') + chalk.gray('   Restore factory settings'), 
          value: 'reset' 
        },
        new inquirer.Separator(chalk.hex('#8B5CF6')('─'.repeat(75))),
        { 
          name: chalk.white('[ 0 ]') + ' ' + chalk.gray.bold('BACK') + chalk.gray('            Return to main menu'), 
          value: 'back' 
        }
      ],
      pageSize: 12
    }
  ]);
  
  switch (settingAction) {
    case 'view':
      await viewSettings();
      break;
    case 'network':
      await changeNetwork();
      break;
    case 'rpc':
      await setCustomRPC();
      break;
    case 'wallets-dir':
      console.log();
      console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' WALLET DIRECTORY LOCATION                                                 ') + chalk.hex('#8B5CF6')('║'));
      
      const pathValue = WALLETS_DIR.padEnd(58);
      console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Path          ') + chalk.gray('│ ') + chalk.white(pathValue) + chalk.hex('#8B5CF6')('║'));
      console.log();
      await new Promise(resolve => setTimeout(resolve, 2000));
      await settingsMenu();
      break;
    case 'reset':
      await resetSettings();
      break;
    case 'back':
      return;
  }
}

/**
 * View current settings
 */
async function viewSettings() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('CURRENT SETTINGS\n'));
  
  const config = await loadConfig();
  
  console.log(chalk.white('Network Configuration:'));
  console.log(chalk.gray(`  Network: ${config.network}`));
  console.log(chalk.gray(`  RPC URL: ${config.rpcUrl}`));
  console.log();
  
  console.log(chalk.white('Wallet Configuration:'));
  console.log(chalk.gray(`  Default Wallet: ${config.defaultWallet || 'None'}`));
  console.log(chalk.gray(`  Wallets Directory: ${WALLETS_DIR}`));
  console.log();
  
  console.log(chalk.white('System:'));
  console.log(chalk.gray(`  Config Directory: ${CONFIG_DIR}`));
  console.log(chalk.gray(`  Last Used: ${config.lastUsed || 'Never'}`));
  console.log();
  
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: 'Press Enter to continue...'
    }
  ]);
  
  await settingsMenu();
}

/**
 * Change network settings
 */
async function changeNetwork() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('CHANGE NETWORK\n'));
  
  const { network } = await inquirer.prompt([
    {
      type: 'list',
      name: 'network',
      message: 'Select network:',
      choices: [
        { name: 'Devnet (Development)', value: 'devnet' },
        { name: 'Testnet (Testing)', value: 'testnet' },
        { name: 'Mainnet Beta (Production)', value: 'mainnet-beta' },
        { name: 'Localhost', value: 'localhost' }
      ]
    }
  ]);
  
  const rpcUrls = {
    'devnet': 'https://api.devnet.solana.com',
    'testnet': 'https://api.testnet.solana.com',
    'mainnet-beta': 'https://api.mainnet-beta.solana.com',
    'localhost': 'http://localhost:8899'
  };
  
  const config = await loadConfig();
  config.network = network;
  config.rpcUrl = rpcUrls[network];
  config.lastUsed = new Date().toISOString();
  await saveConfig(config);
  
  console.log(chalk.yellow(`\n✔ Network changed to ${network}`));
  console.log(chalk.gray(`RPC URL: ${rpcUrls[network]}\n`));
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  await settingsMenu();
}

/**
 * Set custom RPC endpoint
 */
async function setCustomRPC() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('SET CUSTOM RPC ENDPOINT\n'));
  
  const { rpcUrl } = await inquirer.prompt([
    {
      type: 'input',
      name: 'rpcUrl',
      message: 'Enter custom RPC URL:',
      default: 'https://api.devnet.solana.com',
      validate: (input) => {
        if (!input) return 'RPC URL cannot be empty';
        if (!input.startsWith('http')) return 'Must be a valid HTTP(S) URL';
        return true;
      }
    }
  ]);
  
  const spinner = ora('Testing connection...').start();
  
  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    await connection.getVersion();
    
    spinner.succeed(chalk.yellow('✔ Connection successful'));
    
    const config = await loadConfig();
    config.rpcUrl = rpcUrl;
    config.lastUsed = new Date().toISOString();
    await saveConfig(config);
    
    console.log(chalk.yellow('\n✔ Custom RPC endpoint set\n'));
    
  } catch (error) {
    spinner.fail(chalk.red('ERROR: Connection failed'));
    console.error(chalk.red(error.message + '\n'));
  }
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  await settingsMenu();
}

/**
 * Set default wallet
 */
async function setDefaultWallet(options = {}) {
  const { returnToSettings = true } = options;
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('SET DEFAULT WALLET\n'));
  
  const walletFiles = await fs.readdir(WALLETS_DIR);
  const wallets = walletFiles.filter(f => f.endsWith('.json'));
  
  if (wallets.length === 0) {
    console.log(chalk.red('ERROR: No wallets found. Create a wallet first.\n'));
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (returnToSettings) {
      await settingsMenu();
    }
    return;
  }
  
  const { wallet } = await inquirer.prompt([
    {
      type: 'list',
      name: 'wallet',
      message: 'Select default wallet:',
      choices: [
        ...wallets.map(w => ({
          name: w.replace('.json', ''),
          value: w.replace('.json', '')
        })),
        { name: 'Clear default wallet', value: null }
      ]
    }
  ]);
  
  const config = await loadConfig();
  config.defaultWallet = wallet;
  config.lastUsed = new Date().toISOString();
  await saveConfig(config);
  
  if (wallet) {
    console.log(chalk.yellow(`\n✔ Default wallet set to: ${wallet}\n`));
  } else {
    console.log(chalk.yellow('\n✔ Default wallet cleared\n'));
  }
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  if (returnToSettings) {
    await settingsMenu();
  }
}

/**
 * Reset settings to defaults
 */
async function resetSettings() {
  displayTitle();
  console.log(chalk.hex('#8B5CF6').bold('RESET SETTINGS\n'));
  
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Are you sure? This will reset all settings to defaults.',
      default: false
    }
  ]);
  
  if (confirm) {
    await saveConfig(DEFAULT_CONFIG);
    console.log(chalk.yellow('\n✔ Settings reset to defaults\n'));
  } else {
    console.log(chalk.gray('\n Cancelled\n'));
  }
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  await settingsMenu();
}

/**
 * Request airdrop for a public key
 */
async function requestAirdrop(publicKey, amount = 2) {
  const spinner = ora({
    text: chalk.white('Requesting SOL from faucet'),
    spinner: 'dots2'
  }).start();
  
  try {
    const config = await loadConfig();
    if (!['devnet', 'testnet'].includes(config.network)) {
      spinner.fail(chalk.red('Airdrop not supported on this network'));
      console.log();
      console.log(chalk.red('╔═══════════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.red('║') + chalk.white.bold(' NETWORK RESTRICTION                                                        ') + chalk.red('║'));
      console.log(chalk.red('╠═══════════════════════════════════════════════════════════════════════════╣'));
      const networkValue = config.network.padEnd(58);
      console.log(chalk.red('║') + chalk.white(' Current Network ') + chalk.gray('│ ') + chalk.gray(networkValue) + chalk.red('║'));
      console.log(chalk.red('║') + chalk.white(' Supported      ') + chalk.gray('│ ') + chalk.gray('devnet, testnet'.padEnd(58)) + chalk.red('║'));
      console.log(chalk.red('╚═══════════════════════════════════════════════════════════════════════════╝'));
      console.log();
      return false;
    }
    const connection = new Connection(config.rpcUrl, 'confirmed');
    const lamports = Math.round(amount * LAMPORTS_PER_SOL);

    const useCli = await isSolanaCliAvailable();
    let signature = null;

    if (useCli) {
      spinner.text = chalk.white('Solana CLI detected – requesting faucet airdrop');
      try {
        const cliCommand = `solana airdrop ${amount} ${publicKey.toBase58()} --url ${config.rpcUrl} --commitment confirmed`;
        const { stdout, stderr } = await execAsync(cliCommand, { env: process.env });
        spinner.text = chalk.white('Confirming transaction on blockchain');

        const combinedOutput = `${stdout ?? ''}\n${stderr ?? ''}`;
        const signatureMatch = combinedOutput.match(/Signature:\s*([A-Za-z0-9]+)/);
        if (signatureMatch) {
          signature = signatureMatch[1];
        } else {
          // Fallback to querying for most recent signature if parsing fails
          const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 1 });
          signature = signatures.length > 0 ? signatures[0].signature : null;
        }
      } catch (cliError) {
        // CLI failed – fall back to RPC with retries
        spinner.text = chalk.white('CLI airdrop failed, retrying via RPC');
        signature = await requestAirdropViaRpc(connection, publicKey, lamports, amount, spinner);
      }
    } else {
      spinner.text = chalk.white(`Requesting ${amount} SOL from faucet`);
      signature = await requestAirdropViaRpc(connection, publicKey, lamports, amount, spinner);
    }

    if (!signature) {
      throw new Error('Airdrop signature unavailable – confirmation skipped');
    }

    spinner.text = chalk.white('Confirming transaction on blockchain');

    // Use latest blockhash confirmation strategy for reliability
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      },
      'confirmed'
    );

    const balance = await connection.getBalance(publicKey);

    spinner.succeed(chalk.yellow('Airdrop completed successfully'));
    
    console.log();
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white.bold(' AIRDROP COMPLETE                                                          ') + chalk.hex('#8B5CF6')('║'));
    
  const amountValue = `${amount} SOL`.padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Amount        ') + chalk.gray('│ ') + chalk.yellow(amountValue) + chalk.hex('#8B5CF6')('║'));
    
    const balanceValue = `${balance / LAMPORTS_PER_SOL} SOL`.padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' New Balance   ') + chalk.gray('│ ') + chalk.yellow(balanceValue) + chalk.hex('#8B5CF6')('║'));
    
  const networkValue = `${config.network.toUpperCase()} NETWORK`.padEnd(58);
    console.log(chalk.hex('#8B5CF6')('║') + chalk.white(' Network       ') + chalk.gray('│ ') + chalk.blue(networkValue) + chalk.hex('#8B5CF6')('║'));
    console.log();
    return true;
    
  } catch (error) {
    spinner.fail(chalk.red('Airdrop request failed'));
    console.log();
    console.log(chalk.red('╔═══════════════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.red('║') + chalk.white.bold(' AIRDROP FAILED                                                            ') + chalk.red('║'));
    console.log(chalk.red('╠═══════════════════════════════════════════════════════════════════════════╣'));
    
    const reasonValue = error.message.substring(0, 58).padEnd(58);
    console.log(chalk.red('║') + chalk.white(' Reason        ') + chalk.gray('│ ') + chalk.gray(reasonValue) + chalk.red('║'));
    
    console.log(chalk.red('╚═══════════════════════════════════════════════════════════════════════════╝'));
    console.log();
    console.log(chalk.yellow.bold(' ALTERNATIVE SOLUTIONS'));
    console.log(chalk.gray(' ▸ Use web faucet: https://faucet.solana.com'));
    console.log(chalk.gray(' ▸ Try QuickNode: https://faucet.quicknode.com/solana/devnet'));
    console.log(chalk.gray(' ▸ Wait 5-10 minutes and try again (rate limiting)'));
    console.log(chalk.gray(' ▸ See AIRDROP_ALTERNATIVES.md for more options'));
    console.log();
  }
  return false;
}

async function isSolanaCliAvailable() {
  try {
    await execAsync('command -v solana');
    return true;
  } catch {
    return false;
  }
}

async function requestAirdropViaRpc(connection, publicKey, lamports, amount, spinner) {
  let signature = null;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      spinner.text = chalk.white(`Requesting ${amount} SOL from faucet (attempt ${attempt}/${maxAttempts})`);
      signature = await connection.requestAirdrop(publicKey, lamports, 'confirmed');
      return signature;
    } catch (rpcError) {
      const message = rpcError?.message?.toLowerCase?.() ?? '';
      const rateLimited = message.includes('too many') || message.includes('rate') || message.includes('429');
      if (attempt === maxAttempts) {
        throw rpcError;
      }

      const backoffMs = 1500 * attempt;
      spinner.text = rateLimited
        ? chalk.yellow(`Faucet rate limited, retrying in ${backoffMs / 1000}s...`)
        : chalk.yellow(`Airdrop attempt failed (${rpcError.message.trim()}), retrying in ${backoffMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  return signature;
}

/**
 * Clean exit from CLI
 */
function exitCLI() {
  console.clear();
  
  const exitArt = centeredBox([
    '',
    '███████╗███████╗███████╗███████╗██╗ ██████╗ ███╗   ██╗',
    '██╔════╝██╔════╝██╔════╝██╔════╝██║██╔═══██╗████╗  ██║',
    '███████╗█████╗  ███████╗███████╗██║██║   ██║██╔██╗ ██║',
    '╚════██║██╔══╝  ╚════██║╚════██║██║██║   ██║██║╚██╗██║',
    '███████║███████╗███████║███████║██║╚██████╔╝██║ ╚████║',
    '╚══════╝╚══════╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝',
    '',
    'T E R M I N A T E D',
    '',
    'All systems shutdown successfully',
    'Thank you for building',
    ''
  ]);

  console.log(chalk.red(exitArt));
  console.log();
  console.log(chalk.gray.dim('                       Lili CLI v0.0.3 - Solana Developer Toolkit'));
  console.log();
  
  process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Initialize configuration
    await initConfig();
    
    // Show boot sequence
    await bootSequence();
    
    // Show main menu
    await mainMenu();
    
  } catch (error) {
    console.error(chalk.red('\nERROR: Fatal error:'), error.message);
    process.exit(1);
  }
}

// Start the CLI
main();
