export type PublicNetwork = "localnet" | "studionet";

export type PublicConfig = {
  network: PublicNetwork;
  chainId: 61127 | 61999;
  contractAddress: `0x${string}`;
  explorerBaseUrl: string | null;
};

export type PublicConfigMarker = {
  schemaVersion: "accessseal-public-config/1";
  network: PublicNetwork;
  chainId: 61127 | 61999;
  contractAddress: `0x${string}`;
  safeTestConfig: boolean;
};

type Environment = Record<string, string | undefined>;

const NETWORKS = {
  localnet: { chainId: 61127, explorerBaseUrl: null },
  studionet: { chainId: 61999, explorerBaseUrl: "https://studio.genlayer.com" },
} as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";

export function parsePublicConfig(
  env: Environment,
  mode: string,
): PublicConfig {
  for (const key of Object.keys(env)) {
    if (/private[_-]?key/i.test(key) && env[key]) {
      throw new Error(
        "Private keys are never accepted by frontend configuration.",
      );
    }
  }
  const network = env.NEXT_PUBLIC_GENLAYER_NETWORK;
  if (network !== "localnet" && network !== "studionet") {
    throw new Error("GenLayer network must be localnet or studionet.");
  }
  const address = env.NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS;
  const isRepeated =
    typeof address === "string" && /^0x([0-9a-f])\1{39}$/i.test(address);
  const isExplicitTestAddress = mode === "test" && address === TEST_ADDRESS;
  if (
    !address ||
    !ADDRESS.test(address) ||
    (isRepeated && !isExplicitTestAddress) ||
    (address === TEST_ADDRESS && !isExplicitTestAddress)
  ) {
    throw new Error(
      "AccessSeal contract address is missing or is a placeholder.",
    );
  }
  const definition = NETWORKS[network];
  return {
    network,
    chainId: definition.chainId,
    contractAddress: address.toLowerCase() as `0x${string}`,
    explorerBaseUrl: definition.explorerBaseUrl,
  };
}

export function publicConfigMarker(
  env: Environment,
): PublicConfigMarker {
  const safeTestConfig = env.NEXT_PUBLIC_ACCESSSEAL_SAFE_TEST_CONFIG === "1";
  const config = parsePublicConfig(env, safeTestConfig ? "test" : "production");
  return {
    schemaVersion: "accessseal-public-config/1",
    network: config.network,
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    safeTestConfig,
  };
}

export function transactionExplorerUrl(
  config: PublicConfig,
  hash: string,
): string | null {
  if (!config.explorerBaseUrl || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  return `${config.explorerBaseUrl}/transactions/${hash}`;
}
