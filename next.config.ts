import { withAui } from "@assistant-ui/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "100.97.94.76",
    "hermes-agent",
    "10.10.10.80",
    // localhost dev origins — required so Turbopack dev resources (HMR,
    // RSC payload) aren't blocked when running `next dev` locally.
    "127.0.0.1",
    "localhost",
  ],
};

export default withAui(nextConfig);
