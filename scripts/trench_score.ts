/**
 * WTF Trench Score: weekly community leaderboard.
 *
 * Reads: on-chain staking data (Helius devnet/mainnet RPC), Beacon community-stats, WTF Clip community-stats.
 * Writes: scripts/trench-out/trench_<from>_<to>.json and .html (public leaderboard page).
 * Read-only. It never sends a transaction and never needs a wallet key.
 *
 * Run:    yarn trench           (last 7 full days, UTC)
 *         yarn trench:dry       (sample data, no network; to see what the output looks like)
 *         yarn trench --from 2026-10-22 --to 2026-10-28
 *
 * Secrets file (NOT in the project, outside git): C:\Users\18134\wtf-secrets\trench.env  with lines:
 *   HELIUS_RPC=https://devnet.helius-rpc.com/?api-key=...
 *   BEACON_STATS_KEY=...
 *   CLIP_STATS_KEY=...
 */
import * as fs from "fs";
import * as path from "path";

const CONFIG_FILE = path.join(__dirname, "trench_config.json");
const OUT_DIR = path.join(__dirname, "trench-out");
const IDL_FILE = path.join(__dirname, "..", "target", "idl", "wtf_staking.json");

type Config = {
  program_id: string;
  env_file: string;
  beacon_url: string;
  clip_url: string;
  weights: { staking: number; beacon: number; clip: number };
  min_unique_stakers: number;
  max_share: number;
  min_share: number;
  beacon_checkin_cap_vs_stakers: number;
  clip_map?: Record<string, string>;
  beacon_map: Record<string, string>; // beacon community_handle or community_id -> token mint
};

type Comm = {
  mint: string;
  name: string;
  unique_stakers: number;
  weighted_tokens: number;
  total_staked_tokens: number;
  beacon?: any;
  clip?: any;
  staking_part: number;
  beacon_part: number;
  clip_part: number;
  score: number;
  eligible: boolean;
  share: number;
  notes: string[];
};

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes("--dry");

function isoDay(d: Date) { return d.toISOString().slice(0, 10); }
function defaultRange() {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  return { from: isoDay(start), to: isoDay(end) };
}
const norm = (v: number, max: number) => (max > 0 ? v / max : 0);
const short = (s: string) => s.slice(0, 4) + "..." + s.slice(-4);

// ---------- data sources ----------
async function fetchOnChain(cfg: Config, rpc: string): Promise<Comm[]> {
  const anchor = require("@coral-xyz/anchor");
  const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
  const { getMint } = require("@solana/spl-token");
  const conn = new Connection(rpc, "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate()); // read-only, throwaway key
  const provider = new anchor.AnchorProvider(conn, wallet, {});
  const idl = JSON.parse(fs.readFileSync(IDL_FILE, "utf8"));
  const program: any = new anchor.Program(idl, provider);

  // Read accounts directly at fixed byte positions (no IDL decoding needed).
  const crypto = require("crypto");
  const BN = anchor.BN;
  const rawAll = async (n: string): Promise<any[]> => {
    const disc: Buffer = crypto.createHash("sha256").update("account:" + n).digest().subarray(0, 8);
    return conn.getProgramAccounts(new PublicKey(cfg.program_id), {
      filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }],
    });
  };
  const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));
  const u64 = (d: Buffer, o: number) => new BN(d.subarray(o, o + 8), "le");
  const u128 = (d: Buffer, o: number) => new BN(d.subarray(o, o + 16), "le");
  const rawPools = await rawAll("StakePool");
  const rawUsers = await rawAll("UserStake");
  const rawPos = await rawAll("StakePosition");
  console.log(`  on-chain: ${rawPools.length} pools, ${rawUsers.length} user stakes, ${rawPos.length} positions`);
  const pools: any[] = rawPools
    .filter((r: any) => r.account.data.length >= 112)
    .map((r: any) => ({ publicKey: r.pubkey, account: { stakeMint: pk(r.account.data, 80) } }));
  const users: any[] = rawUsers
    .filter((r: any) => r.account.data.length >= 80)
    .map((r: any) => ({ publicKey: r.pubkey, account: { owner: pk(r.account.data, 8), pool: pk(r.account.data, 40), stakedAmount: u64(r.account.data, 72) } }));
  const positions: any[] = rawPos
    .filter((r: any) => r.account.data.length >= 106)
    .map((r: any) => ({ publicKey: r.pubkey, account: { owner: pk(r.account.data, 8), pool: pk(r.account.data, 40), amount: u64(r.account.data, 73), weight: u128(r.account.data, 90) } }));

  const mintOfPool = new Map<string, string>();
  for (const p of pools) mintOfPool.set(p.publicKey.toBase58(), p.account.stakeMint.toBase58());
  const mints = Array.from(new Set(mintOfPool.values()));
  const decimals = new Map<string, number>();
  for (const m of mints) decimals.set(m, (await getMint(conn, new PublicKey(m))).decimals);

  const byMint = new Map<string, { owners: Set<string>; weighted: number; staked: number }>();
  for (const m of mints) byMint.set(m, { owners: new Set(), weighted: 0, staked: 0 });
  for (const u of users) {
    const m = mintOfPool.get(u.account.pool.toBase58());
    if (!m || u.account.stakedAmount.isZero()) continue;
    byMint.get(m)!.owners.add(u.account.owner.toBase58());
  }
  for (const pos of positions) {
    const m = mintOfPool.get(pos.account.pool.toBase58());
    if (!m || pos.account.amount.isZero()) continue;
    const d = Math.pow(10, decimals.get(m)!);
    const b = byMint.get(m)!;
    b.weighted += Number(pos.account.weight.toString()) / d;
    b.staked += Number(pos.account.amount.toString()) / d;
  }
  return mints.map((m) => {
    const b = byMint.get(m)!;
    return blank(m, ((cfg as any).names || {})[m] || short(m), b.owners.size, b.weighted, b.staked);
  });
}

