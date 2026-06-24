import { withAui } from "@assistant-ui/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["100.97.94.76", "hermes-agent", "10.10.10.80"],
};

export default withAui(nextConfig);
