import { pbkdf2Sync, randomBytes } from "node:crypto";

const [, , usernameArg, passwordArg, subscriptionUsernameArg] = process.argv;

if (!usernameArg || !passwordArg) {
  console.error("Usage: node scripts/admin-sql.mjs <username> <password> [subscription_username]");
  process.exit(1);
}

const username = usernameArg.trim();
const password = passwordArg;
const subscriptionUsername = (subscriptionUsernameArg || username).trim();

if (!username) {
  console.error("Username cannot be empty.");
  process.exit(1);
}

if (password.length < 6) {
  console.error("Password must be at least 6 characters.");
  process.exit(1);
}

const iterations = 100000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const passwordHash = `pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

console.log(`INSERT INTO users(username, password_hash, subscription_username, is_admin, is_active)
VALUES (${sql(username)}, ${sql(passwordHash)}, ${sql(subscriptionUsername)}, 1, 1)
ON CONFLICT(username) DO UPDATE SET
  password_hash = excluded.password_hash,
  subscription_username = excluded.subscription_username,
  is_admin = 1,
  is_active = 1,
  updated_at = CURRENT_TIMESTAMP;`);