function blank(mint: string, name: string, stakers: number, weighted: number, staked: number): Comm {
  return { mint, name, unique_stakers: stakers, weighted_tokens: weighted, total_staked_tokens: staked,
    staking_part: 0, beacon_part: 0, clip_part: 0, score: 0, eligible: false, share: 0, notes: [] };
}

async function getJson(url: string, key: string) {
  const res = await fetch(url, { headers: { "x-api-key": key } });
  if (!res.ok) throw new Error(`${url.split("?")[0]} returned ${res.status}`);
  return res.json();
}

// ---------- scoring ----------
function score(comms: Comm[], cfg: Config) {
  const el = comms; // normalise across all communities that have any data
  const maxStakers = Math.max(0, ...el.map((c) => c.unique_stakers));
  const maxW = Math.max(0, ...el.map((c) => Math.sqrt(c.weighted_tokens)));

  for (const c of comms) {
    c.staking_part = 0.5 * norm(c.unique_stakers, maxStakers) + 0.5 * norm(Math.sqrt(c.weighted_tokens), maxW);
    if (c.beacon) {
      const cap = cfg.beacon_checkin_cap_vs_stakers * Math.max(c.unique_stakers, 1);
      c.beacon.checkins_counted = Math.min(c.beacon.unique_checkin_members || 0, cap);
      if ((c.beacon.unique_checkin_members || 0) > cap) c.notes.push("Beacon check-ins capped vs. staker count");
    }
  }
  const maxCk = Math.max(0, ...comms.map((c) => Math.sqrt(c.beacon?.checkins_counted || 0)));
  const maxEv = Math.max(0, ...comms.map((c) => c.beacon?.events_count || 0));
  const maxSt = Math.max(0, ...comms.map((c) => c.beacon?.active_streak_members || 0));
  const maxSp = Math.max(0, ...comms.map((c) => c.clip?.spaces_recorded || 0));
  const maxMin = Math.max(0, ...comms.map((c) => Math.sqrt(c.clip?.total_recorded_minutes || 0)));
  const maxHo = Math.max(0, ...comms.map((c) => c.clip?.unique_hosts || 0));
  const maxCl = Math.max(0, ...comms.map((c) => c.clip?.clips_created || 0));

  for (const c of comms) {
    if (c.beacon) {
      c.beacon_part = 0.5 * norm(Math.sqrt(c.beacon.checkins_counted), maxCk)
        + 0.3 * norm(c.beacon.events_count || 0, maxEv) + 0.2 * norm(c.beacon.active_streak_members || 0, maxSt);
    }
    if (c.clip) {
      c.clip_part = 0.4 * norm(c.clip.spaces_recorded || 0, maxSp) + 0.3 * norm(Math.sqrt(c.clip.total_recorded_minutes || 0), maxMin)
        + 0.2 * norm(c.clip.unique_hosts || 0, maxHo) + 0.1 * norm(c.clip.clips_created || 0, maxCl);
    }
    c.score = cfg.weights.staking * c.staking_part + cfg.weights.beacon * c.beacon_part + cfg.weights.clip * c.clip_part;
    c.eligible = c.unique_stakers >= cfg.min_unique_stakers && c.score > 0;
    if (c.unique_stakers < cfg.min_unique_stakers) c.notes.push(`Needs at least ${cfg.min_unique_stakers} unique stakers to earn`);
  }

  // share with a cap and a floor (water-filling)
  const live = comms.filter((c) => c.eligible);
  const n = live.length;
  if (!n) return;
  const cap = Math.max(cfg.max_share, 1 / n);
  const floor = Math.min(cfg.min_share, 1 / n);
  const total = live.reduce((a, c) => a + c.score, 0);
  let shares = live.map((c) => c.score / total);
  let fixed = live.map(() => false);
  for (let it = 0; it < 20; it++) {
    let changed = false;
    shares = shares.map((s, i) => {
      if (fixed[i]) return s;
      if (s > cap) { fixed[i] = true; changed = true; return cap; }
      if (s < floor) { fixed[i] = true; changed = true; return floor; }
      return s;
    });
    const fixedSum = shares.reduce((a, s, i) => a + (fixed[i] ? s : 0), 0);
    const freeScore = live.reduce((a, c, i) => a + (fixed[i] ? 0 : c.score), 0);
    shares = shares.map((s, i) => (fixed[i] ? s : freeScore > 0 ? (live[i].score / freeScore) * (1 - fixedSum) : 0));
    if (!changed) break;
  }
  live.forEach((c, i) => (c.share = shares[i]));
}

