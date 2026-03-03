interface WalletPublicKeyLike {
  toBase58(): string;
}

interface WalletConnectResult {
  publicKey?: WalletPublicKeyLike;
}

interface InjectedSolanaProvider {
  isPhantom?: boolean;
  isBackpack?: boolean;
  isSolflare?: boolean;
  publicKey?: WalletPublicKeyLike;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<WalletConnectResult | void>;
  signAndSendTransaction?: (transaction: unknown, options?: unknown) => Promise<{ signature?: string } | string>;
}

export interface ConnectedSolanaWallet {
  address: string;
  providerLabel: string;
  provider: InjectedSolanaProvider;
}

export interface SendSolTransferInput {
  connectionUrl: string;
  provider: InjectedSolanaProvider;
  adminWallet: string;
  amount: number;
}

function resolveInjectedProvider(): ConnectedSolanaWallet | null {
  const win = window as Window & {
    solana?: InjectedSolanaProvider;
    solflare?: InjectedSolanaProvider;
    backpack?: { solana?: InjectedSolanaProvider };
  };

  const candidates: Array<{ provider: InjectedSolanaProvider; label: string; priority: number }> = [];

  if (win.solana) {
    let label = "Solana Wallet";
    let priority = 20;
    if (win.solana.isPhantom) {
      label = "Phantom";
      priority = 100;
    } else if (win.solana.isBackpack) {
      label = "Backpack";
      priority = 95;
    } else if (win.solana.isSolflare) {
      label = "Solflare";
      priority = 90;
    }
    candidates.push({ provider: win.solana, label, priority });
  }
  if (win.backpack?.solana) {
    candidates.push({ provider: win.backpack.solana, label: "Backpack", priority: 96 });
  }
  if (win.solflare) {
    candidates.push({ provider: win.solflare, label: "Solflare", priority: 91 });
  }

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.priority - left.priority);
  const picked = candidates[0];
  const existingAddress = picked.provider.publicKey?.toBase58();
  return existingAddress
    ? { address: existingAddress, providerLabel: picked.label, provider: picked.provider }
    : { address: "", providerLabel: picked.label, provider: picked.provider };
}

export async function connectInjectedSolanaWallet(): Promise<ConnectedSolanaWallet> {
  const selected = resolveInjectedProvider();
  if (!selected) {
    throw new Error("No Solana wallet detected. Install Phantom, Backpack, or Solflare.");
  }

  try {
    await selected.provider.connect({ onlyIfTrusted: false });
  } catch {
    await selected.provider.connect();
  }

  const address = selected.provider.publicKey?.toBase58();
  if (!address) {
    throw new Error("Wallet connected but no public key was returned.");
  }

  return {
    address,
    providerLabel: selected.providerLabel,
    provider: selected.provider,
  };
}

export async function sendSolTransferViaWallet(input: SendSolTransferInput): Promise<string> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Bet amount must be greater than zero.");
  }
  if (!input.provider.publicKey) {
    throw new Error("Wallet is not connected.");
  }
  if (!input.provider.signAndSendTransaction) {
    throw new Error("Connected wallet does not support sending transactions.");
  }

  // Ensure browser Buffer exists before loading Solana libs that depend on it.
  const bufferModule = await import("buffer/");
  const scopedGlobal = globalThis as { Buffer?: typeof bufferModule.Buffer };
  if (!scopedGlobal.Buffer) {
    scopedGlobal.Buffer = bufferModule.Buffer;
  }

  const web3 = await import("@solana/web3.js");
  const { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } = web3;

  const connection = new Connection(input.connectionUrl, "confirmed");
  const owner = new PublicKey(input.provider.publicKey.toBase58());
  const admin = new PublicKey(input.adminWallet);

  const tx = new Transaction();
  const lamports = Math.round(amount * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new Error("Bet amount is invalid for SOL transfer.");
  }
  tx.add(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: admin,
      lamports,
    }),
  );

  tx.feePayer = owner;
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latestBlockhash.blockhash;

  const result = await input.provider.signAndSendTransaction(tx, {
    preflightCommitment: "confirmed",
  });
  const signature = typeof result === "string" ? result : result?.signature;
  if (!signature) {
    throw new Error("Wallet did not return a transaction signature.");
  }

  await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    "confirmed",
  );

  return signature;
}

