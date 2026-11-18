export const ACP_PRESETS = [
  {
    // https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
    id: "github-copilot-cli",
    name: "GitHub Copilot CLI",
    command: "copilot",
    args: ["--acp"],
    installHint: "Install GitHub Copilot CLI and sign in with GitHub.",
    docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/install-copilot-cli",
    verified: false,
  },
  {
    // https://github.com/QwenLM/qwen-code/blob/main/docs/developers/architecture.md
    id: "qwen-code",
    name: "Qwen Code",
    command: "qwen",
    args: ["--acp"],
    installHint: "Install Qwen Code (@qwen-code/qwen-code) and configure a provider.",
    docsUrl: "https://github.com/QwenLM/qwen-code#quick-start",
    verified: false,
  },
  {
    // https://kilo.ai/docs/code-with-ai/platforms/cli
    id: "kilo",
    name: "Kilo Code",
    command: "kilo",
    args: ["acp"],
    installHint: "Install Kilo CLI (@kilocode/cli) and sign in or configure a provider.",
    docsUrl: "https://kilo.ai/docs/code-with-ai/platforms/cli",
    verified: false,
  },
  {
    // https://github.com/cline/cline/blob/main/docs/usage/acp.mdx
    id: "cline",
    name: "Cline CLI",
    command: "cline",
    args: ["--acp"],
    installHint: "Install Cline CLI and complete cline auth.",
    docsUrl: "https://github.com/cline/cline/blob/main/docs/usage/acp.mdx",
    verified: false,
  },
  {
    // https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json (goose)
    id: "goose",
    name: "Goose",
    command: "goose",
    args: ["acp"],
    installHint: "Install the Goose CLI and configure a provider with goose configure.",
    docsUrl: "https://github.com/block/goose",
    verified: false,
  },
  {
    // https://kiro.dev/docs/cli/acp/
    id: "kiro",
    name: "Kiro CLI",
    command: "kiro-cli",
    args: ["acp"],
    installHint: "Install Kiro CLI and run kiro-cli login.",
    docsUrl: "https://kiro.dev/docs/cli/acp/",
    verified: false,
  },
  {
    // https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json (factory-droid)
    id: "factory-droid",
    name: "Factory Droid",
    command: "droid",
    args: ["exec", "--output-format", "acp-daemon"],
    installHint: "Install Factory's Droid CLI and sign in.",
    docsUrl: "https://factory.ai/product/cli",
    verified: false,
  },
  {
    // https://docs.augmentcode.com/cli/reference
    id: "auggie",
    name: "Auggie CLI",
    command: "auggie",
    args: ["--acp"],
    installHint: "Install Augment's Auggie CLI (@augmentcode/auggie) and sign in.",
    docsUrl: "https://docs.augmentcode.com/cli/overview",
    verified: false,
  },
  {
    // https://moonshotai.github.io/kimi-cli/en/guides/ides.html
    id: "kimi",
    name: "Kimi CLI",
    command: "kimi",
    args: ["acp"],
    installHint: "Install Moonshot's Kimi CLI and complete /login.",
    docsUrl: "https://moonshotai.github.io/kimi-cli/en/guides/ides.html",
    verified: false,
  },
  {
    // https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json (mistral-vibe)
    id: "mistral-vibe",
    name: "Mistral Vibe",
    command: "vibe-acp",
    args: [],
    installHint: "Install Mistral Vibe with the vibe-acp executable and complete Vibe setup.",
    docsUrl: "https://github.com/mistralai/mistral-vibe#readme",
    verified: false,
  },
  {
    // https://docs.devin.ai/cli/reference/commands#devin-acp
    id: "devin",
    name: "Devin CLI",
    command: "devin",
    args: ["acp"],
    installHint: "Install Cognition's Devin CLI and run devin auth login.",
    docsUrl: "https://docs.devin.ai/cli/reference/commands#devin-acp",
    verified: false,
  },
];
