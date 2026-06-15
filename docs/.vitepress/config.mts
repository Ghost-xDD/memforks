import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "MemForks",
    description: "Git for AI agent memory",
    cleanUrls: true,
    lastUpdated: true,
    markdown: {
      lineNumbers: true,
    },
    themeConfig: {
      search: {
        provider: "local",
      },
      nav: [
        { text: "Guide", link: "/getting-started/quickstart" },
        { text: "Concepts", link: "/concepts/overview" },
        { text: "SDK", link: "/sdk/core" },
        { text: "Examples", link: "/examples/chat" },
        { text: "Operations", link: "/operations/troubleshooting" },
      ],
      sidebar: [
        {
          text: "Getting Started",
          items: [
            { text: "Quickstart", link: "/getting-started/quickstart" },
            { text: "Configuration", link: "/getting-started/configuration" },
          ],
        },
        {
          text: "Concepts",
          items: [
            { text: "Overview", link: "/concepts/overview" },
            { text: "Branching and Merging", link: "/concepts/branching" },
            { text: "MemForks vs Git", link: "/concepts/git-comparison" },
          ],
        },
        {
          text: "Architecture",
          items: [
            { text: "System Architecture", link: "/architecture/" },
            { text: "Data Flows", link: "/architecture/data-flows" },
          ],
        },
        {
          text: "SDK",
          items: [
            { text: "Core SDK", link: "/sdk/core" },
            { text: "Vercel AI SDK", link: "/sdk/vercel-ai" },
            { text: "LangGraph", link: "/sdk/langgraph" },
          ],
        },
        {
          text: "CLI",
          items: [{ text: "Command Line", link: "/cli/" }],
        },
        {
          text: "Examples",
          items: [
            { text: "Branch-Aware Chat", link: "/examples/chat" },
            { text: "LangGraph Research", link: "/examples/research" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "Multi-User Apps", link: "/guides/multi-user" },
            { text: "Developer Bounties", link: "/guides/bounties" },
          ],
        },
        {
          text: "Operations",
          items: [
            { text: "Gas Sponsorship", link: "/operations/sponsor" },
            { text: "Troubleshooting", link: "/operations/troubleshooting" },
          ],
        },
      ],
      socialLinks: [
        { icon: "github", link: "https://github.com/memforks-dev/memforks" },
      ],
      footer: {
        message: "Built on MemWal, Walrus, and Sui.",
        copyright: "Apache-2.0",
      },
    },
    mermaid: {
      startOnLoad: true,
      securityLevel: "strict",
    },
  }),
);