// ---------- output ----------
function html(range: { from: string; to: string }, comms: Comm[], cfg: Config): string {
  const rows = comms.map((c, i) => `<tr>
<td>${i + 1}</td><td>${esc(c.name)}<div class="s">${short(c.mint)}</div></td>
<td>${(c.score * 100).toFixed(1)}</td><td>${(c.share * 100).toFixed(1)}%</td>
<td>${c.unique_stakers}</td><td>${Math.round(c.total_staked_tokens).toLocaleString()}</td>
<td>${c.beacon ? c.beacon.unique_checkin_members : "-"}</td><td>${c.clip ? c.clip.spaces_recorded : "-"}</td>
<td class="s">${esc(c.notes.join("; "))}</td></tr>`).join("\n");
  const w = cfg.weights;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trench Score ${range.from} to ${range.to}</title>
<style>body{background:#0b140d;color:#e8f5e0;font-family:system-ui,sans-serif;margin:16px}h1{color:#6bf24b}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:8px;border-bottom:1px solid #243a26;text-align:left}
.s{color:#8aa88a;font-size:12px}.wrap{overflow-x:auto}</style>
<h1>Trench Score</h1><p>Week ${range.from} to ${range.to} (UTC). Devnet data unless stated.</p>
<div class="wrap"><table><tr><th>#</th><th>Community</th><th>Score</th><th>Share of pot</th><th>Stakers</th><th>Staked</th><th>Beacon people</th><th>Spaces</th><th>Notes</th></tr>
${rows}</table></div>
<p class="s">Formula: score = ${w.staking * 100}% staking strength (unique stakers + lock-weighted stake, square-root) + ${w.beacon * 100}% Beacon showing up + ${w.clip * 100}% WTF Clip live activity.
Share is capped at ${cfg.max_share * 100}% per community, floored at ${cfg.min_share * 100}%, and needs at least ${cfg.min_unique_stakers} unique stakers. Not financial advice; amounts are not guaranteed.</p>`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// ---------- main ----------
async function main() {
  const cfg: Config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const range = { from: arg("from") || defaultRange().from, to: arg("to") || defaultRange().to };
  let comms: Comm[];
  const unmapped: string[] = [];

  if (DRY) {
    const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "trench_sample.json"), "utf8"));
    comms = sample.onchain.map((o: any) => blank(o.mint, o.name, o.unique_stakers, o.weighted_tokens, o.total_staked_tokens));
    attach(comms, sample.beacon, sample.clip, cfg, unmapped);
  } else {
    const env = { ...loadEnv(cfg.env_file), ...process.env } as Record<string, string>;
    for (const k of ["HELIUS_RPC", "BEACON_STATS_KEY", "CLIP_STATS_KEY"]) if (!env[k]) throw new Error(`Missing ${k} in ${cfg.env_file}`);
    comms = await fetchOnChain(cfg, env.HELIUS_RPC);
    const q = `?from=${range.from}&to=${range.to}`;
    let beacon: any[] = [], clip: any = { projects: [] };
    try { beacon = await getJson(cfg.beacon_url + q, env.BEACON_STATS_KEY); } catch (e: any) { console.log("WARN Beacon:", e.message); }
    try { clip = await getJson(cfg.clip_url + q, env.CLIP_STATS_KEY); } catch (e: any) { console.log("WARN Clip:", e.message); }
    attach(comms, beacon, clip.projects || [], cfg, unmapped);
  }

  score(comms, cfg);
  comms.sort((a, b) => b.score - a.score);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, `trench_${range.from}_${range.to}${DRY ? "_SAMPLE" : ""}`);
  fs.writeFileSync(base + ".json", JSON.stringify({ range, weights: cfg.weights, communities: comms }, null, 2));
  fs.writeFileSync(base + ".html", html(range, comms, cfg));

  console.log(`\nTRENCH SCORE ${range.from} to ${range.to}${DRY ? "  (SAMPLE DATA)" : ""}`);
  console.log("rank  community             score  share   stakers  beacon  spaces  note");
  comms.forEach((c, i) => console.log(
    `${String(i + 1).padStart(4)}  ${c.name.padEnd(20).slice(0, 20)}  ${(c.score * 100).toFixed(1).padStart(5)}  ${(c.share * 100).toFixed(1).padStart(5)}%  ${String(c.unique_stakers).padStart(7)}  ` +
    `${String(c.beacon ? c.beacon.unique_checkin_members : "-").padStart(6)}  ${String(c.clip ? c.clip.spaces_recorded : "-").padStart(6)}  ${c.notes.join("; ")}`));
  if (unmapped.length) {
    console.log("\nNOT MATCHED to a token (add to beacon_map in trench_config.json, or add a token address on the Clip page):");
    unmapped.forEach((u) => console.log("  - " + u));
  }
  console.log(`\nSaved: ${base}.json and .html`);
}

function attach(comms: Comm[], beacon: any[], clip: any[], cfg: Config, unmapped: string[]) {
  const byMint = new Map(comms.map((c) => [c.mint, c]));
  for (const b of beacon || []) {
    const mint = b.token_mint || cfg.beacon_map[b.community_handle] || cfg.beacon_map[b.community_id];
    const c = mint && byMint.get(mint);
    if (c) { c.beacon = b; if (b.community_name) c.name = b.community_name; }
    else if (mint) {
      const nc = blank(mint, b.community_name || b.community_handle || mint, 0, 0, 0);
      nc.beacon = b; nc.notes.push("No staking pool yet"); comms.push(nc); byMint.set(mint, nc);
    }
    else unmapped.push(`Beacon: ${b.community_name || b.community_handle || b.community_id}`);
  }
  for (const p of clip || []) {
    const cm: any = (cfg as any).clip_map || {};
    const cmint = p.token_mint_address || cm[p.project_name] || cm[p.project_id];
    const c = cmint && byMint.get(cmint);
    if (c) { c.clip = p; if (!c.beacon && p.project_name) c.name = p.project_name; }
    else if (cmint) {
      const nc = blank(cmint, p.project_name || cmint, 0, 0, 0);
      nc.clip = p; nc.notes.push("No staking pool yet"); comms.push(nc); byMint.set(cmint, nc);
    }
    else unmapped.push(`WTF Clip: ${p.project_name || p.project_id}${p.token_mint_address ? "" : " (no token address on page)"}`);
  }
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
