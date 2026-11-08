// Local state in ~/.wafermap (or $WAFERMAP_HOME):
//   keystore.json  the agent key, encrypted with scrypt + AES-256-GCM under your password
//   config.json    spending caps and default network
//   spend.jsonl    one line per payment or swap, used for the daily cap and `wafermap history`
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { NETS, type Limits, type Net, type SpendEntry } from "./core.js";

export const HOME = process.env.WAFERMAP_HOME || join(homedir(), ".wafermap");
const KEYSTORE = join(HOME, "keystore.json");
const CONFIG = join(HOME, "config.json");
const SPEND = join(HOME, "spend.jsonl");

const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function ensureHome() {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function secureWrite(path: string, data: string) {
  ensureHome();
  writeFileSync(path, data, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: ACLs already limit the profile folder */
  }
}

export const hasWallet = () => existsSync(KEYSTORE);

export function saveKey(privateKey: Hex, address: string, password: string, solana?: string) {
  if (password.length < 8) throw new Error("Use a password of at least 8 characters.");
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, SCRYPT);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(privateKey.slice(2), "hex"), c.final()]);
  secureWrite(
    KEYSTORE,
    JSON.stringify(
      { version: 1, address, ...(solana ? { solana } : {}), kdf: "scrypt", kdfparams: { n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("hex") }, cipher: "aes-256-gcm", iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ciphertext: ct.toString("hex") },
      null,
      2,
    ),
  );
}

export function keystoreAddress(): string | null {
  if (!hasWallet()) return null;
  return JSON.parse(readFileSync(KEYSTORE, "utf8")).address ?? null;
}

/** The wallet's Solana address. Wallets made before 0.3 learn it the first time they are unlocked. */
export function keystoreSolana(): string | null {
  if (!hasWallet()) return null;
  return JSON.parse(readFileSync(KEYSTORE, "utf8")).solana ?? null;
}
export function rememberSolana(address: string) {
  const k = JSON.parse(readFileSync(KEYSTORE, "utf8"));
  if (k.solana === address) return;
  secureWrite(KEYSTORE, JSON.stringify({ ...k, solana: address }, null, 2));
}

export function loadKey(password: string): Hex {
  if (!hasWallet()) throw new Error("No wallet yet. Run `wafermap init`.");
  const k = JSON.parse(readFileSync(KEYSTORE, "utf8"));
  const key = scryptSync(password, Buffer.from(k.kdfparams.salt, "hex"), 32, { N: k.kdfparams.n, r: k.kdfparams.r, p: k.kdfparams.p, maxmem: SCRYPT.maxmem });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(k.iv, "hex"));
  d.setAuthTag(Buffer.from(k.tag, "hex"));
  try {
    return `0x${Buffer.concat([d.update(Buffer.from(k.ciphertext, "hex")), d.final()]).toString("hex")}` as Hex;
  } catch {
    throw new Error("Wrong password.");
  }
}

export type Config = { network: Net; limits: Limits; mcpSwaps?: boolean; mcpConfirm?: boolean; endpointCheck?: boolean };
const DEFAULTS: Config = { network: "robinhood", limits: { perPayment: 0.1, perDay: 1, perSwap: 25 }, mcpSwaps: false, mcpConfirm: false, endpointCheck: false };

export function config(): Config {
  if (!existsSync(CONFIG)) return DEFAULTS;
  const c = JSON.parse(readFileSync(CONFIG, "utf8"));
  return { network: NETS.includes(c.network) ? c.network : "robinhood", limits: { ...DEFAULTS.limits, ...c.limits }, mcpSwaps: c.mcpSwaps === true, mcpConfirm: c.mcpConfirm === true, endpointCheck: c.endpointCheck === true };
}

export function saveConfig(c: Config) {
  secureWrite(CONFIG, JSON.stringify(c, null, 2));
}

export function spendLog(): SpendEntry[] {
  if (!existsSync(SPEND)) return [];
  return readFileSync(SPEND, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function appendSpend(e: SpendEntry) {
  ensureHome();
  appendFileSync(SPEND, JSON.stringify(e) + "\n", { mode: 0o600 });
}
