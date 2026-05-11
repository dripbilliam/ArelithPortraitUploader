import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";
const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  basePath: isGitHubPages && repoName ? `/${repoName}` : "",
  assetPrefix: isGitHubPages && repoName ? `/${repoName}/` : undefined,
};

export default nextConfig;
