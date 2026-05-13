/**
 * If there is no .env file yet, copy .env.example → .env so you can edit one file.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");

if (existsSync(envPath)) {
  console.log("✅ You already have a file named .env — I did not change it.\n");
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.log("❌ I could not find .env.example next to package.json. Ask for help.\n");
  process.exit(1);
}

copyFileSync(examplePath, envPath);
console.log("✅ I created a new file called .env for you (it is a copy of .env.example).\n");
console.log("👉 Next: open .env in Notepad and fill in your bot token and other lines.\n");
