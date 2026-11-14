import type { NextConfig } from "next";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

if (process.env.APP_ENV === "test") {
  const testEnvPath = path.resolve(process.cwd(), ".env.test.local");
  if (fs.existsSync(testEnvPath)) {
    dotenv.config({ path: testEnvPath, override: true });
  }
}

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
